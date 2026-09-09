import type { DashboardClient } from '../browser/DashboardClient.js'
import type { TaskRecord } from '../domain/Task.js'
import type { DiscoveryOutput } from '../rewards/RewardsDiscoveryService.js'
import type { RewardOffer } from '../rewards/RewardsModel.js'
import { webOfferExecutionPath } from '../rewards/OfferExecution.js'
import type { TaskAdapter, VerificationResult } from '../rewards/TaskAdapter.js'
import { buildRewardsRouterStateTree } from '../rewards/DashboardParser.js'
import { buildReportActivityBody } from '../rewards/ReportActivity.js'
import { createHash } from 'node:crypto'

import { REWARDS_URLS } from '../browser/Urls.js'

export interface ControlledMutationCandidate {
  task: TaskRecord
  offer: RewardOffer
  actionId: string
  deploymentId?: string
  routerStateTree: string
}

export interface ControlledClaimCandidate {
  task: TaskRecord
  claimablePoints: number
  actionId: string
  deploymentId?: string
  routerStateTree: string
}

export interface ControlledClaimUiCandidate {
  task: TaskRecord
  claimablePoints: number
}

export type ControlledExecutionPath =
  | 'report-activity'
  | 'navigate-only'
  | 'claim-server-action'
  | 'claim-ui'

export interface ControlledNavigationCandidate {
  task: TaskRecord
  offer: RewardOffer & { destinationUrl: string }
}

export interface ControlledMutationCandidateSummary {
  taskType: TaskRecord['type']
  source: RewardOffer['source']
  count: number
  activityType: number | 'missing'
  promotional: boolean | 'missing'
  hasDestinationUrl: boolean
  progressTotal: 'missing' | 'zero' | 'positive'
  attributeKeys: readonly string[]
}

export function controlledMutationFingerprint(
  task: Pick<TaskRecord, 'accountId' | 'sourceTaskId'>
) {
  return createHash('sha256').update(`${task.accountId}\0${task.sourceTaskId}`).digest('hex')
}

export function controlledAccountIndex(args: readonly string[], accountCount: number): number {
  const values = args
    .filter((argument) => argument.startsWith('--account-index='))
    .map((argument) => argument.slice('--account-index='.length))
  if (values.length > 1) throw new Error('controlled-account-index-duplicate')
  const value = values[0] ?? '1'
  if (!/^\d+$/.test(value)) throw new Error('controlled-account-index-invalid')
  const index = Number(value)
  if (!Number.isSafeInteger(index) || index < 1 || index > accountCount) {
    throw new Error('controlled-account-index-out-of-range')
  }
  return index
}

export function controlledExecutionPath(args: readonly string[]): ControlledExecutionPath {
  const values = args
    .filter((argument) => argument.startsWith('--execution-path='))
    .map((argument) => argument.slice('--execution-path='.length))
  if (values.length > 1) throw new Error('controlled-execution-path-duplicate')
  const value = values[0] ?? 'report-activity'
  if (
    value !== 'report-activity' &&
    value !== 'navigate-only' &&
    value !== 'claim-server-action' &&
    value !== 'claim-ui'
  ) {
    throw new Error('controlled-execution-path-invalid')
  }
  return value
}

export function controlledTaskType(args: readonly string[]): TaskRecord['type'] | undefined {
  const values = args
    .filter((argument) => argument.startsWith('--task-type='))
    .map((argument) => argument.slice('--task-type='.length))
  if (values.length > 1) throw new Error('controlled-task-type-duplicate')
  const value = values[0]
  if (value === undefined) return undefined
  const supported: readonly TaskRecord['type'][] = [
    'claim-bonus-points',
    'app-activity',
    'daily-set',
    'special-promotion',
    'more-promotion',
    'app-check-in',
    'read-to-earn',
    'punch-card',
    'mobile-search',
    'pc-search',
    'unknown'
  ]
  if (!supported.includes(value as TaskRecord['type'])) {
    throw new Error('controlled-task-type-invalid')
  }
  return value as TaskRecord['type']
}

