import { describe, expect, it } from 'vitest'
import { SqliteStore } from '../src/infra/SqliteStore.js'

describe('task evidence journal', () => {
  it('rejects missing timezone and does not coerce unknown or invalid balances to zero', () => {
    const store = new SqliteStore(':memory:')
    const row = {
      runId: 'run',
      accountId: 'synthetic',
      taskId: 'task',
      source: 'rsc',
      kind: 'verification' as const,
      observedAt: '2026-09-08T01:00:00Z'
    }
    expect(() => {
      store.ledger.recordTaskEvidence({ ...row, observedAt: '2026-09-08T01:00:00' })
    }).toThrow()
    store.ledger.recordTaskEvidence({ ...row, balance: -1, completed: 30, total: 30 })
    expect(store.ledger.balances('run')).toHaveLength(0)
    expect(store.ledger.taskEvidence('run')[0]).toMatchObject({
      balance: null,
      confirmedPoints: null,
      completed: 30
    })
    store.close()
  })
  it('retains observations without turning balance or completion into credit', () => {
    const store = new SqliteStore(':memory:')
    const row = {
      runId: 'run',
      accountId: 'synthetic',
      taskId: 'task',
      source: 'app-dashboard',
      kind: 'response' as const,
      observedAt: '2026-09-08T01:00:00Z',
      balance: 5088,
      accepted: true
    }
    store.ledger.recordTaskEvidence(row)
    store.ledger.recordTaskEvidence(row)
    expect(store.ledger.taskEvidence('run')).toHaveLength(1)
    expect(store.ledger.taskEvidence('run')[0]).toMatchObject({
      balance: 5088,
      confirmedPoints: null
    })
    expect(store.ledger.balances('run')[0]?.balance).toBe(5088)
    store.close()
  })
})
