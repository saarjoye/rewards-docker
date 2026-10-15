import { describe, expect, it, vi } from 'vitest'
import { SqliteStore } from '../src/infra/SqliteStore.js'
import { RunViews } from '../src/web/RunViews.js'
import type { EvidenceSource } from '../src/domain/Evidence.js'
import { localDateKey } from '../src/domain/DateKey.js'

function snapshot(
  store: SqliteStore,
  phase: 'start' | 'live' | 'end',
  balance: number,
  time: string,
  runId = 'run',
  accountId = 'account',
  source: EvidenceSource = 'rsc',
  provenance?: string
) {
  const defaultProvenance =
    provenance ??
    (source === 'app-dashboard'
      ? 'appResponse.balance'
      : source === 'bing-flyout'
        ? 'userStatus.availablePoints'
        : source === 'browser-response'
          ? 'browser-response.balance'
          : source === 'legacy-getuserinfo'
            ? 'userInfo.balance'
            : 'flight.availablePoints')
  store.ledger.balance(runId, accountId, phase, {
    value: balance,
    availability: 'valid',
    confidence: 1,
    source,
    observedAt: time,
    provenance: defaultProvenance
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
  it('marks conflict and sets dailyBalanceDelta to null when evidence sources diverge in magnitude', () => {
    const store = new SqliteStore(':memory:')
    try {
      const date = '2026-09-09'
      snapshot(store, 'start', 12928, `${date}T01:00:00Z`, 'run1', 'account', 'app-dashboard', 'appResponse.balance')
      snapshot(store, 'live', 1017, `${date}T02:00:00Z`, 'run2', 'account', 'bing-flyout', 'userStatus.availablePoints')
      snapshot(store, 'end', 12988, `${date}T03:00:00Z`, 'run1', 'account', 'app-dashboard', 'appResponse.balance')

      const views = new RunViews(store)
      const day = views.day('account', date);
      expect(day.conflicting).toBe(true)
      expect(day.dailyBalanceDelta).toBeNull()
      expect(day.verificationStatus).toBe('conflict')
      expect(day.openingBalance).toBeNull()
      expect(day.closingBalance).toBeNull()

      const todayDate = localDateKey()
      snapshot(store, 'start', 12928, `${todayDate}T01:00:00Z`, 'today-run1', 'account-today', 'app-dashboard')
      snapshot(store, 'live', 1017, `${todayDate}T02:00:00Z`, 'today-run2', 'account-today', 'bing-flyout')
      const todayRows = views.today([{
        accountId: 'account-today',
        displayAlias: 'Today Account',
        maskedEmail: 'today***@example.com',
        runAccountIndex: 1
      }])
      expect(todayRows[0]?.conflicting).toBe(true)
      expect(todayRows[0]?.dailyBalanceDelta).toBeNull()
      expect(todayRows[0]?.accountTotalPoints).toBeNull()
      expect(todayRows[0]?.verificationStatus).toBe('conflict')
    } finally {
      store.close()
    }
  })

  it('calculates dailyBalanceDelta and account total correctly when all observations come from a single source caliber', () => {
    const store = new SqliteStore(':memory:')
    try {
      const date = '2026-09-09'
      snapshot(store, 'start', 12928, `${date}T01:00:00Z`, 'run1', 'account', 'app-dashboard', 'appResponse.balance')
      snapshot(store, 'live', 12950, `${date}T01:30:00Z`, 'run1', 'account', 'app-dashboard', 'appResponse.balance')
      snapshot(store, 'end', 12988, `${date}T02:00:00Z`, 'run1', 'account', 'app-dashboard', 'appResponse.balance')

      const views = new RunViews(store)
      const day = views.day('account', date)
      expect(day.conflicting).toBe(false)
      expect(day.dailyBalanceDelta).toBe(60)
      expect(day.openingBalance).toBe(12928)
      expect(day.closingBalance).toBe(12988)
      expect(day.verificationStatus).toBe('confirmed')

      const todayDate = localDateKey()
      snapshot(store, 'start', 12928, `${todayDate}T01:00:00Z`, 'run-today', 'account-today', 'app-dashboard')
      snapshot(store, 'end', 12988, `${todayDate}T02:00:00Z`, 'run-today', 'account-today', 'app-dashboard')
      const todayRows = views.today([{
        accountId: 'account-today',
        displayAlias: 'Today Account',
        maskedEmail: 'today***@example.com',
        runAccountIndex: 1
      }])
      expect(todayRows[0]?.conflicting).toBe(false)
      expect(todayRows[0]?.dailyBalanceDelta).toBe(60)
      expect(todayRows[0]?.accountTotalPoints).toBe(12988)
      expect(todayRows[0]?.verificationStatus).toBe('confirmed')
    } finally {
      store.close()
    }
  })

  it('calibrates and reconciles balance after a conflict, restoring authoritative points and clearing conflict in today views', () => {
    const store = new SqliteStore(':memory:')
    try {
      const todayDate = localDateKey()
      snapshot(store, 'start', 12928, `${todayDate}T01:00:00Z`, 'run1', 'account-calib', 'app-dashboard', 'appResponse.balance')
      snapshot(store, 'live', 1017, `${todayDate}T02:00:00Z`, 'run2', 'account-calib', 'bing-flyout', 'userStatus.availablePoints')
      snapshot(store, 'end', 12988, `${todayDate}T03:00:00Z`, 'run1', 'account-calib', 'app-dashboard', 'appResponse.balance')

      const views = new RunViews(store)
      const before = views.today([{
        accountId: 'account-calib',
        displayAlias: 'Calib Account',
        maskedEmail: 'calib***@example.com',
        runAccountIndex: 1
      }])[0]
      expect(before?.conflicting).toBe(true)
      expect(before?.accountTotalPoints).toBeNull()
      expect(before?.dailyBalanceDelta).toBeNull()
      expect(before?.verificationStatus).toBe('conflict')

      const res = store.ledger.calibrateBalance(
        'account-calib',
        12993,
        'app-dashboard',
        todayDate,
        undefined,
        `${todayDate}T04:00:00.000Z`
      )
      expect(res.cleanedCount).toBe(1)
      expect(res.conflictCount).toBe(1)

      const after = views.today([{
        accountId: 'account-calib',
        displayAlias: 'Calib Account',
        maskedEmail: 'calib***@example.com',
        runAccountIndex: 1
      }])[0]
      expect(after?.conflicting).toBe(false)
      expect(after?.accountTotalPoints).toBe(12993)
      expect(after?.dailyBalanceDelta).toBe(65)
      expect(after?.verificationStatus).not.toBe('conflict')

      const day = views.day('account-calib', todayDate)
      expect(day.conflicting).toBe(false)
      expect(day.openingBalance).toBe(12928)
      expect(day.closingBalance).toBe(12993)
      expect(day.dailyBalanceDelta).toBe(65)
    } finally {
      store.close()
    }
  })

  it('calibrates balance when only corrupt observations existed, establishing clean baseline', () => {
    const store = new SqliteStore(':memory:')
    try {
      const todayDate = localDateKey()
      snapshot(store, 'live', 1017, `${todayDate}T02:00:00Z`, 'run2', 'account-only-bad', 'bing-flyout', 'userStatus.availablePoints')

      const views = new RunViews(store)
      const before = views.today([{
        accountId: 'account-only-bad',
        displayAlias: 'Bad Account',
        maskedEmail: 'bad***@example.com',
        runAccountIndex: 1
      }])[0]
      expect(before?.accountTotalPoints).toBe(1017)

      const res = store.ledger.calibrateBalance('account-only-bad', 12993, 'app-dashboard', todayDate)
      expect(res.cleanedCount).toBe(1)

      const after = views.today([{
        accountId: 'account-only-bad',
        displayAlias: 'Bad Account',
        maskedEmail: 'bad***@example.com',
        runAccountIndex: 1
      }])[0]
      expect(after?.conflicting).toBe(false)
      expect(after?.accountTotalPoints).toBe(12993)
      expect(after?.verificationStatus).toBe('pending')
    } finally {
      store.close()
    }
  })

  it('accepts calibration -> availablePoints as one total caliber when the daily delta is plausible', () => {
    const store = new SqliteStore(':memory:')
    try {
      const todayDate = localDateKey()
      // User calibrates account: total points 13150, today points 222 (opening: 12928, end: 13150)
      store.ledger.calibrateBalance('acc-1', 13150, 'app-dashboard', todayDate, 222, `${todayDate}T08:00:00.000Z`)

      const views = new RunViews(store)
      const afterCalib = views.today([{
        accountId: 'acc-1',
        displayAlias: 'Test Account',
        maskedEmail: 'test***@example.com',
        runAccountIndex: 1
      }])[0]
      expect(afterCalib?.conflicting).toBe(false)
      expect(afterCalib?.accountTotalPoints).toBe(13150)
      expect(afterCalib?.dailyBalanceDelta).toBe(222)

      // A later total reading arrives from Bing flyout. Because availablePoints
      // is a total-caliber field, it must extend the calibrated interval rather
      // than being rejected as a different caliber.
      snapshot(store, 'end', 13174, `${todayDate}T09:00:00Z`, 'task-run-1', 'acc-1', 'bing-flyout', 'userStatus.availablePoints')

      const day = views.day('acc-1', todayDate)
      expect(day.conflicting).toBe(false)
      expect(day.openingBalance).toBe(12928)
      expect(day.closingBalance).toBe(13174)
      expect(day.dailyBalanceDelta).toBe(246)
      expect(day.verificationStatus).toBe('confirmed')

      const today = views.today([{
        accountId: 'acc-1',
        displayAlias: 'Test Account',
        maskedEmail: 'test***@example.com',
        runAccountIndex: 1
      }])[0]
      expect(today?.conflicting).toBe(false)
      expect(today?.accountTotalPoints).toBe(13174)
      expect(today?.dailyBalanceDelta).toBe(246)
      expect(today?.verificationStatus).toBe('confirmed')
    } finally {
      store.close()
    }
  })

  it('quarantines and rejects wild anomalous observations from poisoning a calibrated account', () => {
    const store = new SqliteStore(':memory:')
    try {
      const todayDate = localDateKey()
      // Calibrate account to 13150 with today points 222
      store.ledger.calibrateBalance('acc-wild', 13150, 'app-dashboard', todayDate, 222)

      // Wild corrupt observations arrive (e.g. 222 misattributed to balance or 1017).
      // These are from a different caliber and are quarantined as conflict instead
      // of poisoning the calibrated total.
      snapshot(store, 'live', 222, `${todayDate}T10:00:00Z`, 'wild-run', 'acc-wild', 'rsc', 'flight.availablePoints')
      snapshot(store, 'live', 1017, `${todayDate}T10:05:00Z`, 'wild-run', 'acc-wild', 'bing-flyout', 'userStatus.availablePoints')

      const views = new RunViews(store)
      const today = views.today([{
        accountId: 'acc-wild',
        displayAlias: 'Wild Account',
        maskedEmail: 'wild***@example.com',
        runAccountIndex: 1
      }])[0]
      expect(today?.conflicting).toBe(false)
      expect(today?.accountTotalPoints).toBe(13150)
      expect(today?.dailyBalanceDelta).toBe(222)
      expect(today?.verificationStatus).not.toBe('conflict')
    } finally {
      store.close()
    }
  })

})