function claimDescriptor(discovery: DiscoveryOutput, excludedFingerprints: ReadonlySet<string>) {
  return [...discovery.descriptors.values()].find(
    (candidate) =>
      candidate.task.type === 'claim-bonus-points' &&
      candidate.task.status === 'discovered' &&
      candidate.task.executable &&
      candidate.claimablePoints !== undefined &&
      candidate.claimablePoints > 0 &&
      !excludedFingerprints.has(controlledMutationFingerprint(candidate.task))
  )
}

export function selectControlledClaimUiCandidate(
  discovery: DiscoveryOutput,
  excludedFingerprints: ReadonlySet<string> = new Set()
): ControlledClaimUiCandidate | undefined {
  const descriptor = claimDescriptor(discovery, excludedFingerprints)
  if (!descriptor?.claimablePoints) return undefined
  return { task: descriptor.task, claimablePoints: descriptor.claimablePoints }
}

export function selectControlledClaimCandidate(
  discovery: DiscoveryOutput,
  excludedFingerprints: ReadonlySet<string> = new Set()
): ControlledClaimCandidate | undefined {
  const reportClaimAllPoints = actionId(discovery, 'reportClaimAllPoints')
  if (!reportClaimAllPoints) return undefined
  const descriptor = claimDescriptor(discovery, excludedFingerprints)
  if (!descriptor?.claimablePoints) return undefined
  return {
    task: descriptor.task,
    claimablePoints: descriptor.claimablePoints,
    actionId: reportClaimAllPoints,
    routerStateTree: buildRewardsRouterStateTree('earn'),
    ...(discovery.snapshot.deploymentId ? { deploymentId: discovery.snapshot.deploymentId } : {})
  }
}

function actionId(discovery: DiscoveryOutput, name: string): string | undefined {
  const exact = discovery.snapshot.actionIds[name]
  if (exact) return exact
  return Object.entries(discovery.snapshot.actionIds).find(([key]) =>
    key.toLowerCase().includes(name.toLowerCase())
  )?.[1]
}

export function selectControlledMutationCandidate(
  discovery: DiscoveryOutput,
  excludedFingerprints: ReadonlySet<string> = new Set()
): ControlledMutationCandidate | undefined {
  const reportActivity = actionId(discovery, 'reportActivity')
  if (!reportActivity) return undefined
  const candidates = [...discovery.descriptors.values()].filter(
    (descriptor): descriptor is typeof descriptor & { offer: RewardOffer } =>
      descriptor.task.type === 'more-promotion' &&
      descriptor.task.status === 'discovered' &&
      descriptor.task.executable &&
      descriptor.offer !== undefined &&
      webOfferExecutionPath(descriptor.offer, true) === 'report-activity' &&
      !excludedFingerprints.has(controlledMutationFingerprint(descriptor.task)) &&
      Boolean(descriptor.offer.hash)
  )
  const descriptor =
    candidates.find((candidate) => (candidate.task.progress.total ?? 0) > 0) ?? candidates[0]
  if (!descriptor) return undefined
  return {
    task: descriptor.task,
    offer: descriptor.offer,
    actionId: reportActivity,
    routerStateTree: discovery.snapshot.routerStateTree ?? buildRewardsRouterStateTree('dashboard'),
    ...(discovery.snapshot.deploymentId ? { deploymentId: discovery.snapshot.deploymentId } : {})
  }
}

export function selectControlledNavigationCandidate(
  discovery: DiscoveryOutput,
  excludedFingerprints: ReadonlySet<string> = new Set(),
  taskType?: TaskRecord['type']
): ControlledNavigationCandidate | undefined {
  const candidates = [...discovery.descriptors.values()].filter(
    (
      descriptor
    ): descriptor is typeof descriptor & {
      offer: RewardOffer & { destinationUrl: string }
    } =>
      descriptor.task.status === 'discovered' &&
      (taskType === undefined || descriptor.task.type === taskType) &&
      descriptor.task.executable &&
      descriptor.offer !== undefined &&
      descriptor.offer.destinationUrl !== undefined &&
      webOfferExecutionPath(descriptor.offer, true) === 'navigate-only' &&
      !excludedFingerprints.has(controlledMutationFingerprint(descriptor.task))
  )
  const priorities: readonly TaskRecord['type'][] = [
    'more-promotion',
    'special-promotion',
    'daily-set',
    'punch-card'
  ]
  const descriptor = candidates.sort(
    (left, right) => priorities.indexOf(left.task.type) - priorities.indexOf(right.task.type)
  )[0]
  return descriptor ? { task: descriptor.task, offer: descriptor.offer } : undefined
}

