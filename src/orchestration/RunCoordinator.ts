import { randomUUID } from 'node:crypto'

import type { AccountBrowserSlot } from '../browser/BrowserRuntime.js'
import { BrowserRuntime } from '../browser/BrowserRuntime.js'
import { DashboardClient } from '../browser/DashboardClient.js'
import { AppOAuthClient, type AppToken } from '../browser/AppOAuthClient.js'
import { LoginController } from '../browser/LoginController.js'
import { REWARDS_URLS } from '../browser/Urls.js'
import { LoginStateError, requiresUserAction } from '../auth/LoginState.js'
import type { EncryptedSessionStore } from '../auth/EncryptedSessionStore.js'
import { aggregateAccountStatus, type AccountRunStatus } from '../domain/AccountRun.js'
import { localDateKey } from '../domain/DateKey.js'
import { batchStatus } from '../domain/RunOutcome.js'
import type { RunRequest } from '../domain/RunRequest.js'
import type { TaskRecord } from '../domain/Task.js'
import type { AccountSecretStore, AccountSummary } from '../infra/AccountSecretStore.js'
import type { ApplicationConfig } from '../infra/Config.js'
import type { SqliteStore } from '../infra/SqliteStore.js'
import type { StructuredLogger } from '../infra/StructuredLogger.js'
import { redactText } from '../security/Redactor.js'
import {
  RewardsDiscoveryService,
  type DiscoveryOutput
} from '../rewards/RewardsDiscoveryService.js'
import { RewardsTaskExecutor, type ExecutionMode } from '../rewards/RewardsTaskExecutor.js'
import type { RewardsObservation } from '../rewards/RewardsModel.js'
import type { ReadableMutationLedger } from './MutationExecutor.js'
import { assertBusinessDate, BusinessDateChanged } from './BusinessDate.js'
import type { FieldEvidence } from '../domain/Evidence.js'
import type { RunLedger } from '../infra/RunLedger.js'
import { balanceInterval } from '../infra/BalanceInterval.js'
import {
  AccountPipeline,
  accountPipelineDiagnostic,
  type AccountPipelineContext,
  type AccountPipelinePort,
  type AccountPipelineStage,
  type StageResult
} from './AccountPipeline.js'

export interface RunStartResult {
  runId: string
  selectedAccountIndexes: readonly number[]
}

export function accountExecutionState(status: AccountRunStatus | 'cancelled' | 'interrupted') {
  const states = {
    success: 'completed',
    partial: 'partial',
    failed: 'failed',
    'action-required': 'action-required',
    cancelled: 'cancelled',
    interrupted: 'interrupted',
    queued: 'queued',
    running: 'running'
  } as const
  return states[status]
}

export class RunAlreadyActiveError extends Error {
  constructor(readonly runId: string) {
    super('A Rewards run is already active')
    this.name = 'RunAlreadyActiveError'
  }
}

interface AccountResources {
  desktop?: AccountBrowserSlot
  mobile?: AccountBrowserSlot
  desktopClient?: DashboardClient
  mobileClient?: DashboardClient
  appToken?: AppToken
  appObservation?: RewardsObservation
  verifiedObservation?: RewardsObservation
  discovery?: DiscoveryOutput
  initialPoints?: number
  finalPoints?: number
  finalEvidence?: FieldEvidence<number>
  guardDate?: () => void
  initialTaskProgress?: ReadonlyMap<string, number>
  initialTaskStatuses?: ReadonlyMap<string, TaskRecord['status']>
}

export class ApplicationRunCoordinator {
  private static readonly activeStoreRuns = new WeakMap<object, string>()
  private active: { runId: string; controller: AbortController } | undefined
  private completion: Promise<void> | undefined
  private finishing = false
  private interrupted = false

  constructor(
    private readonly accounts: AccountSecretStore,
    private readonly store: SqliteStore,
    private readonly sessions: EncryptedSessionStore,
    private readonly browser: BrowserRuntime,
    private readonly logger: StructuredLogger,
    private readonly config: ApplicationConfig,
    private readonly mutationLedger?: ReadableMutationLedger,
    private readonly runLedger: RunLedger | undefined = store.ledger
  ) {}

