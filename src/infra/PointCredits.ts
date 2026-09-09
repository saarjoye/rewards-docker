import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { localDateKey } from '../domain/DateKey.js'

const amount = z.number().int().nonnegative().nullable().default(null)
export const creditInput = z
  .object({
    runId: z.string().min(1),
    accountId: z.string().min(1),
    taskId: z.string().min(1),
    source: z.string().min(1).max(100),
    observedAt: z.iso.datetime({ offset: true }),
    businessDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    officialCreditId: z.string().min(1).max(512).optional(),
    taskInstanceId: z.string().min(1).max(512).optional(),
    creditType: z.string().min(1).max(100).default('task'),
    reportedPoints: amount,
    expectedPoints: amount,
    earnedPoints: amount,
    verificationStatus: z.enum(['pending', 'confirmed']).default('pending'),
    evidenceSource: z
      .enum([
        'task-report',
        'official-credit',
        'official-progress',
        'isolated-balance',
        'account-balance'
      ])
      .default('task-report'),
    beforeSnapshotId: z.string().optional(),
    afterSnapshotId: z.string().optional(),
    isolationVerified: z.boolean().default(false),
    submitted: z.boolean().default(false)
  })
  .strict()
export type CreditInput = z.input<typeof creditInput>
export type Credit = z.output<typeof creditInput> & {
  creditKey: string
  businessDate: string
  legacyUnverified: boolean
  conflict: boolean
}

export class PointCredits {
  constructor(
    private readonly db: DatabaseSync,
    private readonly changed: () => void = () => undefined
  ) {}

  record(input: CreditInput): Credit {
    const value = creditInput.parse(input)
    value.observedAt = new Date(value.observedAt).toISOString()
    const businessDate = value.businessDate ?? localDateKey(new Date(value.observedAt))
    const stable = Boolean(value.officialCreditId || value.taskInstanceId)
    const identity = value.officialCreditId
      ? [value.accountId, value.source, value.officialCreditId]
      : [
          value.accountId,
          value.source,
          businessDate,
          value.taskInstanceId ?? `${value.runId}:${value.taskId}`,
          value.creditType
        ]
    const creditKey = createHash('sha256').update(JSON.stringify(identity)).digest('hex')
    const old = this.db
      .prepare('SELECT payload_json FROM point_credits WHERE credit_key=?')
      .get(creditKey) as { payload_json: string } | undefined
    const previous = old ? (JSON.parse(old.payload_json) as Credit) : undefined
    const conflict =
      previous?.conflict === true ||
      (previous?.verificationStatus === 'confirmed' &&
        value.verificationStatus === 'confirmed' &&
        previous.earnedPoints !== value.earnedPoints)
    const next: Credit = {
      ...value,
      runId: previous?.runId ?? value.runId,
      creditKey,
      businessDate: previous?.businessDate ?? businessDate,
      legacyUnverified: !stable,
      conflict
    }
    next.submitted ||= previous?.submitted === true
    next.reportedPoints ??= previous?.reportedPoints ?? null
    next.expectedPoints ??= previous?.expectedPoints ?? null
    if (
      next.officialCreditId &&
      ['official-credit', 'official-progress'].includes(next.evidenceSource)
    ) {
      const report = this.rows(next.accountId, next.businessDate, next.runId).find(
        (row) => row.taskId === next.taskId && row.evidenceSource !== 'official-credit'
      )
      next.reportedPoints ??= report?.reportedPoints ?? null
      next.expectedPoints ??= report?.expectedPoints ?? null
    }
    if (!stable) next.verificationStatus = 'pending'
    if (this.confirmed(next) === null) next.verificationStatus = 'pending'
    // A retry report cannot demote an existing confirmed credit or move its owning run.
    if (previous && this.confirmed(previous) !== null && !conflict) return previous
    if (previous && Date.parse(previous.observedAt) > Date.parse(next.observedAt) && !conflict)
      return previous
    if (previous?.evidenceSource === 'official-progress' && next.evidenceSource === 'task-report')
      next.evidenceSource = 'official-progress'
    this.db
      .prepare(
        `INSERT INTO point_credits(credit_key, account_id, run_id, business_date, payload_json)
      VALUES(?,?,?,?,?) ON CONFLICT(credit_key) DO UPDATE SET business_date=excluded.business_date, payload_json=excluded.payload_json`
      )
      .run(creditKey, next.accountId, next.runId, next.businessDate, JSON.stringify(next))
    if (!this.db.isTransaction) this.changed()
    return next
  }

