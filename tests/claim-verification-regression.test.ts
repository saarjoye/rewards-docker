import type { BrowserContext, Page } from 'patchright'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DashboardClient } from '../src/browser/DashboardClient.js'
import { createEvidence } from '../src/domain/Evidence.js'
import type { TaskRecord } from '../src/domain/Task.js'
import { DEFAULT_CONFIG } from '../src/infra/Config.js'
import { SqliteStore } from '../src/infra/SqliteStore.js'
import type { StructuredLogger } from '../src/infra/StructuredLogger.js'
import type { DiscoveryOutput } from '../src/rewards/RewardsDiscoveryService.js'
import { RewardsTaskExecutor } from '../src/rewards/RewardsTaskExecutor.js'

const stores: SqliteStore[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  vi.useRealTimers()
})

function evidence<T>(value: T) {
  return createEvidence({
    value,
    availability: 'valid',
    source: 'rsc',
    confidence: 1,
    observedAt: '2026-10-02T00:00:00Z'
  })
}

/** Server state and the already-rendered document intentionally remain independent. */
function fixture(input: { pagePoints?: number; serverPoints?: number } = {}) {
  vi.useFakeTimers()
  const store = new SqliteStore(':memory:')
  stores.push(store)
  let pagePoints: number | undefined = input.pagePoints ?? 30
  let serverPoints: number | undefined = input.serverPoints ?? 0
  let currentUrl = 'https://rewards.bing.com/earn'
  const buttons = {
    evaluateAll: vi.fn(() =>
      Promise.resolve(
        pagePoints === undefined
          ? []
          : [
              {
                index: 0,
                texts: [`Claim ${String(pagePoints)} points`],
                contextTexts: [],
                expanded: null,
                controls: null,
                disabled: false,
                visible: true
              }
            ]
      )
    )
  }
  const goto = vi.fn((url: string) => {
    currentUrl = url
    pagePoints = serverPoints
    return Promise.resolve(null)
  })
  // Raw Server Action fetch returns a receipt; it does not replace the rendered document.
  const evaluate = vi.fn().mockResolvedValue({ status: 200, ok: true, text: '1:true\n' })
  const page = {
    url: () => currentUrl,
    goto,
    evaluate,
    locator: vi.fn().mockReturnValue(buttons),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined)
  }
  const logger = { write: vi.fn() } as unknown as StructuredLogger
  const client = new DashboardClient(
    {} as BrowserContext,
    page as unknown as Page,
    logger,
    'synthetic-run',
    'synthetic-account'
  )
  vi.spyOn(client, 'fetchDashboard').mockResolvedValue({
    source: 'rsc',
    rewardsUser: evidence(true),
    market: evidence('CN'),
    availablePoints: evidence(130),
    pcSearch: evidence({ completed: 0, total: 0, remaining: 0 }),
    mobileSearch: evidence({ completed: 0, total: 0, remaining: 0 }),
    offers: [],
    topLevelFields: []
  })
  const task: TaskRecord = {
    taskId: 'synthetic-account:2026-10-02:claim-bonus-points',
    accountId: 'synthetic-account',
    localDate: '2026-10-02',
    sourceTaskId: 'claim-bonus-points',
    type: 'claim-bonus-points',
    source: 'rsc',
    displayName: '领取奖励积分',
    executable: true,
    required: true,
    status: 'discovered',
    progress: { completed: 0, total: 1 },
    updatedAt: '2026-10-02T00:00:00Z'
  }
  const discovery: DiscoveryOutput = {
    snapshot: {
      rewardsUser: evidence(true),
      market: evidence('CN'),
      availablePoints: evidence(100),
      pcSearch: evidence({ completed: 0, total: 0, remaining: 0 }),
      mobileSearch: evidence({ completed: 0, total: 0, remaining: 0 }),
      offers: [],
      actionIds: { reportClaimAllPoints: 'synthetic-claim-action' }
    },
    tasks: [task],
    descriptors: new Map([[task.taskId, { task, claimablePoints: 30 }]]),
    dataSources: { rsc: true, dom: false, dashboard: true, flyout: false, 'app-dashboard': false }
  }
  const executor = new RewardsTaskExecutor(
    {} as BrowserContext,
    client,
    store,
    logger,
    DEFAULT_CONFIG,
    'synthetic-run',
    'account-1'
  )
  const execute = async () => {
    const running = executor.executeTypes({
      discovery,
      types: ['claim-bonus-points'],
      mode: 'mutating',
      signal: new AbortController().signal
    })
    await vi.runAllTimersAsync()
    return running
  }
  return {
    store,
    task,
    client,
    page,
    buttons,
    goto,
    evaluate,
    execute,
    setServerPoints(value: number | undefined) {
      serverPoints = value
    }
  }
}

