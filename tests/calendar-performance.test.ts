import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SqliteStore } from '../src/infra/SqliteStore.js'
import { RunViews } from '../src/web/RunViews.js'
import type { TaskRecord } from '../src/domain/Task.js'
import { legacyCalendar } from './helpers/legacyCalendar.js'

const stores: SqliteStore[] = []
const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const store of stores.splice(0)) store.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function open(path = ':memory:') {
  const store = new SqliteStore(path)
  stores.push(store)
  return store
}
const indexes: Record<string, string[]> = {
  idx_tasks_local_date: ['local_date'],
  idx_run_tasks_business_date: ['business_date', 'account_id'],
  idx_run_tasks_run_id: ['run_id', 'account_id'],
  idx_account_runs_local_date: ['local_date'],
  idx_point_credits_business_date: ['business_date'],
  idx_balance_obs_business_date: ['business_date'],
  idx_runs_started_at: ['started_at'],
  idx_runs_local_date: ['local_date']
}
function seed(store: SqliteStore, days: number, runsPerDay = 2, tasksPerAccount = 2) {
  const evidence = store.database.prepare('INSERT INTO task_evidence VALUES (?, ?, ?, ?, ?, ?)')
  const lifecycle = store.database.prepare(`INSERT INTO account_lifecycle
    (run_id, account_id, account_index, account_label, started_at, ended_at, execution_state, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'completed', ?)`)
  store.database.exec('BEGIN')
  try {
    for (let day = 1; day <= days; day += 1) {
      const date = `2026-10-${String(day).padStart(2, '0')}`
      for (let run = 0; run < runsPerDay; run += 1) {
        const runId = `${date}:run-${String(run)}`
        const startedAt = `${date}T0${String(run)}:00:00.000Z`
        const endedAt = `${date}T0${String(run)}:10:00.000Z`
        store.createRun({
          runId,
          localDate: date,
          executionMode: 'mutating',
          selectedAccountIndexes: [1, 2, 3],
          startedAt
        })
        store.updateRun(runId, 'completed', endedAt)
        for (let account = 1; account <= 3; account += 1) {
          const accountId = `synthetic-${String(account)}`
          lifecycle.run(
            runId,
            accountId,
            account,
            `Account ${String(account)}`,
            startedAt,
            endedAt,
            endedAt
          )
          store.ledger.balance(runId, accountId, 'start', {
            availability: 'valid',
            confidence: 1,
            source: 'bing-flyout',
            observedAt: startedAt,
            value: 100 + run * 10
          })
          store.ledger.balance(runId, accountId, 'end', {
            availability: 'valid',
            confidence: 1,
            source: 'bing-flyout',
            observedAt: endedAt,
            value: 110 + run * 10
          })
          for (let index = 0; index < tasksPerAccount; index += 1) {
            const taskId = `${accountId}:${date}:${String(index)}`
            const task: TaskRecord = {
              taskId,
              accountId,
              localDate: date,
              sourceTaskId: String(index),
              type: 'daily-set',
              source: 'rsc',
              displayName: 'Synthetic task',
              executable: true,
              required: true,
              status: 'completed',
              progress: { completed: 1, total: 1 },
              updatedAt: endedAt
            }
            store.upsertTask(task, runId)
            for (const kind of ['response', 'verification']) {
              evidence.run(
                `${runId}:${taskId}:${kind}`,
                runId,
                taskId,
                accountId,
                endedAt,
                JSON.stringify({
                  runId,
                  accountId,
                  taskId,
                  source: 'browser-response',
                  kind,
                  observedAt: endedAt,
                  businessDate: date
                })
              )
            }
          }
        }
      }
    }
    store.database.exec('COMMIT')
  } catch (error) {
    store.database.exec('ROLLBACK')
    throw error
  }
}

describe('business index migrations', () => {
  it('creates all eight indexes on a fresh database and upgrades an existing one idempotently', () => {
    const root = mkdtempSync(join(tmpdir(), 'next19-index-test-'))
    roots.push(root)
    const path = join(root, 'synthetic.sqlite')
    const initial = open(path)
    seed(initial, 1)
    initial.searchQueries.reserve({
      accountId: 'synthetic-1',
      taskId: 'search',
      localDate: '2026-10-01',
      candidates: ['synthetic query']
    })
    for (const [name, columns] of Object.entries(indexes)) {
      const actual = initial.database.prepare(`PRAGMA index_info(${name})`).all() as {
        name: string
      }[]
      expect(actual.map((row) => row.name)).toEqual(columns)
      initial.database.exec(`DROP INDEX ${name}`)
    }
    initial.close()
    stores.splice(stores.indexOf(initial), 1)
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const reopened = open(path)
      for (const [name, columns] of Object.entries(indexes)) {
        const actual = reopened.database.prepare(`PRAGMA index_info(${name})`).all() as {
          name: string
        }[]
        expect(actual.map((row) => row.name)).toEqual(columns)
      }
      const descending = reopened.database
        .prepare('PRAGMA index_xinfo(idx_runs_started_at)')
        .all() as { name: string | null; desc: number }[]
      expect(descending.find((row) => row.name === 'started_at')?.desc).toBe(1)
      expect(reopened.ledger.tasks('2026-10-01:run-0')).toHaveLength(6)
      expect(
        reopened.searchQueries.reserve({
          accountId: 'synthetic-2',
          taskId: 'search',
          localDate: '2026-10-01',
          candidates: ['synthetic query']
        })
      ).toBeNull()
      reopened.close()
      stores.splice(stores.indexOf(reopened), 1)
    }
  })

  it('uses the business indexes for matching predicates and records the monthly LIKE query plan', () => {
    const store = open()
    const queries: [string, string][] = [
      ['idx_tasks_local_date', "SELECT * FROM tasks WHERE local_date = '2026-10-01'"],
      [
        'idx_run_tasks_business_date',
        "SELECT * FROM run_tasks WHERE business_date = '2026-10-01' AND account_id = 'synthetic-1'"
      ],
      [
        'idx_run_tasks_run_id',
        "SELECT * FROM run_tasks WHERE run_id = 'run' AND account_id = 'synthetic-1'"
      ],
      ['idx_account_runs_local_date', "SELECT * FROM account_runs WHERE local_date = '2026-10-01'"],
      [
        'idx_point_credits_business_date',
        "SELECT * FROM point_credits WHERE business_date = '2026-10-01'"
      ],
      [
        'idx_balance_obs_business_date',
        "SELECT * FROM balance_observations WHERE business_date = '2026-10-01'"
      ],
      ['idx_runs_started_at', 'SELECT * FROM runs ORDER BY started_at DESC LIMIT 20'],
      ['idx_runs_local_date', "SELECT * FROM runs WHERE local_date = '2026-10-01'"]
    ]
    for (const [index, sql] of queries) {
      const plan = store.database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[]
      expect(plan.map((row) => row.detail).join('\n')).toContain(index)
    }
    const monthlyPlan = store.database
      .prepare(
        "EXPLAIN QUERY PLAN SELECT account_id, business_date, run_id FROM run_tasks WHERE business_date LIKE '2026-10-%'"
      )
      .all() as { detail: string }[]
    console.info(
      'calendar monthly LIKE query plan:',
      monthlyPlan.map((row) => row.detail)
    )
  })
})