  rows(accountId: string, date?: string, runId?: string): Credit[] {
    return (
      this.db
        .prepare(
          `SELECT payload_json FROM point_credits WHERE account_id=?
      AND (? IS NULL OR business_date=?) AND (? IS NULL OR run_id=?)`
        )
        .all(accountId, date ?? null, date ?? null, runId ?? null, runId ?? null) as {
        payload_json: string
      }[]
    ).map((row) => JSON.parse(row.payload_json) as Credit)
  }

  rowsForRun(runId: string): Credit[] {
    return (
      this.db.prepare('SELECT payload_json FROM point_credits WHERE run_id=?').all(runId) as {
        payload_json: string
      }[]
    ).map((row) => JSON.parse(row.payload_json) as Credit)
  }

  taskPoints(runId: string, accountId: string, taskId: string, businessDate: string) {
    const empty = {
      taskEarnedPoints: null as number | null,
      taskEarnedPointsSource: null as string | null,
      taskEarnedPointsStatus: 'unavailable',
      taskCreditKey: null as string | null
    }
    const credits = this.rows(accountId, businessDate, runId).filter((row) => row.taskId === taskId)
    if (credits.some((row) => row.conflict)) return empty
    for (const source of ['official-credit', 'official-progress', 'isolated-balance']) {
      const valid = credits.filter(
        (row) => row.evidenceSource === source && this.confirmed(row) !== null
      )
      if (valid.length)
        return {
          taskEarnedPoints: valid.reduce((sum, row) => sum + (this.confirmed(row) ?? 0), 0),
          taskEarnedPointsSource: source,
          taskEarnedPointsStatus: 'confirmed',
          taskCreditKey: valid
            .map((row) => row.creditKey)
            .sort()
            .join(',')
        }
    }
    // A rejected explicit attribution must not be revived by the snapshot fallback.
    if (credits.some((row) => row.evidenceSource === 'isolated-balance')) return empty
    // Only explicit task boundaries may be attributed. Legacy account snapshots stay account-only.
    const snapshots = this.db
      .prepare(
        `SELECT snapshot_id, task_id, phase, balance, observed_at FROM balance_observations
      WHERE run_id=? AND account_id=? AND business_date=? ORDER BY observed_at`
      )
      .all(runId, accountId, businessDate) as {
      snapshot_id: string
      task_id: string | null
      phase: string
      balance: number
      observed_at: string
    }[]
    const before = snapshots.find((row) => row.task_id === taskId && row.phase === 'task-before')
    const after = snapshots.findLast((row) => row.task_id === taskId && row.phase === 'task-after')
    if (
      !before ||
      !after ||
      before.observed_at >= after.observed_at ||
      after.balance < before.balance
    )
      return empty
    const interval = snapshots.filter(
      (row) => row.observed_at >= before.observed_at && row.observed_at <= after.observed_at
    )
    const competingWindows = this.db
      .prepare(
        `SELECT MIN(observed_at) AS start, MAX(observed_at) AS end,
      SUM(CASE WHEN phase='task-after' THEN 1 ELSE 0 END) AS closed
      FROM balance_observations WHERE account_id=? AND business_date=?
      AND phase IN ('task-before','task-after') AND (run_id<>? OR task_id IS NULL OR task_id<>?)
      GROUP BY run_id, task_id`
      )
      .all(accountId, businessDate, runId, taskId) as {
      start: string
      end: string
      closed: number
    }[]
    if (
      competingWindows.some(
        (window) =>
          window.start < after.observed_at &&
          (window.closed === 0 || window.end > before.observed_at)
      )
    )
      return empty
    const times = new Map<string, number>()
    for (const row of interval) {
      if (times.has(row.observed_at) && times.get(row.observed_at) !== row.balance) return empty
      times.set(row.observed_at, row.balance)
      if (
        row.task_id !== taskId &&
        ['task-before', 'task-after'].includes(row.phase) &&
        row.observed_at > before.observed_at &&
        row.observed_at < after.observed_at
      )
        return empty
    }
    if (
      this.rows(accountId, businessDate).some(
        (row) =>
          row.taskId !== taskId &&
          row.observedAt > before.observed_at &&
          row.observedAt <= after.observed_at
      )
    )
      return empty
    return {
      taskEarnedPoints: after.balance - before.balance,
      taskEarnedPointsSource: 'isolated-balance',
      taskEarnedPointsStatus: 'confirmed',
      taskCreditKey: createHash('sha256')
        .update(JSON.stringify([before.snapshot_id, after.snapshot_id]))
        .digest('hex')
    }
  }

