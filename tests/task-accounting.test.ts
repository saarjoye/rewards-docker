import { describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { SqliteStore } from '../src/infra/SqliteStore.js'
import { migrateRunLedger } from '../src/infra/RunLedger.js'
import { RunViews } from '../src/web/RunViews.js'
import { TaskEvidencePanel } from '../src/web/ui/TaskEvidencePanel'
import type { TaskRecord } from '../src/domain/Task.js'

const task: TaskRecord = {
  taskId: 'task',
  accountId: 'account',
  sourceTaskId: 'offer',
  localDate: '2026-09-09',
  source: 'bing-flyout',
  type: 'daily-set',
  displayName: 'Synthetic',
  status: 'running',
  progress: { completed: 12, total: 60 },
  executable: true,
  required: true,
  updatedAt: '2026-09-09T08:16:48Z'
}
function fixture() {
  const store = new SqliteStore(':memory:')
  store.upsertTask(task, 'run')
  const views = new RunViews(store)
  const current = () => views.run('run')?.tasks[0]
  const balance = (
    phase: 'live' | 'task-before' | 'task-after',
    value: number,
    at: string,
    taskId?: string,
    accountId = 'account',
    runId = 'run'
  ) => {
    store.ledger.balance(
      runId,
      accountId,
      phase,
      { value, observedAt: at, availability: 'valid', confidence: 1, source: 'bing-flyout' },
      taskId
    )
  }
  return { store, views, current, balance }
}
describe('task numeric accounting', () => {
  it('chooses source priority only among equally recent equal balances, and rejects conflicting totals', () => {
    const { store, current, balance } = fixture()
    try {
      balance('live', 17607, '2026-09-09T08:16:48Z')
      store.ledger.balance('run', 'account', 'live', {
        value: 17607,
        observedAt: '2026-09-09T08:16:48Z',
        source: 'app-dashboard',
        confidence: 1,
        availability: 'valid'
      })
      expect(current()?.accountRealtimeBalanceSource).toBe('bing-flyout')
      store.ledger.balance('run', 'account', 'live', {
        value: 17608,
        observedAt: '2026-09-09T08:17:48Z',
        source: 'app-dashboard',
        confidence: 1,
        availability: 'valid'
      })
      expect(current()?.accountRealtimeBalance).toBe(17608)
      balance('live', 17609, '2026-09-09T08:17:48Z')
      expect(current()?.accountRealtimeBalance).toBeNull()
    } finally {
      store.close()
    }
  })
  it('does not turn plain official progress into money but accepts a bound official receipt', () => {
    const { store, current } = fixture()
    try {
      const progress = {
        runId: 'run',
        accountId: 'account',
        taskId: 'task',
        source: 'bing-flyout',
        observedAt: '2026-09-09T08:16:48Z',
        taskInstanceId: 'offer',
        expectedPoints: 10,
        evidenceSource: 'official-progress' as const
      }
      store.ledger.credits.record(progress)
      expect(current()?.taskEarnedPoints).toBeNull()
      store.ledger.credits.record({
        ...progress,
        officialCreditId: 'receipt',
        earnedPoints: 10,
        verificationStatus: 'confirmed'
      })
      expect(current()).toMatchObject({
        taskEarnedPoints: 10,
        taskEarnedPointsSource: 'official-progress'
      })
    } finally {
      store.close()
    }
  })
  it('returns latest total while progress is 12/60 with no end snapshot', () => {
    const { store, current, balance } = fixture()
    try {
      balance('live', 17607, '2026-09-09T08:16:48Z')
      expect(current()).toMatchObject({
        accountRealtimeBalance: 17607,
        accountRealtimeBalanceSource: 'bing-flyout',
        accountRealtimeBalanceAt: '2026-09-09T08:16:48.000Z',
        taskStatus: 'running',
        taskProgress: { completed: 12, total: 60 },
        taskEarnedPoints: null,
        taskEarnedPointsSource: null,
        taskEarnedPointsStatus: 'unavailable'
      })
      const html = renderToStaticMarkup(
        createElement(TaskEvidencePanel, { tasks: [current() ?? task] })
      )
      expect(html).toContain('账号实时余额：17607 分')
      expect(html).toContain('任务到账：— 分')
      expect(html).not.toMatch(/已观测|未取得|未匹配|待确认/)
    } finally {
      store.close()
    }
  })
  it.each([10, 0])('reads a stable official credit with real amount %s once', (amount) => {
    const { store, current } = fixture()
    try {
      const value = {
        runId: 'run',
        accountId: 'account',
        taskId: 'task',
        source: 'bing-flyout',
        observedAt: '2026-09-09T08:16:48Z',
        officialCreditId: 'official',
        earnedPoints: amount,
        verificationStatus: 'confirmed' as const,
        evidenceSource: 'official-credit' as const
      }
      store.ledger.credits.record(value)
      store.ledger.credits.record(value)
      expect(current()).toMatchObject({
        taskEarnedPoints: amount,
        taskEarnedPointsSource: 'official-credit',
        taskEarnedPointsStatus: 'confirmed'
      })
      expect(store.ledger.credits.rowsForRun('run')).toHaveLength(1)
      const html = renderToStaticMarkup(
        createElement(TaskEvidencePanel, { tasks: [current() ?? task] })
      )
      expect(html).toContain(`任务到账：${String(amount)} 分`)
      expect(html).toContain('账号实时余额：— 分')
    } finally {
      store.close()
    }
  })
  it('derives only an isolated same-task interval and never attributes old unbound snapshots', () => {
    const { store, current, balance } = fixture()
    try {
      balance('task-before', 1000, '2026-09-09T07:00:00Z')
      balance('task-after', 1010, '2026-09-09T07:01:00Z')
      expect(current()?.taskEarnedPoints).toBeNull()
      balance('task-before', 1000, '2026-09-09T08:00:00Z', 'task')
      balance('task-after', 1010, '2026-09-09T08:01:00Z', 'task')
      expect(current()).toMatchObject({
        taskEarnedPoints: 10,
        taskEarnedPointsSource: 'isolated-balance'
      })
      balance('task-before', 1005, '2026-09-09T08:00:30Z', 'other')
      expect(current()?.taskEarnedPoints).toBeNull()
    } finally {
      store.close()
    }
  })
  it('isolates account, run, date and task identity without using reports as credits', () => {
    const { store, current, balance } = fixture()
    try {
      balance('task-before', 1000, '2026-09-09T08:00:00Z', 'task')
      balance('task-after', 1010, '2026-09-09T08:01:00Z', 'other')
      balance('task-after', 2000, '2026-09-09T08:01:00Z', 'task', 'other')
      balance('task-after', 3000, '2026-09-09T08:01:00Z', 'task', 'account', 'other')
      balance('task-after', 4000, '2026-09-09T16:01:00Z', 'task')
      store.ledger.credits.record({
        runId: 'run',
        accountId: 'account',
        taskId: 'task',
        source: 'bing-flyout',
        taskInstanceId: 'offer',
        observedAt: '2026-09-09T08:16:48Z',
        earnedPoints: 10,
        reportedPoints: 10,
        evidenceSource: 'task-report'
      })
      expect(current()?.taskEarnedPoints).toBeNull()
      expect(current()?.accountRealtimeBalance).toBe(1010)
    } finally {
      store.close()
    }
  })
  it('prefers verification over response over execution and broadcasts committed numeric changes', () => {
    const { store, current, balance } = fixture()
    try {
      const changed = vi.fn()
      store.subscribe(changed)
      balance('live', 17607, '2026-09-09T08:16:48Z')
      for (const [kind, time] of [
        ['execution', '08:20:00'],
        ['response', '08:19:00'],
        ['verification', '08:18:00']
      ] as const)
        store.ledger.recordTaskEvidence({
          runId: 'run',
          accountId: 'account',
          taskId: 'task',
          source: 'bing-flyout',
          kind,
          observedAt: `2026-09-09T${time}Z`
        })
      expect(current()?.latestTaskEvidence?.kind).toBe('verification')
      expect(current()?.taskEvidence).toHaveLength(3)
      expect(current()?.accountRealtimeBalance).toBe(17607)
      expect(changed).toHaveBeenCalledTimes(4)
      store.ledger.credits.record({
        runId: 'run',
        accountId: 'account',
        taskId: 'task',
        source: 'bing-flyout',
        observedAt: '2026-09-09T08:21:00Z',
        officialCreditId: 'receipt',
        earnedPoints: 10,
        evidenceSource: 'official-credit',
        verificationStatus: 'confirmed'
      })
      expect(changed).toHaveBeenCalledTimes(5)
      expect(current()?.taskEarnedPoints).toBe(10)
      changed.mockClear()
      store.database.exec(
        "CREATE TRIGGER synthetic_fail BEFORE INSERT ON task_evidence BEGIN SELECT RAISE(ABORT,'synthetic'); END"
      )
      expect(() => {
        store.ledger.recordTaskEvidence({
          runId: 'run',
          accountId: 'account',
          taskId: 'task',
          kind: 'response',
          source: 'bing-flyout',
          observedAt: '2026-09-09T08:22:00Z',
          balance: 18000
        })
      }).toThrow()
      expect(changed).not.toHaveBeenCalled()
      expect(current()?.accountRealtimeBalance).toBe(17607)
    } finally {
      store.close()
    }
  })
  it('adds nullable task links idempotently and preserves the complete old balance row', () => {
    const db = new DatabaseSync(':memory:')
    try {
      db.exec(`CREATE TABLE schema_version(version INTEGER PRIMARY KEY, applied_at TEXT);
        CREATE TABLE balance_observations(snapshot_id TEXT PRIMARY KEY, run_id TEXT, account_id TEXT,
          phase TEXT, balance INTEGER, observed_at TEXT, business_date TEXT, source TEXT);
        INSERT INTO balance_observations VALUES('old','run','account','live',17607,'2026-09-09T08:16:48.000Z','2026-09-09','bing-flyout');`)
      const old = { ...db.prepare('SELECT * FROM balance_observations').get() }
      migrateRunLedger(db)
      migrateRunLedger(db)
      expect({ ...db.prepare('SELECT * FROM balance_observations').get() }).toEqual({
        ...old,
        task_id: null
      })
      expect(db.prepare('SELECT COUNT(*) AS n FROM schema_version WHERE version=5').get()?.n).toBe(
        1
      )
    } finally {
      db.close()
    }
  })
  it('rolls back the new column and version if the new index cannot be created', () => {
    const db = new DatabaseSync(':memory:')
    try {
      db.exec(`CREATE TABLE schema_version(version INTEGER PRIMARY KEY, applied_at TEXT);
        CREATE TABLE balance_observations(snapshot_id TEXT PRIMARY KEY, run_id TEXT, account_id TEXT,
          phase TEXT, balance INTEGER, observed_at TEXT, business_date TEXT, source TEXT);
        CREATE TABLE balance_task_scope(id TEXT);`)
      expect(() => {
        migrateRunLedger(db)
      }).toThrow()
      expect(
        db
          .prepare('PRAGMA table_info(balance_observations)')
          .all()
          .some((row) => row.name === 'task_id')
      ).toBe(false)
      expect(db.prepare('SELECT COUNT(*) AS n FROM schema_version').get()?.n).toBe(0)
    } finally {
      db.close()
    }
  })
})
