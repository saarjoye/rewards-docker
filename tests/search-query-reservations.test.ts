import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Worker } from 'node:worker_threads'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { SearchQueryReservations } from '../src/infra/SearchQueryReservations.js'
import { SearchQueryPool, cleanSearchQueries } from '../src/orchestration/SearchQueryPool.js'

const databases: DatabaseSync[] = []
const roots: string[] = []
afterEach(() => {
  for (const database of databases.splice(0)) database.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  vi.doUnmock('node:fs')
  vi.resetModules()
})

function open(path = ':memory:') {
  const database = new DatabaseSync(path)
  databases.push(database)
  database.exec('PRAGMA busy_timeout = 5000')
  return { database, allocator: new SearchQueryReservations(database) }
}

const input = {
  localDate: '2026-09-21',
  accountId: 'synthetic-a',
  taskId: 'pc',
  candidates: ['甲', '乙', '丙']
}

describe('durable daily query reservations', () => {
  it('shares reservations across accounts and PC/mobile tasks, and resets only on a new day', () => {
    const { allocator, database } = open()
    expect(allocator.reserve(input)).toBe('甲')
    expect(allocator.reserve({ ...input, taskId: 'mobile' })).toBe('乙')
    expect(allocator.reserve({ ...input, accountId: 'synthetic-b' })).toBe('丙')
    expect(allocator.reserve(input)).toBeNull()
    expect(allocator.reserve({ ...input, localDate: '2026-09-22' })).toBe('甲')
    const rows = database.prepare('SELECT * FROM search_query_reservations').all()
    expect(rows).toHaveLength(4)
    expect(rows[0]?.query_hash).toMatch(/^[a-f0-9]{64}$/u)
    expect(rows[0]).not.toHaveProperty('query')
  })

  it('does not release reservations on restart and does not allow duplicate explicit queries', () => {
    const root = mkdtempSync(join(tmpdir(), 'search-reservations-'))
    roots.push(root)
    const path = join(root, 'test.sqlite')
    const first = open(path)
    expect(first.allocator.reserve({ ...input, candidates: ['  ＡＢＣ   科技 '] })).not.toBeNull()
    first.database.close()
    databases.splice(databases.indexOf(first.database), 1)
    const second = open(path)
    expect(second.allocator.reserve({ ...input, candidates: ['abc 科技'] })).toBeNull()
    expect(second.allocator.reserve(input)).toBe('甲')
  })

  it('rolls back a failed allocation without leaving an open transaction', () => {
    const { allocator } = open()
    function* broken(): Generator<string> {
      yield ''
      throw new Error('synthetic allocation failure')
    }
    expect(() => allocator.reserve({ ...input, candidates: broken() })).toThrow(
      'synthetic allocation failure'
    )
    expect(allocator.reserve(input)).toBe('甲')
  })

  it('allocates different words to concurrent database connections', async () => {
    const root = mkdtempSync(join(tmpdir(), 'search-concurrent-'))
    roots.push(root)
    const path = join(root, 'test.sqlite')
    open(path)
    const results = await Promise.all(
      Array.from(
        { length: 4 },
        (_, index) =>
          new Promise<unknown>((resolveResult, reject) => {
            const worker = new Worker(
              `
        require('tsx/cjs');
        const { DatabaseSync } = require('node:sqlite');
        const { parentPort, workerData } = require('node:worker_threads');
        const { SearchQueryReservations } = require(workerData.module);
        const database = new DatabaseSync(workerData.path);
        database.exec('PRAGMA busy_timeout = 5000');
        const allocator = new SearchQueryReservations(database);
        const query = allocator.reserve(workerData.input);
        database.close();
        parentPort.postMessage(query);
      `,
              {
                eval: true,
                workerData: {
                  path,
                  module: resolve('src/infra/SearchQueryReservations.ts'),
                  input: {
                    ...input,
                    accountId: `synthetic-${String(index)}`,
                    candidates: ['甲', '乙', '丙', '丁']
                  }
                }
              }
            )
            let result: unknown
            worker.once('message', (value: unknown) => {
              result = value
            })
            worker.once('error', reject)
            worker.once('exit', (code) => {
              if (code === 0) resolveResult(result)
              else reject(new Error(`worker exit ${String(code)}`))
            })
          })
      )
    )
    expect(results).not.toContain(null)
    expect(new Set(results).size).toBe(4)
  })
})

describe('query dictionary loading', () => {
  it('ships at least 1000 unique normalized queries and copies custom dictionaries', () => {
    const pool = new SearchQueryPool()
    expect(pool.size).toBeGreaterThanOrEqual(1000)
    expect(new Set(pool.getQueries('stable-id', input.localDate, pool.size)).size).toBe(pool.size)
    expect(cleanSearchQueries(['  科技 ', '', 12, '科技', 'ＡＢＣ', 'abc'])).toEqual([
      '科技',
      'ＡＢＣ'
    ])
    const custom = ['甲', '乙']
    const isolated = new SearchQueryPool(custom)
    custom.splice(0)
    expect(isolated.size).toBe(2)
  })

  it.each(['missing', 'invalid'])(
    'uses exactly 52 base words when dictionary files are %s',
    async (kind) => {
      vi.resetModules()
      vi.doMock('node:fs', () => ({
        existsSync: () => kind !== 'missing',
        readFileSync: () => '{invalid json'
      }))
      const { SearchQueryPool: Pool, FALLBACK_SEARCH_TERMS } =
        await import('../src/orchestration/SearchQueryPool.js')
      const pool = new Pool()
      expect(pool.size).toBe(52)
      expect(new Set(pool.getQueries('a', input.localDate, 52))).toEqual(
        new Set(FALLBACK_SEARCH_TERMS)
      )
    }
  )
})
