import { randomBytes, randomUUID } from 'node:crypto'

import type { BrowserContext } from 'patchright'

import type { DashboardClient } from '../browser/DashboardClient.js'
import { REWARDS_URLS } from '../browser/Urls.js'
import type { TaskRecord } from '../domain/Task.js'
import type { ApplicationConfig } from '../infra/Config.js'
import type { SqliteStore } from '../infra/SqliteStore.js'
import type { StructuredLogger } from '../infra/StructuredLogger.js'
import {
  MutationExecutor,
  MutationNotStartedError,
  type ReadableMutationLedger
} from '../orchestration/MutationExecutor.js'
import { SearchExecutionError, SearchExecutor } from '../orchestration/SearchExecutor.js'
import { BusinessDateChanged } from '../orchestration/BusinessDate.js'
import type { TaskCreditEvidence } from './OfficialCredit.js'
import type { TaskAdapter, VerificationResult } from './TaskAdapter.js'
import type { DiscoveryOutput, TaskExecutionDescriptor } from './RewardsDiscoveryService.js'
import type { RewardOffer, RewardsDiscoverySnapshot } from './RewardsModel.js'
import { webOfferExecutionPath } from './OfferExecution.js'
import { buildReportActivityBody } from './ReportActivity.js'
import { buildRewardsQuestRouterStateTree, buildRewardsRouterStateTree } from './DashboardParser.js'

export type ExecutionMode = 'read-only' | 'mutating'

interface LedgerReconciliation {
  task: TaskRecord
  handled: boolean
  pending: boolean
}

function findAction(snapshot: RewardsDiscoverySnapshot, name: string): string | undefined {
  const exact = snapshot.actionIds[name]
  if (exact) return exact
  const entry = Object.entries(snapshot.actionIds).find(([key]) =>
    key.toLowerCase().includes(name.toLowerCase())
  )
  return entry?.[1]
}

export class RewardsTaskExecutor {
  private readonly mutation: MutationExecutor

  constructor(
    private readonly context: BrowserContext,
    private readonly client: DashboardClient,
    private readonly store: SqliteStore,
    private readonly logger: StructuredLogger,
    private readonly config: ApplicationConfig,
    private readonly runId: string,
    private readonly accountAlias: string,
    private readonly appToken?: string,
    private readonly mutationLedger: ReadableMutationLedger = store,
    private readonly guardDate?: () => void
  ) {
    this.mutation = new MutationExecutor(mutationLedger)
  }

  async executeTypes(input: {
    discovery: DiscoveryOutput
    types: readonly TaskRecord['type'][]
    mode: ExecutionMode
    signal: AbortSignal
  }): Promise<{ status: 'completed' | 'partial' | 'failed'; tasks: readonly TaskRecord[] }> {
    throwIfAborted(input.signal)
    this.guardDate?.()
    const selected = input.discovery.tasks.filter((task) => input.types.includes(task.type))
    const reconciled = selected.map((task) => this.reconcileKnownMutation(task))
    if (input.mode === 'read-only') {
      return {
        status: reconciled.some(({ pending }) => pending) ? 'partial' : 'completed',
        tasks: reconciled.map(({ task }) => task)
      }
    }
    let partial = reconciled.some(({ pending }) => pending)

    for (const reconciliation of reconciled) {
      this.guardDate?.()
      const original = reconciliation.task
      throwIfAborted(input.signal)
      if (reconciliation.handled) continue
      if (original.status === 'completed' || original.status === 'skipped') continue
      if (!original.executable) {
        partial = true
        continue
      }
      const descriptor = input.discovery.descriptors.get(original.taskId)
      if (!descriptor) {
        this.persist({ ...original, status: 'failed', reason: '任务执行描述不存在' })
        return { status: 'failed', tasks: selected }
      }

      if (original.type === 'pc-search' || original.type === 'mobile-search') {
        try {
          const executor = new SearchExecutor(
            this.context,
            this.client,
            this.logger,
            this.config.search,
            this.runId,
            this.accountAlias
          )
          const running = this.persist({ ...original, status: 'running' })
          const completed = await executor.run({
            task: running,
            mobile: original.type === 'mobile-search',
            signal: input.signal,
            onProgress: (task) => void this.persist(task),
            ...(this.guardDate ? { beforeSubmit: this.guardDate } : {})
          })
          this.persist(completed)
        } catch (error) {
          if (error instanceof BusinessDateChanged) {
            this.persist({
              ...(this.store.getTask(original.taskId) ?? original),
              status: 'verification-pending',
              reason: '业务日期变化，原任务保留待复核'
            })
            throw error
          }
          const latest = this.store.getTask(original.taskId) ?? original
          const failed = this.persist({
            ...latest,
            status: 'failed',
            reason:
              error instanceof SearchExecutionError
                ? `${error.operationStage}: ${error.message}`
                : error instanceof Error
                  ? error.message
                  : '搜索失败'
          })
          await this.logTask(failed)
          return { status: 'failed', tasks: selected }
        }
        continue
      }

      if (original.type === 'read-to-earn') {
        const outcome = await this.executeReadToEarn(descriptor, input.signal)
        if (outcome === 'failed') return { status: 'failed', tasks: selected }
        if (outcome === 'partial') partial = true
        continue
      }

      const unsupportedReason = this.unsupportedWebExecutionReason(
        descriptor,
        input.discovery.snapshot
      )
      if (unsupportedReason) {
        partial = true
        this.persist({
          ...original,
          executable: false,
          status: 'unknown',
          reason: unsupportedReason
        })
        continue
      }

      const running = this.persist({ ...original, status: 'running' })
      const outcome = await this.mutation.execute(
        running,
        this.adapterFor(descriptor, input.discovery.snapshot),
        input.signal
      )
      if (outcome.status === 'failed') {
        const failed = this.persist({
          ...running,
          status: 'failed',
          reason: outcome.message ?? 'mutation rejected'
        })
        await this.logTask(failed)
        if (original.required) return { status: 'failed', tasks: selected }
        partial = true
        continue
      }
      if (outcome.status === 'verification-pending') {
        partial = true
        this.persist({
          ...running,
          status: 'verification-pending',
          reason: outcome.message ?? outcome.verification?.reason ?? '只读复核未确认'
        })
      } else {
        this.persist({
          ...running,
          status: 'completed',
          progress: outcome.verification?.progress ?? {
            completed: running.progress.total ?? 1,
            total: running.progress.total ?? 1
          }
        })
      }
    }

    return { status: partial ? 'partial' : 'completed', tasks: reconciled.map(({ task }) => task) }
  }

