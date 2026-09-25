import { createHash, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

import {
  normalizeSearchQuery,
  type SearchQueryAllocationInput,
  type SearchQueryAllocator
} from '../domain/SearchQueryAllocation.js'

export class SearchQueryReservations implements SearchQueryAllocator {
  constructor(private readonly database: DatabaseSync) {
    database.exec(`CREATE TABLE IF NOT EXISTS search_query_reservations (
      local_date TEXT NOT NULL,
      query_hash TEXT NOT NULL,
      account_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      allocation_id TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      PRIMARY KEY (local_date, query_hash)
    )`)
  }

  reserve(input: SearchQueryAllocationInput): string | null {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const insert = this.database.prepare(`INSERT INTO search_query_reservations
        (local_date, query_hash, account_id, task_id, allocation_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(local_date, query_hash) DO NOTHING`)
      let selected: string | null = null
      for (const query of input.candidates) {
        const normalized = normalizeSearchQuery(query)
        if (!normalized) continue
        const hash = createHash('sha256').update(normalized).digest('hex')
        const result = insert.run(
          input.localDate,
          hash,
          input.accountId,
          input.taskId,
          randomUUID(),
          new Date().toISOString()
        )
        if (result.changes > 0) {
          selected = query
          break
        }
      }
      this.database.exec('COMMIT')
      return selected
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }
}