describe('lightweight calendar', () => {
  it('preserves monthly reconciliation and summaries without loading full run details', () => {
    const store = open()
    seed(store, 2)
    const baseline = new RunViews(store)
    const expected = legacyCalendar(store, baseline, '2026-10', '2026-10-02:run-1')
    baseline.dispose()
    const views = new RunViews(store)
    const heavy = vi.spyOn(views, 'run').mockImplementation(() => {
      throw new Error('Calendar must not load run details')
    })
    const summary = vi.spyOn(views, 'runSummary')
    const entries = views.calendar('2026-10', '2026-10-02:run-1')
    expect(entries).toEqual(expected)
    expect(heavy).not.toHaveBeenCalled()
    expect(summary).toHaveBeenCalledTimes(4)
    expect(entries).toHaveLength(6)
    expect(entries.every((entry) => entry.taskCount === 2)).toBe(true)
    expect(views.calendar('2026-10-01')).toHaveLength(3)
    expect(views.calendar('2026-11')).toEqual([])
    views.dispose()
  })

  it('keeps legacy account indexes, cross-day lifecycle entries and missing summaries', () => {
    const store = open()
    seed(store, 1, 1)
    store.database.exec("DELETE FROM account_lifecycle WHERE account_id = 'synthetic-1'")
    store.upsertAccountRun({
      runId: '2026-10-01:run-0',
      accountId: 'synthetic-1',
      runAccountIndex: 7,
      localDate: '2026-10-01',
      status: 'success',
      updatedAt: '2026-10-01T00:10:00Z'
    })
    store.database.exec(
      "UPDATE account_lifecycle SET ended_at = '2026-10-01T16:30:00Z' WHERE account_id = 'synthetic-2'"
    )
    store.upsertAccountRun({
      runId: 'orphan',
      accountId: 'legacy',
      runAccountIndex: 9,
      localDate: '2026-10-03',
      status: 'partial',
      updatedAt: '2026-10-03T00:00:00Z'
    })
    const views = new RunViews(store)
    expect(
      views.calendar('2026-10-01').find((row) => row.accountId === 'synthetic-1')
    ).toMatchObject({ accountIndex: 7, accountLabel: '标签—', taskCount: 2 })
    expect(views.calendar('2026-10-02')).toHaveLength(1)
    expect(views.calendar('2026-10-02')[0]).toMatchObject({
      accountId: 'synthetic-2',
      taskCount: 0
    })
    expect(views.calendar('2026-10-03')[0]).toMatchObject({
      accountId: 'legacy',
      accountIndex: 9,
      records: []
    })
    views.dispose()
  })

  it('compares cold monthly calendar timing against the next.19 reference', () => {
    const store = open()
    seed(store, 31, 2, 20)
    for (const name of Object.keys(indexes)) store.database.exec(`DROP INDEX ${name}`)
    const baseline = new RunViews(store)
    const before = performance.now()
    const expected = legacyCalendar(store, baseline, '2026-10')
    const beforeMs = performance.now() - before
    baseline.dispose()
    // Recreate the exact new indexes without re-seeding or changing synthetic records.
    const tables = [
      'tasks',
      'run_tasks',
      'run_tasks',
      'account_runs',
      'point_credits',
      'balance_observations',
      'runs',
      'runs'
    ]
    Object.entries(indexes).forEach(([name, columns], index) => {
      const table = tables[index]
      if (!table) throw new Error('Missing synthetic index table')
      const suffix = name === 'idx_runs_started_at' ? ' DESC' : ''
      store.database.exec(`CREATE INDEX ${name} ON ${table}(${columns.join(', ')}${suffix})`)
    })
    const optimized = new RunViews(store)
    const after = performance.now()
    const actual = optimized.calendar('2026-10')
    const afterMs = performance.now() - after
    optimized.dispose()
    expect(actual).toEqual(expected)
    expect(actual).toHaveLength(93)
    console.info(
      'calendar cold benchmark:',
      JSON.stringify({
        days: 31,
        runs: 62,
        accounts: 3,
        taskSnapshots: 3720,
        evidenceRows: 7440,
        beforeMs: Math.round(beforeMs),
        afterMs: Math.round(afterMs)
      })
    )
  }, 60_000)
})
