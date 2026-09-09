import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import type {
  MutationLedgerState,
  ReadableMutationLedger
} from '../orchestration/MutationExecutor.js'

export class HashedMutationLedger implements ReadableMutationLedger {
  private readonly database: DatabaseSync

  constructor(
    path: string,
    private readonly accountIndex: number,
    private readonly localDate: string
  ) {
    if (!Number.isInteger(accountIndex) || accountIndex < 1) {
      throw new RangeError('accountIndex must be a positive integer')
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(localDate)) {
      throw new TypeError('localDate must use YYYY-MM-DD')
    }
    mkdirSync(dirname(path), { recursive: true })
    this.database = new DatabaseSync(path)
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS acceptance_mutations (
        account_index INTEGER NOT NULL,
        local_date TEXT NOT NULL,
        task_hash TEXT PRIMARY KEY,
        state TEXT NOT NULL
      );
    `)
  }

  beginMutation(taskId: string): boolean {
    const result = this.database
      .prepare(
        `INSERT OR IGNORE INTO acceptance_mutations
          (account_index, local_date, task_hash, state)
         VALUES (?, ?, ?, 'submission-started')`
      )
      .run(this.accountIndex, this.localDate, this.hashTaskId(taskId))
    return result.changes === 1
  }

  cancelMutation(taskId: string): void {
    this.database
      .prepare(
        `DELETE FROM acceptance_mutations
         WHERE account_index = ? AND local_date = ? AND task_hash = ? AND state = 'submission-started'`
      )
      .run(this.accountIndex, this.localDate, this.hashTaskId(taskId))
  }

  updateMutation(taskId: string, state: Exclude<MutationLedgerState, 'submission-started'>): void {
    this.database
      .prepare(
        `UPDATE acceptance_mutations
         SET state = ?
         WHERE account_index = ? AND local_date = ? AND task_hash = ?`
      )
      .run(state, this.accountIndex, this.localDate, this.hashTaskId(taskId))
  }

  getMutationState(taskId: string): MutationLedgerState | undefined {
    const row = this.database
      .prepare(
        `SELECT state FROM acceptance_mutations
         WHERE account_index = ? AND local_date = ? AND task_hash = ?`
      )
      .get(this.accountIndex, this.localDate, this.hashTaskId(taskId)) as
      | { state: MutationLedgerState }
      | undefined
    return row?.state
  }

  close(): void {
    this.database.close()
  }

  private hashTaskId(taskId: string): string {
    const marker = `:${this.localDate}:`
    const markerIndex = taskId.indexOf(marker)
    const logicalKey = markerIndex >= 0 ? taskId.slice(markerIndex + marker.length) : taskId
    return createHash('sha256')
      .update(`${String(this.accountIndex)}\0${this.localDate}\0${logicalKey}`)
      .digest('hex')
  }
}
