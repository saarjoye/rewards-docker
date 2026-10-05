import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { TaskRecord } from '../src/domain/Task.js'
import { localDateKey } from '../src/domain/DateKey.js'
import { SqliteStore } from '../src/infra/SqliteStore.js'
import { RunViews } from '../src/web/RunViews.js'
import { Overview } from '../src/web/ui/ConsolePages'

const accounts = [
  {
    accountId: 'synthetic-account',
    displayAlias: '合成账号',
    maskedEmail: 'Synthetic',
    runAccountIndex: 1
  }
]
function task(id: string, date: string, expectedPoints?: number): TaskRecord {
  return {
    taskId: id,
    accountId: accounts[0]?.accountId ?? 'synthetic-account',
    localDate: date,
    sourceTaskId: id,
    source: 'rsc',
    type: 'daily-set',
    displayName: '合成每日任务',
    executable: true,
    required: true,
    status: 'completed',
    progress: { completed: 1, total: 1 },
    updatedAt: `${date}T01:00:00Z`,
    ...(expectedPoints === undefined ? {} : { expectedPoints })
  }
}
function recordCredit(store: SqliteStore, runId: string, item: TaskRecord, amount: number) {
  store.ledger.credits.record({
    runId,
    accountId: item.accountId,
    taskId: item.taskId,
    taskInstanceId: item.sourceTaskId,
    source: item.source,
    observedAt: item.updatedAt,
    businessDate: item.localDate,
    officialCreditId: `${item.taskId}-receipt`,
    earnedPoints: amount,
    expectedPoints: item.expectedPoints,
    evidenceSource: 'official-credit',
    verificationStatus: 'confirmed',
    submitted: true
  })
}

