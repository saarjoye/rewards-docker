import { describe, it, expect } from 'vitest'
import { SqliteStore } from '../src/infra/SqliteStore.js'
import { RunViews } from '../src/web/RunViews.js'
import type { CreditInput } from '../src/infra/PointCredits.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const credit = (id: string, points: number): CreditInput => ({
  runId: 'run',
  accountId: 'account',
  taskId: id,
  source: 'rsc',
  observedAt: '2026-09-09T01:00:00Z',
  officialCreditId: id,
  reportedPoints: points,
  earnedPoints: points,
  expectedPoints: points,
  verificationStatus: 'confirmed',
  evidenceSource: 'official-credit',
  submitted: true
})
function setup(before = 5312, after = 5517) {
  const store = new SqliteStore(':memory:')
  store.createRun({
    runId: 'run',
    localDate: '2026-09-09',
    executionMode: 'mutating',
    selectedAccountIndexes: [1],
    startedAt: '2026-09-09T00:00:00Z'
  })
  for (const [phase, value, observedAt] of [
    ['start', before, '2026-09-09T00:00:00Z'],
    ['end', after, '2026-09-09T02:00:00Z']
  ] as const)
    store.ledger.balance('run', 'account', phase, {
      availability: 'valid',
      value,
      source: 'bing-flyout',
      confidence: 1,
      observedAt
    })
  return store
}
describe('strict credit reconciliation', () => {
  it('retains stable identity after reopening and rejects observations outside the balance interval', async () => {
    const root = await mkdtemp(join(tmpdir(), 'credit-restart-'))
    let store = new SqliteStore(join(root, 'fixture.sqlite'))
    try {
      store.ledger.credits.record(credit('restart', 30))
      store.close()
      store = new SqliteStore(join(root, 'fixture.sqlite'))
      store.ledger.credits.record({ ...credit('restart', 30), runId: 'retry' })
      expect(store.ledger.credits.rows('account')).toHaveLength(1)
      for (const [phase, value, observedAt] of [
        ['start', 100, '2026-09-09T02:00:00Z'],
        ['end', 130, '2026-09-09T03:00:00Z']
      ] as const)
        store.ledger.balance('run', 'account', phase, {
          availability: 'valid',
          value,
          source: 'bing-flyout',
          confidence: 1,
          observedAt
        })
      expect(new RunViews(store).day('account', '2026-09-09').confirmedTaskPoints).toBeNull()
    } finally {
      store.close()
      await rm(root, { recursive: true, force: true })
    }
  })
  it('renders lifecycle-only evidence on its Shanghai day without a formal run', () => {
    const store = new SqliteStore(':memory:')
    try {
      store.ledger.lifecycle({
        runId: 'orphan',
        accountId: 'account',
        accountIndex: 3,
        accountLabel: 'Synthetic',
        executionState: 'running',
        startedAt: '2026-09-08T16:01:00Z',
        endedAt: null,
        updatedAt: '2026-09-08T16:01:00Z'
      })
      const views = new RunViews(store)
      expect(views.calendar('2026-09')[0]).toMatchObject({
        businessDate: '2026-09-09',
        accountIndex: 3,
        dailyBalanceDelta: null
      })
      expect(views.run('orphan')?.persistence).toBe('provisional')
      expect(views.run('nonexistent')).toBeUndefined()
    } finally {
      store.close()
    }
  })
  it('shares 205/120/85 through day, run and calendar without adding the residual to credits', () => {
    const store = setup()
    try {
      for (const [id, points] of [
        ['app', 30],
        ['flyout', 60],
        ['rsc', 30]
      ] as const)
        store.ledger.credits.record(credit(id, points))
      const views = new RunViews(store)
      const expected = {
        reportedTaskPoints: 120,
        confirmedTaskPoints: 120,
        unattributedBalanceDelta: 85,
        overreportedTaskPoints: 0
      }
      expect(views.day('account', '2026-09-09')).toMatchObject({
        ...expected,
        dailyBalanceDelta: 205
      })
      expect(views.run('run')?.accounts[0]).toMatchObject({ ...expected, runBalanceDelta: 205 })
      expect(views.calendar('2026-09')[0]).toMatchObject(expected)
    } finally {
      store.close()
    }
  })
  it('does not force 111 reported points into 83 balance points or label the excess as residual', () => {
    const store = setup(100, 183)
    try {
      store.ledger.credits.record(credit('conflict', 111))
      expect(new RunViews(store).day('account', '2026-09-09')).toMatchObject({
        dailyBalanceDelta: 83,
        confirmedTaskPoints: null,
        overreportedTaskPoints: 28,
        unattributedBalanceDelta: null
      })
    } finally {
      store.close()
    }
  })
  it('deduplicates official identity across runs and rejects conflicting amounts', () => {
    const store = setup()
    try {
      store.ledger.credits.record(credit('same', 30))
      store.ledger.credits.record({ ...credit('same', 30), runId: 'retry' })
      expect(store.ledger.credits.rows('account')).toHaveLength(1)
      expect(store.ledger.credits.rowsForRun('retry')).toHaveLength(0)
      store.ledger.credits.record({ ...credit('same', 40), runId: 'retry' })
      expect(new RunViews(store).day('account', '2026-09-09').confirmedTaskPoints).toBeNull()
    } finally {
      store.close()
    }
  })
  it('keeps expected points and unverified completion pending, preserves non-task and negative balance changes', () => {
    const store = setup(200, 180)
    try {
      store.ledger.credits.record({
        runId: 'run',
        accountId: 'account',
        taskId: 'unverified',
        source: 'rsc',
        observedAt: '2026-09-09T01:00:00Z',
        expectedPoints: 30,
        submitted: true
      })
      expect(new RunViews(store).day('account', '2026-09-09')).toMatchObject({
        dailyBalanceDelta: -20,
        confirmedTaskPoints: null,
        pendingTaskPoints: 30,
        legacyUnverified: true
      })
    } finally {
      store.close()
    }
    const extra = setup()
    try {
      expect(new RunViews(extra).day('account', '2026-09-09')).toMatchObject({
        confirmedTaskPoints: null,
        unattributedBalanceDelta: 205
      })
    } finally {
      extra.close()
    }
  })
  it('confirms an isolated delayed observation only once, and rejects concurrent attribution windows', () => {
    const store = setup(100, 130)
    try {
      for (const [phase, value, observedAt] of [
        ['task-before', 100, '2026-09-09T00:10:00Z'],
        ['task-after', 130, '2026-09-09T00:20:00Z']
      ] as const)
        store.ledger.balance('run', 'account', phase, {
          availability: 'valid',
          value,
          source: 'bing-flyout',
          confidence: 1,
          observedAt
        })
      const before = store.ledger
        .balances('run')
        .find((row) => row.phase === 'task-before')?.snapshotId
      const after = store.ledger
        .balances('run')
        .find((row) => row.phase === 'task-after')?.snapshotId
      const isolated: CreditInput = {
        runId: 'run',
        accountId: 'account',
        taskId: 'task',
        source: 'rsc',
        taskInstanceId: 'offer',
        observedAt: '2026-09-09T00:15:00Z',
        expectedPoints: 30,
        reportedPoints: 30,
        submitted: true
      }
      store.ledger.credits.record(isolated)
      expect(new RunViews(store).day('account', '2026-09-09').confirmedTaskPoints).toBeNull()
      const verified: CreditInput = {
        ...isolated,
        observedAt: '2026-09-09T00:21:00Z',
        earnedPoints: 30,
        verificationStatus: 'confirmed',
        evidenceSource: 'isolated-balance',
        isolationVerified: true,
        beforeSnapshotId: before,
        afterSnapshotId: after
      }
      store.ledger.credits.record(verified)
      store.ledger.credits.record(verified)
      expect(new RunViews(store).day('account', '2026-09-09').confirmedTaskPoints).toBe(30)
      store.ledger.credits.record({
        ...verified,
        taskInstanceId: 'competing',
        taskId: 'other',
        reportedPoints: 0
      })
      expect(new RunViews(store).day('account', '2026-09-09').confirmedTaskPoints).toBeNull()
    } finally {
      store.close()
    }
  })
})