  async start(request: RunRequest): Promise<RunStartResult> {
    await Promise.resolve()
    const storeActiveRunId = ApplicationRunCoordinator.activeStoreRuns.get(this.store)
    if (this.active || storeActiveRunId) {
      throw new RunAlreadyActiveError(this.active?.runId ?? storeActiveRunId as string)
    }
    if (request.accountMode === 'continue' && request.retryPendingSearch === true) {
      throw new TypeError('retryPendingSearch requires single-account mode')
    }
    const localDate = localDateKey()
    const selected = this.selectAccounts(request, localDate)
    const runId = randomUUID()
    const executionMode = request.executionMode ?? 'read-only'
    const controller = new AbortController()
    ApplicationRunCoordinator.activeStoreRuns.set(this.store, runId)
    try {
      this.store.createRun({
        runId,
        localDate,
        executionMode,
        selectedAccountIndexes: selected.map((account) => account.runAccountIndex),
        startedAt: new Date().toISOString()
      })
      for (const account of selected)
        this.runLedger?.lifecycle({
          runId,
          accountId: account.accountId,
          accountIndex: account.runAccountIndex,
          accountLabel: account.maskedEmail,
          startedAt: null,
          endedAt: null,
          executionState: 'queued',
          updatedAt: new Date().toISOString()
        })
    } catch (error) {
      if (ApplicationRunCoordinator.activeStoreRuns.get(this.store) === runId)
        ApplicationRunCoordinator.activeStoreRuns.delete(this.store)
      throw error
    }
    this.active = { runId, controller }
    this.finishing = false
    this.interrupted = false
    this.completion = this.executeRun(
      runId,
      localDate,
      executionMode,
      selected,
      controller,
      request.accountMode === 'account',
      request.runAccountIndex,
      request.retryPendingSearch === true
    )
    // Keep failures observable to shutdown without an unhandled background rejection.
    void this.completion.catch(() => undefined)
    return { runId, selectedAccountIndexes: selected.map((account) => account.runAccountIndex) }
  }

  cancel(runId: string): boolean {
    if (!this.active || this.active.runId !== runId || this.finishing) return false
    this.store.updateRun(runId, 'cancelling')
    this.active.controller.abort(new Error('run-cancelled'))
    return true
  }

  get activeRunId(): string | undefined {
    return this.active?.runId
  }

  async stopAndWait(reason: 'cancelled' | 'interrupted' = 'cancelled'): Promise<void> {
    if (this.active && !this.finishing && reason === 'interrupted') this.interrupted = true
    if (this.active) this.cancel(this.active.runId)
    await this.completion
  }

  private selectAccounts(request: RunRequest, localDate: string): AccountSummary[] {
    const all = this.accounts.list()
    if (request.accountMode === 'account') {
      const index = request.runAccountIndex
      if (!Number.isInteger(index) || index === undefined || index < 1 || index > all.length) {
        throw new RangeError(`runAccountIndex must be between 1 and ${String(all.length)}`)
      }
      const selected = all[index - 1]
      if (!selected?.enabled) throw new RangeError('Selected account is disabled')
      return [selected]
    }
    if (request.runAccountIndex !== undefined) {
      throw new TypeError('continue mode must not include runAccountIndex')
    }
    return all.filter(
      (account) =>
        account.enabled && !this.store.isAccountCompleteForDate(account.accountId, localDate)
    )
  }

