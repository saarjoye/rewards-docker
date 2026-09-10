import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { BrowserContext } from 'patchright'
import { DashboardFetchError, type DashboardClient } from '../src/browser/DashboardClient.js'
import type { TaskRecord } from '../src/domain/Task.js'
import { DEFAULT_CONFIG } from '../src/infra/Config.js'
import type { LogEvent, StructuredLogger } from '../src/infra/StructuredLogger.js'
import { SqliteStore } from '../src/infra/SqliteStore.js'
import { SearchExecutor } from '../src/orchestration/SearchExecutor.js'
import { BusinessDateChanged } from '../src/orchestration/BusinessDate.js'
import { parseDashboardPayload } from '../src/rewards/DashboardParser.js'
import { RewardsTaskExecutor } from '../src/rewards/RewardsTaskExecutor.js'
import type { DiscoveryOutput } from '../src/rewards/RewardsDiscoveryService.js'
import { batchStatus, taskBoundAccountState } from '../src/domain/RunOutcome.js'
import { completionTitle } from '../src/notifications/Notifications.js'
import { RunViews } from '../src/web/RunViews.js'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const task = (): TaskRecord => ({
  taskId: 'synthetic:2026-09-10:pc-search',
  accountId: 'synthetic',
  localDate: '2026-09-10',
  sourceTaskId: 'pc-search',
  type: 'pc-search',
  source: 'bing-flyout',
  displayName: 'PC 搜索',
  executable: true,
  required: true,
  status: 'running',
  progress: { completed: 9, total: 60 },
  updatedAt: '2026-09-10T00:00:00.000Z'
})

function observation(value: unknown = [{ pointProgress: 9, pointProgressMax: 60 }]) {
  return parseDashboardPayload(
    { dashboard: { userStatus: { counters: { pcSearch: value } } } },
    'bing-flyout'
  )
}

function harness(values = [observation()], inputTask = task()) {
  vi.useFakeTimers()
  const press = vi.fn().mockResolvedValue(undefined)
  const box = { first: () => box, waitFor: vi.fn(), fill: vi.fn(), press }
  const page = { goto: vi.fn(), locator: () => box, close: vi.fn().mockResolvedValue(undefined) }
  const context = { newPage: vi.fn().mockResolvedValue(page) } as unknown as BrowserContext
  const fetchDashboard = vi
    .fn()
    .mockImplementation(() => Promise.resolve(values.length > 1 ? values.shift() : values[0]))
  const client = { fetchDashboard } as unknown as DashboardClient
  const write = vi.fn<(event: LogEvent) => Promise<void>>().mockResolvedValue(undefined)
  const logger = { write } as unknown as StructuredLogger
  const config = {
    ...DEFAULT_CONFIG,
    search: {
      ...DEFAULT_CONFIG.search,
      delayMinSeconds: 0,
      delayMaxSeconds: 0,
      scroll: false,
      clickResult: false
    }
  }
  const executor = new SearchExecutor(context, client, logger, config.search, 'run', 'synthetic')
  const onProgress = vi.fn<(task: TaskRecord) => void>()
  const controller = new AbortController()
  const input = { task: inputTask, mobile: false, signal: controller.signal, onProgress }
  return {
    executor,
    input,
    press,
    fetchDashboard,
    write,
    context,
    client,
    logger,
    config,
    controller
  }
}

async function finish<T>(promise: Promise<T>): Promise<T> {
  const handled = promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error })
  )
  await vi.runAllTimersAsync()
  const result = await handled
  if ('error' in result) throw result.error
  return result.value
}