  private reconcileKnownMutation(task: TaskRecord): LedgerReconciliation {
    const ledgerState = this.mutationLedger.getMutationState(task.taskId)
    if (!ledgerState) return { task, handled: false, pending: false }

    const confirmedByDiscovery =
      task.status === 'completed' ||
      (task.type === 'claim-bonus-points' &&
        task.status === 'skipped' &&
        task.progress.completed >= 1)
    if (confirmedByDiscovery) {
      if (ledgerState !== 'verified') this.mutationLedger.updateMutation(task.taskId, 'verified')
      return { task: this.persist(task), handled: true, pending: false }
    }

    if (task.status === 'skipped') return { task, handled: true, pending: false }

    const pending = this.persist({
      ...task,
      status: 'verification-pending',
      reason:
        ledgerState === 'verified'
          ? '历史复核已完成，但最新只读状态不一致'
          : '已有任务动作尚未被最新只读数据确认，不会重复提交'
    })
    return { task: pending, handled: true, pending: true }
  }

  private adapterFor(
    descriptor: TaskExecutionDescriptor,
    snapshot: RewardsDiscoverySnapshot
  ): TaskAdapter {
    const offer = descriptor.offer
    const adapter: TaskAdapter = {
      execute: async ({ signal }) => {
        if (signal.aborted) throw signal.reason
        if (descriptor.task.type === 'claim-bonus-points') {
          const actionId = findAction(snapshot, 'reportClaimAllPoints')
          if (actionId) {
            const response = await this.client.reportServerAction({
              actionId,
              body: [],
              url: REWARDS_URLS.earn,
              referer: REWARDS_URLS.earn,
              routerStateTree: buildRewardsRouterStateTree('earn'),
              ...(snapshot.deploymentId ? { deploymentId: snapshot.deploymentId } : {})
            })
            return { accepted: response.acknowledged, observedAt: new Date().toISOString() }
          }
          const result = await this.client.claimBonusByUiWithResult()
          if (!result.clicked) throw new MutationNotStartedError('Claim control was not found')
          return { accepted: result.acknowledged, observedAt: new Date().toISOString() }
        }
        if (descriptor.task.type === 'app-check-in' || descriptor.task.type === 'app-activity') {
          if (!this.appToken) return { accepted: false, observedAt: new Date().toISOString() }
          const payload = this.appPayload(descriptor.task.type, offer)
          await this.submitAppEvidence(descriptor.task, payload)
          return { accepted: true, observedAt: new Date().toISOString() }
        }
        if (!offer) return { accepted: false, observedAt: new Date().toISOString() }
        const actionId = findAction(snapshot, 'reportActivity')
        const executionPath = webOfferExecutionPath(offer, actionId !== undefined)
        if (executionPath === 'report-activity' && actionId) {
          const response = await this.client.reportServerAction({
            actionId,
            body: buildReportActivityBody(offer),
            offerId: offer.sourceTaskId,
            ...(offer.parentOfferId
              ? {
                  url: REWARDS_URLS.quest(offer.parentOfferId),
                  referer: REWARDS_URLS.quest(offer.parentOfferId),
                  routerStateTree: buildRewardsQuestRouterStateTree(offer.parentOfferId)
                }
              : {
                  url: REWARDS_URLS.dashboard,
                  referer: REWARDS_URLS.dashboard,
                  routerStateTree:
                    snapshot.routerStateTree ?? buildRewardsRouterStateTree('dashboard')
                }),
            ...(snapshot.deploymentId ? { deploymentId: snapshot.deploymentId } : {})
          })
          return {
            accepted: response.acknowledged,
            observedAt: new Date().toISOString(),
            ...(response.credit ? { credit: response.credit } : {})
          }
        }
        if (executionPath === 'navigate-only' && offer.destinationUrl) {
          await this.client.navigateOffer(offer.destinationUrl, {
            sourceTaskId: offer.sourceTaskId,
            displayName: offer.displayName
          })
          return { accepted: true, observedAt: new Date().toISOString() }
        }
        return { accepted: false, observedAt: new Date().toISOString() }
      },
      verify: async ({ signal }) => this.verifyTask(descriptor, signal)
    }
    return {
      execute: async (context) => {
        this.store.ledger.captureTaskBalance(this.runId, descriptor.task.accountId, 'task-before')
        const receipt = await adapter.execute(context)
        this.store.ledger.recordTaskEvidence({
          runId: this.runId,
          accountId: descriptor.task.accountId,
          taskId: descriptor.task.taskId,
          source: descriptor.task.source,
          kind: 'response',
          observedAt: receipt.observedAt,
          accepted: receipt.accepted,
          ...(receipt.credit ? { credit: receipt.credit } : {})
        })
        return receipt
      },
      verify: async (context) => {
        const result = await adapter.verify(context)
        if (
          result.points?.availability !== 'valid' &&
          result.confirmed &&
          !context.signal.aborted
        ) {
          try {
            result.points = (
              await this.client.fetchDashboard(context.signal, Date.now() + 15_000)
            ).availablePoints
          } catch {
            /* Keep the last real observation; never invent a final balance. */
          }
        }
        if (result.points)
          this.store.ledger.balance(
            this.runId,
            descriptor.task.accountId,
            'task-after',
            result.points
          )
        this.store.ledger.recordTaskEvidence({
          runId: this.runId,
          accountId: descriptor.task.accountId,
          taskId: descriptor.task.taskId,
          source: descriptor.task.source,
          kind: 'verification',
          observedAt: new Date().toISOString(),
          completed: result.progress.completed,
          total: result.progress.total,
          ...(result.credit ? { credit: result.credit } : {})
        })
        return result
      }
    }
  }

