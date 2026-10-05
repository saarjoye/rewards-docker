import { verifyLogin, type LoginVerificationResult } from '../auth/LoginVerification.js'
import { createEvidence, selectTrustedEvidence, type FieldEvidence } from '../domain/Evidence.js'
import { createTaskId, type QuestTaskContext, type TaskRecord } from '../domain/Task.js'
import { DashboardClient } from '../browser/DashboardClient.js'
import { sameOfferUrl } from '../browser/OfferMatching.js'
import { TaskRegistry } from './TaskRegistry.js'
import type {
  RewardOffer,
  RewardsDiscoverySnapshot,
  RewardsObservation,
  SearchQuota
} from './RewardsModel.js'

export interface TaskExecutionDescriptor {
  task: TaskRecord
  offer?: RewardOffer
  claimablePoints?: number
  quest?: QuestTaskContext
}

export interface DiscoveryOutput {
  snapshot: RewardsDiscoverySnapshot
  tasks: readonly TaskRecord[]
  descriptors: ReadonlyMap<string, TaskExecutionDescriptor>
  dataSources: Readonly<Record<'rsc' | 'dom' | 'dashboard' | 'flyout' | 'app-dashboard', boolean>>
}

function unknownEvidence<T>(field: string): FieldEvidence<T> {
  return createEvidence({
    availability: 'unknown',
    source: 'browser-response',
    confidence: 0,
    observedAt: new Date().toISOString(),
    reason: `${field} unavailable from all sources`
  })
}

/** Groups are ordered by authority; verification and action metadata stay in one observation. */
function mergeOffers(
  groups: readonly (readonly RewardOffer[])[],
  domOffers: readonly RewardOffer[]
): RewardOffer[] {
  const offers = new Map<string, RewardOffer>()
  for (const group of groups) {
    for (const incoming of group) {
      if (!offers.has(incoming.sourceTaskId)) offers.set(incoming.sourceTaskId, incoming)
    }
  }
  return [...offers.values()].map((offer) => {
    if (
      offer.source !== 'rsc' ||
      offer.identityStable === false ||
      !offer.executable ||
      offer.destinationUrl
    )
      return offer

    // Keep the existing DOM destination fallback, but never let it enable a
    // disabled task, overwrite progress/type, or provide Server Action metadata.
    const matches = domOffers.filter((candidate) => candidate.sourceTaskId === offer.sourceTaskId)
    const dom = matches[0]
    if (
      matches.length !== 1 ||
      !dom ||
      dom.source !== offer.source ||
      dom.type !== offer.type ||
      dom.identityStable !== true ||
      !dom.destinationUrl ||
      !sameOfferUrl(dom.destinationUrl, dom.destinationUrl)
    )
      return offer

    return { ...offer, destinationUrl: dom.destinationUrl }
  })
}

const APP_DASHBOARD_TASK_TYPES = new Set<RewardOffer['type']>([
  'app-activity',
  'app-check-in',
  'read-to-earn'
])

function taskOffers(observation: RewardsObservation): readonly RewardOffer[] {
  if (observation.source !== 'app-dashboard') return observation.offers
  return observation.offers.filter((offer) => APP_DASHBOARD_TASK_TYPES.has(offer.type))
}

function hasValidProfile(
  observations: readonly RewardsObservation[],
  bootstrapPoints: FieldEvidence<number>
): boolean {
  const hasValid = (field: 'market' | 'pcSearch'): boolean =>
    observations.some((observation) => observation[field].availability === 'valid')
  const hasRewardsIdentity = observations.some(
    (observation) =>
      observation.rewardsUser.availability === 'valid' && observation.rewardsUser.value === true
  )
  const hasPoints =
    bootstrapPoints.availability === 'valid' ||
    observations.some((observation) => observation.availablePoints.availability === 'valid')
  return hasPoints && hasRewardsIdentity && hasValid('market') && hasValid('pcSearch')
}

function abortReason(signal: AbortSignal | undefined): Error {
  const reason = signal?.reason as unknown
  return reason instanceof Error ? reason : new Error('Operation was aborted')
}

async function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (milliseconds <= 0) return
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort)
      resolve()
    }, milliseconds)
    const abort = (): void => {
      clearTimeout(timer)
      reject(abortReason(signal))
    }
    signal?.addEventListener('abort', abort, { once: true })
  })
}

export class RewardsDiscoveryService {
  private readonly registry = new TaskRegistry()

