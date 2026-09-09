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
  constructor(private readonly db: DatabaseSync) {}

  record(input: CreditInput): void {
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
    if (!stable) next.verificationStatus = 'pending'
    // A retry report cannot demote an existing confirmed credit or move its owning run.
    if (previous?.verificationStatus === 'confirmed' && !conflict) return
    if (previous && Date.parse(previous.observedAt) > Date.parse(next.observedAt) && !conflict)
      return
    this.db
      .prepare(
        `INSERT INTO point_credits(credit_key, account_id, run_id, business_date, payload_json)
      VALUES(?,?,?,?,?) ON CONFLICT(credit_key) DO UPDATE SET business_date=excluded.business_date, payload_json=excluded.payload_json`
      )
      .run(creditKey, next.accountId, next.runId, next.businessDate, JSON.stringify(next))
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

  confirmed(row: Credit): number | null {
    if (
      row.legacyUnverified ||
      row.conflict ||
      row.verificationStatus !== 'confirmed' ||
      row.earnedPoints === null
    )
      return null
    if (row.evidenceSource === 'official-credit' && row.officialCreditId) return row.earnedPoints
    if (
      row.evidenceSource !== 'isolated-balance' ||
      !row.isolationVerified ||
      !row.beforeSnapshotId ||
      !row.afterSnapshotId
    )
      return null
    const snapshots = this.db
      .prepare(
        'SELECT snapshot_id, run_id, account_id, business_date, observed_at, balance, phase FROM balance_observations WHERE snapshot_id IN (?,?)'
      )
      .all(row.beforeSnapshotId, row.afterSnapshotId) as {
      snapshot_id: string
      run_id: string
      account_id: string
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
    const rows = this.rows(accountId, date, runId).filter(
      (row) => row.evidenceSource !== 'account-balance'
    )
    const total = (values: (number | null)[]) =>
      values.length && values.every((value) => value !== null)
        ? values.reduce<number>((sum, value) => sum + value, 0)
        : null
    const reportedTaskPoints = total(rows.map((row) => row.reportedPoints))
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
    const sumVerified = verified.reduce<number>((sum, value) => sum + (value ?? 0), 0)
    const conflict =
      rows.some((row) => row.conflict) || (delta !== null && sumVerified > Math.max(0, delta))
    const confirmedTaskPoints =
      conflict || delta === null || !rows.length || !verified.some((value) => value !== null)
        ? null
        : sumVerified
    const pending = rows.filter(
      (row, index) => row.submitted && (verified[index] === null || conflict)
    )
    const pendingTaskPoints = pending.length
      ? total(pending.map((row) => row.expectedPoints))
      : rows.length
        ? 0
        : null
    const overreportedTaskPoints =
      reportedTaskPoints === null || delta === null
        ? null
        : Math.max(0, reportedTaskPoints - Math.max(0, delta))
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
          : verified.some((value) => value === null) || (unattributedBalanceDelta ?? 0) > 0
            ? 'partial'
            : 'confirmed'
    }
  }
}