  private async submitAppEvidence(
    task: TaskRecord,
    payload: Readonly<Record<string, unknown>>
  ): Promise<void> {
    if (!this.appToken) throw new Error('App authentication unavailable')
    this.store.ledger.captureTaskBalance(this.runId, task.accountId, 'task-before')
    let credit: TaskCreditEvidence | undefined
    const balance = await this.client.submitAppActivity(
      this.appToken,
      payload,
      undefined,
      (value) => {
        credit = value
      }
    )
    this.store.ledger.recordTaskEvidence({
      runId: this.runId,
      accountId: task.accountId,
      taskId: task.taskId,
      source: 'app-dashboard',
      kind: 'response',
      observedAt: new Date().toISOString(),
      accepted: true,
      ...(credit ? { credit } : {}),
      ...(balance === undefined ? {} : { balance })
    })
  }

  private unsupportedWebExecutionReason(
    descriptor: TaskExecutionDescriptor,
    snapshot: RewardsDiscoverySnapshot
  ): string | undefined {
    if (
      descriptor.task.type === 'claim-bonus-points' ||
      descriptor.task.type === 'app-check-in' ||
      descriptor.task.type === 'app-activity'
    ) {
      return undefined
    }
    if (!descriptor.offer) return '任务缺少可验证的执行元数据'
    const path = webOfferExecutionPath(
      descriptor.offer,
      findAction(snapshot, 'reportActivity') !== undefined
    )
    if (path === 'interactive-quiz') return '交互式 Quiz 尚未实现，禁止作为普通活动提交'
    if (path === 'interactive-poll') return '交互式投票尚未实现，禁止作为普通活动提交'
    if (path === 'unsupported') return '任务缺少受支持且可验证的执行路径'
    return undefined
  }

