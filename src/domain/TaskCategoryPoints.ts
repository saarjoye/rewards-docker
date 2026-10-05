import { pointAmount, type TaskPointDetail } from './TaskPointDetail.js'
import type { TaskPointSummary } from './TaskPointSummary.js'

export interface CategoryBalance {
  runId: string
  accountId: string
  businessDate: string
  taskId?: string | null
  snapshotId?: string
  phase: string
  balance: number
  observedAt: string
}

export interface CategoryCredit {
  runId: string
  accountId: string
  businessDate: string
  taskId: string
  observedAt: string
  evidenceSource: string
  confirmedPoints: number | null
  conflict: boolean
  beforeSnapshotId?: string | undefined
  afterSnapshotId?: string | undefined
}

interface Scope {
  runId: string
  accountId: string
}

const timestamp = (value: string) =>
  /(Z|[+-]\d{2}:\d{2})$/.test(value) ? Date.parse(value) : Number.NaN

function confirmedSum(tasks: readonly TaskPointDetail[]): number | null {
  const amounts = tasks.map((task) => pointAmount(task.confirmedPoints)).filter((n) => n !== null)
  return amounts.length ? pointAmount(amounts.reduce((sum, value) => sum + value, 0)) : null
}

/** A category may share cached boundaries internally, but not with another activity. */
function isolatedGain(
  tasks: readonly TaskPointDetail[],
  scope: Scope,
  balances: readonly CategoryBalance[],
  credits: readonly CategoryCredit[]
): number | null {
  if (!balances.length) return null
  const timed = balances.map((row) => ({ ...row, time: timestamp(row.observedAt) }))
  if (timed.some((row) => !Number.isFinite(row.time) || pointAmount(row.balance) === null))
    return null
  const ids = new Set(tasks.map((task) => task.taskId))
  const owns = (row: { runId: string; taskId?: string | null }) =>
    row.runId === scope.runId && row.taskId != null && ids.has(row.taskId)
  const windows = new Map<
    string,
    { runId: string; taskId: string | null; start: number; end: number }
  >()
  for (const row of timed) {
    if (row.phase !== 'task-before' && row.phase !== 'task-after') continue
    const key = JSON.stringify([row.runId, row.taskId ?? null])
    const window = windows.get(key) ?? {
      runId: row.runId,
      taskId: row.taskId ?? null,
      start: Infinity,
      end: -Infinity
    }
    if (row.phase === 'task-before') window.start = Math.min(window.start, row.time)
    else window.end = Math.max(window.end, row.time)
    windows.set(key, window)
  }
  const ownWindows = [...windows.values()].filter(owns)
  if (!ownWindows.length || ownWindows.some((row) => row.start > row.end)) return null
  // Skipped/unstarted tasks need no measurement. Every attempted task must have both boundaries.
  if (
    tasks.some(
      (task) =>
        (task.confirmedPoints !== null ||
          !['skipped', 'discovered', 'selected'].includes(task.status)) &&
        !ownWindows.some((window) => window.taskId === task.taskId)
    )
  )
    return null
  const start = Math.min(...ownWindows.map((row) => row.start))
  const end = Math.max(...ownWindows.map((row) => row.end))
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) return null
  const overlaps = (from: number, to: number) => from < end && to > start
  if (
    [...windows.values()].some(
      (window) =>
        !owns(window) &&
        overlaps(
          window.start === Infinity ? -Infinity : window.start,
          window.end === -Infinity ? Infinity : window.end
        )
    )
  )
    return null
  // Another run can have no task boundaries (for example a legacy search).
  const runs = new Map<string, typeof timed>()
  for (const row of timed) {
    if (row.runId === scope.runId) continue
    const group = runs.get(row.runId) ?? []
    group.push(row)
    runs.set(row.runId, group)
  }
  for (const rows of runs.values()) {
    const opening = rows.find((row) => row.phase === 'start')
    const endings = rows.filter((row) => row.phase === 'end')
    const closing = endings.length ? Math.max(...endings.map((row) => row.time)) : Infinity
    if (opening && overlaps(opening.time, closing)) return null
    if (
      rows.some(
        (row) => row.time > start && (row.time < end || (row.time === end && row.phase !== 'start'))
      )
    )
      return null
  }
  if (timed.some((row) => row.taskId != null && !owns(row) && row.time > start && row.time < end))
    return null
  const snapshots = new Map(timed.map((row) => [row.snapshotId, row.time]))
  for (const credit of credits) {
    if (owns(credit)) {
      // Do not revive an attribution the existing ledger rejected.
      if (credit.evidenceSource === 'isolated-balance' && credit.confirmedPoints === null)
        return null
      if (credit.confirmedPoints !== null) {
        const time = timestamp(credit.observedAt)
        if (!Number.isFinite(time) || time < start || time > end) return null
      }
      continue
    }
    const time = timestamp(credit.observedAt)
    if (!Number.isFinite(time) || (time > start && time <= end)) return null
    const from = credit.beforeSnapshotId ? snapshots.get(credit.beforeSnapshotId) : undefined
    const to = credit.afterSnapshotId ? snapshots.get(credit.afterSnapshotId) : undefined
    if (from !== undefined && to !== undefined && overlaps(from, to)) return null
  }
  const interval = timed
    .filter((row) => row.time >= start && row.time <= end)
    .sort((a, b) => a.time - b.time)
  for (let index = 1; index < interval.length; index += 1) {
    const previous = interval[index - 1]
    const current = interval[index]
    if (!previous || !current) return null
    if (
      current.balance < previous.balance ||
      (current.time === previous.time && current.balance !== previous.balance)
    )
      return null
  }
  const before = interval[0]
  const after = interval.at(-1)
  if (!before || !after) return null
  const gain = pointAmount(after.balance - before.balance)
  const known = confirmedSum(tasks)
  return gain !== null && (known === null || gain >= known) ? gain : null
}

