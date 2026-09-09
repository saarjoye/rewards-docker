import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import type { FieldEvidence } from '../domain/Evidence.js'
import type { AccountRunStatus } from '../domain/AccountRun.js'
import type { TaskRecord } from '../domain/Task.js'
import type { AccountRunSummary, RunStatus, RunSummary } from '../domain/RunState.js'
import type { ExecutionMode } from '../domain/RunRequest.js'
import { RunLedger, migrateRunLedger } from './RunLedger.js'
import { redactText } from '../security/Redactor.js'

export interface PointsHistoryRecord {
  accountId: string
  localDate: string
  initialPoints: number | null
  finalPoints: number | null
  gainedPoints: number | null
  status: AccountRunStatus
  balanceConfirmed: boolean
  recordedAt: string
}

export class SqliteStore {
  readonly database: DatabaseSync
  readonly ledger: RunLedger

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true })
    this.database = new DatabaseSync(path)
    this.database.exec(
      'PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;'
    )
    this.migrate()
    migrateRunLedger(this.database)
    this.ledger = new RunLedger(this.database)
  }

  close(): void {
    this.database.close()
  }

  recoverInterruptedRuns(at = new Date().toISOString()): void {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      this.database
        .prepare(
          `UPDATE account_lifecycle SET execution_state = 'interrupted', updated_at = ?
        WHERE execution_state = 'running' AND ended_at IS NULL`
        )
        .run(at)
      this.database
        .prepare(
          `UPDATE account_runs SET status = 'partial',
        stage = 'interrupted', message = 'Previous process ended before verification', updated_at = ?
        WHERE status = 'running' AND run_id IN
          (SELECT run_id FROM runs WHERE status IN ('queued', 'running', 'cancelling'))`
        )
        .run(at)
      this.database
        .prepare(
          `UPDATE runs SET status = 'interrupted'
        WHERE status IN ('queued', 'running', 'cancelling')`
        )
        .run()
      this.database.exec('COMMIT')
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }

  upsertAccountRun(input: {
    runId: string
    accountId: string
    runAccountIndex: number
    localDate: string
    status: AccountRunStatus
    stage?: string
    message?: string
    updatedAt: string
  }): void {
    this.database
      .prepare(
        `
        INSERT INTO account_runs(run_id, account_id, run_account_index, local_date, status, stage, message, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id, account_id) DO UPDATE SET
          run_account_index = excluded.run_account_index,
          status = excluded.status,
          stage = excluded.stage,
          message = excluded.message,
          updated_at = excluded.updated_at
      `
      )
      .run(
        input.runId,
        input.accountId,
        input.runAccountIndex,
        input.localDate,
        input.status,
        input.stage ?? null,
        input.message ?? null,
        input.updatedAt
      )
  }

  createRun(input: {
    runId: string
    localDate: string
    executionMode: ExecutionMode
    selectedAccountIndexes: readonly number[]
    startedAt: string
  }): void {
    this.database
      .prepare(
        `INSERT INTO runs(run_id, local_date, execution_mode, status, selected_indexes_json, started_at)
       VALUES (?, ?, ?, 'queued', ?, ?)`
      )
      .run(
        input.runId,
        input.localDate,
        input.executionMode,
        JSON.stringify(input.selectedAccountIndexes),
        input.startedAt
      )
  }

  updateRun(runId: string, status: RunStatus, finishedAt?: string): void {
    this.database
      .prepare('UPDATE runs SET status = ?, finished_at = ? WHERE run_id = ?')
      .run(status, finishedAt ?? null, runId)
  }

  listRuns(limit = 20, offset = 0, runId?: string): RunSummary[] {
    const rows = this.database
      .prepare(
        `SELECT run_id, local_date, execution_mode, status, selected_indexes_json, started_at, finished_at
         FROM runs WHERE (? IS NULL OR run_id = ?) ORDER BY started_at DESC LIMIT ? OFFSET ?`
      )
      .all(runId ?? null, runId ?? null, limit, offset) as Array<{
      run_id: string
      local_date: string
      execution_mode: ExecutionMode
      status: RunStatus
      selected_indexes_json: string
      started_at: string
      finished_at: string | null
    }>
    return rows.map((row) => ({
      runId: row.run_id,
      localDate: row.local_date,
      executionMode: row.execution_mode,
      status: row.status,
      selectedAccountIndexes: JSON.parse(row.selected_indexes_json) as number[],
      startedAt: row.started_at,
      ...(row.finished_at === null ? {} : { finishedAt: row.finished_at })
    }))
  }

  getRun(runId: string): RunSummary | undefined {
    return this.listRuns(1, 0, runId)[0]
  }

  listAccountRuns(runId: string): AccountRunSummary[] {
    const rows = this.database
      .prepare(
        `SELECT run_id, account_id, run_account_index, local_date, status, stage, message, updated_at
         FROM account_runs WHERE run_id = ? ORDER BY run_account_index`
      )
      .all(runId) as Array<{
      run_id: string
      account_id: string
      run_account_index: number
      local_date: string
      status: AccountRunStatus
      stage: string | null
      message: string | null
      updated_at: string
    }>
    return rows.map((row) => ({
      runId: row.run_id,
      accountId: row.account_id,
      runAccountIndex: row.run_account_index,
      localDate: row.local_date,
      status: row.status,
      ...(row.stage === null ? {} : { stage: row.stage }),
      ...(row.message === null ? {} : { message: row.message }),
      updatedAt: row.updated_at
    }))
  }

  isAccountCompleteForDate(accountId: string, localDate: string): boolean {
    const row = this.database
      .prepare(
        `SELECT status FROM account_runs
         WHERE account_id = ? AND local_date = ? ORDER BY updated_at DESC LIMIT 1`
      )
      .get(accountId, localDate) as { status: AccountRunStatus } | undefined
    return row?.status === 'success'
  }

  upsertTask(task: TaskRecord, runId?: string): void {
    this.database.exec('SAVEPOINT task_snapshot')
    try {
      if (runId) this.ledger.task(runId, task)
      this.upsertCurrentTask(task)
      this.database.exec('RELEASE task_snapshot')
    } catch (error) {
      this.database.exec('ROLLBACK TO task_snapshot; RELEASE task_snapshot')
      throw error
    }
  }

  private upsertCurrentTask(task: TaskRecord): void {
    this.database
      .prepare(
        `
        INSERT INTO tasks(
          task_id, account_id, local_date, source_task_id, type, source, display_name,
          executable, required, status, completed, total, reason, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(task_id) DO UPDATE SET
          display_name = excluded.display_name,
          executable = excluded.executable,
          required = excluded.required,
          status = excluded.status,
          completed = excluded.completed,
          total = excluded.total,
          reason = excluded.reason,
          updated_at = excluded.updated_at
      `
      )
      .run(
        task.taskId,
        task.accountId,
        task.localDate,
        task.sourceTaskId,
        task.type,
        task.source,
        redactText(task.displayName),
        task.executable ? 1 : 0,
        task.required ? 1 : 0,
        task.status,
        task.progress.completed,
        task.progress.total,
        task.reason === undefined ? null : redactText(task.reason),
        task.updatedAt
      )
  }

  getTask(taskId: string): TaskRecord | undefined {
    const row = this.database
      .prepare(
        `SELECT task_id, account_id, local_date, source_task_id, type, source, display_name,
                executable, required, status, completed, total, reason, updated_at
         FROM tasks WHERE task_id = ?`
      )
      .get(taskId) as
      | {
          task_id: string
          account_id: string
          local_date: string
          source_task_id: string
          type: string
          source: string
          display_name: string
          executable: number
          required: number
          status: string
          completed: number
          total: number | null
          reason: string | null
          updated_at: string
        }
      | undefined
    if (!row) return undefined
    return {
      taskId: row.task_id,
      accountId: row.account_id,
      localDate: row.local_date,
      sourceTaskId: row.source_task_id,
      type: row.type as TaskRecord['type'],
      source: row.source as TaskRecord['source'],
      displayName: row.display_name,
      executable: row.executable === 1,
      required: row.required === 1,
      status: row.status as TaskRecord['status'],
      progress: { completed: row.completed, total: row.total },
      ...(row.reason === null ? {} : { reason: row.reason }),
      updatedAt: row.updated_at
    }
  }

  recordPoints(input: {
    accountId: string
    localDate: string
    initialPoints?: number
    finalPoints?: number
    status: AccountRunStatus
    balanceConfirmed: boolean
    recordedAt: string
  }): void {
    const gained =
      input.initialPoints === undefined || input.finalPoints === undefined
        ? null
        : input.finalPoints - input.initialPoints
    const balanceConfirmed =
      input.balanceConfirmed &&
      Number.isSafeInteger(input.initialPoints) &&
      (input.initialPoints ?? -1) >= 0 &&
      Number.isSafeInteger(input.finalPoints) &&
      (input.finalPoints ?? -1) >= 0
    this.database
      .prepare(
        `INSERT INTO points_history(
          account_id, local_date, initial_points, final_points, gained_points, status,
          balance_confirmed, recorded_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.accountId,
        input.localDate,
        input.initialPoints ?? null,
        input.finalPoints ?? null,
        gained,
        input.status,
        balanceConfirmed ? 1 : 0,
        input.recordedAt
      )
  }

  getLatestPointsHistory(accountId: string, localDate: string): PointsHistoryRecord | undefined {
    const row = this.database
      .prepare(
        `SELECT account_id, local_date, initial_points, final_points, gained_points, status,
                balance_confirmed, recorded_at
         FROM points_history
         WHERE account_id = ? AND local_date = ?
         ORDER BY id DESC LIMIT 1`
      )
      .get(accountId, localDate) as
      | {
          account_id: string
          local_date: string
          initial_points: number | null
          final_points: number | null
          gained_points: number | null
          status: AccountRunStatus
          balance_confirmed: number
          recorded_at: string
        }
      | undefined
    if (!row) return undefined
    return {
      accountId: row.account_id,
      localDate: row.local_date,
      initialPoints: row.initial_points,
      finalPoints: row.final_points,
      gainedPoints: row.gained_points,
      status: row.status,
      balanceConfirmed: row.balance_confirmed === 1,
      recordedAt: row.recorded_at
    }
  }

  recordEvidence<T>(input: {
    runId: string
    accountId: string
    field: string
    evidence: FieldEvidence<T>
  }): void {
    this.database
      .prepare(
        `
        INSERT INTO field_evidence(
          run_id, account_id, field, availability, source, confidence, observed_at, value_json, reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
      )
      .run(
        input.runId,
        input.accountId,
        input.field,
        input.evidence.availability,
        input.evidence.source,
        input.evidence.confidence,
        input.evidence.observedAt,
        input.evidence.value === undefined ? null : JSON.stringify(input.evidence.value),
        input.evidence.reason ?? null
      )
  }

  beginMutation(taskId: string, startedAt = new Date().toISOString()): boolean {
    const result = this.database
      .prepare(
        `
        INSERT OR IGNORE INTO mutation_ledger(task_id, state, started_at, updated_at)
        VALUES (?, 'submission-started', ?, ?)
      `
      )
      .run(taskId, startedAt, startedAt)
    return result.changes === 1
  }

  cancelMutation(taskId: string): void {
    this.database
      .prepare(`DELETE FROM mutation_ledger WHERE task_id = ? AND state = 'submission-started'`)
      .run(taskId)
  }

  updateMutation(
    taskId: string,
    state: 'submitted' | 'verification-pending' | 'verified' | 'failed',
    updatedAt = new Date().toISOString()
  ): void {
    this.database
      .prepare('UPDATE mutation_ledger SET state = ?, updated_at = ? WHERE task_id = ?')
      .run(state, updatedAt, taskId)
  }

  getMutationState(
    taskId: string
  ):
    | 'submission-started'
    | 'submitted'
    | 'verification-pending'
    | 'verified'
    | 'failed'
    | undefined {
    const row = this.database
      .prepare('SELECT state FROM mutation_ledger WHERE task_id = ?')
      .get(taskId) as { state: string } | undefined
    if (!row) return undefined
    if (
      row.state === 'submission-started' ||
      row.state === 'submitted' ||
      row.state === 'verification-pending' ||
      row.state === 'verified' ||
      row.state === 'failed'
    ) {
      return row.state
    }
    return undefined
  }

  listTaskState(localDate: string): TaskRecord[] {
    const rows = this.database
      .prepare(
        `
        SELECT task_id, account_id, local_date, source_task_id, type, source, display_name,
               executable, required, status, completed, total, reason, updated_at
        FROM tasks
        WHERE local_date = ?
        ORDER BY account_id, updated_at, task_id
      `
      )
      .all(localDate) as Array<{
      task_id: string
      account_id: string
      local_date: string
      source_task_id: string
      type: string
      source: string
      display_name: string
      executable: number
      required: number
      status: string
      completed: number
      total: number | null
      reason: string | null
      updated_at: string
    }>

    return rows.map((row) => {
      const task: TaskRecord = {
        taskId: row.task_id,
        accountId: row.account_id,
        localDate: row.local_date,
        sourceTaskId: row.source_task_id,
        type: row.type as TaskRecord['type'],
        source: row.source as TaskRecord['source'],
        displayName: row.display_name,
        executable: row.executable === 1,
        required: row.required === 1,
        status: row.status as TaskRecord['status'],
        progress: { completed: row.completed, total: row.total },
        updatedAt: row.updated_at
      }
      if (row.reason !== null) task.reason = row.reason
      return task
    })
  }

  private migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS account_runs (
        run_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        run_account_index INTEGER NOT NULL CHECK(run_account_index >= 1),
        local_date TEXT NOT NULL,
        status TEXT NOT NULL,
        stage TEXT,
        message TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(run_id, account_id)
      );

      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        local_date TEXT NOT NULL,
        execution_mode TEXT NOT NULL,
        status TEXT NOT NULL,
        selected_indexes_json TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT
      );

      CREATE TABLE IF NOT EXISTS accounts (
        account_id TEXT PRIMARY KEY,
        display_alias TEXT NOT NULL,
        encrypted_credentials TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS administrators (
        username TEXT PRIMARY KEY,
        password_digest TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS web_sessions (
        token_hash TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        csrf_hash TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(username) REFERENCES administrators(username) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS tasks (
        task_id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        local_date TEXT NOT NULL,
        source_task_id TEXT NOT NULL,
        type TEXT NOT NULL,
        source TEXT NOT NULL,
        display_name TEXT NOT NULL,
        executable INTEGER NOT NULL,
        required INTEGER NOT NULL,
        status TEXT NOT NULL,
        completed INTEGER NOT NULL,
        total INTEGER,
        reason TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS field_evidence (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        field TEXT NOT NULL,
        availability TEXT NOT NULL,
        source TEXT NOT NULL,
        confidence REAL NOT NULL CHECK(confidence >= 0 AND confidence <= 1),
        observed_at TEXT NOT NULL,
        value_json TEXT,
        reason TEXT
      );

      CREATE TABLE IF NOT EXISTS mutation_ledger (
        task_id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS points_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id TEXT NOT NULL,
        local_date TEXT NOT NULL,
        initial_points INTEGER,
        final_points INTEGER,
        gained_points INTEGER,
        status TEXT NOT NULL,
        balance_confirmed INTEGER NOT NULL,
        recorded_at TEXT NOT NULL
      );

      INSERT OR IGNORE INTO schema_version(version, applied_at)
      VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
    `)
  }
}