  private async verifyTask(
    descriptor: TaskExecutionDescriptor,
    signal: AbortSignal
  ): Promise<VerificationResult> {
    try {
      this.guardDate?.()
    } catch {
      return { confirmed: false, progress: descriptor.task.progress, reason: '跨日后原任务待确认' }
    }
    if (descriptor.task.type === 'claim-bonus-points') {
      let claimable: number | undefined
      for (let attempt = 1; attempt <= 4; attempt += 1) {
        claimable = await this.client.readClaimablePoints()
        try {
          this.guardDate?.()
        } catch {
          return {
            confirmed: false,
            progress: descriptor.task.progress,
            reason: '跨日后原领取任务待确认'
          }
        }
        if (claimable === 0) break
        if (attempt < 4) await abortableDelay(5_000, signal)
      }
      return {
        confirmed: claimable === 0,
        progress: { completed: claimable === 0 ? 1 : 0, total: 1 },
        ...(claimable === 0 ? {} : { reason: '领取请求已完成，积分待复核' })
      }
    }
    if (
      (descriptor.task.type === 'app-check-in' || descriptor.task.type === 'app-activity') &&
      this.appToken
    ) {
      const observation = await this.client.fetchAppDashboard(this.appToken)
      const offer = observation.offers.find(
        (item) => item.sourceTaskId === descriptor.task.sourceTaskId
      )
      return {
        ...this.offerVerification(descriptor.task, offer),
        points: observation.availablePoints
      }
    }
    if (descriptor.offer?.source === 'bing-flyout') {
      const observation = await this.client.fetchFlyout(Date.now() + 15_000, signal)
      const offer = observation?.offers.find(
        (item) => item.sourceTaskId === descriptor.task.sourceTaskId
      )
      return {
        ...this.offerVerification(descriptor.task, offer),
        ...(observation ? { points: observation.availablePoints } : {})
      }
    }
    const bootstrap = await this.client.bootstrapRsc()
    const offer = bootstrap.offers.find(
      (item) => item.sourceTaskId === descriptor.task.sourceTaskId
    )
    return { ...this.offerVerification(descriptor.task, offer), points: bootstrap.availablePoints }
  }

  private offerVerification(task: TaskRecord, offer: RewardOffer | undefined): VerificationResult {
    try {
      this.guardDate?.()
    } catch {
      return { confirmed: false, progress: task.progress, reason: '跨日后原任务待确认' }
    }
    if (!offer) {
      return {
        confirmed: false,
        progress: task.progress,
        reason: '只读复核未找到原任务，不能推断已完成'
      }
    }
    return {
      confirmed: offer.complete,
      progress: { completed: offer.completed, total: offer.total },
      credit: {
        evidenceSource: 'official-progress',
        verificationStatus: 'pending',
        ...(offer.expectedPoints === undefined ? {} : { expectedPoints: offer.expectedPoints })
      },
      ...(offer.complete ? {} : { reason: '任务仍未完成' })
    }
  }