  confirmed(row: Credit): number | null {
    if (
      row.legacyUnverified ||
      row.conflict ||
      row.verificationStatus !== 'confirmed' ||
      row.earnedPoints === null
    )
      return null
    if (
      ['official-credit', 'official-progress'].includes(row.evidenceSource) &&
      row.officialCreditId
    )
      return row.earnedPoints
    if (
      row.evidenceSource !== 'isolated-balance' ||
      !row.isolationVerified ||
      !row.beforeSnapshotId ||
      !row.afterSnapshotId
    )
      return null
    const snapshots = this.db
      .prepare(
        'SELECT snapshot_id, run_id, account_id, task_id, business_date, observed_at, balance, phase FROM balance_observations WHERE snapshot_id IN (?,?)'
      )
      .all(row.beforeSnapshotId, row.afterSnapshotId) as {
      snapshot_id: string
      run_id: string
      account_id: string
      task_id: string | null
      business_date: string
      observed_at: string
      balance: number
      phase: string
    }[]
    const before = snapshots.find((item) => item.snapshot_id === row.beforeSnapshotId)
    const after = snapshots.find((item) => item.snapshot_id === row.afterSnapshotId)
    if (
      !before ||
      !after ||
      before.phase !== 'task-before' ||
      after.phase !== 'task-after' ||
      before.task_id !== row.taskId ||
      after.task_id !== row.taskId ||
      before.run_id !== after.run_id ||
      before.run_id !== row.runId ||
      before.account_id !== row.accountId ||
      after.account_id !== row.accountId ||
      before.business_date !== row.businessDate ||
      after.business_date !== row.businessDate ||
      before.observed_at >= after.observed_at ||
      after.balance - before.balance !== row.earnedPoints ||
      Date.parse(row.observedAt) < Date.parse(after.observed_at)
    )
      return null
    // Competing attribution windows invalidate isolation instead of splitting the delta.
    const competing = this.rows(row.accountId, row.businessDate).some((other) => {
      if (other.creditKey === row.creditKey || !other.beforeSnapshotId || !other.afterSnapshotId)
        return false
      const window = this.db
        .prepare(
          'SELECT MIN(observed_at) AS start, MAX(observed_at) AS end FROM balance_observations WHERE snapshot_id IN (?,?)'
        )
        .get(other.beforeSnapshotId, other.afterSnapshotId) as {
        start: string | null
        end: string | null
      }
      return (
        window.start !== null &&
        window.end !== null &&
        window.start < after.observed_at &&
        window.end > before.observed_at
      )
    })
    return competing ? null : row.earnedPoints
  }

