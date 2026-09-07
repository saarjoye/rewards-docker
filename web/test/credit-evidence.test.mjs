import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { reconcileAccountDay, reconcileDailyPoints } from '../src/point-reconciliation.mjs'
import { HistoryStore } from '../src/history.mjs'
import { AccountIdentity } from '../src/security.mjs'
import { buildPublicState } from '../src/status.mjs'
import { applyTaskEvent, accountRef } from '../../scripts/api/taskEvents.js'
import { taskTableMarkup } from '../public/run-view.js'

const date = '2026-09-07', start = `${date}T01:00:00Z`, end = `${date}T02:00:00Z`
const row = (delta, runKey = 'current', day = date) => ({ accountKey: 'a', runKey, initialPoints: 100, finalPoints: 100 + delta,
    initialObservedAt: `${day}T01:00:00Z`, finalObservedAt: `${day}T02:00:00Z`, startedAt: `${day}T01:00:00Z`, endedAt: `${day}T02:00:00Z` })
const event = (points, extra = {}) => ({ accountKey: 'a', runKey: 'current', eventKey: 'report', source: 'app', points, confirmedAt: `${date}T01:30:00Z`, ...extra })
test('account discovery uses observation dates without inventing process timestamps', () => {
    const result = reconcileDailyPoints({ date, currentRunId: 'current', runs: [{ ...row(22), startedAt: null, endedAt: null }] })
    assert.equal(result.dailyBalanceDelta, 22)
    assert.equal(result.runBalanceDelta, 22)
    assert.equal(result.accounts.length, 1)
})
test('111 reported / 83 balance keeps 28 as excess and all unverified reports pending', () => {
    const result = reconcileAccountDay({ date, accountKey: 'a', currentRunId: 'current', runs: [row(83)], pointEvents: [event(111)] })
    assert.equal(result.runBalanceDelta, 83)
    assert.equal(result.dailyBalanceDelta, 83)
    assert.equal(result.reportedTaskPoints, 111)
    assert.equal(result.confirmedPoints, null)
    assert.equal(result.pendingPoints, 111)
    assert.equal(result.overreportedPoints, 28)
    assert.equal(result.unattributedBalanceDelta, null)
})
test('54 observed without task evidence is balance-only; legacy overlap remains unknown', () => {
    const result = reconcileAccountDay({ date, accountKey: 'a', runs: [row(54)] })
    assert.equal(result.dailyBalanceDelta, 54)
    assert.equal(result.confirmedPoints, 0)
    assert.equal(result.unattributedBalanceDelta, 54)
    const overlap = reconcileAccountDay({ date, accountKey: 'a', runs: [row(44)], pointEvents: [event(44, { source: 'account-balance' })] })
    assert.equal(overlap.dailyBalanceDelta, 44)
    assert.equal(overlap.unattributedBalanceDelta, null)
})
test('run selection excludes history and missing final balances cannot be closed by a later run', () => {
    const rows = [row(134, 'old', '2026-09-05'), row(30, 'previous', '2026-09-06'), row(30)]
    const input = { date, accountKey: 'a', runs: rows, currentRunId: 'current' }
    assert.equal(reconcileAccountDay(input).runBalanceDelta, 30)
    assert.equal(reconcileAccountDay({ ...input, currentRunId: null }).runBalanceDelta, null)
    rows[2].finalPoints = null
    rows.push({ ...row(15, 'later'), initialPoints: 130, finalPoints: 145 })
    assert.equal(reconcileAccountDay(input).runBalanceDelta, null)
    assert.deepEqual(reconcileAccountDay(input), reconcileAccountDay(input))
})
test('cross midnight, missing observation timestamps, missing balances and decreases', () => {
    const overnight = { ...row(30), initialObservedAt: '2026-09-06T15:50:00Z', finalObservedAt: '2026-09-06T16:20:00Z' }
    assert.equal(reconcileAccountDay({ date, accountKey: 'a', runs: [overnight] }).dailyBalanceDelta, null)
    const legacy = { ...row(30), initialObservedAt: null, finalObservedAt: null }
    assert.equal(reconcileAccountDay({ date, accountKey: 'a', runs: [legacy], pointEvents: [event(111)] }).todayGained, null)
    assert.equal(reconcileAccountDay({ date, accountKey: 'a', runs: [row(-20)] }).dailyBalanceDelta, -20)
})
test('pending event and another account cannot enter confirmed credits', () => {
    const proof = { creditKey: 'stable', identityStable: true, evidenceSource: 'official-progress', legacyUnverified: false }
    const result = reconcileAccountDay({ date, accountKey: 'a', runs: [row(83)], pointEvents: [event(28, { ...proof, verificationStatus: 'pending' }), event(55, { ...proof, accountKey: 'b', verificationStatus: 'confirmed' })] })
    assert.equal(result.reportedTaskPoints, 28)
    assert.equal(result.confirmedPoints, null)
})
test('confirmed identity is deduplicated and pending completion is never rendered as an award', () => {
    const proof = event(3, { creditKey: 'official-id', identityStable: true, verificationStatus: 'confirmed', evidenceSource: 'official-credit', legacyUnverified: false })
    const result = reconcileAccountDay({ date, accountKey: 'a', runs: [row(54)], pointEvents: [proof, { ...proof, runKey: 'retry' }] })
    assert.equal(result.confirmedPoints, 3)
    assert.equal(result.reportedTaskPoints, 3)
    assert.equal(result.unattributedBalanceDelta, 51)
    const html = taskTableMarkup([{ status: 'completed', verification: 'pending', earnedPoints: null }])
    assert.match(html, /任务完成，积分待确认/)
    assert.doesNotMatch(html, /0 分|已确认获得积分/)
})
test('late migration failure rolls back new evidence schema and leaves old points intact', () => {
    const db = new DatabaseSync(':memory:')
    db.exec('CREATE TABLE runs (id TEXT); CREATE TABLE account_runs (id TEXT); CREATE TABLE point_events (event_key TEXT, run_key TEXT, account_key TEXT, points REAL, confirmed_at TEXT, local_date TEXT, source TEXT);')
    db.exec("INSERT INTO point_events VALUES ('old','run','account',111,'2026-09-07T01:00:00Z','2026-09-07','app')")
    const exec = db.exec.bind(db)
    db.exec = sql => { if (sql.includes('CREATE TABLE IF NOT EXISTS balance_snapshots')) throw new Error('fixture migration failure'); return exec(sql) }
    try {
        assert.throws(() => HistoryStore.prototype.migrateVerification.call({ db }), /fixture migration failure/)
        assert.equal(db.prepare('PRAGMA table_info(point_events)').all().length, 7)
        assert.equal(db.prepare('SELECT points FROM point_events').get().points, 111)
        db.exec = exec
        HistoryStore.prototype.migrateVerification.call({ db })
        HistoryStore.prototype.migrateVerification.call({ db })
        assert.equal(db.prepare('SELECT points, evidence_json FROM point_events').get().evidence_json, null)
        assert.equal(db.prepare('SELECT points FROM point_events').get().points, 111)
    } finally { db.close() }
})
test('counter overlap and restart generate identical stable credit keys', () => {
    const email = 'fixture@example.invalid'
    const make = () => ({ accounts: { a: { email, live: {}, tasks: {} } } })
    const emit = (state, invocationId, from, to) => applyTaskEvent(state, { title: 'TASK-EVENT', message: JSON.stringify({ version: 2, sequence: 1, eventId: `${invocationId}:1`, invocationId,
        at: end, confirmedAt: end, startedAt: start, accountRef: accountRef(email), kind: 'task', id: 'dashboard:mobile:search', source: 'dashboard', platform: 'mobile', status: 'completed', terminal: true,
        verification: 'confirmed', earnedPoints: to - from, evidenceSource: 'official-progress', progressBefore: from, progressAfter: to }) })
    const state = make()
    emit(state, 'first', 0, 3)
    emit(state, 'retry', 2, 5)
    assert.equal(state.accounts.a.collectedPoints, 5)
    const restart = make()
    emit(restart, 'restart', 0, 3)
    assert.deepEqual(restart.accounts.a.pointRecords.map(r => r.creditKey), state.accounts.a.pointRecords.slice(0, 3).map(r => r.creditKey))
})
test('SQLite persists evidence and dedup across restart, APIs share balance results, legacy values survive', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mrs-credit-fixture-'))
    const identity = new AccountIdentity(directory)
    let store = new HistoryStore(directory, identity)
    try {
        const account = { email: 'fixture@example.invalid', telemetryVersion: 2, status: 'completed', initialPoints: 100, finalPoints: 183,
            initialObservedAt: start, finalObservedAt: end, pointRecords: [{ id: 'attempt', points: 111, source: 'app', confirmedAt: end }] }
        const run = { id: 'current', startedAt: start, endedAt: end, accounts: [account], exit: { code: 0 } }
        store.ingest({}, { runs: [run] })
        store.ingest({}, { runs: [run] })
        const daily = store.reconciliation(date, identity.keyFor(account.email), 'current')
        assert.equal(daily.todayGained, 83)
        assert.equal(daily.overreportedPoints, 28)
        assert.equal(store.getRun('current').accounts[0].runBalanceDelta, 83)
        assert.equal(store.calendar({ start: date, end: date }).days[0].totalGained, 83)
        const state = buildPublicState({ status: { state: 'running', runId: 'current', run: { accounts: [account] } }, configuredAccounts: { accounts: [{ email: account.email }] }, identity,
            historySummary: { balanceReconciliation: [daily] } })
        assert.equal(state.accounts[0].points.dailyBalanceDelta, 83)
        assert.equal(state.accounts[0].points.confirmedPoints, null)
        const proof = { id: 'proof', creditKey: 'stable-proof', identityStable: true, verificationStatus: 'confirmed', evidenceSource: 'official-credit', points: 3, source: 'app', confirmedAt: end }
        store.ingestPoints('one', [{ ...account, pointRecords: [proof] }])
        store.close()
        store = new HistoryStore(directory, identity)
        store.migrateVerification()
        store.ingestPoints('two', [{ ...account, pointRecords: [{ ...proof, id: 'retry' }] }])
        assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM point_events').get().n, 2)
        assert.equal(store.db.prepare("SELECT points FROM point_events WHERE points = 111").get().points, 111)
    } finally { store.close(); fs.rmSync(directory, { recursive: true, force: true }) }
})