  private async executeRun(
    runId: string,
    localDate: string,
    mode: ExecutionMode,
    selected: readonly AccountSummary[],
    controller: AbortController,
    singleAccountMode: boolean,
    targetAccountIndex: number | undefined,
    retryPendingSearch: boolean
  ): Promise<void> {
    const results: AccountRunStatus[] = []
    try {
      this.store.updateRun(runId, 'running')
      for (const account of selected) {
        if (controller.signal.aborted) break
        const status = await this.executeAccount(
          runId,
          localDateKey(),
          mode,
          account,
          controller.signal,
          singleAccountMode,
          targetAccountIndex,
          retryPendingSearch
        )
        results.push(status)
      }
      const finishedAt = new Date().toISOString()
      if (controller.signal.aborted)
        this.store.updateRun(runId, this.interrupted ? 'interrupted' : 'cancelled', finishedAt)
      else this.store.updateRun(runId, batchStatus(results, selected.length), finishedAt)
    } catch (error) {
      this.store.updateRun(
        runId,
        controller.signal.aborted ? (this.interrupted ? 'interrupted' : 'cancelled') : 'failed',
        new Date().toISOString()
      )
      if (!controller.signal.aborted) throw error
    } finally {
      this.finishing = true
      await this.browser.close().catch(() => undefined)
      if (this.active?.runId === runId) this.active = undefined
      if (ApplicationRunCoordinator.activeStoreRuns.get(this.store) === runId)
        ApplicationRunCoordinator.activeStoreRuns.delete(this.store)
    }
  }

  private async executeAccount(
    runId: string,
    localDate: string,
    mode: ExecutionMode,
    account: AccountSummary,
    signal: AbortSignal,
    singleAccountMode: boolean,
    targetAccountIndex: number | undefined,
    retryPendingSearch: boolean
  ): Promise<AccountRunStatus> {
    const credentials = this.accounts.getCredentials(account.accountId)
    if (!credentials) return 'failed'
    const resources: AccountResources = {}
    const context: AccountPipelineContext = {
      runId,
      accountId: account.accountId,
      runAccountIndex: account.runAccountIndex,
      localDate,
      signal
    }
    resources.guardDate = () => {
      assertBusinessDate(context.localDate)
    }
    const startedAt = new Date().toISOString()
    const lifecycle = (
      executionState:
        | 'queued'
        | 'running'
        | 'completed'
        | 'partial'
        | 'failed'
        | 'cancelled'
        | 'interrupted'
        | 'action-required'
    ): void => {
      const at = new Date().toISOString()
      this.runLedger?.lifecycle({
        runId,
        accountId: account.accountId,
        accountIndex: account.runAccountIndex,
        accountLabel: account.maskedEmail,
        startedAt,
        endedAt: executionState === 'running' ? null : at,
        executionState,
        updatedAt: at
      })
    }
    lifecycle('running')
    let rediscovering = false
    this.store.upsertAccountRun({
      ...context,
      status: 'queued',
      updatedAt: new Date().toISOString()
    })

    const port: AccountPipelinePort = {
      execute: (stage) => {
        if (stage !== 'authenticate') resources.guardDate?.()
        if (rediscovering && stage === 'authenticate')
          return Promise.resolve({ status: 'completed' })
        return this.executeStage(
          stage,
          context,
          mode,
          credentials,
          resources,
          singleAccountMode,
          targetAccountIndex,
          retryPendingSearch
        )
      },
      checkpoint: (stage, result) => {
        const status: AccountRunStatus =
          result.status === 'failed'
            ? 'failed'
            : result.status === 'action-required'
              ? 'action-required'
              : result.status === 'partial'
                ? 'partial'
                : stage === 'final-verification'
                  ? 'success'
                  : 'running'
        this.store.upsertAccountRun({
          ...context,
          status,
          stage: result.failureStage ?? stage,
          ...(result.message === undefined ? {} : { message: redactText(result.message) }),
          updatedAt: new Date().toISOString()
        })
        return Promise.resolve()
      }
    }

    try {
      const pipeline = new AccountPipeline(port)
      let result
      for (;;) {
        try {
          result = await pipeline.run(context)
          if (result.status !== 'failed' && result.status !== 'action-required')
            resources.guardDate()
          break
        } catch (error) {
          if (!(error instanceof BusinessDateChanged)) throw error
          context.localDate = localDateKey()
          rediscovering = true
          delete resources.discovery
          delete resources.verifiedObservation
          delete resources.appObservation
          delete resources.finalPoints
          delete resources.initialPoints
          delete resources.finalEvidence
        }
      }
      if (
        ['failed', 'partial'].includes(result.status) &&
        !resources.finalEvidence &&
        resources.discovery &&
        resources.desktopClient &&
        !signal.aborted
      ) {
        delete resources.finalEvidence
        delete resources.finalPoints
        // One read-only closeout attempt. Authentication failures and cancelled runs never enter here.
        try {
          const observation = await resources.desktopClient.fetchDashboard(
            signal,
            Date.now() + 15_000
          )
          if (observation.availablePoints.availability === 'valid') {
            resources.finalEvidence = observation.availablePoints
          }
        } catch {
          await this.logger.write({
            level: 'warn',
            event: 'final-balance-unavailable',
            runId,
            accountAlias: `account-${String(account.runAccountIndex)}`,
            status: 'pending'
          })
        }
      }
      const tasks = this.store.ledger
        .tasks(runId)
        .filter((task) => task.accountId === account.accountId)
      const finalEvidence = resources.finalEvidence
      if (finalEvidence) this.runLedger?.balance(runId, account.accountId, 'end', finalEvidence)
      const status =
        result.status === 'success' ? aggregateAccountStatus(tasks, finalEvidence) : result.status
      const diagnostic = accountPipelineDiagnostic(result)
      const interval = balanceInterval(
        this.store.ledger.balances(runId, account.accountId, context.localDate),
        true
      )
      const balanceConfirmed = interval.verificationStatus === 'confirmed'
      this.store.upsertAccountRun({
        ...context,
        status,
        ...(diagnostic.stage === undefined ? {} : { stage: diagnostic.stage }),
        ...(diagnostic.message === undefined ? {} : { message: redactText(diagnostic.message) }),
        updatedAt: new Date().toISOString()
      })
      this.store.recordPoints({
        accountId: account.accountId,
        localDate: context.localDate,
        ...(interval.openingBalance === null ? {} : { initialPoints: interval.openingBalance }),
        ...(!balanceConfirmed || interval.closingBalance === null
          ? {}
          : { finalPoints: interval.closingBalance }),
        status,
        balanceConfirmed,
        recordedAt: new Date().toISOString()
      })
      lifecycle(accountExecutionState(status))
      return status
    } catch (error) {
      this.store.upsertAccountRun({
        ...context,
        status: signal.aborted ? 'partial' : 'failed',
        stage: signal.aborted ? 'cancelled' : 'execution-error',
        message: signal.aborted
          ? 'Execution stopped; verification remains pending'
          : 'Execution failed',
        updatedAt: new Date().toISOString()
      })
      lifecycle(signal.aborted ? (this.interrupted ? 'interrupted' : 'cancelled') : 'failed')
      throw error
    } finally {
      await resources.mobile?.close().catch(() => undefined)
      await resources.desktop?.close().catch(() => undefined)
    }
  }