describe('search dashboard observation', () => {
  it('stops after one authorized search even when the counter grows below its quota', async () => {
    const h = harness([observation([{ pointProgress: 48, pointProgressMax: 60 }])], {
      ...task(),
      progress: { completed: 45, total: 60 }
    })
    expect(await finish(h.executor.run({ ...h.input, singleQuery: '合成单次查询' }))).toMatchObject(
      {
        progress: { completed: 48, total: 60 },
        searchObservation: { state: 'progress-confirmed', submittedCount: 1, canContinue: false }
      }
    )
    expect(h.press).toHaveBeenCalledTimes(1)
  })
  it('keeps five unresolved searches at 45/60 and journals each read without resubmitting', async () => {
    const seed = {
      ...task(),
      progress: { completed: 45, total: 60 },
      searchObservation: {
        runId: 'run',
        submittedCount: 5,
        unknownSubmissionCount: 0,
        awaitingProgress: true,
        completed: 45,
        total: 60,
        observedAt: '2026-09-10T00:00:00.000Z',
        result: 'submitted'
      }
    }
    const h = harness([observation([{ pointProgress: 45, pointProgressMax: 60 }])], seed)
    const result = await finish(h.executor.run(h.input))
    expect(result).toMatchObject({
      status: 'verification-pending',
      progress: { completed: 45, total: 60 },
      searchObservation: { submittedCount: 5, state: 'progress-pending', canContinue: false }
    })
    expect(h.press).not.toHaveBeenCalled()
    const events = h.input.onProgress.mock.calls
      .map(([value]) => value.searchObservation?.lastEvent)
      .filter((value) => value?.kind === 'observation')
    expect(new Set(events.map((event) => event?.eventId)).size).toBe(4)
    expect(events[0]).toMatchObject({
      completed: 45,
      remaining: 15,
      durationMs: 0,
      usedFallback: null
    })
  })

  it('read-only recovery can confirm 48/60 but cannot submit another search', async () => {
    const h = harness([observation([{ pointProgress: 48, pointProgressMax: 60 }])], {
      ...task(),
      progress: { completed: 45, total: 60 }
    })
    const result = await finish(h.executor.run({ ...h.input, readOnly: true }))
    expect(result).toMatchObject({
      progress: { completed: 48, total: 60 },
      searchObservation: { state: 'progress-confirmed', submittedCount: 0 }
    })
    expect(h.press).not.toHaveBeenCalled()
  })

  it('keeps an observed unchanged counter separate from later request failures', async () => {
    const h = harness()
    h.fetchDashboard
      .mockResolvedValueOnce(observation())
      .mockRejectedValue(new Error('synthetic-network'))
    const result = await finish(h.executor.run(h.input))
    expect(result).toMatchObject({
      status: 'verification-pending',
      searchObservation: { state: 'progress-pending', result: 'request-failed' }
    })
  })

  it('writes idempotent search events without creating credit or balance evidence', () => {
    const store = new SqliteStore(':memory:')
    try {
      const original = task()
      store.upsertTask(original, 'run')
      store.ledger.balance('run', original.accountId, 'live', {
        availability: 'valid',
        value: 100,
        source: 'bing-flyout',
        confidence: 1,
        observedAt: original.updatedAt
      })
      const search = {
        eventId: 'synthetic-event',
        kind: 'observation' as const,
        state: 'progress-confirmed' as const,
        reason: 'progress-increased',
        source: 'bing-flyout',
        availability: 'valid',
        completed: 48,
        total: 60,
        remaining: 12,
        observedAt: original.updatedAt,
        durationMs: 10,
        usedFallback: true,
        attempt: 2,
        submittedCount: 5,
        unknownSubmissionCount: 0,
        lastConfirmedCompleted: 48,
        lastConfirmedTotal: 60,
        canContinue: true
      }
      const row = {
        runId: 'run',
        accountId: original.accountId,
        taskId: original.taskId,
        source: original.source,
        kind: 'verification' as const,
        observedAt: original.updatedAt,
        search
      }
      store.ledger.recordTaskEvidence(row)
      store.ledger.recordTaskEvidence({ ...row, executionState: 'verification-pending' })
      expect(store.ledger.taskEvidence('run')).toHaveLength(1)
      expect(store.ledger.credits.rowsForRun('run')).toHaveLength(0)
      expect(store.ledger.balances('run', original.accountId)).toHaveLength(1)
    } finally {
      store.close()
    }
  })
  it('accepts valid growth immediately and persists the actual submission', async () => {
    const h = harness([observation([{ pointProgress: 60, pointProgressMax: 60 }])])
    const result = await finish(h.executor.run(h.input))
    expect(result).toMatchObject({
      status: 'completed',
      progress: { completed: 60, total: 60 },
      searchObservation: { submittedCount: 1, unknownSubmissionCount: 0 }
    })
    expect(h.press).toHaveBeenCalledTimes(1)
    expect(h.fetchDashboard).toHaveBeenCalledTimes(1)
    expect(
      h.input.onProgress.mock.calls.some(
        ([value]) => value.searchObservation?.result === 'submitted'
      )
    ).toBe(true)
  })

  it.each([
    ['unchanged', [{ pointProgress: 9, pointProgressMax: 60 }], 'progress-unchanged'],
    ['missing', null, 'counter-missing'],
    ['invalid', [{ pointProgress: false, pointProgressMax: 60 }], 'counter-invalid'],
    ['regressed', [{ pointProgress: 6, pointProgressMax: 60 }], 'snapshot-regressed'],
    ['quota changed', [{ pointProgress: 9, pointProgressMax: 9 }], 'quota-conflict']
  ])('retains progress and submits only once for %s', async (_name, value, classification) => {
    const h = harness([observation(value)])
    const result = await finish(h.executor.run(h.input))
    expect(result).toMatchObject({
      status: 'verification-pending',
      progress: { completed: 9, total: 60 },
      searchObservation: { submittedCount: 1, result: classification, awaitingProgress: true }
    })
    expect(h.fetchDashboard).toHaveBeenCalledTimes(4)
    expect(h.press).toHaveBeenCalledTimes(1)
    const logs = h.write.mock.calls
      .map(([event]) => event)
      .filter((event) => event.event === 'search-dashboard-observation')
    expect(logs).toHaveLength(4)
    expect(logs[0]).toMatchObject({ source: 'bing-flyout', status: classification, attempt: 1 })
    expect(Object.keys(logs[0] ?? {})).toEqual(
      expect.arrayContaining([
        'source',
        'availability',
        'completed',
        'total',
        'remaining',
        'observedAt'
      ])
    )
    expect(JSON.stringify(logs)).not.toMatch(/accountAlias|https?:|Cookie|Token|Authorization/)
    if (classification === 'counter-missing' || classification === 'counter-invalid')
      expect(logs[0]?.completed).toBeNull()
  })

  it('observes delayed growth without resubmitting during review', async () => {
    const h = harness([
      observation(),
      observation(),
      observation([{ pointProgress: 60, pointProgressMax: 60 }])
    ])
    expect(await finish(h.executor.run(h.input))).toMatchObject({ status: 'completed' })
    expect(h.fetchDashboard).toHaveBeenCalledTimes(3)
    expect(h.press).toHaveBeenCalledTimes(1)
  })

  it('keeps request failure distinct and never logs the original error', async () => {
    const h = harness()
    h.fetchDashboard.mockRejectedValue(new Error('synthetic-private-request-material'))
    await expect(finish(h.executor.run(h.input))).rejects.toMatchObject({
      message: 'dashboard-request-failed'
    })
    expect(h.input.onProgress.mock.calls.at(-1)?.[0]).toMatchObject({
      searchObservation: { state: 'failed', submittedCount: 1 }
    })
    expect(JSON.stringify(h.write.mock.calls)).not.toContain('synthetic-private-request-material')
  })

  it('distinguishes HTTP 200 parsing failure from authentication failure', async () => {
    const h = harness()
    h.fetchDashboard.mockRejectedValue(new DashboardFetchError('private', 200, 1, 0))
    expect(await finish(h.executor.run(h.input))).toMatchObject({
      searchObservation: { result: 'counter-invalid' }
    })
    h.fetchDashboard.mockRejectedValue(new DashboardFetchError('private', 401, 1, 0))
    await expect(finish(h.executor.run(h.input))).rejects.toMatchObject({
      message: 'dashboard-authentication-failed'
    })
  })

  it('does not accept a lower or older snapshot during recovery', async () => {
    const recovered = {
      ...task(),
      searchObservation: {
        runId: 'run',
        submittedCount: 5,
        unknownSubmissionCount: 0,
        awaitingProgress: true,
        completed: 9,
        total: 60,
        observedAt: '2099-01-01T00:00:00.000Z',
        result: 'submitted'
      }
    }
    const h = harness([observation([{ pointProgress: 60, pointProgressMax: 60 }])], recovered)
    expect(await finish(h.executor.run(h.input))).toMatchObject({
      progress: { completed: 9, total: 60 },
      searchObservation: { submittedCount: 5, result: 'snapshot-regressed' }
    })
    expect(h.press).not.toHaveBeenCalled()
  })

  it('propagates cancellation during review without another submission', async () => {
    const h = harness()
    h.fetchDashboard.mockImplementation(() => {
      h.controller.abort(new Error('cancelled'))
      return Promise.resolve(observation())
    })
    await expect(finish(h.executor.run(h.input))).rejects.toThrow('cancelled')
    expect(h.press).toHaveBeenCalledTimes(1)
  })

  it('does not accept observations after the business date changes', async () => {
    const h = harness()
    let changed = false
    h.fetchDashboard.mockImplementation(() => {
      changed = true
      return Promise.resolve(observation([{ pointProgress: 60, pointProgressMax: 60 }]))
    })
    await expect(
      finish(
        h.executor.run({
          ...h.input,
          beforeSubmit: () => {
            if (changed) throw new BusinessDateChanged()
          }
        })
      )
    ).rejects.toBeInstanceOf(BusinessDateChanged)
    expect(h.input.onProgress.mock.calls.at(-1)?.[0].progress.completed).toBe(9)
  })

  it('records unknown submissions before Enter can fail, without replay', async () => {
    const h = harness()
    h.press.mockRejectedValue(new Error('synthetic-submit-timeout'))
    expect(await finish(h.executor.run(h.input))).toMatchObject({
      status: 'verification-pending',
      searchObservation: { submittedCount: 0, unknownSubmissionCount: 1 }
    })
    expect(h.press).toHaveBeenCalledTimes(1)
  })

  it('bounds the observation window even when a request consumes the remaining budget', async () => {
    const h = harness()
    const deadlines: number[] = []
    h.fetchDashboard.mockImplementation((_signal: AbortSignal, deadline: number) => {
      deadlines.push(deadline)
      vi.setSystemTime(deadline)
      return Promise.resolve(observation([{ pointProgress: 60, pointProgressMax: 60 }]))
    })
    expect(await finish(h.executor.run(h.input))).toMatchObject({
      status: 'verification-pending',
      progress: { completed: 9, total: 60 }
    })
    expect(deadlines).toHaveLength(1)
    expect(h.press).toHaveBeenCalledTimes(1)
  })

  it('persists pending results in the run ledger and recovers without a new search', async () => {
    const h = harness()
    const directory = await mkdtemp(join(tmpdir(), 'search-progress-'))
    const path = join(directory, 'synthetic.sqlite')
    let store = new SqliteStore(path)
    try {
      const live: TaskRecord[] = []
      store.subscribe(() => {
        const saved = store.ledger.tasks('run')[0]
        if (saved) live.push(new RunViews(store).task('run', saved))
      })
      const discovery = {
        tasks: [task()],
        descriptors: new Map([[task().taskId, { task: task() }]])
      } as unknown as DiscoveryOutput
      const execute = () =>
        new RewardsTaskExecutor(
          h.context,
          h.client,
          store,
          h.logger,
          h.config,
          'run',
          'synthetic'
        ).executeTypes({
          discovery,
          types: ['pc-search'],
          mode: 'mutating',
          signal: h.input.signal
        })
      expect(await finish(execute())).toMatchObject({
        status: 'partial',
        tasks: [{ status: 'verification-pending', searchObservation: { submittedCount: 1 } }]
      })
      expect(store.ledger.tasks('run')[0]).toMatchObject({
        searchObservation: { submittedCount: 1 },
        progress: { completed: 9, total: 60 }
      })
      expect(
        live.some(
          (value) => value.status === 'running' && value.searchObservation?.submittedCount === 1
        )
      ).toBe(true)
      expect(taskBoundAccountState('completed', store.ledger.tasks('run'))).toBe('partial')
      expect(batchStatus(['partial'], 1)).toBe('partial')
      expect(completionTitle('partial')).not.toContain('账号任务完成')
      store.close()
      store = new SqliteStore(path)
      // Rediscovery must not erase the persisted submission before reconciliation.
      store.upsertTask({ ...task(), progress: { completed: 0, total: 60 } }, 'run')
      expect(store.getTask(task().taskId)).toMatchObject({
        status: 'verification-pending',
        progress: { completed: 9, total: 60 }
      })
      expect(await finish(execute())).toMatchObject({ status: 'partial' })
      expect(h.press).toHaveBeenCalledTimes(1)
      h.fetchDashboard.mockResolvedValue(observation([{ pointProgress: 60, pointProgressMax: 60 }]))
      expect(await finish(execute())).toMatchObject({
        status: 'completed',
        tasks: [{ status: 'completed' }]
      })
      expect(h.press).toHaveBeenCalledTimes(1)
    } finally {
      store.close()
      await rm(directory, { recursive: true, force: true })
    }
  })
})

