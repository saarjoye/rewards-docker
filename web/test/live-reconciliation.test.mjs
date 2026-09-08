import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { HistoryStore } from '../src/history.mjs'
import { AccountIdentity } from '../src/security.mjs'
import { reconcileAccountDay, reconcileDailyPoints } from '../src/point-reconciliation.mjs'
import { createRefreshScheduler, isProgressEvent } from '../src/refresh-scheduler.mjs'
import { applyTaskEvent, accountRef } from '../../scripts/api/taskEvents.js'

const date = '2026-09-08', start = `${date}T01:00:00Z`, observed = `${date}T02:00:00Z`
const email = 'fixture@example.invalid'
const base = () => ({ email, telemetryVersion: 2, status: 'running', initialPoints: 5312, initialObservedAt: start,
    live: { balance: 5517 }, balanceObservedAt: observed,
    pointRecords: [30, 60, 30].map((points, index) => ({ id: `credit-${index}`, creditKey: `credit-${index}`, identityStable: true,
        verificationStatus: 'confirmed', evidenceSource: 'official-credit', source: ['app', 'flyout', 'rsc'][index], points, confirmedAt: observed })) })
function fixture(run) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mrs-live-fixture-'))
    const identity = new AccountIdentity(directory)
    const store = new HistoryStore(directory, identity)
    try { run(store, identity, directory) } finally { store.close(); fs.rmSync(directory, { recursive: true, force: true }) }
}
test('live 205/120/85 is visible without formal history and final persistence replaces it once', () => fixture((store, identity) => {
    const account = base(), status = { runId: 'live-run', state: 'running', startedAt: start, run: { accounts: [account] } }
    store.ingest(status, { runs: [] })
    store.ingest(status, { runs: [] })
    const daily = store.reconciliation(date, identity.keyFor(email), 'live-run')
    assert.equal(daily.runBalanceDelta, 205)
    assert.equal(daily.balanceVerification, 'provisional')
    assert.equal(daily.confirmedPoints, 120)
    assert.equal(daily.unattributedBalanceDelta, 85)
    let calendar = store.calendar({ start: date, end: date })
    assert.equal(calendar.days[0].totalGained, 205)
    assert.equal(calendar.days[0].status, 'running')
    assert.equal(calendar.days[0].records, 1)
    assert.equal(calendar.records.length, 1)
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM runs').get().n, 0)
    account.finalPoints = 5517
    account.finalObservedAt = `${date}T02:01:00Z`
    account.status = 'completed'
    store.ingest(status, { runs: [] })
    assert.equal(store.calendar({ start: date, end: date }).days[0].status, 'completed-pending-persist')
    const history = { runs: [{ id: 'live-run', startedAt: start, endedAt: account.finalObservedAt, accounts: [account], exit: { code: 0 } }] }
    store.ingest({ ...status, state: 'idle' }, history)
    calendar = store.calendar({ start: date, end: date })
    assert.equal(calendar.days[0].records, 1)
    assert.equal(calendar.records.length, 1)
    assert.equal(calendar.days[0].totalGained, 205)
    assert.equal(calendar.days[0].confirmedPoints, 120)
    assert.equal(calendar.days[0].balanceVerification, 'confirmed')
}))
test('snapshot-only, event-only and restart remain visible without fabricating final balances', () => fixture((store, identity, directory) => {
    const account = base()
    account.pointRecords = []
    account.live.balance = null
    store.ingest({ runId: 'only-start', state: 'running', startedAt: start, run: { accounts: [account] } }, {})
    store.liveStatus = null
    let calendar = store.calendar({ start: date, end: date })
    assert.equal(calendar.days[0].records, 1)
    assert.equal(calendar.days[0].totalGained, null)
    const eventOnly = { ...base(), initialPoints: null, live: {}, pointRecords: base().pointRecords }
    store.ingest({ runId: 'only-events', state: 'running', startedAt: start, run: { accounts: [eventOnly] } }, {})
    const restarted = new HistoryStore(directory, identity)
    try {
        calendar = restarted.calendar({ start: date, end: date })
        assert.equal(calendar.days[0].records, 2)
        assert.equal(calendar.days[0].totalGained, null)
        assert.equal(calendar.days[0].confirmedPoints, 120)
    } finally { restarted.close() }
}))
test('active 30, interruption, account isolation and newer live observations', () => {
    const row = { accountKey: 'a', runKey: 'r', startedAt: start, initialPoints: 5000, initialObservedAt: start,
        liveBalance: 5030, liveObservedAt: observed, status: 'running' }
    const input = { date, accountKey: 'a', currentRunId: 'r', runs: [row] }
    assert.equal(reconcileAccountDay(input).liveRunBalanceDelta, 30)
    row.status = 'interrupted'
    assert.equal(reconcileAccountDay(input).runBalanceDelta, null)
    assert.equal(reconcileAccountDay(input).dailyBalanceDelta, 30)
    row.finalPoints = 5020
    row.finalObservedAt = `${date}T01:30:00Z`
    assert.equal(reconcileAccountDay(input).dailyBalanceDelta, 30)
    assert.equal(reconcileAccountDay({ ...input, accountKey: 'other' }).dailyBalanceDelta, null)
    assert.equal(reconcileAccountDay({ ...input, date: '2026-09-09' }).dailyBalanceDelta, null)
})
test('balance reducer rejects missing and out-of-order observations', () => {
    const state = { accounts: { a: { email, live: {}, tasks: {} } } }
    const emit = (sequence, balance, at, phase = 'live') => applyTaskEvent(state, { title: 'TASK-EVENT', message: JSON.stringify({
        version: 2, sequence, eventId: `fixture:${sequence}`, at, kind: 'balance', phase, balance, accountRef: accountRef(email) }) })
    emit(1, 5000, start, 'start')
    emit(2, 5030, observed)
    emit(3, null, `${date}T03:00:00Z`, 'end')
    emit(4, 5010, start)
    assert.equal(state.accounts.a.live.balance, 5030)
    assert.equal(state.accounts.a.finalPoints, undefined)
    assert.equal(state.accounts.a.balanceObservedAt, observed)
})
test('serial accounts preserve completed balances and do not import unrelated runs', () => {
    const rows = [
        { accountKey: 'a', runKey: 'r', initialPoints: 100, finalPoints: 110, initialObservedAt: start, finalObservedAt: observed, status: 'completed' },
        { accountKey: 'b', runKey: 'r', initialPoints: 200, liveBalance: 230, initialObservedAt: start, liveObservedAt: observed, status: 'running' },
        { accountKey: 'c', runKey: 'old', initialPoints: 300, finalPoints: 399, initialObservedAt: start, finalObservedAt: observed, status: 'completed' }
    ]
    const daily = reconcileDailyPoints({ date, currentRunId: 'r', runs: rows })
    assert.equal(daily.runBalanceDelta, 40)
    assert.equal(daily.accounts.find(account => account.accountKey === 'c').runBalanceDelta, null)
    rows[1].finalPoints = 230
    rows[1].finalObservedAt = observed
    rows[1].status = 'completed'
    assert.equal(reconcileDailyPoints({ date, currentRunId: 'r', runs: rows }).balanceVerification, 'confirmed')
})
test('scheduler debounces, serializes, retains a trailing refresh and switches polling', async () => {
    let now = 0, calls = 0, pendingResolve
    const timers = new Map()
    let id = 0
    const setTimer = (fn, delay) => { timers.set(++id, { fn, at: now + delay }); return id }
    const flush = async ms => { now += ms; for (const [key, timer] of [...timers]) if (timer.at <= now) { timers.delete(key); timer.fn() }; for (let i = 0; i < 8; i++) await Promise.resolve() }
    const scheduler = createRefreshScheduler({ setTimer, clearTimer: key => timers.delete(key), publish() {},
        refresh: () => { calls++; return new Promise(resolve => { pendingResolve = resolve }) } })
    assert.equal(isProgressEvent('TASK-EVENT'), true)
    assert.equal(isProgressEvent('TASK-SNAPSHOT'), true)
    assert.equal(isProgressEvent('DEBUG'), false)
    scheduler.schedule(); scheduler.schedule()
    await flush(299); assert.equal(calls, 0)
    await flush(1); assert.equal(calls, 1)
    scheduler.schedule(); scheduler.schedule()
    pendingResolve({ status: { state: 'running', runId: 'r' } })
    await flush(0); await flush(0); assert.equal(calls, 2)
    pendingResolve({ status: { state: 'running', runId: 'r' } })
    await flush(0); await flush(3000); await flush(0); assert.equal(calls, 3)
    pendingResolve({ status: { state: 'idle', runId: 'r' } })
    await flush(0); scheduler.stop()
    assert.equal(timers.size, 0)
})
