import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { localDateKey } from '../domain/DateKey.js'
import type { FieldEvidence } from '../domain/Evidence.js'
import type { TaskRecord } from '../domain/Task.js'
import { redactText } from '../security/Redactor.js'

export interface BalanceObservation {
  runId: string
  accountId: string
  phase: 'start' | 'live' | 'end'
  balance: number
  observedAt: string
  businessDate: string
  source: string
}

export interface TaskEvidence {
  runId: string
  accountId: string
  taskId: string
  source: string
  kind: 'response' | 'verification' | 'execution'
  observedAt: string
  balance?: number
  accepted?: boolean
  completed?: number
  total?: number | null
  executionState?: string
}

export interface AccountLifecycle {
  runId: string
  accountId: string
  accountIndex: number
  accountLabel: string
  startedAt: string | null
  endedAt: string | null
  executionState:
    | 'queued'
    | 'running'
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'interrupted'
    | 'action-required'
  updatedAt: string
}

export function migrateRunLedger(database: DatabaseSync): void {
  database.exec('BEGIN IMMEDIATE')
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS run_tasks (
        run_id TEXT NOT NULL, task_id TEXT NOT NULL, account_id TEXT NOT NULL,
        business_date TEXT NOT NULL, updated_at TEXT NOT NULL, payload_json TEXT NOT NULL,
        PRIMARY KEY(run_id, task_id)
      );
      CREATE TABLE IF NOT EXISTS balance_observations (
        snapshot_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, account_id TEXT NOT NULL,
        phase TEXT NOT NULL, balance INTEGER NOT NULL CHECK(balance >= 0),
        observed_at TEXT NOT NULL, business_date TEXT NOT NULL, source TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS balance_account_day ON balance_observations(account_id, business_date, observed_at);
      CREATE TABLE IF NOT EXISTS task_evidence (
        evidence_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, account_id TEXT NOT NULL,
        task_id TEXT NOT NULL, observed_at TEXT NOT NULL, payload_json TEXT NOT NULL
      );
      INSERT OR IGNORE INTO schema_version(version, applied_at)
        VALUES (3, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
      CREATE TABLE IF NOT EXISTS account_lifecycle (
        run_id TEXT NOT NULL, account_id TEXT NOT NULL, account_index INTEGER NOT NULL,
        account_label TEXT NOT NULL, started_at TEXT, ended_at TEXT,
        execution_state TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY(run_id, account_id)
      );
      INSERT OR IGNORE INTO schema_version(version, applied_at)
        VALUES (2, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
    `)
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}

export class RunLedger {
  constructor(private readonly database: DatabaseSync) {}

  recordTaskEvidence(input: TaskEvidence): void {
    if (
      !Number.isFinite(Date.parse(input.observedAt)) ||
      !/(Z|[+-]\d{2}:\d{2})$/.test(input.observedAt)
    )
      throw new TypeError('Task evidence requires an actual observation timestamp')
    const numeric = (value: unknown): value is number =>
      Number.isSafeInteger(value) && Number(value) >= 0
    // An observation is not a credit. Never persist raw adapter responses.
    const row = {
      runId: input.runId,
      accountId: input.accountId,
      taskId: input.taskId,
      source: input.source,
      kind: input.kind,
      observedAt: new Date(input.observedAt).toISOString(),
      businessDate: localDateKey(new Date(input.observedAt)),
      balance: numeric(input.balance) ? input.balance : null,
      accepted: typeof input.accepted === 'boolean' ? input.accepted : null,
      completed: numeric(input.completed) ? input.completed : null,
      total: numeric(input.total) ? input.total : null,
      executionState: input.executionState ? redactText(input.executionState) : null,
      confirmedPoints: null,
      creditKey: null
    }
    const payload = JSON.stringify(row)
    const id = createHash('sha256').update(payload).digest('hex')
    this.database.exec('SAVEPOINT task_evidence_write')
    try {
      this.database
        .prepare('INSERT OR IGNORE INTO task_evidence VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, row.runId, row.accountId, row.taskId, row.observedAt, payload)
      if (row.balance !== null)
        this.balance(row.runId, row.accountId, 'live', {
          availability: 'valid',
          value: row.balance,
          source: 'browser-response',
          confidence: 1,
          observedAt: row.observedAt
        })
      this.database.exec('RELEASE task_evidence_write')
    } catch (error) {
      this.database.exec('ROLLBACK TO task_evidence_write; RELEASE task_evidence_write')
      throw error
    }
  }

  taskEvidence(runId: string): Array<TaskEvidence & { confirmedPoints: null }> {
    const rows = this.database
      .prepare(
        'SELECT payload_json FROM task_evidence WHERE run_id = ? ORDER BY observed_at, evidence_id'
      )
      .all(runId) as Array<{ payload_json: string }>
    return rows.map(
      (row) => JSON.parse(row.payload_json) as TaskEvidence & { confirmedPoints: null }
    )
  }

  task(runId: string, task: TaskRecord): void {
    // Persist only the public task model, never an adapter descriptor or response.
    const payload: TaskRecord = {
      taskId: task.taskId,
      accountId: task.accountId,
      localDate: task.localDate,
      sourceTaskId: task.sourceTaskId,
      type: task.type,
      source: task.source,
      displayName: redactText(task.displayName),
      executable: task.executable,
      required: task.required,
      status: task.status,
      progress: { ...task.progress },
      updatedAt: task.updatedAt,
      ...(task.reason === undefined ? {} : { reason: redactText(task.reason) })
    }
    this.database
      .prepare(
        `INSERT INTO run_tasks VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id, task_id) DO UPDATE SET updated_at = excluded.updated_at,
        payload_json = excluded.payload_json WHERE excluded.updated_at >= run_tasks.updated_at`
      )
      .run(
        runId,
        task.taskId,
        task.accountId,
        task.localDate,
        task.updatedAt,
        JSON.stringify(payload)
      )
  }

  tasks(runId: string): TaskRecord[] {
    const rows = this.database
      .prepare(
        'SELECT payload_json FROM run_tasks WHERE run_id = ? ORDER BY business_date, account_id, task_id'
      )
      .all(runId) as Array<{ payload_json: string }>
    return rows.map((row) => JSON.parse(row.payload_json) as TaskRecord)
  }

  lifecycle(input: AccountLifecycle): void {
    this.database
      .prepare(
        `INSERT INTO account_lifecycle VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id, account_id) DO UPDATE SET
        started_at = COALESCE(account_lifecycle.started_at, excluded.started_at),
        ended_at = excluded.ended_at, execution_state = excluded.execution_state,
        updated_at = excluded.updated_at
      WHERE excluded.updated_at >= account_lifecycle.updated_at
        AND account_lifecycle.ended_at IS NULL`
      )
      .run(
        input.runId,
        input.accountId,
        input.accountIndex,
        input.accountLabel,
        input.startedAt,
        input.endedAt,
        input.executionState,
        input.updatedAt
      )
  }

  accounts(runId: string): AccountLifecycle[] {
    return this.database
      .prepare(
        `SELECT run_id AS runId, account_id AS accountId,
      account_index AS accountIndex, account_label AS accountLabel, started_at AS startedAt,
      ended_at AS endedAt, execution_state AS executionState, updated_at AS updatedAt
      FROM account_lifecycle WHERE run_id = ? ORDER BY account_index`
      )
      .all(runId) as unknown as AccountLifecycle[]
  }

  balance(
    runId: string,
    accountId: string,
    phase: BalanceObservation['phase'],
    evidence: FieldEvidence<number>
  ): void {
    if (
      evidence.availability !== 'valid' ||
      !Number.isSafeInteger(evidence.value) ||
      evidence.value === undefined ||
      evidence.value < 0 ||
      !Number.isFinite(evidence.confidence) ||
      evidence.confidence < 0.8 ||
      !Number.isFinite(Date.parse(evidence.observedAt)) ||
      !/(Z|[+-]\d{2}:\d{2})$/.test(evidence.observedAt)
    )
      return
    const observedAt = new Date(evidence.observedAt).toISOString()
    const key = createHash('sha256')
      .update(JSON.stringify([runId, accountId, phase, observedAt, evidence.source]))
      .digest('hex')
    this.database
      .prepare('INSERT OR IGNORE INTO balance_observations VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(
        key,
        runId,
        accountId,
        phase,
        evidence.value,
        observedAt,
        localDateKey(new Date(observedAt)),
        evidence.source
      )
  }

  balances(runId?: string, accountId?: string, businessDate?: string): BalanceObservation[] {
    const sql = `SELECT run_id AS runId, account_id AS accountId, phase, balance,
      observed_at AS observedAt, business_date AS businessDate, source FROM balance_observations`
    return this.database
      .prepare(
        `${sql} WHERE (? IS NULL OR run_id = ?)
      AND (? IS NULL OR account_id = ?) AND (? IS NULL OR business_date = ?) ORDER BY observed_at`
      )
      .all(
        runId ?? null,
        runId ?? null,
        accountId ?? null,
        accountId ?? null,
        businessDate ?? null,
        businessDate ?? null
      ) as unknown as BalanceObservation[]
  }
}