describe('claim verification reads a fresh official document', () => {
  it('confirms a successful Server Action despite a stale positive rendered amount', async () => {
    const f = fixture()
    expect((await f.execute()).status).toBe('completed')
    expect(f.store.getMutationState(f.task.taskId)).toBe('verified')
    expect(f.store.getTask(f.task.taskId)).toMatchObject({
      status: 'completed',
      progress: { completed: 1, total: 1 }
    })
    expect(f.goto).toHaveBeenCalledWith('https://rewards.bing.com/dashboard', expect.anything())
    expect(f.evaluate).toHaveBeenCalledTimes(1)
  })

  it('does not trust stale zero when the fresh page still has claimable points', async () => {
    const f = fixture({ pagePoints: 0, serverPoints: 30 })
    expect((await f.execute()).status).toBe('partial')
    expect(f.store.getTask(f.task.taskId)?.status).toBe('verification-pending')
    expect(f.goto).toHaveBeenCalledTimes(4)
    expect(f.evaluate).toHaveBeenCalledTimes(1)
    expect((await f.execute()).status).toBe('partial')
    expect(f.goto).toHaveBeenCalledTimes(8)
    expect(f.evaluate).toHaveBeenCalledTimes(1)
  })

  it('refreshes an existing pending claim without resubmitting it', async () => {
    const f = fixture()
    f.store.beginMutation(f.task.taskId)
    f.store.updateMutation(f.task.taskId, 'verification-pending')
    expect((await f.execute()).status).toBe('completed')
    expect(f.store.getMutationState(f.task.taskId)).toBe('verified')
    expect(f.evaluate).not.toHaveBeenCalled()
  })

  it('keeps failed refresh unknown instead of using stale zero', async () => {
    const f = fixture({ pagePoints: 0, serverPoints: 30 })
    f.goto.mockRejectedValue(new Error('synthetic refresh unavailable'))
    expect((await f.execute()).status).toBe('partial')
    expect(f.store.getMutationState(f.task.taskId)).toBe('verification-pending')
    expect(f.buttons.evaluateAll).not.toHaveBeenCalled()
    expect(f.evaluate).toHaveBeenCalledTimes(1)
  })

  it('does not interpret a missing claim card in the fresh document as zero', async () => {
    const f = fixture({ pagePoints: 0 })
    f.setServerPoints(undefined)
    expect((await f.execute()).status).toBe('partial')
    expect(f.store.getMutationState(f.task.taskId)).toBe('verification-pending')
    expect(f.evaluate).toHaveBeenCalledTimes(1)
  })

  it('observes delayed claim settlement with further reads, not further submissions', async () => {
    const f = fixture({ serverPoints: 30 })
    const navigate = f.goto.getMockImplementation()
    if (!navigate) throw new Error('Synthetic navigation implementation missing')
    f.goto.mockImplementation((url) => {
      if (f.goto.mock.calls.length === 2) f.setServerPoints(0)
      return navigate(url)
    })
    expect((await f.execute()).status).toBe('completed')
    expect(f.goto).toHaveBeenCalledTimes(2)
    expect(f.evaluate).toHaveBeenCalledTimes(1)
  })

  it.each(['https://login.live.com/', 'https://untrusted.example/dashboard'])(
    'does not read stale zero after refresh redirects to %s',
    async (destination) => {
      const f = fixture({ pagePoints: 0 })
      const navigate = f.goto.getMockImplementation()
      if (!navigate) throw new Error('Synthetic navigation implementation missing')
      f.goto.mockImplementation(() => navigate(destination))
      expect((await f.execute()).status).toBe('partial')
      expect(f.store.getMutationState(f.task.taskId)).toBe('verification-pending')
      expect(f.buttons.evaluateAll).not.toHaveBeenCalled()
      expect(f.evaluate).toHaveBeenCalledTimes(1)
    }
  )

  it('can confirm fresh zero without treating an uncertain response as proof', async () => {
    const f = fixture()
    f.evaluate.mockResolvedValue({ status: 504, ok: false, text: '' })
    expect((await f.execute()).status).toBe('completed')
    expect(f.goto).toHaveBeenCalledTimes(1)
    expect(f.store.getMutationState(f.task.taskId)).toBe('verified')
    expect(f.evaluate).toHaveBeenCalledTimes(1)
  })

  it('retains the existing no-refresh discovery read by default', async () => {
    const f = fixture()
    await expect(f.client.readClaimablePoints()).resolves.toBe(30)
    expect(f.goto).not.toHaveBeenCalled()
    expect(f.evaluate).not.toHaveBeenCalled()
  })

  it('cancels during refresh without reading stale data or leaving navigation running', async () => {
    const f = fixture({ pagePoints: 0 })
    const abort = new AbortController()
    const reason = new Error('synthetic refresh cancelled')
    f.goto.mockImplementation(() => {
      abort.abort(reason)
      return Promise.resolve(null)
    })
    await expect(f.client.readClaimablePoints(abort.signal, { refresh: true })).rejects.toBe(reason)
    expect(f.page.close).toHaveBeenCalledTimes(1)
    expect(f.buttons.evaluateAll).not.toHaveBeenCalled()
    expect(f.evaluate).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
})