  async verifyAuthenticated(
    client: DashboardClient,
    signal?: AbortSignal
  ): Promise<{
    verification: LoginVerificationResult
    observation?: RewardsObservation
  }> {
    const deadline = Date.now() + 45_000
    let flyout: RewardsObservation | undefined
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      flyout = await client.fetchFlyout(deadline, signal)
      if (flyout?.rewardsUser.availability === 'valid' && flyout.rewardsUser.value === true) break
      if (attempt < 3) await delay(attempt * 750, signal)
    }
    const flyoutConfirmsProfile =
      flyout?.rewardsUser.availability === 'valid' &&
      flyout.rewardsUser.value === true &&
      flyout.availablePoints.availability === 'valid'
    const dashboard = flyoutConfirmsProfile
      ? undefined
      : await client.fetchDashboard(signal, deadline).catch(() => undefined)
    const profile = dashboard ?? flyout
    const bingIdentity = flyout?.rewardsUser
    const rewardsProfile = profile?.availablePoints
    const verification = verifyLogin({
      microsoftAuthenticated: true,
      bingIdentity:
        bingIdentity?.availability === 'valid' && bingIdentity.value !== undefined
          ? createEvidence({
              ...bingIdentity,
              value: { rewardsUser: bingIdentity.value }
            })
          : createEvidence({
              availability: 'missing',
              source: 'bing-flyout',
              confidence: 0,
              observedAt: new Date().toISOString(),
              reason: 'Bing flyout did not confirm Rewards membership'
            }),
      rewardsProfile:
        rewardsProfile?.availability === 'valid' && rewardsProfile.value !== undefined
          ? createEvidence({
              ...rewardsProfile,
              value: { availablePoints: rewardsProfile.value }
            })
          : createEvidence({
              availability: 'missing',
              source: 'browser-response',
              confidence: 0,
              observedAt: new Date().toISOString(),
              reason: 'Rewards balance was not confirmed'
            })
    })
    return { verification, ...(profile === undefined ? {} : { observation: profile }) }
  }

  async discover(input: {
    accountId: string
    localDate: string
    client: DashboardClient
    initialObservation?: RewardsObservation
    appObservation?: RewardsObservation
    punchCards?: boolean
    knownQuestTasks?: readonly TaskRecord[]
    signal?: AbortSignal
  }): Promise<DiscoveryOutput> {
    const deadline = Date.now() + 90_000
    const bootstrap = await input.client.bootstrapRsc(input.signal, deadline)
    const domOffers =
      bootstrap.domOffers ?? (await input.client.discoverDomOffers(input.signal, deadline))
    const observations: RewardsObservation[] = input.initialObservation
      ? [input.initialObservation]
      : []
    if (input.appObservation) observations.push(input.appObservation)
    let flyout = observations.find((observation) => observation.source === 'bing-flyout')
    if (!flyout) flyout = await input.client.fetchFlyout(deadline, input.signal)
    if (flyout && !observations.includes(flyout)) observations.push(flyout)
    const dashboard = hasValidProfile(observations, bootstrap.availablePoints)
      ? undefined
      : await input.client.fetchDashboard(input.signal, deadline).catch(() => undefined)
    if (dashboard) observations.push(dashboard)

    const availablePoints =
      selectTrustedEvidence(observations.map((item) => item.availablePoints)) ??
      (bootstrap.availablePoints.availability === 'valid'
        ? bootstrap.availablePoints
        : unknownEvidence<number>('availablePoints'))
    const rewardsUser =
      selectTrustedEvidence(observations.map((item) => item.rewardsUser)) ??
      unknownEvidence<boolean>('rewardsUser')
    const marketCandidates = observations
      .filter((item) => item.source === 'bing-flyout' || item.source === 'legacy-getuserinfo')
      .map((item) => item.market)
    const market =
      selectTrustedEvidence(marketCandidates) ?? this.bestUnavailable(marketCandidates, 'market')
    const pcSearch =
      selectTrustedEvidence(observations.map((item) => item.pcSearch)) ??
      this.bestUnavailable(
        observations.map((item) => item.pcSearch),
        'pcSearch'
      )
    const mobileSearch =
      selectTrustedEvidence(observations.map((item) => item.mobileSearch)) ??
      this.bestUnavailable(
        observations.map((item) => item.mobileSearch),
        'mobileSearch'
      )
    // Flight owns RSC verification. Without Flight, prefer the independently
    // re-observable flyout over DOM rows, which also label themselves as RSC.
    let offers = mergeOffers(
      [
        bootstrap.offers,
        ...(flyout ? [taskOffers(flyout)] : []),
        ...observations.filter((item) => item !== flyout).map(taskOffers),
        domOffers
      ],
      domOffers
    )
    if (input.punchCards) {
      const parents = new Set(
        offers
          .filter((offer) => offer.type === 'punch-card' && /_pcparent_/i.test(offer.sourceTaskId))
          .map((offer) => offer.sourceTaskId)
      )
      offers = offers.map((offer) =>
        parents.has(offer.sourceTaskId) ? { ...offer, isGroup: true, executable: false } : offer
      )
      for (const task of input.knownQuestTasks ?? []) {
        if (task.accountId === input.accountId && task.localDate <= input.localDate && task.quest)
          parents.add(task.quest.parentOfferId)
      }
      for (const parentOfferId of parents) {
        input.signal?.throwIfAborted()
        if (Date.now() >= deadline) break
        try {
          const detail = await input.client.readQuest(parentOfferId, input.signal, deadline)
          input.signal?.throwIfAborted()
          if (detail.parentOfferId !== parentOfferId) continue
          const ids = new Set(detail.offers.map((offer) => offer.sourceTaskId))
          offers = [...offers.filter((offer) => !ids.has(offer.sourceTaskId)), ...detail.offers]
        } catch (error) {
          if (input.signal?.aborted) throw error
          // Failure of one detail page must not interrupt normal card discovery.
        }
      }
    }
    const snapshot: RewardsDiscoverySnapshot = {
      rewardsUser,
      market,
      availablePoints,
      pcSearch,
      mobileSearch,
      offers,
      actionIds: bootstrap.actionIds,
      ...(bootstrap.deploymentId === undefined ? {} : { deploymentId: bootstrap.deploymentId }),
      ...(bootstrap.routerStateTree === undefined
        ? {}
        : { routerStateTree: bootstrap.routerStateTree })
    }

    const descriptors = new Map<string, TaskExecutionDescriptor>()
    for (const offer of offers) {
      const classified = this.registry.classify({
        accountId: input.accountId,
        localDate: input.localDate,
        sourceTaskId: offer.sourceTaskId,
        sourceType: offer.type,
        source: offer.source,
        displayName: offer.displayName,
        completed: offer.completed,
        total: offer.total,
        alreadyComplete: offer.complete
      })
      const task: TaskRecord = {
        ...classified,
        ...(offer.identityStable === undefined ? {} : { identityStable: offer.identityStable }),
        ...(offer.expectedPoints === undefined ? {} : { expectedPoints: offer.expectedPoints }),
        executable:
          classified.executable &&
          offer.executable &&
          !(offer.total === 0 && offer.isPromotional === true),
        ...(offer.total === 0 && offer.isPromotional === true
          ? { status: 'skipped', reason: '推广卡片明确标记为零积分' }
          : {}),
        ...(offer.quest ? { quest: offer.quest } : {}),
        ...(!offer.complete && !offer.executable
          ? offer.source === 'app-dashboard' && offer.attributes?.hidden?.toLowerCase() === 'true'
            ? { status: 'skipped', reason: 'App 数据源标记为隐藏' }
            : { status: 'unknown', reason: '任务存在，但缺少可验证的执行元数据' }
          : {})
      }
      if (!offer.complete && offer.isGroup) {
        task.status = 'skipped'
        task.reason = '任务包入口：全部子任务完成后由官方确认整包奖励'
      } else if (!offer.complete && offer.quest && offer.locked) {
        task.status = 'skipped'
        task.reason = '任务包子任务尚未解锁：上一项完成后至少等待 24 小时，以官方状态为准'
      } else if (!offer.complete && offer.restrictionReason) {
        task.status = 'unknown'
        task.reason = offer.restrictionReason
      }
      descriptors.set(task.taskId, {
        task,
        offer,
        ...(offer.quest ? { quest: offer.quest } : {})
      })
    }

    // Keep submitted child identities across dates: a new daily ID must never resend an action.
    if (input.punchCards) {
      for (const known of input.knownQuestTasks ?? []) {
        if (
          known.accountId !== input.accountId ||
          known.localDate > input.localDate ||
          known.type !== 'punch-card' ||
          !known.quest ||
          !['running', 'submitted', 'verification-pending', 'completed'].includes(known.status)
        )
          continue
        const current = descriptors.get(
          createTaskId(input.accountId, input.localDate, known.sourceTaskId)
        )
        if (!current) {
          // Completed Links may disappear. Older completions only locate the package, not today's tasks.
          if (known.localDate === input.localDate || known.status !== 'completed') {
            descriptors.set(known.taskId, {
              task: { ...known, executable: false },
              quest: known.quest
            })
          }
          continue
        }
        const sameIdentity =
          current.quest?.parentOfferId === known.quest.parentOfferId &&
          current.quest.title === known.quest.title &&
          current.quest.ariaLabel === known.quest.ariaLabel
        const confirmed = sameIdentity && current.task.status === 'completed'
        descriptors.delete(current.task.taskId)
        descriptors.set(known.taskId, {
          ...current,
          quest: known.quest,
          task: {
            ...known,
            executable: false,
            updatedAt: current.task.updatedAt,
            ...(confirmed
              ? { status: 'completed' as const, progress: current.task.progress }
              : {
                  status: 'verification-pending' as const,
                  reason: '已有任务包动作尚未被官方确认，保留原日期身份并仅只读复核'
                })
          }
        })
      }
    }

    for (const type of [
      'daily-set',
      'special-promotion',
      'more-promotion',
      'punch-card',
      'app-activity',
      'app-check-in',
      'read-to-earn'
    ] as const) {
      if ([...descriptors.values()].some(({ task }) => task.type === type)) continue
      const appType = ['app-activity', 'app-check-in', 'read-to-earn'].includes(type)
      const sourceAvailable = appType ? input.appObservation !== undefined : true
      const taskId = createTaskId(input.accountId, input.localDate, `category-${type}`)
      const task: TaskRecord = {
        taskId,
        accountId: input.accountId,
        localDate: input.localDate,
        sourceTaskId: `category-${type}`,
        type,
        source: appType ? 'app-dashboard' : 'rsc',
        displayName: this.categoryName(type),
        executable: false,
        required: type === 'daily-set',
        status: sourceAvailable ? 'skipped' : 'unknown',
        progress: { completed: 0, total: 0 },
        reason: sourceAvailable ? '当前账号未发现该类任务' : '对应数据源未确认',
        updatedAt: new Date().toISOString()
      }
      descriptors.set(taskId, { task })
    }

    this.addSearchTask(descriptors, input.accountId, input.localDate, 'pc-search', pcSearch)
    this.addSearchTask(descriptors, input.accountId, input.localDate, 'mobile-search', mobileSearch)
    const claimablePoints = await input.client
      .readClaimablePoints(input.signal)
      .catch((error: unknown) => {
        if (input.signal?.aborted) throw error
        return undefined
      })
    this.addClaimTask(descriptors, input.accountId, input.localDate, claimablePoints)

    return {
      snapshot,
      tasks: [...descriptors.values()].map(({ task }) => task),
      descriptors,
      dataSources: {
        rsc: true,
        dom: true,
        dashboard: dashboard !== undefined,
        flyout: flyout !== undefined,
        'app-dashboard': input.appObservation !== undefined
      }
    }
  }

  private bestUnavailable<T>(
    candidates: readonly FieldEvidence<T>[],
    field: string
  ): FieldEvidence<T> {
    return (
      candidates.find((item) => item.availability !== 'missing') ??
      candidates[0] ??
      unknownEvidence<T>(field)
    )
  }

  private addSearchTask(
    descriptors: Map<string, TaskExecutionDescriptor>,
    accountId: string,
    localDate: string,
    type: 'pc-search' | 'mobile-search',
    counter: FieldEvidence<SearchQuota>
  ): void {
    const taskId = createTaskId(accountId, localDate, type)
    const value = counter.value
    const valid = counter.availability === 'valid' && value !== undefined
    const task: TaskRecord = {
      taskId,
      accountId,
      localDate,
      sourceTaskId: type,
      type,
      source: counter.source,
      displayName: type === 'pc-search' ? 'PC 搜索' : '移动搜索',
      executable: valid,
      required: type === 'pc-search',
      status: valid ? (value.remaining === 0 ? 'completed' : 'discovered') : 'unknown',
      progress: valid
        ? { completed: value.completed, total: value.total }
        : { completed: 0, total: null },
      ...(!valid ? { reason: counter.reason ?? `${type} counter 未确认` } : {}),
      updatedAt: new Date().toISOString()
    }
    descriptors.set(taskId, { task })
  }

  private addClaimTask(
    descriptors: Map<string, TaskExecutionDescriptor>,
    accountId: string,
    localDate: string,
    claimablePoints: number | undefined
  ): void {
    const taskId = createTaskId(accountId, localDate, 'claim-bonus-points')
    const known = claimablePoints !== undefined
    const task: TaskRecord = {
      taskId,
      accountId,
      localDate,
      sourceTaskId: 'claim-bonus-points',
      type: 'claim-bonus-points',
      source: 'rsc',
      displayName: '领取奖励积分',
      executable: known && claimablePoints > 0,
      required: true,
      status: !known ? 'unknown' : claimablePoints === 0 ? 'skipped' : 'discovered',
      progress: { completed: known && claimablePoints === 0 ? 1 : 0, total: 1 },
      ...(!known ? { reason: '可领取积分未确认' } : {}),
      updatedAt: new Date().toISOString()
    }
    descriptors.set(taskId, { task, ...(known ? { claimablePoints } : {}) })
  }

  private categoryName(type: TaskRecord['type']): string {
    const names: Record<TaskRecord['type'], string> = {
      'claim-bonus-points': '领取奖励积分',
      'app-activity': 'App 活动',
      'daily-set': '每日任务',
      'special-promotion': '特殊活动',
      'more-promotion': '更多推广',
      'app-check-in': '每日签到',
      'read-to-earn': '阅读赚取',
      'punch-card': '打卡活动',
      'mobile-search': '移动搜索',
      'pc-search': 'PC 搜索',
      unknown: '未知任务'
    }
    return names[type]
  }
}
