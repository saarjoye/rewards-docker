import type { BrowserContext } from 'patchright'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DashboardClient } from '../src/browser/DashboardClient.js'
import { createEvidence } from '../src/domain/Evidence.js'
import type { TaskRecord } from '../src/domain/Task.js'
import { DEFAULT_CONFIG } from '../src/infra/Config.js'
import { SqliteStore } from '../src/infra/SqliteStore.js'
import type { StructuredLogger } from '../src/infra/StructuredLogger.js'
import { RewardsTaskExecutor } from '../src/rewards/RewardsTaskExecutor.js'
import type {
  DiscoveryOutput,
  TaskExecutionDescriptor
} from '../src/rewards/RewardsDiscoveryService.js'
import type { RewardOffer } from '../src/rewards/RewardsModel.js'
import type { VerificationResult } from '../src/rewards/TaskAdapter.js'
import { taskFailure } from '../src/domain/Presentation.js'

const stores: SqliteStore[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  vi.useRealTimers()
})
const pointEvidence = createEvidence({
  source: 'rsc',
  availability: 'valid',
  confidence: 1,
  value: 100,
  observedAt: '2026-10-02T00:00:00Z'
})
function fixture(source: RewardOffer['source'] = 'rsc') {
  const store = new SqliteStore(':memory:')
  stores.push(store)
  const offer: RewardOffer = {
    sourceTaskId: 'synthetic-offer',
    type: 'more-promotion',
    source,
    displayName: 'Synthetic card',
    complete: false,
    completed: 0,
    total: 1,
    executable: true,
    destinationUrl: 'https://www.bing.com/search?q=synthetic'
  }
  const task: TaskRecord = {
    taskId: 'synthetic-account:day:offer',
    accountId: 'synthetic-account',
    localDate: '2026-10-02',
    sourceTaskId: offer.sourceTaskId,
    type: offer.type,
    source,
    displayName: offer.displayName,
    executable: true,
    required: false,
    status: 'discovered',
    progress: { completed: 0, total: 1 },
    updatedAt: '2026-10-02T00:00:00Z'
  }
  const observation = (offers: readonly RewardOffer[]) => ({
    offers,
    availablePoints: pointEvidence
  })
  const bootstrapRsc = vi.fn().mockResolvedValue(observation([offer]))
  const fetchFlyout = vi.fn().mockResolvedValue({ ...observation([offer]), source })
  const navigateOffer = vi.fn().mockResolvedValue(undefined)
  const readClaimablePoints = vi.fn().mockResolvedValue(0)
  const client = {
    bootstrapRsc,
    fetchFlyout,
    navigateOffer,
    readClaimablePoints
  } as unknown as DashboardClient
  const guardDate = vi.fn()
  const executor = new RewardsTaskExecutor(
    {} as BrowserContext,
    client,
    store,
    { write: vi.fn() } as unknown as StructuredLogger,
    DEFAULT_CONFIG,
    'synthetic-run',
    'account-1',
    undefined,
    store,
    guardDate
  )
  const descriptor: TaskExecutionDescriptor = { task, offer }
  const verify = (signal = new AbortController().signal) =>
    (
      executor as unknown as {
        verifyTask(input: TaskExecutionDescriptor, signal: AbortSignal): Promise<VerificationResult>
      }
    ).verifyTask(descriptor, signal)
  const snapshot = {
    offers: [offer],
    availablePoints: pointEvidence,
    rewardsUser: pointEvidence,
    market: pointEvidence,
    pcSearch: pointEvidence,
    mobileSearch: pointEvidence,
    actionIds: {}
  } as unknown as DiscoveryOutput['snapshot']
  const discovery: DiscoveryOutput = {
    snapshot,
    tasks: [task],
    descriptors: new Map([[task.taskId, descriptor]]),
    dataSources: { rsc: true, dom: false, dashboard: true, flyout: true, 'app-dashboard': false }
  }
  return {
    store,
    task,
    offer,
    descriptor,
    executor,
    verify,
    observation,
    bootstrapRsc,
    fetchFlyout,
    navigateOffer,
    readClaimablePoints,
    guardDate,
    discovery
  }
}
async function settle<T>(promise: Promise<T>): Promise<T> {
  await vi.advanceTimersByTimeAsync(1_100)
  return promise
}

