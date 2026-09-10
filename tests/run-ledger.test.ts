import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SqliteStore } from '../src/infra/SqliteStore.js'
import { migrateRunLedger } from '../src/infra/RunLedger.js'
import { RunViews } from '../src/web/RunViews.js'
import type { TaskRecord } from '../src/domain/Task.js'
import { assertBusinessDate, BusinessDateChanged } from '../src/orchestration/BusinessDate.js'
import { localDateKey } from '../src/domain/DateKey.js'

const task: TaskRecord = {
  taskId: 'synthetic:2026-09-08:offer',
  accountId: 'synthetic',
  localDate: '2026-09-08',
  sourceTaskId: 'offer',
  type: 'daily-set',
  source: 'rsc',
  displayName: 'Synthetic task',
  executable: true,
  required: true,
  status: 'running',
  progress: { completed: 0, total: 1 },
  updatedAt: '2026-09-08T00:00:00.000Z'
}
function setup() {
  const store = new SqliteStore(':memory:')
  store.createRun({
    runId: 'run',
    localDate: '2026-09-08',
    executionMode: 'read-only',
    selectedAccountIndexes: [3],
    startedAt: '2026-09-08T00:00:00Z'
  })
  store.updateRun('run', 'running')
  store.ledger.lifecycle({
    runId: 'run',
    accountId: 'synthetic',
    accountIndex: 3,
    accountLabel: 's***@example.test',
    startedAt: '2026-09-08T00:00:00Z',
    endedAt: null,
    executionState: 'running',
    updatedAt: '2026-09-08T00:00:00Z'
  })
  return store
}
function balance(
  store: SqliteStore,
  value: number,
  at: string,
  phase: 'start' | 'live' | 'end' = 'live'
) {
  store.ledger.balance('run', 'synthetic', phase, {
    value,
    observedAt: at,
    source: 'bing-flyout',
    confidence: 0.9,
    availability: 'valid'
  })
}