export function summarizeControlledMutationCandidates(
  discovery: DiscoveryOutput
): readonly ControlledMutationCandidateSummary[] {
  const groups = new Map<string, ControlledMutationCandidateSummary>()
  for (const descriptor of discovery.descriptors.values()) {
    const offer = descriptor.offer
    if (
      descriptor.task.status !== 'discovered' ||
      !descriptor.task.executable ||
      !offer?.hash ||
      webOfferExecutionPath(offer, true) !== 'report-activity'
    ) {
      continue
    }
    const attributeKeys = Object.keys(offer.attributes ?? {}).sort()
    const progressTotal =
      descriptor.task.progress.total === null
        ? 'missing'
        : descriptor.task.progress.total === 0
          ? 'zero'
          : 'positive'
    const summary: ControlledMutationCandidateSummary = {
      taskType: descriptor.task.type,
      source: offer.source,
      count: 1,
      activityType: offer.activityType ?? 'missing',
      promotional: offer.isPromotional ?? 'missing',
      hasDestinationUrl: offer.destinationUrl !== undefined,
      progressTotal,
      attributeKeys
    }
    const key = JSON.stringify({ ...summary, count: 0 })
    const current = groups.get(key)
    if (current) current.count += 1
    else groups.set(key, summary)
  }
  return [...groups.values()].sort((left, right) => {
    const byType = left.taskType.localeCompare(right.taskType)
    if (byType !== 0) return byType
    return JSON.stringify(left).localeCompare(JSON.stringify(right))
  })
}

export function createControlledMutationAdapter(input: {
  client: DashboardClient
  candidate: ControlledMutationCandidate
  verificationAttempts?: number
  sleep?: (milliseconds: number) => Promise<void>
  onTransportResult?: (result: { status: number; acknowledged: boolean }) => void
}): TaskAdapter {
  const attempts = Math.max(1, Math.min(3, input.verificationAttempts ?? 3))
  const sleep =
    input.sleep ??
    ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)))
  return {
    execute: async ({ signal }) => {
      if (signal.aborted) throw signal.reason
      const offer = input.candidate.offer
      const response = await input.client.reportServerAction({
        actionId: input.candidate.actionId,
        body: buildReportActivityBody(offer),
        url: REWARDS_URLS.dashboard,
        referer: REWARDS_URLS.dashboard,
        routerStateTree: input.candidate.routerStateTree,
        ...(input.candidate.deploymentId ? { deploymentId: input.candidate.deploymentId } : {})
      })
      input.onTransportResult?.(response)
      return { accepted: response.acknowledged, observedAt: new Date().toISOString() }
    },
    verify: async ({ signal }) => {
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        if (signal.aborted) throw signal.reason
        const bootstrap = await input.client.bootstrapRsc(signal)
        const current = bootstrap.offers.find(
          (offer) => offer.sourceTaskId === input.candidate.offer.sourceTaskId
        )
        if (current?.complete) {
          return {
            confirmed: true,
            progress: { completed: current.completed, total: current.total },
            points: bootstrap.availablePoints
          }
        }
        if (attempt < attempts) await sleep(attempt * 1000)
      }
      return {
        confirmed: false,
        progress: input.candidate.task.progress,
        reason: '受控任务提交后尚未从 RSC 确认完成'
      }
    }
  }
}