  private async executeStage(
    stage: AccountPipelineStage,
    context: AccountPipelineContext,
    mode: ExecutionMode,
    credentials: { email: string; password: string },
    resources: AccountResources,
    singleAccountMode: boolean,
    targetAccountIndex: number | undefined,
    retryPendingSearch: boolean
  ): Promise<StageResult> {
    if (stage === 'authenticate') return this.authenticate(context, credentials, resources)
    if (!resources.desktop || !resources.desktopClient) throw new Error('desktop-login unavailable')
    if (stage === 'discover') {
      if (!resources.appObservation && resources.appToken && resources.mobileClient) {
        resources.appObservation = await resources.mobileClient.fetchAppDashboard(
          resources.appToken.accessToken
        )
      }
      resources.discovery = await new RewardsDiscoveryService().discover({
        accountId: context.accountId,
        localDate: context.localDate,
        client: resources.desktopClient,
        ...(resources.verifiedObservation === undefined
          ? {}
          : { initialObservation: resources.verifiedObservation }),
        ...(resources.appObservation === undefined
          ? {}
          : { appObservation: resources.appObservation }),
        signal: context.signal
      })
      delete resources.verifiedObservation
      resources.discovery = this.applyTaskConfiguration(resources.discovery)
      for (const task of resources.discovery.tasks) this.store.upsertTask(task, context.runId)
      this.runLedger?.balance(
        context.runId,
        context.accountId,
        'start',
        resources.discovery.snapshot.availablePoints
      )
      this.store.recordEvidence({
        runId: context.runId,
        accountId: context.accountId,
        field: 'availablePoints',
        evidence: resources.discovery.snapshot.availablePoints
      })
      this.store.recordEvidence({
        runId: context.runId,
        accountId: context.accountId,
        field: 'rewardsUser',
        evidence: resources.discovery.snapshot.rewardsUser
      })
      this.store.recordEvidence({
        runId: context.runId,
        accountId: context.accountId,
        field: 'pcSearch',
        evidence: resources.discovery.snapshot.pcSearch
      })
      this.store.recordEvidence({
        runId: context.runId,
        accountId: context.accountId,
        field: 'mobileSearch',
        evidence: resources.discovery.snapshot.mobileSearch
      })
      if (resources.discovery.snapshot.availablePoints.value !== undefined) {
        resources.initialPoints = resources.discovery.snapshot.availablePoints.value
      }
      resources.initialTaskProgress = new Map(
        resources.discovery.tasks.map((task) => [task.taskId, task.progress.completed])
      )
      resources.initialTaskStatuses = new Map(
        resources.discovery.tasks.map((task) => [task.taskId, task.status])
      )
      return { status: 'completed' }
    }
    if (!resources.discovery) throw new Error('discovery unavailable')

    if (stage === 'claim-bonus-points') {
      const refreshed = this.applyTaskConfiguration(
        await new RewardsDiscoveryService().discover({
          accountId: context.accountId,
          localDate: context.localDate,
          client: resources.desktopClient,
          ...(resources.appObservation === undefined
            ? {}
            : { appObservation: resources.appObservation }),
          signal: context.signal
        })
      )
      const claim = refreshed.tasks.find((task) => task.type === 'claim-bonus-points')
      if (claim) this.store.upsertTask(claim, context.runId)
      const claimDescriptor = claim ? refreshed.descriptors.get(claim.taskId) : undefined
      resources.discovery = {
        ...refreshed,
        tasks: claim ? [claim] : [],
        descriptors: new Map(claim && claimDescriptor ? [[claim.taskId, claimDescriptor]] : [])
      }
    }
    if (stage === 'final-verification') {
      const expectedProgressGain = this.confirmedPointProgressGain(context, resources)
      const hasUnquantifiedCompletion = this.hasUnquantifiedCompletion(context, resources)
      const maximumAttempts = expectedProgressGain > 0 || hasUnquantifiedCompletion ? 4 : 1
      for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
        const observation = await resources.desktopClient.fetchDashboard(context.signal)
        if (
          observation.availablePoints.availability === 'valid' &&
          observation.availablePoints.value !== undefined
        ) {
          resources.finalPoints = observation.availablePoints.value
          resources.finalEvidence = observation.availablePoints
          this.runLedger?.balance(
            context.runId,
            context.accountId,
            'live',
            observation.availablePoints
          )
          const progressSettled =
            resources.initialPoints === undefined ||
            resources.finalPoints >= resources.initialPoints + expectedProgressGain
          const unquantifiedSettled =
            !hasUnquantifiedCompletion ||
            resources.initialPoints === undefined ||
            resources.finalPoints > resources.initialPoints ||
            attempt === maximumAttempts
          const settled = progressSettled && unquantifiedSettled
          await this.logger.write({
            level: settled ? 'info' : 'warn',
            event: 'final-balance-verification',
            runId: context.runId,
            accountAlias: `account-${String(context.runAccountIndex)}`,
            stage: settled ? 'final-dashboard' : 'final-dashboard-settlement',
            status: settled ? 'confirmed' : 'pending',
            attempt
          })
          if (settled) return { status: 'completed' }
        }
        if (attempt < maximumAttempts) await abortableDelay(10_000, context.signal)
      }
      return resources.finalPoints === undefined
        ? { status: 'partial', message: '最终余额未确认', failureStage: 'final-dashboard' }
        : {
            status: 'partial',
            message: '最终余额尚未反映已确认的搜索进度',
            failureStage: 'final-dashboard-settlement'
          }
    }