/** Read-only notification scores. Expected values and account-wide residuals are never earnings. */
export function taskCategoryPoints(
  summaries: readonly TaskPointSummary[],
  scope: Scope,
  observations: readonly CategoryBalance[],
  evidence: readonly CategoryCredit[] = []
): Map<string, number> {
  const balances = observations.filter((row) => row.accountId === scope.accountId)
  const credits = evidence.filter((row) => row.accountId === scope.accountId)
  const result = new Map<string, number>()
  for (const summary of summaries) {
    const belongs = (row: CategoryCredit) =>
      row.runId === scope.runId &&
      summary.tasks.some(
        (task) => task.taskId === row.taskId && task.businessDate === row.businessDate
      )
    if (
      summary.tasks.some((task) => task.pointsStatus === 'conflict') ||
      credits.some(
        (row) =>
          belongs(row) &&
          (row.conflict ||
            (row.confirmedPoints !== null && pointAmount(row.confirmedPoints) === null))
      )
    )
      continue
    const days = new Map<string | null, TaskPointDetail[]>()
    for (const task of summary.tasks) {
      const group = days.get(task.businessDate) ?? []
      group.push(task)
      days.set(task.businessDate, group)
    }
    const amounts: number[] = []
    let overflow = false
    for (const [date, tasks] of days) {
      const known = confirmedSum(tasks)
      if (known === null && tasks.some((task) => pointAmount(task.confirmedPoints) !== null)) {
        overflow = true
        break
      }
      const inferred =
        date && tasks.some((task) => pointAmount(task.confirmedPoints) === null)
          ? isolatedGain(
              tasks,
              scope,
              balances.filter((row) => row.businessDate === date),
              credits.filter((row) => row.businessDate === date)
            )
          : null
      const value = inferred ?? known
      if (value !== null) amounts.push(value)
    }
    const total = amounts.length
      ? pointAmount(amounts.reduce((sum, value) => sum + value, 0))
      : null
    if (!overflow && total !== null) result.set(summary.key, total)
  }
  return result
}