describe('run evidence ledger', () => {
  it('restores snapshots after reopening a temporary database without duplicate balances', async () => {
    const root = await mkdtemp(join(tmpdir(), 'next-ledger-test-'))
    const path = join(root, 'synthetic.sqlite')
    let store = new SqliteStore(path)
    try {
      store.upsertTask(task, 'run')
      balance(store, 100, '2026-09-08T00:00:00Z', 'start')
      store.close()
      store = new SqliteStore(path)
      balance(store, 100, '2026-09-08T00:00:00Z', 'start')
      expect(store.ledger.tasks('run')[0]?.taskId).toBe(task.taskId)
      expect(store.ledger.balances('run')).toHaveLength(1)
    } finally {
      store.close()
      await rm(root, { recursive: true, force: true })
    }
  })
  it('isolates historical snapshots from later runs and ignores older snapshots', () => {
    const store = setup()
    try {
      store.upsertTask(task, 'run')
      store.upsertTask({ ...task, status: 'completed', updatedAt: '2026-09-08T01:00:00Z' }, 'later')
      expect(store.ledger.tasks('run')[0]?.status).toBe('running')
      expect(store.getTask(task.taskId)?.status).toBe('completed')
      store.ledger.task('later', task)
      expect(store.ledger.tasks('later')[0]?.status).toBe('completed')
    } finally {
      store.close()
    }
  })
  it('shows a live delta without inventing confirmed task credit and deduplicates evidence', () => {
    const store = setup()
    try {
      store.upsertTask({ ...task, status: 'completed' }, 'run')
      balance(store, 5000, '2026-09-08T00:00:00Z', 'start')
      balance(store, 5088, '2026-09-08T00:01:00Z')
      balance(store, 5088, '2026-09-08T00:01:00Z')
      const views = new RunViews(store)
      expect(views.run('run', 'run')).toMatchObject({
        runBalanceDelta: 88,
        accountsTotal: 1,
        persistence: 'live'
      })
      expect(views.run('run', 'run')?.accounts[0]).toMatchObject({
        confirmedTaskPoints: null,
        accountIndex: 3,
        verificationStatus: 'provisional'
      })
      expect(views.calendar('2026-09')[0]?.dailyBalanceDelta).toBe(88)
      expect(store.ledger.balances()).toHaveLength(2)
    } finally {
      store.close()
    }
  })
  it('preserves zero, negative and unknown balances distinctly', () => {
    const store = setup()
    try {
      const views = new RunViews(store)
      expect(views.run('run')?.runBalanceDelta).toBeNull()
      balance(store, 200, '2026-09-08T00:00:00Z', 'start')
      expect(views.run('run')?.runBalanceDelta).toBeNull()
      balance(store, 200, '2026-09-08T00:01:00Z')
      expect(views.run('run', 'run')?.runBalanceDelta).toBe(0)
      expect(views.run('run')?.runBalanceDelta).toBeNull()
      balance(store, 180, '2026-09-08T00:02:00Z', 'end')
      expect(views.run('run')?.runBalanceDelta).toBe(-20)
    } finally {
      store.close()
    }
  })
  it('splits Shanghai dates and never closes yesterday with a new day observation', () => {
    const store = setup()
    try {
      balance(store, 100, '2026-09-08T15:59:00Z', 'start')
      balance(store, 130, '2026-09-08T16:01:00Z')
      const views = new RunViews(store)
      expect(views.day('synthetic', '2026-09-08').dailyBalanceDelta).toBeNull()
      expect(views.day('synthetic', '2026-09-09').dailyBalanceDelta).toBeNull()
      expect(localDateKey(new Date('2026-09-08T16:01:00Z'))).toBe('2026-09-09')
      expect(() => {
        assertBusinessDate('2026-09-08', new Date('2026-09-08T16:01:00Z'))
      }).toThrow(BusinessDateChanged)
    } finally {
      store.close()
    }
  })
  it('keeps completed account lifecycle when the run is interrupted', () => {
    const store = setup()
    try {
      store.upsertTask(
        { ...task, status: 'completed', progress: { completed: 1, total: 1 } },
        'run'
      )
      const account = store.ledger.accounts('run')[0]
      if (!account) throw new Error('Missing synthetic account')
      store.ledger.lifecycle({
        ...account,
        executionState: 'completed',
        endedAt: '2026-09-08T01:00:00Z',
        updatedAt: '2026-09-08T01:00:00Z'
      })
      store.recoverInterruptedRuns()
      store.ledger.lifecycle({
        ...account,
        executionState: 'failed',
        updatedAt: new Date().toISOString()
      })
      expect(store.ledger.accounts('run')[0]?.executionState).toBe('completed')
      expect(store.getRun('run')?.status).toBe('interrupted')
    } finally {
      store.close()
    }
  })
  it('migrates repeatedly without rewriting legacy point values', () => {
    const store = setup()
    try {
      // Reproduce a pre-fix row, independently of today's stricter writer.
      store.database
        .prepare(
          `INSERT INTO points_history(account_id, local_date, initial_points, final_points, gained_points, status, balance_confirmed, recorded_at) VALUES(?,?,?,?,?,?,?,?)`
        )
        .run('synthetic', '2026-09-08', 100, 83, -17, 'partial', 0, '2026-09-08T01:00:00Z')
      migrateRunLedger(store.database)
      migrateRunLedger(store.database)
      expect(store.getLatestPointsHistory('synthetic', '2026-09-08')?.gainedPoints).toBe(-17)
      expect(
        store.database.prepare('SELECT COUNT(*) AS n FROM schema_version WHERE version=2').get()?.n
      ).toBe(1)
    } finally {
      store.close()
    }
  })
  it('rolls back a failing migration without partial tables', () => {
    const db = new DatabaseSync(':memory:')
    try {
      db.exec(
        'CREATE TABLE schema_version(version INTEGER PRIMARY KEY, applied_at TEXT); CREATE VIEW balance_observations AS SELECT 1 AS fake;'
      )
      expect(() => {
        migrateRunLedger(db)
      }).toThrow()
      expect(
        db.prepare("SELECT name FROM sqlite_master WHERE name='run_tasks'").get()
      ).toBeUndefined()
    } finally {
      db.close()
    }
  })
})