export function createControlledClaimAdapter(input: {
  client: DashboardClient
  candidate: ControlledClaimCandidate
  verificationAttempts?: number
  sleep?: (milliseconds: number) => Promise<void>
  onTransportResult?: (result: { status: number; acknowledged: boolean }) => void
}): TaskAdapter {
  const attempts = Math.max(1, Math.min(4, input.verificationAttempts ?? 4))
  const sleep =
    input.sleep ??
    ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)))
  return {
    execute: async ({ signal }) => {
      if (signal.aborted) throw signal.reason
      const response = await input.client.reportServerAction({
        actionId: input.candidate.actionId,
        body: [],
        url: REWARDS_URLS.earn,
        referer: REWARDS_URLS.earn,
        routerStateTree: input.candidate.routerStateTree,
        ...(input.candidate.deploymentId ? { deploymentId: input.candidate.deploymentId } : {})
      })
      input.onTransportResult?.(response)
      return { accepted: response.acknowledged, observedAt: new Date().toISOString() }
    },
    verify: ({ signal }) =>
      verifyControlledClaim(input.client, input.candidate.task, attempts, sleep, signal)
  }
}

export function createControlledClaimUiAdapter(input: {
  client: DashboardClient
  candidate: ControlledClaimUiCandidate
  verificationAttempts?: number
  sleep?: (milliseconds: number) => Promise<void>
  onTransportResult?: (result: { status?: number; acknowledged: boolean }) => void
}): TaskAdapter {
  const attempts = Math.max(1, Math.min(4, input.verificationAttempts ?? 4))
  const sleep =
    input.sleep ??
    ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)))
  return {
    execute: async ({ signal }) => {
      if (signal.aborted) throw signal.reason
      const result = await input.client.claimBonusByUiWithResult()
      input.onTransportResult?.({
        ...(result.status === undefined ? {} : { status: result.status }),
        acknowledged: result.acknowledged
      })
      return { accepted: result.acknowledged, observedAt: new Date().toISOString() }
    },
    verify: ({ signal }) =>
      verifyControlledClaim(input.client, input.candidate.task, attempts, sleep, signal)
  }
}

async function verifyControlledClaim(
  client: DashboardClient,
  task: TaskRecord,
  attempts: number,
  sleep: (milliseconds: number) => Promise<void>,
  signal: AbortSignal
): Promise<VerificationResult> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (signal.aborted) throw signal.reason
    const claimablePoints = await client.readClaimablePoints()
    if (claimablePoints === 0) {
      const observation = await client.fetchDashboard(signal)
      return {
        confirmed: true,
        progress: { completed: 1, total: 1 },
        points: observation.availablePoints
      }
    }
    if (attempt < attempts) await sleep(attempt * 5_000)
  }
  return {
    confirmed: false,
    progress: task.progress,
    reason: '领取动作后可领取积分仍未归零'
  }
}

export function createControlledNavigationAdapter(input: {
  client: DashboardClient
  candidate: ControlledNavigationCandidate
  verificationAttempts?: number
  sleep?: (milliseconds: number) => Promise<void>
  onNavigation?: () => void
}): TaskAdapter {
  const attempts = Math.max(1, Math.min(3, input.verificationAttempts ?? 3))
  const sleep =
    input.sleep ??
    ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)))
  return {
    execute: async ({ signal }) => {
      if (signal.aborted) throw signal.reason
      input.onNavigation?.()
      await input.client.navigateOffer(input.candidate.offer.destinationUrl)
      return { accepted: true, observedAt: new Date().toISOString() }
    },
    verify: async ({ signal }) => {
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        if (signal.aborted) throw signal.reason
        const observation =
          input.candidate.offer.source === 'bing-flyout'
            ? await input.client.fetchFlyout(Date.now() + 15_000, signal)
            : await input.client.bootstrapRsc(signal)
        if (!observation) {
          if (attempt < attempts) await sleep(attempt * 1000)
          continue
        }
        const current = observation.offers.find(
          (offer) => offer.sourceTaskId === input.candidate.offer.sourceTaskId
        )
        if (current?.complete) {
          return {
            confirmed: true,
            progress: { completed: current.completed, total: current.total },
            points: observation.availablePoints
          }
        }
        if (attempt < attempts) await sleep(attempt * 1000)
      }
      return {
        confirmed: false,
        progress: input.candidate.task.progress,
        reason: '受控导航后尚未从对应任务数据源确认完成'
      }
    }
  }
}
