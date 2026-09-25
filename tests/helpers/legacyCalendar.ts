// next.19 calendar reference, retained only for synthetic equivalence and timing checks.
import type { SqliteStore } from '../../src/infra/SqliteStore.js'
import type { RunViews } from '../../src/web/RunViews.js'

export function legacyCalendar(
  store: SqliteStore,
  views: RunViews,
  month: string,
  activeRunId?: string
) {
  const runCache = new Map<string, ReturnType<RunViews['run']>>()
  const pairs = store.database
    .prepare(
      `SELECT account_id AS accountId, business_date AS businessDate, run_id AS runId FROM balance_observations WHERE business_date LIKE ?
      UNION SELECT account_id, business_date, run_id FROM run_tasks WHERE business_date LIKE ?
      UNION SELECT account_id, local_date, run_id FROM account_runs WHERE local_date LIKE ?
      UNION SELECT account_id, business_date, run_id FROM point_credits WHERE business_date LIKE ?
      UNION SELECT a.account_id, r.local_date, r.run_id FROM account_lifecycle a JOIN runs r ON a.run_id = r.run_id WHERE r.local_date LIKE ?
      UNION SELECT account_id, date(COALESCE(started_at, updated_at), '+8 hours'), run_id FROM account_lifecycle
        WHERE date(COALESCE(started_at, updated_at), '+8 hours') LIKE ?
      UNION SELECT account_id, date(ended_at, '+8 hours'), run_id FROM account_lifecycle
        WHERE date(ended_at, '+8 hours') LIKE ?`
    )
    .all(...Array<string>(7).fill(`${month}-%`)) as Array<{
    accountId: string
    businessDate: string
    runId: string
  }>
  const groups = new Map<string, typeof pairs>()
  for (const pair of pairs) {
    const key = `${pair.businessDate}:${pair.accountId}`
    groups.set(key, [...(groups.get(key) ?? []), pair])
  }
  return [...groups.values()]
    .map((group) => {
      const first = group[0]
      if (!first) throw new Error('Empty calendar group')
      const records = [...new Set(group.map((row) => row.runId))]
        .map((id) => {
          if (!runCache.has(id)) runCache.set(id, views.run(id, activeRunId))
          return runCache.get(id)
        })
        .filter((row) => row !== undefined)
      const account = records
        .flatMap((row) => row.accounts)
        .find((row) => row.accountId === first.accountId)
      const tasks = new Map(
        records
          .flatMap((row) => row.tasks)
          .filter(
            (row) => row.accountId === first.accountId && row.localDate === first.businessDate
          )
          .map((row) => [row.taskId, row])
      )
      return {
        ...views.day(first.accountId, first.businessDate),
        accountId: first.accountId,
        accountIndex: account?.accountIndex ?? null,
        accountLabel: account?.accountLabel ?? '标签—',
        taskCount: tasks.size,
        records: records.map((row) => ({
          runId: row.runId,
          status: row.status,
          runStatusLabel: row.runStatusLabel,
          executionMode: row.executionMode,
          executionModeLabel: row.executionModeLabel,
          accountsEnded: row.accountsEnded,
          accountsCompleted: row.accountsCompleted,
          accountsPartial: row.accountsPartial,
          accountsFailed: row.accountsFailed,
          accountsNotCompleted: row.accountsNotCompleted,
          accountsTotal: row.accountsTotal,
          detailUrl: row.detailUrl,
          startedAt: row.startedAt,
          endedAt: row.finishedAt ?? null,
          persistence: row.persistence
        }))
      }
    })
    .sort(
      (a, b) =>
        a.businessDate.localeCompare(b.businessDate) ||
        (a.accountIndex ?? 0) - (b.accountIndex ?? 0)
    )
}