  private async executeReadToEarn(
    descriptor: TaskExecutionDescriptor,
    signal: AbortSignal
  ): Promise<'completed' | 'partial' | 'failed'> {
    if (!this.appToken) {
      this.persist({ ...descriptor.task, status: 'failed', reason: 'app-oauth unavailable' })
      return 'failed'
    }
    const maximumSubmissions = 10
    let total = descriptor.task.progress.total
    let completed = descriptor.task.progress.completed
    for (let index = 0; index < maximumSubmissions; index += 1) {
      this.guardDate?.()
      if (signal.aborted) throw signal.reason
      if (total !== null && completed >= total) {
        this.persist({
          ...descriptor.task,
          status: 'completed',
          progress: { completed, total }
        })
        return 'completed'
      }
      const ledgerId = `${descriptor.task.taskId}:article:${String(index + 1)}`
      const previousState = this.mutationLedger.getMutationState(ledgerId)
      if (previousState) {
        const verified = await this.readAppOffer(descriptor)
        if (!verified || (!verified.complete && verified.completed <= completed)) {
          this.persist({
            ...descriptor.task,
            status: 'verification-pending',
            progress: { completed, total },
            reason: '已有阅读动作尚未确认，仅执行只读复核'
          })
          return 'partial'
        }
        this.mutationLedger.updateMutation(ledgerId, 'verified')
        completed = verified.completed
        total = verified.total
        if (verified.complete) {
          this.persist({
            ...descriptor.task,
            status: 'completed',
            progress: { completed, total }
          })
          return 'completed'
        }
        continue
      }
      if (!this.mutationLedger.beginMutation(ledgerId)) return 'partial'
      try {
        await this.submitAppEvidence(descriptor.task, {
          amount: 1,
          id: randomBytes(32).toString('hex'),
          type: 101,
          attributes: { offerid: descriptor.offer?.sourceTaskId ?? 'ENUS_readarticle3_30points' },
          country: 'CN'
        })
        this.mutationLedger.updateMutation(ledgerId, 'submitted')
        const verified = await this.readAppOffer(descriptor)
        if (!verified || (!verified.complete && verified.completed <= completed)) {
          this.mutationLedger.updateMutation(ledgerId, 'verification-pending')
          this.persist({
            ...descriptor.task,
            status: 'verification-pending',
            progress: { completed, total },
            reason: '阅读动作已提交，但 App Dashboard 未确认进度增加'
          })
          return 'partial'
        }
        this.mutationLedger.updateMutation(ledgerId, 'verified')
        completed = verified.completed
        total = verified.total
        this.persist({
          ...descriptor.task,
          status: verified.complete ? 'completed' : 'running',
          progress: { completed, total }
        })
        if (verified.complete) return 'completed'
      } catch (error) {
        this.mutationLedger.updateMutation(ledgerId, 'verification-pending')
        this.persist({
          ...descriptor.task,
          status: 'verification-pending',
          progress: { completed, total },
          reason: error instanceof Error ? error.message : '阅读任务结果待复核'
        })
        return 'partial'
      }
      if (index < maximumSubmissions - 1) {
        await new Promise((resolve) => setTimeout(resolve, 5_000))
      }
    }
    this.persist({
      ...descriptor.task,
      status: 'verification-pending',
      progress: { completed, total },
      reason: '阅读任务达到单日最大动作次数，但 App Dashboard 尚未确认完成'
    })
    return 'partial'
  }

  private async readAppOffer(
    descriptor: TaskExecutionDescriptor
  ): Promise<RewardOffer | undefined> {
    if (!this.appToken) return undefined
    const observation = await this.client.fetchAppDashboard(this.appToken)
    try {
      this.guardDate?.()
    } catch {
      return undefined
    }
    const offer = observation.offers.find(
      (offer) => offer.sourceTaskId === descriptor.task.sourceTaskId
    )
    if (offer)
      this.store.ledger.recordTaskEvidence({
        runId: this.runId,
        accountId: descriptor.task.accountId,
        taskId: descriptor.task.taskId,
        source: 'app-dashboard',
        kind: 'verification',
        observedAt: new Date().toISOString(),
        completed: offer.completed,
        total: offer.total,
        credit: {
          evidenceSource: 'official-progress',
          verificationStatus: 'pending',
          ...(offer.expectedPoints === undefined ? {} : { expectedPoints: offer.expectedPoints })
        }
      })
    return offer
  }

  private appPayload(
    type: 'app-check-in' | 'app-activity',
    offer?: RewardOffer
  ): Record<string, unknown> {
    return type === 'app-check-in'
      ? {
          risk_context: {},
          type: 103,
          channel: 'SAIOS',
          attributes: {},
          id: randomUUID(),
          amount: 1,
          country: 'CN'
        }
      : {
          id: randomUUID(),
          amount: 1,
          type: 101,
          attributes: { offerid: offer?.sourceTaskId ?? '' },
          country: 'CN'
        }
  }

  private persist(task: TaskRecord): TaskRecord {
    const updated = { ...task, updatedAt: new Date().toISOString() }
    this.store.upsertTask(updated, this.runId)
    this.store.ledger.recordTaskEvidence({
      runId: this.runId,
      accountId: task.accountId,
      taskId: task.taskId,
      source: task.source,
      kind: 'execution',
      observedAt: updated.updatedAt,
      completed: task.progress.completed,
      total: task.progress.total,
      executionState: task.status,
      credit: {
        submitted: ['submitted', 'verification-pending', 'verified'].includes(
          this.mutationLedger.getMutationState(task.taskId) ?? ''
        )
      }
    })
    return updated
  }

  private async logTask(task: TaskRecord): Promise<void> {
    await this.logger.write({
      level: task.status === 'failed' ? 'error' : 'info',
      event: 'task-state',
      runId: this.runId,
      accountAlias: this.accountAlias,
      taskType: task.type,
      status: task.status,
      ...(task.reason === undefined ? {} : { message: task.reason })
    })
  }
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortReason(signal))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, milliseconds)
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortReason(signal))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('task-aborted')
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal)
}
