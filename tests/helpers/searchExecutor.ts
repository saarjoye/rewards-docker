import { DatabaseSync } from 'node:sqlite'
import { afterEach } from 'vitest'

import { SearchQueryReservations } from '../../src/infra/SearchQueryReservations.js'
import { SearchExecutor } from '../../src/orchestration/SearchExecutor.js'

const databases: DatabaseSync[] = []
afterEach(() => {
  for (const database of databases.splice(0)) database.close()
})

export function createSearchExecutor(
  ...args: ConstructorParameters<typeof SearchExecutor>
): SearchExecutor {
  if (!args[8]) {
    const database = new DatabaseSync(':memory:')
    databases.push(database)
    args[8] = new SearchQueryReservations(database)
  }
  return new SearchExecutor(...args)
}
