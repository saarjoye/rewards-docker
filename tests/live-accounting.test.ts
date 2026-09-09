import { describe, expect, it, vi } from 'vitest'
import { SqliteStore } from '../src/infra/SqliteStore.js'
import { RunViews } from '../src/web/RunViews.js'

function snapshot(
  store: SqliteStore,
  phase: 'start' | 'live' | 'end',
  balance: number,
  time: string,
  runId = 'run',
  accountId = 'account'
) {
  store.ledger.balance(runId, accountId, phase, {
    value: balance,
    availability: 'valid',
    confidence: 1,
    source: 'rsc',
    observedAt: time
  })
}
describe('scoped live accounting', () => {
  it('does not publish a total when simultaneous balance observations conflict', () => {
    const store = new SqliteStore(':memory:')
    try {
      snapshot(store, 'start', 1000, '2026-09-09T01:00:00Z')
      snapshot(store, 'live', 1110, '2026-09-09T01:01:00Z')
      snapshot(store, 'end', 1120, '2026-09-09T01:01:00Z')
      expect(new RunViews(store).accountDate('run', 'account', '2026-09-09')).toMatchObject({
        latestBalance: null,
        liveBalanceDelta: null,
        attributionStatus: 'conflict'
      })
    } finally {
      store.close()
    }
  })
  it('publishes observed values before finalization, including failed accounts', () => {
    const store = new SqliteStore(':memory:')
    try {
      const changed = vi.fn()
      store.subscribe(changed)
      snapshot(store, 'start', 1000, '2026-09-09T01:00:00Z')
      snapshot(store, 'live', 1110, '2026-09-09T01:01:00Z')
      expect(changed).toHaveBeenCalled()
      store.ledger.lifecycle({
        runId: 'run',
        accountId: 'account',
        accountIndex: 1,
        accountLabel: 'Synthetic',
        executionState: 'failed',
        startedAt: '2026-09-09T01:00:00Z',
        endedAt: '2026-09-09T01:02:00Z',
        updatedAt: '2026-09-09T01:02:00Z'
      })
      const views = new RunViews(store)
      expect(views.run('run')?.accounts[0]).toMatchObject({
        liveBalanceDelta: 110,
        liveBalanceStatus: 'live',
        confirmedBalanceDelta: null,
        executionState: 'failed',
        statisticScope: { runId: 'run', accountId: 'account', businessDate: '2026-09-09' }
      })
      snapshot(store, 'end', 1110, '2026-09-09T01:03:00Z')
      expect(views.run('run')?.accounts[0]).toMatchObject({
        liveBalanceDelta: 110,
        liveBalanceStatus: 'final',
        confirmedBalanceDelta: 110
      })
    } finally {
      store.close()
    }
  })
  it('keeps +110 unmatched and +60 overreported as separate comparisons, never revenue', () => {
    const store = new SqliteStore(':memory:')
    try {
      snapshot(store, 'start', 1000, '2026-09-09T01:00:00Z')
      snapshot(store, 'live', 1110, '2026-09-09T01:02:00Z')
      store.ledger.credits.record({
        runId: 'run',
        accountId: 'account',
        taskId: 'task',
        source: 'rsc',
        observedAt: '2026-09-09T01:01:00Z',
        officialCreditId: 'zero',
        earnedPoints: 0,
        reportedPoints: 170,
        verificationStatus: 'confirmed',
        evidenceSource: 'official-credit'
      })
      const value = new RunViews(store).accountDate('run', 'account', '2026-09-09')
      expect(value).toMatchObject({
        liveBalanceDelta: 110,
        confirmedTaskPoints: 0,
        reportedTaskPoints: 170,
        unmatchedBalancePoints: 110,
        overreportedTaskPoints: 60,
        attributionStatus: 'overreported'
      })
      expect(value.unattributedBalancePoints).toBe(110)
    } finally {
      store.close()
    }
  })
  it('isolates runs, accounts and Shanghai dates and preserves unknown and negative values', () => {
    const store = new SqliteStore(':memory:')
    try {
      snapshot(store, 'start', 1000, '2026-09-09T01:00:00Z')
      snapshot(store, 'live', 980, '2026-09-09T01:02:00Z')
      snapshot(store, 'end', 9000, '2026-09-09T02:00:00Z', 'other')
      snapshot(store, 'end', 8000, '2026-09-09T02:00:00Z', 'run', 'other')
      snapshot(store, 'end', 7000, '2026-09-09T16:00:00Z')
      const views = new RunViews(store)
      expect(views.accountDate('run', 'account', '2026-09-09')).toMatchObject({
        liveBalanceDelta: -20,
        confirmedBalanceDelta: null
      })
      expect(views.accountDate('run', 'account', '2026-09-10')).toMatchObject({
        liveBalanceDelta: null,
        confirmedBalanceDelta: null,
        liveBalanceStatus: 'unavailable',
        unmatchedBalancePoints: null
      })
      expect(views.accountDate('missing', 'account', '2026-09-09').liveBalanceDelta).toBeNull()
    } finally {
      store.close()
    }
  })
})
