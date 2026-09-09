import { localDateKey } from '../domain/DateKey.js'
import type { BalanceObservation } from '../infra/RunLedger.js'
import type { SqliteStore } from '../infra/SqliteStore.js'

export function balanceInterval(observations: readonly BalanceObservation[], requireStart = false) {
  const sorted = [...observations].sort((a, b) => a.observedAt.localeCompare(b.observedAt))
  const opening = requireStart ? sorted.find((row) => row.phase === 'start') : sorted[0]
  const closing = sorted.at(-1)
  const conflicts = new Map<string, number>()
  let conflicting = false
  for (const row of sorted) {
    if (conflicts.has(row.observedAt) && conflicts.get(row.observedAt) !== row.balance)
      conflicting = true
    conflicts.set(row.observedAt, row.balance)
  }
  const valid = opening && closing && opening.observedAt < closing.observedAt && !conflicting
  const delta = valid ? closing.balance - opening.balance : null
  const finalized =
    valid && sorted.some((row) => row.observedAt === closing.observedAt && row.phase === 'end')
  return {
    delta,
    openingBalance: opening?.balance ?? null,
    closingBalance: closing?.balance ?? null,
    observedFrom: opening?.observedAt ?? null,
    observedAt: closing?.observedAt ?? null,
    verificationStatus: delta === null ? 'pending' : finalized ? 'confirmed' : 'provisional',
    evidenceSources: [...new Set(sorted.map((row) => row.source))]
  }
}

export class RunViews {
  constructor(private readonly store: SqliteStore) {}

  day(accountId: string, businessDate: string) {
    const balances = this.store.ledger.balances(undefined, accountId, businessDate)
    const interval = balanceInterval(balances)
    return {
      businessDate,
      timezone: 'Asia/Shanghai',
      dailyBalanceDelta: interval.delta,
      ...interval
    }
  }

  run(runId: string, activeRunId?: string) {
    const run = this.store.getRun(runId)
    if (!run) return undefined
    const snapshots = this.store.ledger.tasks(runId)
    const taskEvidence = this.store.ledger.taskEvidence(runId)
    const balances = this.store.ledger.balances(runId)
    const lifecycle = this.store.ledger.accounts(runId)
    const legacy = this.store.listAccountRuns(runId)
    const ids = new Set([
      ...lifecycle.map((row) => row.accountId),
      ...legacy.map((row) => row.accountId),
      ...snapshots.map((row) => row.accountId),
      ...balances.map((row) => row.accountId)
    ])
    const accounts = [...ids].map((accountId) => {
      const execution = lifecycle.find((row) => row.accountId === accountId)
      const old = legacy.find((row) => row.accountId === accountId)
      const tasks = snapshots.filter((row) => row.accountId === accountId)
      const observed = balances.filter((row) => row.accountId === accountId)
      const interval = balanceInterval(observed, true)
      const dates = [
        ...new Set([
          ...observed.map((row) => row.businessDate),
          ...tasks.map((row) => row.localDate),
          old?.localDate ?? run.localDate
        ])
      ].sort()
      const interrupted = ['interrupted', 'cancelled'].includes(
        execution?.executionState ?? run.status
      )
      const runBalanceDelta =
        interrupted && interval.verificationStatus !== 'confirmed' ? null : interval.delta
      return {
        accountId,
        accountIndex: execution?.accountIndex ?? old?.runAccountIndex ?? null,
        accountLabel: execution?.accountLabel ?? '标签待确认',
        executionState: execution?.executionState ?? old?.status ?? 'unknown',
        startedAt: execution?.startedAt ?? null,
        endedAt: execution?.endedAt ?? null,
        runBalanceDelta,
        dailyBalances: dates.map((date) => this.day(accountId, date)),
        reportedTaskPoints: null,
        confirmedTaskPoints: null,
        pendingTaskPoints: null,
        pendingTaskCount: tasks.filter((task) => task.status !== 'skipped').length,
        verificationStatus: runBalanceDelta === null ? 'pending' : interval.verificationStatus,
        observedAt: interval.observedAt,
        evidenceSources: interval.evidenceSources,
        legacyUnverified: !execution,
        taskEvidence: taskEvidence.filter((row) => row.accountId === accountId),
        tasks
      }
    })
    const deltas = accounts.map((row) => row.runBalanceDelta)
    return {
      ...run,
      accounts,
      tasks: snapshots,
      persistence: activeRunId === runId ? 'live' : 'durable',
      accountsTotal: run.selectedAccountIndexes.length,
      accountsProcessed: lifecycle.filter((row) => row.endedAt !== null).length,
      accountsCompleted: lifecycle.filter((row) => row.executionState === 'completed').length,
      runBalanceDelta:
        deltas.length && deltas.every((value) => value !== null)
          ? deltas.reduce<number>((sum, value) => sum + value, 0)
          : null,
      detailUrl: `/api/runs/${runId}`,
      timezone: 'Asia/Shanghai',
      dataFreshness: activeRunId === runId ? 'live' : 'historical'
    }
  }

  calendar(month: string, activeRunId?: string) {
    const runCache = new Map<string, ReturnType<RunViews['run']>>()
    const pairs = this.store.database
      .prepare(
        `SELECT account_id AS accountId, business_date AS businessDate, run_id AS runId FROM balance_observations WHERE business_date LIKE ?
      UNION SELECT account_id, business_date, run_id FROM run_tasks WHERE business_date LIKE ?
      UNION SELECT account_id, local_date, run_id FROM account_runs WHERE local_date LIKE ?
      UNION SELECT a.account_id, r.local_date, r.run_id FROM account_lifecycle a JOIN runs r ON a.run_id = r.run_id WHERE r.local_date LIKE ?`
      )
      .all(`${month}-%`, `${month}-%`, `${month}-%`, `${month}-%`) as Array<{
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
            if (!runCache.has(id)) runCache.set(id, this.run(id, activeRunId))
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
          ...this.day(first.accountId, first.businessDate),
          accountId: first.accountId,
          accountIndex: account?.accountIndex ?? null,
          accountLabel: account?.accountLabel ?? '标签待确认',
          reportedTaskPoints: null,
          confirmedTaskPoints: null,
          pendingTaskCount: tasks.size,
          pendingTaskPoints: null,
          records: records.map((row) => ({
            runId: row.runId,
            status: row.status,
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

  today() {
    return this.calendar(localDateKey().slice(0, 7)).filter(
      (row) => row.businessDate === localDateKey()
    )
  }
}