    const types = this.enabledTaskTypes(stage)
    const outcome =
      stage === 'search'
        ? await this.executeSearchStage(
            context,
            mode,
            resources,
            types,
            singleAccountMode,
            targetAccountIndex,
            retryPendingSearch
          )
        : await new RewardsTaskExecutor(
            stage === 'app-tasks' && resources.mobile
              ? resources.mobile.context
              : resources.desktop.context,
            stage === 'app-tasks' && resources.mobileClient
              ? resources.mobileClient
              : resources.desktopClient,
            this.store,
            this.logger,
            this.config,
            context.runId,
            `account-${String(context.runAccountIndex)}`,
            resources.appToken?.accessToken,
            this.mutationLedger,
            resources.guardDate
          ).executeTypes({
            discovery: resources.discovery,
            types,
            mode,
            signal: context.signal,
            accountMode: singleAccountMode ? 'account' : 'continue',
            accountIndex: context.runAccountIndex,
            ...(targetAccountIndex === undefined ? {} : { targetAccountIndex }),
            retryPendingSearch
          })
    const failedTask = this.store
      .listTaskState(context.localDate)
      .find(
        (task) =>
          task.accountId === context.accountId &&
          task.status === 'failed' &&
          types.includes(task.type)
      )
    return {
      status: outcome.status,
      ...(failedTask?.reason === undefined ? {} : { message: failedTask.reason })
    }
  }

  private async executeSearchStage(
    context: AccountPipelineContext,
    mode: ExecutionMode,
    resources: AccountResources,
    types: readonly TaskRecord['type'][],
    singleAccountMode: boolean,
    targetAccountIndex: number | undefined,
    retryPendingSearch: boolean
  ): Promise<{ status: 'completed' | 'partial' | 'failed' }> {
    if (!resources.discovery || !resources.desktop || !resources.desktopClient) {
      throw new Error('desktop-search resources unavailable')
    }

    let status: 'completed' | 'partial' = 'completed'
    if (types.includes('pc-search')) {
      const desktopOutcome = await new RewardsTaskExecutor(
        resources.desktop.context,
        resources.desktopClient,
        this.store,
        this.logger,
        this.config,
        context.runId,
        `account-${String(context.runAccountIndex)}`,
        undefined,
        this.mutationLedger,
        resources.guardDate
      ).executeTypes({
        discovery: resources.discovery,
        types: ['pc-search'],
        mode,
        signal: context.signal,
        accountMode: singleAccountMode ? 'account' : 'continue',
        accountIndex: context.runAccountIndex,
        ...(targetAccountIndex === undefined ? {} : { targetAccountIndex }),
        retryPendingSearch,
        resumePendingSearch: mode === 'mutating' && !singleAccountMode
      })
      if (desktopOutcome.status === 'failed') return { status: 'failed' }
      if (desktopOutcome.status === 'partial') status = 'partial'
    }

    if (types.includes('mobile-search')) {
      const mobileTasks = resources.discovery.tasks.filter((task) => task.type === 'mobile-search')
      if (!resources.mobile || !resources.mobileClient) {
        for (const task of mobileTasks) {
          if (task.status === 'completed' || task.status === 'skipped') continue
          this.store.upsertTask({
            ...task,
            status: 'failed',
            reason: 'mobile-search context unavailable',
            updatedAt: new Date().toISOString()
          })
        }
        if (mobileTasks.some((task) => task.status !== 'completed' && task.status !== 'skipped')) {
          status = 'partial'
        }
      } else {
        const mobileOutcome = await new RewardsTaskExecutor(
          resources.mobile.context,
          resources.mobileClient,
          this.store,
          this.logger,
          this.config,
          context.runId,
          `account-${String(context.runAccountIndex)}`,
          resources.appToken?.accessToken,
          this.mutationLedger,
          resources.guardDate
        ).executeTypes({
          discovery: resources.discovery,
          types: ['mobile-search'],
          mode,
          signal: context.signal,
          accountMode: singleAccountMode ? 'account' : 'continue',
          accountIndex: context.runAccountIndex,
          ...(targetAccountIndex === undefined ? {} : { targetAccountIndex }),
          retryPendingSearch
        })
        if (mobileOutcome.status === 'failed') return { status: 'failed' }
        if (mobileOutcome.status === 'partial') status = 'partial'
      }
    }
    return { status }
  }

  private confirmedPointProgressGain(
    context: AccountPipelineContext,
    resources: AccountResources
  ): number {
    const tasks = this.store
      .listTaskState(context.localDate)
      .filter((task) => task.accountId === context.accountId)
    const pointProgressTypes = new Set<TaskRecord['type']>([
      'app-activity',
      'daily-set',
      'mobile-search',
      'more-promotion',
      'pc-search',
      'read-to-earn',
      'special-promotion'
    ])
    return tasks.reduce((total, task) => {
      if (!pointProgressTypes.has(task.type) || (task.progress.total ?? 0) <= 1) return total
      const initial = resources.initialTaskProgress?.get(task.taskId)
      return initial === undefined ? total : total + Math.max(0, task.progress.completed - initial)
    }, 0)
  }

  private hasUnquantifiedCompletion(
    context: AccountPipelineContext,
    resources: AccountResources
  ): boolean {
    return this.store
      .listTaskState(context.localDate)
      .filter((task) => task.accountId === context.accountId && task.type !== 'unknown')
      .some((task) => {
        const initialStatus = resources.initialTaskStatuses?.get(task.taskId)
        return (
          initialStatus !== undefined &&
          initialStatus !== 'completed' &&
          task.status === 'completed' &&
          (task.progress.total ?? 0) <= 1
        )
      })
  }

  private enabledTaskTypes(stage: AccountPipelineStage): readonly TaskRecord['type'][] {
    if (stage === 'web-rewards') {
      return [
        ...(this.config.tasks.dailySet ? (['daily-set'] as const) : []),
        ...(this.config.tasks.specialPromotions ? (['special-promotion'] as const) : []),
        ...(this.config.tasks.morePromotions ? (['more-promotion'] as const) : []),
        ...(this.config.tasks.punchCards ? (['punch-card'] as const) : [])
      ]
    }
    if (stage === 'app-tasks') {
      return [
        ...(this.config.tasks.appActivities ? (['app-activity'] as const) : []),
        ...(this.config.tasks.appCheckIn ? (['app-check-in'] as const) : []),
        ...(this.config.tasks.readToEarn ? (['read-to-earn'] as const) : [])
      ]
    }
    if (stage === 'search') {
      return [
        ...(this.config.tasks.mobileSearch ? (['mobile-search'] as const) : []),
        ...(this.config.tasks.pcSearch ? (['pc-search'] as const) : [])
      ]
    }
    if (stage === 'claim-bonus-points') {
      return this.config.tasks.claimBonusPoints ? ['claim-bonus-points'] : []
    }
    return []
  }

  private applyTaskConfiguration(discovery: DiscoveryOutput): DiscoveryOutput {
    const enabled = new Set<TaskRecord['type']>([
      ...this.enabledTaskTypes('web-rewards'),
      ...this.enabledTaskTypes('app-tasks'),
      ...this.enabledTaskTypes('search'),
      ...this.enabledTaskTypes('claim-bonus-points')
    ])
    const tasks = discovery.tasks.map((task) =>
      enabled.has(task.type) || task.type === 'unknown'
        ? task
        : {
            ...task,
            executable: false,
            status: 'skipped' as const,
            reason: '配置已禁用'
          }
    )
    const descriptors = new Map(discovery.descriptors)
    for (const task of tasks) {
      const current = descriptors.get(task.taskId)
      if (current) descriptors.set(task.taskId, { ...current, task })
    }
    return { ...discovery, tasks, descriptors }
  }

  private async authenticate(
    context: AccountPipelineContext,
    credentials: { email: string; password: string },
    resources: AccountResources
  ): Promise<StageResult> {
    const login = new LoginController(this.logger)
    resources.desktop = await this.browser.openSlot(context.accountId, 'web-desktop')
    resources.desktopClient = new DashboardClient(
      resources.desktop.context,
      resources.desktop.page,
      this.logger,
      context.runId,
      `account-${String(context.runAccountIndex)}`,
      (observation) => {
        this.runLedger?.balance(
          context.runId,
          context.accountId,
          'live',
          observation.availablePoints
        )
      }
    )
    await resources.desktop.page.goto(REWARDS_URLS.dashboard, {
      waitUntil: 'domcontentloaded',
      timeout: 30_000
    })
    await login.login(resources.desktop.page, credentials, context.signal)
    const desktopObservation = await this.verifyBrowserSession(
      resources.desktop,
      resources.desktopClient,
      login,
      credentials,
      context.signal
    )
    if (desktopObservation) resources.verifiedObservation = desktopObservation
    else delete resources.verifiedObservation
    await resources.desktop.commitVerified()

    const needsMobile =
      this.config.tasks.mobileSearch ||
      this.config.tasks.appActivities ||
      this.config.tasks.appCheckIn ||
      this.config.tasks.readToEarn
    if (!needsMobile) return { status: 'completed' }

    try {
      resources.mobile = await this.browser.openSlot(context.accountId, 'web-mobile')
      resources.mobileClient = new DashboardClient(
        resources.mobile.context,
        resources.mobile.page,
        this.logger,
        context.runId,
        `account-${String(context.runAccountIndex)}`,
        (observation) => {
          this.runLedger?.balance(
            context.runId,
            context.accountId,
            'live',
            observation.availablePoints
          )
        }
      )
      await resources.mobile.page.goto(REWARDS_URLS.dashboard, {
        waitUntil: 'domcontentloaded',
        timeout: 30_000
      })
      await login.login(resources.mobile.page, credentials, context.signal)
      await this.verifyBrowserSession(
        resources.mobile,
        resources.mobileClient,
        login,
        credentials,
        context.signal
      )
      await resources.mobile.commitVerified()

      const oauth = new AppOAuthClient(
        resources.mobile.context,
        resources.mobile.page,
        this.sessions,
        this.logger,
        login,
        context.runId,
        `account-${String(context.runAccountIndex)}`
      )
      resources.appToken =
        (await oauth.readStored(context.accountId)) ??
        (await oauth.acquire(context.accountId, credentials, context.signal))
      resources.appObservation = await resources.mobileClient.fetchAppDashboard(
        resources.appToken.accessToken
      )
      await oauth.commitVerified(context.accountId, resources.appToken)
      return { status: 'completed' }
    } catch (error) {
      return {
        status:
          error instanceof LoginStateError && requiresUserAction(error.loginState)
            ? 'action-required'
            : 'partial',
        failureStage: error instanceof LoginStateError ? error.loginStage : 'app-oauth',
        message: error instanceof Error ? error.message : '移动认证未确认'
      }
    }
  }

  private async verifyBrowserSession(
    slot: AccountBrowserSlot,
    client: DashboardClient,
    login: LoginController,
    credentials: { email: string; password: string },
    signal: AbortSignal
  ): Promise<RewardsObservation | undefined> {
    const discovery = new RewardsDiscoveryService()
    let verified = await discovery.verifyAuthenticated(client, signal)
    if (!verified.verification.valid) {
      await slot.page.goto(REWARDS_URLS.bingSignIn, {
        waitUntil: 'domcontentloaded',
        timeout: 30_000
      })
      await login.login(slot.page, credentials, signal)
      verified = await discovery.verifyAuthenticated(client, signal)
    }
    if (!verified.verification.valid) {
      throw new LoginStateError({
        loginState: 'unknown',
        loginStage:
          verified.verification.failedStage === 'bing'
            ? 'bing-session-error'
            : 'login-verification',
        message: verified.verification.reason ?? '登录验证失败',
        ...safeLocation(slot.page.url())
      })
    }
    return verified.observation
  }
}

function safeLocation(raw: string): { url: string; host: string; path: string } {
  try {
    const url = new URL(raw)
    return { url: `${url.origin}${url.pathname}`, host: url.hostname, path: url.pathname }
  } catch {
    return { url: '[invalid-url]', host: '', path: '' }
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
  return signal.reason instanceof Error ? signal.reason : new Error('run-aborted')
}