describe('bounded official task verification', () => {
  it.each(['rsc', 'bing-flyout'] as const)(
    'observes delayed %s completion without resubmitting',
    async (source) => {
      vi.useFakeTimers()
      const f = fixture(source)
      const read = source === 'rsc' ? f.bootstrapRsc : f.fetchFlyout
      read.mockResolvedValueOnce({ ...f.observation([f.offer]), source }).mockResolvedValue({
        ...f.observation([{ ...f.offer, complete: true, completed: 1 }]),
        source
      })
      expect(await settle(f.verify())).toMatchObject({
        confirmed: true,
        progress: { completed: 1, total: 1 }
      })
      expect(read).toHaveBeenCalledTimes(2)
      expect(f.navigateOffer).not.toHaveBeenCalled()
    }
  )

  it('keeps stable incomplete progress pending after at most three read-only observations', async () => {
    vi.useFakeTimers()
    const f = fixture()
    expect(await settle(f.verify())).toMatchObject({
      confirmed: false,
      failureCode: 'task-still-incomplete'
    })
    expect(f.bootstrapRsc).toHaveBeenCalledTimes(3)
  })

  it('does not infer completion from a missing task', async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.bootstrapRsc.mockResolvedValue(f.observation([]))
    expect(await settle(f.verify())).toMatchObject({
      confirmed: false,
      failureCode: 'task-not-found-during-verification'
    })
    expect(f.bootstrapRsc).toHaveBeenCalledTimes(3)
  })

  it('does not accept a completed task from a different source or a duplicate ID', async () => {
    for (const offers of [
      [{ ...fixture().offer, source: 'bing-flyout' as const, complete: true }],
      [fixture().offer, { ...fixture().offer, complete: true }]
    ]) {
      const f = fixture()
      f.bootstrapRsc.mockResolvedValue(f.observation(offers))
      expect(await f.verify()).toMatchObject({
        confirmed: false,
        failureCode: 'task-verification-source-mismatch'
      })
      expect(f.bootstrapRsc).toHaveBeenCalledTimes(1)
    }
  })

  it('keeps legacy-discovered tasks compatible with matching official RSC completion', async () => {
    const f = fixture()
    f.descriptor.task = { ...f.task, source: 'legacy-getuserinfo' }
    f.descriptor.offer = { ...f.offer, source: 'legacy-getuserinfo' }
    f.bootstrapRsc.mockResolvedValue(f.observation([{ ...f.offer, complete: true, completed: 1 }]))
    expect(await f.verify()).toMatchObject({
      confirmed: true,
      progress: { completed: 1, total: 1 }
    })
    expect(f.bootstrapRsc).toHaveBeenCalledTimes(1)
    expect(f.navigateOffer).not.toHaveBeenCalled()
  })

  it('does not confirm a different task type that happens to reuse the same ID', async () => {
    const f = fixture()
    f.bootstrapRsc.mockResolvedValue(
      f.observation([{ ...f.offer, type: 'daily-set', complete: true, completed: 1 }])
    )
    expect(await f.verify()).toMatchObject({
      confirmed: false,
      failureCode: 'task-verification-source-mismatch'
    })
    expect(f.bootstrapRsc).toHaveBeenCalledTimes(1)
  })

  it('classifies read timeouts without saving raw error text or retrying failed reads', async () => {
    const f = fixture()
    const error = new Error('https://example.test/?code=synthetic-secret')
    error.name = 'TimeoutError'
    f.bootstrapRsc.mockRejectedValue(error)
    const result = await f.verify()
    expect(result).toMatchObject({ confirmed: false, failureCode: 'task-verification-timeout' })
    expect(JSON.stringify(result)).not.toContain('synthetic-secret')
    expect(f.bootstrapRsc).toHaveBeenCalledTimes(1)
  })

  it('keeps an unavailable flyout distinct from a missing original task', async () => {
    const f = fixture('bing-flyout')
    f.fetchFlyout.mockResolvedValue(undefined)
    expect(await f.verify()).toMatchObject({
      confirmed: false,
      failureCode: 'task-verification-unavailable'
    })
    expect(f.fetchFlyout).toHaveBeenCalledTimes(1)
  })

  it('stops without another read on cancellation during the observation delay', async () => {
    vi.useFakeTimers()
    const f = fixture()
    const abort = new AbortController()
    const running = f.verify(abort.signal).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(1)
    abort.abort(new Error('synthetic-cancelled'))
    await vi.advanceTimersByTimeAsync(1_100)
    expect(await running).toMatchObject({ message: 'synthetic-cancelled' })
    expect(f.bootstrapRsc).toHaveBeenCalledTimes(1)
  })

  it('never confirms a task across the local date boundary', async () => {
    const f = fixture()
    f.guardDate.mockImplementation(() => {
      throw new Error('synthetic-midnight')
    })
    expect(await f.verify()).toMatchObject({
      confirmed: false,
      failureCode: 'task-verification-date-changed'
    })
    expect(f.bootstrapRsc).not.toHaveBeenCalled()
  })

  it('shares a fixed deadline across all observations instead of extending the budget', async () => {
    vi.useFakeTimers()
    const f = fixture()
    const start = Date.now()
    await settle(f.verify())
    const deadlines = f.bootstrapRsc.mock.calls.map((args) => args[1] as number)
    expect(deadlines).toEqual([start + 90_000, start + 90_000, start + 90_000])
  })

  it('does not confirm completion if the business date changes during the read', async () => {
    const f = fixture()
    f.bootstrapRsc.mockImplementation(() => {
      f.guardDate.mockImplementation(() => {
        throw new Error('synthetic-midnight')
      })
      return Promise.resolve(f.observation([{ ...f.offer, complete: true, completed: 1 }]))
    })
    expect(await f.verify()).toMatchObject({
      confirmed: false,
      failureCode: 'task-verification-date-changed'
    })
  })

  it('does not continue observing after the first read consumes the available deadline', async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.bootstrapRsc.mockImplementation(() => {
      vi.setSystemTime(Date.now() + 90_000)
      return Promise.resolve(f.observation([f.offer]))
    })
    expect(await f.verify()).toMatchObject({ confirmed: false })
    expect(f.bootstrapRsc).toHaveBeenCalledTimes(1)
  })

  it('persists the safe failure reason and never resends a pending mutation in another execution', async () => {
    vi.useFakeTimers()
    const f = fixture()
    const input = {
      discovery: f.discovery,
      types: ['more-promotion'] as const,
      mode: 'mutating' as const,
      signal: new AbortController().signal
    }
    await settle(f.executor.executeTypes(input))
    expect(f.store.getTask(f.task.taskId)).toMatchObject({
      status: 'verification-pending',
      reason: 'task-still-incomplete'
    })
    await settle(f.executor.executeTypes(input))
    expect(f.navigateOffer).toHaveBeenCalledTimes(1)
    expect(f.store.getMutationState(f.task.taskId)).toBe('verification-pending')
  })

  it('recovers an existing pending mutation by verification only, without calling its execute adapter', async () => {
    const f = fixture()
    f.store.beginMutation(f.task.taskId)
    f.store.updateMutation(f.task.taskId, 'verification-pending')
    f.bootstrapRsc.mockResolvedValue(f.observation([{ ...f.offer, complete: true, completed: 1 }]))
    const result = await f.executor.executeTypes({
      discovery: f.discovery,
      types: ['more-promotion'],
      mode: 'mutating',
      signal: new AbortController().signal
    })
    expect(result).toMatchObject({ status: 'completed', tasks: [{ status: 'completed' }] })
    expect(f.store.getTask(f.task.taskId)?.reason).toBeUndefined()
    expect(f.store.getMutationState(f.task.taskId)).toBe('verified')
    expect(f.navigateOffer).not.toHaveBeenCalled()
    expect(f.bootstrapRsc).toHaveBeenCalledTimes(1)
  })

  it('preserves explicit-zero claim verification and shows safe detailed failure labels', async () => {
    const f = fixture()
    f.descriptor.task = { ...f.task, type: 'claim-bonus-points' }
    expect(await f.verify()).toMatchObject({
      confirmed: true,
      progress: { completed: 1, total: 1 }
    })
    expect(f.readClaimablePoints).toHaveBeenCalledTimes(1)
    expect(taskFailure('task-still-incomplete').failureLabel).toBe('已执行，官方进度仍未完成')
  })
})
