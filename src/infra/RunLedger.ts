import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { localDateKey } from '../domain/DateKey.js'
import type { FieldEvidence, EvidenceSource } from '../domain/Evidence.js'
import type { SearchEvent, TaskRecord } from '../domain/Task.js'
import { redactText } from '../security/Redactor.js'
import { PointCredits, type CreditInput } from './PointCredits.js'
import { balanceInterval } from './BalanceInterval.js'
import { taskBoundAccountState } from '../domain/RunOutcome.js'

export interface BalanceObservation {
  runId: string
  accountId: string
  snapshotId?: string
  taskId?: string | null
  phase: 'start' | 'live' | 'end' | 'task-before' | 'task-after'
  balance: number
  observedAt: string
  businessDate: string
  source: EvidenceSource
}

export interface TaskEvidence {
  search?: SearchEvent
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
  credit?: Omit<CreditInput, 'runId' | 'accountId' | 'taskId' | 'source' | 'observedAt'>
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
    | 'partial'
    | 'failed'
    | 'cancelled'
    | 'interrupted'
    | 'action-required'
  updatedAt: string
  completionSource?: string | null
  completionEventKey?: string | null
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
      CREATE TABLE IF NOT EXISTS account_completions (
        event_key TEXT PRIMARY KEY, run_id TEXT NOT NULL, account_id TEXT NOT NULL,
        ended_at TEXT NOT NULL, payload_json TEXT NOT NULL, UNIQUE(run_id, account_id)
      );
      CREATE TABLE IF NOT EXISTS point_credits (
        credit_key TEXT PRIMARY KEY, account_id TEXT NOT NULL, run_id TEXT NOT NULL,
        business_date TEXT NOT NULL, payload_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS credit_account_day ON point_credits(account_id, business_date);
      INSERT OR IGNORE INTO schema_version(version, applied_at)
        VALUES (4, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
    `)
    const columns = database.prepare('PRAGMA table_info(account_lifecycle)').all() as {
      name: string
    }[]
    for (const name of ['completion_source', 'completion_event_key']) {
      if (!columns.some((column) => column.name === name))
        database.exec(`ALTER TABLE account_lifecycle ADD COLUMN ${name} TEXT`)
    }
    const balanceColumns = database.prepare('PRAGMA table_info(balance_observations)').all() as {
      name: string
    }[]
    if (!balanceColumns.some((column) => column.name === 'task_id'))
      database.exec('ALTER TABLE balance_observations ADD COLUMN task_id TEXT NULL')
    database.exec(`CREATE INDEX IF NOT EXISTS balance_task_scope ON balance_observations(run_id, account_id, business_date, task_id, observed_at);
      INSERT OR IGNORE INTO schema_version(version, applied_at) VALUES (5, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));`)
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}

export class RunLedger {
  taskEvidenceForScope(
    runId: string | undefined,
    accountId: string,
    businessDate: string
  ): boolean {
    return Boolean(
      this.database
        .prepare(
          `SELECT 1 FROM task_evidence WHERE account_id=? AND (? IS NULL OR run_id=?) AND json_extract(payload_json,'$.businessDate')=? LIMIT 1`
        )
        .get(accountId, runId ?? null, runId ?? null, businessDate)
    )
  }
  readonly credits: PointCredits
  constructor(
    private readonly database: DatabaseSync,
    private readonly changed: () => void = () => undefined
  ) {
    this.credits = new PointCredits(database, changed)
  }

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
      creditKey: null as string | null,
      ...(input.search ? { search: input.search } : {})
    }
    const payload = JSON.stringify(row)
    const hash = createHash('sha256').update(payload)
    if (
      input.credit?.officialCreditId ||
      input.credit?.beforeSnapshotId ||
      input.credit?.evidenceSource
    )
      hash.update(
        JSON.stringify([
          input.credit.officialCreditId ?? null,
          input.credit.beforeSnapshotId ?? null,
          input.credit.afterSnapshotId ?? null,
          input.credit.evidenceSource ?? null,
          input.credit.earnedPoints ?? null
        ])
      )
    const id = input.search
      ? createHash('sha256')
          .update(
            JSON.stringify([input.runId, input.accountId, input.taskId, input.search.eventId])
          )
          .digest('hex')
      : hash.digest('hex')
    this.database.exec('SAVEPOINT task_evidence_write')
    try {
      this.database
        .prepare('INSERT OR IGNORE INTO task_evidence VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, row.runId, row.accountId, row.taskId, row.observedAt, payload)
      if (row.balance !== null)
        this.balance(
          row.runId,
          row.accountId,
          row.kind === 'response' || row.kind === 'verification' ? 'task-after' : 'live',
          {
            availability: 'valid',
            value: row.balance,
            source: 'browser-response',
            confidence: 1,
            observedAt: row.observedAt
          },
          row.taskId
        )
      else if (!input.search && (row.kind === 'response' || row.kind === 'verification'))
        this.captureTaskBalance(row.runId, row.accountId, 'task-after', row.taskId)
      if (!input.search && row.kind === 'execution' && row.executionState === 'running')
        this.captureTaskBalance(row.runId, row.accountId, 'task-before', row.taskId)
      const task = this.tasks(input.runId).find((item) => item.taskId === input.taskId)
      if (task && task.accountId !== input.accountId)
        throw new TypeError('Task evidence account does not match the run task')
      if (task && input.credit?.businessDate && input.credit.businessDate !== task.localDate)
        throw new TypeError('Credit business date does not match the run task')
      const hasCreditObservation =
        row.accepted === true ||
        input.credit?.submitted === true ||
        input.credit?.evidenceSource !== undefined ||
        task?.reportedPoints !== undefined
      const credit =
        hasCreditObservation && !input.search
          ? this.credits.record({
              ...(task?.identityStable === false ? {} : { taskInstanceId: task?.sourceTaskId }),
              businessDate: task?.localDate,
              creditType: task?.type ?? 'task',
              reportedPoints: task?.reportedPoints ?? null,
              expectedPoints: task?.expectedPoints ?? null,
              submitted:
                (row.kind === 'response' && row.accepted === true) ||
                row.executionState === 'submitted',
              ...input.credit,
              runId: row.runId,
              accountId: row.accountId,
              taskId: row.taskId,
              source: task?.source ?? row.source,
              observedAt: row.observedAt
            })
          : undefined
      if (credit) {
        row.creditKey = credit.creditKey
        this.database
          .prepare('UPDATE task_evidence SET payload_json=? WHERE evidence_id=?')
          .run(JSON.stringify(row), id)
      }
      this.database.exec('RELEASE task_evidence_write')
    } catch (error) {
      this.database.exec('ROLLBACK TO task_evidence_write; RELEASE task_evidence_write')
      throw error
    }
    this.changed()
  }

  taskEvidence(
    runId: string
  ): Array<TaskEvidence & { confirmedPoints: number | null; creditKey: string | null }> {
    const rows = this.database
      .prepare(
        'SELECT payload_json FROM task_evidence WHERE run_id = ? ORDER BY observed_at, evidence_id'
      )
      .all(runId) as Array<{ payload_json: string }>
    const credits = this.credits.rowsForRun(runId)
    return rows.map((row) => {
      const evidence = JSON.parse(row.payload_json) as TaskEvidence & {
        confirmedPoints: number | null
        creditKey: string | null
      }
      const credit = credits.find(
        (item) =>
          item.creditKey === evidence.creditKey &&
          item.accountId === evidence.accountId &&
          item.taskId === evidence.taskId
      )
      return { ...evidence, confirmedPoints: credit ? this.credits.confirmed(credit) : null }
    })
  }

  captureTaskBalance(
    runId: string,
    accountId: string,
    phase: 'task-before' | 'task-after',
    taskId?: string
  ): void {
    const latest = this.balances(runId, accountId).at(-1)
    if (latest)
      this.balance(
        runId,
        accountId,
        phase,
        {
          availability: 'valid',
          value: latest.balance,
          source: latest.source,
          confidence: 1,
          observedAt: latest.observedAt
        },
        taskId
      )
  }

  task(runId: string, task: TaskRecord): TaskRecord {
    if (!task.searchObservation && (task.type === 'pc-search' || task.type === 'mobile-search')) {
      const previous = this.latestSearchTask(task.taskId)
      if (
        previous?.searchObservation &&
        (previous.searchObservation.awaitingProgress || previous.searchObservation.runId === runId)
      ) {
        task = {
          ...task,
          searchObservation: previous.searchObservation,
          progress: previous.progress,
          status: previous.searchObservation.awaitingProgress
            ? 'verification-pending'
            : previous.status,
          ...(previous.reason ? { reason: previous.reason } : {})
        }
      }
    }
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
      ...(task.searchObservation ? { searchObservation: { ...task.searchObservation } } : {}),
      updatedAt: task.updatedAt,
      ...(task.identityStable === undefined ? {} : { identityStable: task.identityStable }),
      ...(task.reason === undefined ? {} : { reason: redactText(task.reason) }),
      ...(task.reportedPoints === undefined ? {} : { reportedPoints: task.reportedPoints }),
      ...(task.expectedPoints === undefined ? {} : { expectedPoints: task.expectedPoints })
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
    return payload
  }

  latestSearchTask(taskId: string): TaskRecord | undefined {
    const row = this.database
      .prepare(
        `SELECT payload_json FROM run_tasks
      WHERE task_id = ? AND json_type(payload_json, '$.searchObservation') = 'object'
      ORDER BY julianday(updated_at) DESC, rowid DESC LIMIT 1`
      )
      .get(taskId) as { payload_json: string } | undefined
    return row ? (JSON.parse(row.payload_json) as TaskRecord) : undefined
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
    if (
      input.executionState === 'completed' &&
      taskBoundAccountState(
        input.executionState,
        this.tasks(input.runId).filter((task) => task.accountId === input.accountId)
      ) !== 'completed'
    )
      input = { ...input, executionState: 'partial' }
    this.database.exec('SAVEPOINT account_completion_write')
    try {
      this.database
        .prepare(
          `INSERT INTO account_lifecycle(run_id, account_id, account_index, account_label, started_at, ended_at, execution_state, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id, account_id) DO UPDATE SET
        started_at = COALESCE(account_lifecycle.started_at, excluded.started_at),
        ended_at = excluded.ended_at, execution_state = excluded.execution_state,
        updated_at = excluded.updated_at
      WHERE excluded.updated_at >= account_lifecycle.updated_at
        AND (account_lifecycle.ended_at IS NULL OR (excluded.execution_state='completed' AND account_lifecycle.execution_state!='completed'))`
        )
        .run(
          input.runId,
          input.accountId,
          input.accountIndex,
          redactText(input.accountLabel),
          input.startedAt,
          input.endedAt,
          input.executionState,
          input.updatedAt
        )
      const current = this.accounts(input.runId).find((row) => row.accountId === input.accountId)
      if (current?.endedAt && current.executionState === input.executionState) {
        const eventKey = `account-complete:${input.runId}:${input.accountId}`
        const observations = this.balances(input.runId, input.accountId)
        const interval = balanceInterval(observations, true)
        const delta = interval.verificationStatus === 'confirmed' ? interval.delta : null
        const tasks = this.tasks(input.runId).filter((task) => task.accountId === input.accountId)
        const diagnostic = this.database
          .prepare('SELECT stage, message FROM account_runs WHERE run_id=? AND account_id=?')
          .get(input.runId, input.accountId) as
          | { stage: string | null; message: string | null }
          | undefined
        const event = {
          ...current,
          eventType: 'ACCOUNT-END',
          status: current.executionState,
          success: current.executionState === 'completed',
          initialPoints: interval.openingBalance,
          finalPoints: delta === null ? null : interval.closingBalance,
          collectedPoints: delta,
          balanceConfirmed: delta !== null,
          failureStage: diagnostic?.stage ? redactText(diagnostic.stage) : null,
          failureReason: diagnostic?.message ? redactText(diagnostic.message) : null,
          completedTasks: tasks.filter((task) => task.status === 'completed').length,
          unconfirmedTasks: tasks.filter((task) => !['completed', 'skipped'].includes(task.status))
            .length,
          duration: current.startedAt
            ? Math.max(0, Date.parse(current.endedAt) - Date.parse(current.startedAt))
            : null,
          completionSource: 'ACCOUNT-END',
          completionEventKey: eventKey,
          verificationStatus: delta === null ? 'pending' : 'confirmed'
        }
        this.database
          .prepare(
            `INSERT INTO account_completions VALUES (?,?,?,?,?)
        ON CONFLICT(event_key) DO UPDATE SET payload_json=excluded.payload_json, ended_at=excluded.ended_at
        WHERE json_extract(account_completions.payload_json, '$.success') != 1`
          )
          .run(eventKey, input.runId, input.accountId, current.endedAt, JSON.stringify(event))
        this.database
          .prepare(
            'UPDATE account_lifecycle SET completion_source=?, completion_event_key=? WHERE run_id=? AND account_id=?'
          )
          .run('ACCOUNT-END', eventKey, input.runId, input.accountId)
      }
      this.database.exec('RELEASE account_completion_write')
    } catch (error) {
      this.database.exec('ROLLBACK TO account_completion_write; RELEASE account_completion_write')
      throw error
    }
    this.changed()
  }

  accounts(runId: string): AccountLifecycle[] {
    return this.database
      .prepare(
        `SELECT run_id AS runId, account_id AS accountId,
      account_index AS accountIndex, account_label AS accountLabel, started_at AS startedAt,
      ended_at AS endedAt, execution_state AS executionState, updated_at AS updatedAt,
      completion_source AS completionSource, completion_event_key AS completionEventKey
      FROM account_lifecycle WHERE run_id = ? ORDER BY account_index`
      )
      .all(runId) as unknown as AccountLifecycle[]
  }

  balance(
    runId: string,
    accountId: string,
    phase: BalanceObservation['phase'],
    evidence: FieldEvidence<number>,
    taskId?: string
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
      .update(
        JSON.stringify([
          runId,
          accountId,
          phase,
          observedAt,
          evidence.source,
          ...(taskId ? [taskId] : [])
        ])
      )
      .digest('hex')
    this.database
      .prepare(
        'INSERT OR IGNORE INTO balance_observations(snapshot_id, run_id, account_id, phase, balance, observed_at, business_date, source, task_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        key,
        runId,
        accountId,
        phase,
        evidence.value,
        observedAt,
        localDateKey(new Date(observedAt)),
        evidence.source,
        taskId ?? null
      )
    // Task evidence uses a savepoint: announce only after its complete transaction commits.
    if (!this.database.isTransaction) this.changed()
  }

  balances(runId?: string, accountId?: string, businessDate?: string): BalanceObservation[] {
    const sql = `SELECT snapshot_id AS snapshotId, run_id AS runId, account_id AS accountId, phase, balance,
      observed_at AS observedAt, business_date AS businessDate, source, task_id AS taskId FROM balance_observations`
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