  reconcile(accountId: string, delta: number | null, date?: string, runId?: string) {
    const allRows = this.rows(accountId, date, runId)
    const priority = (row: Credit) =>
      [
        'official-credit',
        'official-progress',
        'isolated-balance',
        'task-report',
        'account-balance'
      ].indexOf(row.evidenceSource)
    const rows = allRows.filter(
      (row) =>
        row.evidenceSource !== 'account-balance' &&
        !allRows.some(
          (other) =>
            priority(other) < priority(row) &&
            this.confirmed(other) !== null &&
            other.runId === row.runId &&
            other.taskId === row.taskId &&
            other.businessDate === row.businessDate
        )
    )
    const total = (values: (number | null)[]) =>
      values.length && values.every((value) => value !== null)
        ? values.reduce<number>((sum, value) => sum + value, 0)
        : null
    const reportedTaskPoints = total(
      rows.map((row) => row.reportedPoints).filter((value) => value !== null)
    )
    const scope = this.db
      .prepare(
        `SELECT MIN(observed_at) AS start, MAX(observed_at) AS end FROM balance_observations
      WHERE account_id=? AND (? IS NULL OR business_date=?) AND (? IS NULL OR run_id=?)`
      )
      .get(accountId, date ?? null, date ?? null, runId ?? null, runId ?? null) as {
      start: string | null
      end: string | null
    }
    const verified = rows.map((row) =>
      scope.start && scope.end && row.observedAt >= scope.start && row.observedAt <= scope.end
        ? this.confirmed(row)
        : null
    )
    const taskScopes = this.db
      .prepare(
        `SELECT DISTINCT run_id, task_id, business_date
      FROM balance_observations WHERE account_id=? AND task_id IS NOT NULL
      AND (? IS NULL OR business_date=?) AND (? IS NULL OR run_id=?)`
      )
      .all(accountId, date ?? null, date ?? null, runId ?? null, runId ?? null) as {
      run_id: string
      task_id: string
      business_date: string
    }[]
    const derived = taskScopes.flatMap((task) => {
      if (
        rows.some(
          (row, index) =>
            row.runId === task.run_id &&
            row.taskId === task.task_id &&
            row.businessDate === task.business_date &&
            verified[index] !== null
        )
      )
        return []
      const points = this.taskPoints(task.run_id, accountId, task.task_id, task.business_date)
      return points.taskEarnedPoints !== null &&
        points.taskEarnedPointsSource === 'isolated-balance'
        ? [{ ...task, points: points.taskEarnedPoints }]
        : []
    })
    const sumVerified =
      verified.reduce<number>((sum, value) => sum + (value ?? 0), 0) +
      derived.reduce((sum, task) => sum + task.points, 0)
    const conflict =
      rows.some((row) => row.conflict) || (delta !== null && sumVerified > Math.max(0, delta))
    const confirmedTaskPoints =
      conflict || delta === null || (!derived.length && !verified.some((value) => value !== null))
        ? null
        : sumVerified
    const pending = rows.filter(
      (row, index) =>
        row.submitted &&
        (conflict ||
          (verified[index] === null &&
            !derived.some(
              (task) =>
                task.run_id === row.runId &&
                task.task_id === row.taskId &&
                task.business_date === row.businessDate
            )))
    )
    const pendingTaskPoints = pending.length
      ? total(pending.map((row) => row.expectedPoints))
      : rows.length || derived.length
        ? 0
        : null
    const overreportedTaskPoints =
      reportedTaskPoints === null || delta === null ? null : Math.max(0, reportedTaskPoints - delta)
    const legacyBalance = this.rows(accountId, date, runId).some(
      (row) => row.evidenceSource === 'account-balance'
    )
    const unattributedBalanceDelta =
      delta === null || delta < 0 || conflict || legacyBalance || (overreportedTaskPoints ?? 0) > 0
        ? null
        : delta - (confirmedTaskPoints ?? 0)
    return {
      reportedTaskPoints,
      confirmedTaskPoints,
      pendingTaskPoints,
      pendingTaskCount: pending.length,
      unattributedBalanceDelta,
      overreportedTaskPoints,
      legacyUnverified: rows.some((row) => row.legacyUnverified),
      creditVerificationStatus: conflict
        ? 'conflict'
        : confirmedTaskPoints === null
          ? 'pending'
          : pending.length > 0 || (unattributedBalanceDelta ?? 0) > 0
            ? 'partial'
            : 'confirmed'
    }
  }
}