describe('task points in account views', () => {
  it('includes a readable task list in overview points evidence', () => {
    const store = new SqliteStore(':memory:')
    const views = new RunViews(store)
    try {
      const date = localDateKey()
      const item = task('daily', date, 100)
      store.upsertTask(item, 'synthetic-run')
      recordCredit(store, 'synthetic-run', item, 97)
      const today = views.today(accounts)
      expect(today[0]).toMatchObject({
        taskPointDetails: [
          {
            taskId: item.taskId,
            displayName: '合成每日任务',
            confirmedPoints: 97,
            expectedPoints: 100
          }
        ]
      })
      const html = renderToStaticMarkup(
        createElement(Overview, {
          state: {
            version: 'test',
            localDate: date,
            accounts: [],
            tasks: [],
            taskSummary: {
              discovered: 1,
              completed: 1,
              verificationPending: 0,
              failed: 0,
              actionRequired: 0,
              executable: 1,
              skipped: 0,
              unknown: 0
            },
            runnerReady: false,
            activeRunId: null,
            runs: [],
            today
          },
          openRun: () => undefined
        })
      )
      expect(html).toContain('查看积分依据')
      expect(html).toContain('任务积分明细')
      expect(html).toContain('合成每日任务')
      expect(html).toContain('已确认 +97 分')
      expect(html).toContain('预计 +100 分')
      expect(html).toContain('已完成')
    } finally {
      views.dispose()
      store.close()
    }
  })

  it('deduplicates the same daily task across runs and keeps the owning credit', () => {
    const store = new SqliteStore(':memory:')
    const views = new RunViews(store)
    try {
      const date = localDateKey()
      const item = task('daily', date, 10)
      store.upsertTask(item, 'first-run')
      recordCredit(store, 'first-run', item, 10)
      store.upsertTask({ ...item, updatedAt: `${date}T02:00:00Z` }, 'retry-run')
      expect(views.today(accounts)[0]).toMatchObject({
        taskPointDetails: [
          {
            taskId: item.taskId,
            confirmedPoints: 10,
            expectedPoints: 10,
            status: 'completed'
          }
        ]
      })
      expect(store.ledger.credits.rowsForRun('retry-run')).toHaveLength(0)
    } finally {
      views.dispose()
      store.close()
    }
  })

  it('keeps account and Shanghai date scopes and never expands full run evidence', () => {
    const store = new SqliteStore(':memory:')
    const views = new RunViews(store)
    try {
      const date = localDateKey()
      store.upsertTask(task('today', date, 5), 'run')
      store.upsertTask(task('yesterday', '2025-01-01', 480), 'older-run')
      store.upsertTask({ ...task('other', date, 100), accountId: 'other-account' }, 'run')
      vi.spyOn(views, 'run').mockImplementation(() => {
        throw new Error('No full run reads')
      })
      vi.spyOn(store.ledger, 'taskEvidence').mockImplementation(() => {
        throw new Error('No full evidence reads')
      })
      expect(views.today(accounts)[0]).toMatchObject({
        taskPointDetails: [
          {
            taskId: 'today',
            confirmedPoints: null,
            expectedPoints: 5
          }
        ]
      })
      expect(store.ledger.credits.rowsForRun('run')).toHaveLength(0)
    } finally {
      vi.restoreAllMocks()
      views.dispose()
      store.close()
    }
  })

  it('displays only isolated task balances and withdraws attribution when another task overlaps', () => {
    const store = new SqliteStore(':memory:')
    const views = new RunViews(store)
    try {
      const date = localDateKey()
      const item = task('isolated', date, 10)
      store.upsertTask(item, 'run')
      for (const [phase, value, time] of [
        ['task-before', 1000, '08:00:00'],
        ['task-after', 1010, '08:01:00']
      ] as const)
        store.ledger.balance(
          'run',
          item.accountId,
          phase,
          {
            value,
            observedAt: date + 'T' + time + 'Z',
            availability: 'valid',
            confidence: 1,
            source: 'bing-flyout'
          },
          item.taskId
        )
      expect(views.taskPointDetails(item.accountId, date)).toMatchObject([
        { taskId: item.taskId, confirmedPoints: 10, confirmedSource: 'isolated-balance' }
      ])
      store.ledger.balance(
        'run',
        item.accountId,
        'task-before',
        {
          value: 1005,
          observedAt: date + 'T08:00:30Z',
          availability: 'valid',
          confidence: 1,
          source: 'bing-flyout'
        },
        'other-task'
      )
      expect(views.taskPointDetails(item.accountId, date)).toMatchObject([
        { taskId: item.taskId, confirmedPoints: null, expectedPoints: 10 }
      ])
      expect(store.ledger.credits.rowsForRun('run')).toHaveLength(0)
    } finally {
      views.dispose()
      store.close()
    }
  })

  it('refreshes cached task details after a receipt and across Shanghai midnight', () => {
    vi.useFakeTimers()
    vi.setSystemTime('2026-10-04T15:59:59.500Z')
    const store = new SqliteStore(':memory:')
    const views = new RunViews(store)
    try {
      const first = task('day-one', '2026-10-04', 5)
      const second = task('day-two', '2026-10-05', 7)
      store.upsertTask(first, 'first-run')
      expect(views.today(accounts)[0]?.taskPointDetails[0]?.confirmedPoints).toBeNull()
      recordCredit(store, 'first-run', first, 5)
      expect(views.today(accounts)[0]?.taskPointDetails[0]?.confirmedPoints).toBe(5)
      store.upsertTask(second, 'second-run')
      recordCredit(store, 'second-run', second, 7)
      expect(views.today(accounts)[0]?.taskPointDetails.map((row) => row.taskId)).toEqual([
        'day-one'
      ])
      vi.setSystemTime('2026-10-04T16:00:00Z')
      expect(views.today(accounts)[0]?.taskPointDetails).toMatchObject([
        { taskId: 'day-two', businessDate: '2026-10-05', confirmedPoints: 7 }
      ])
    } finally {
      views.dispose()
      store.close()
      vi.useRealTimers()
    }
  })
})