describe('strict search counter shapes', () => {
  it.each([null, '', ' ', false, true, -1, 1.5, '1e2', Number.MAX_SAFE_INTEGER + 1])(
    'does not coerce %s into progress',
    (value) => {
      expect(
        observation([{ pointProgress: value, pointProgressMax: 60 }]).pcSearch.availability
      ).toBe('invalid')
    }
  )
  it('accepts case-insensitive names and explicit wrappers with numeric aliases', () => {
    for (const value of [
      { POINT_PROGRESS: '9', POINT_PROGRESS_MAX: '60' },
      { items: [{ pointProgress: 9, pointProgressMax: 60 }] },
      {
        counters: [
          { pointProgress: 4, pointProgressMax: 30 },
          { pointProgress: 5, pointProgressMax: 30 }
        ]
      }
    ]) {
      expect(
        parseDashboardPayload(
          { dashboard: { userStatus: { counters: { PCSEARCH: value } } } },
          'bing-flyout'
        ).pcSearch.value
      ).toEqual({ completed: 9, total: 60, remaining: 51 })
    }
  })
  it('rejects conflicting aliases and aggregate overflow', () => {
    expect(
      observation([{ pointProgress: 9, point_progress: 10, pointProgressMax: 60 }]).pcSearch
        .availability
    ).toBe('invalid')
    expect(
      observation([
        { pointProgress: 0, pointProgressMax: Number.MAX_SAFE_INTEGER },
        { pointProgress: 0, pointProgressMax: 1 }
      ]).pcSearch.availability
    ).toBe('invalid')
    expect(
      parseDashboardPayload(
        {
          dashboard: {
            userStatus: {
              counters: {
                pcSearch: [{ pointProgress: 9, pointProgressMax: 60 }],
                PCSearch: [{ pointProgress: 10, pointProgressMax: 60 }]
              }
            }
          }
        },
        'bing-flyout'
      ).pcSearch.availability
    ).toBe('invalid')
  })
})
