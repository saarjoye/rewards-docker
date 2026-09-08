import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { HistoryStore } from '../src/history.mjs'
import { accountTimingMarkup } from '../public/account-timing.js'
import { buildPublicState } from '../src/status.mjs'
import { applyLogToRunState, createRunState, summarizeRunState } from '../../scripts/api/logParser.js'
import { historyRecord } from '../../scripts/api/taskEvents.js'

const startedAt = '2026-09-08T00:00:00.000Z'
const endedAt = '2026-09-08T01:02:03.000Z'

test('completed timing shows Shanghai start/end and elapsed rather than balance observation time', () => {
    const html = accountTimingMarkup({ startedAt, endedAt })
    assert.match(html, /2026-09-08 08:00:00/)
    assert.match(html, /2026-09-08 09:02:03/)
    assert.match(html, /1小时2分3秒/)
    assert.doesNotMatch(html, /进行中|待确认/)
})

test('live timing advances, completed timing freezes, and incomplete timing stays unknown', () => {
    assert.match(accountTimingMarkup({ startedAt, running: true }, Date.parse(endedAt)), /进行中.*已执行.*1小时2分3秒/)
    assert.match(accountTimingMarkup({ startedAt, endedAt, running: true }, Date.parse(endedAt) + 90000), /1小时2分3秒/)
    for (const timing of [{}, { startedAt }, { endedAt }, { startedAt: endedAt, endedAt: startedAt }, { startedAt: '<script>' }]) {
        const html = accountTimingMarkup(timing)
        assert.match(html, /待确认/)
        assert.doesNotMatch(html, /0小时0分0秒|NaN|undefined|<script>/)
    }
})

test('timing spans Shanghai midnight and preserves a known zero duration', () => {
    const html = accountTimingMarkup({ startedAt: '2026-09-07T15:50:00Z', endedAt: '2026-09-07T16:20:00Z' })
    assert.match(html, /2026-09-07 23:50:00/)
    assert.match(html, /2026-09-08 00:20:00/)
    assert.match(html, /0小时30分0秒/)
    assert.match(accountTimingMarkup({ startedAt, endedAt: startedAt }), /0小时0分0秒/)
})

test('Core account timestamps survive parsing, history serialization and public state with unknown balance', () => {
    const state = createRunState()
    const email = 'timing@example.invalid'
    const apply = (title, message) => applyLogToRunState(state, { parsed: true, title, message, user: 'timing', receivedAt: '2026-09-09T00:00:00Z' })
    apply('ACCOUNT-START', `Starting account: ${email} | geoLocale: auto | locale: en-US | startedAt=${startedAt}`)
    apply('ACCOUNT-END', `Completed account: ${email} | pointsGained=null | previousBalance=100 | currentBalance=null | durationSeconds=3723 | startedAt=${startedAt} | endedAt=${endedAt}`)
    const run = summarizeRunState(state)
    const account = historyRecord({ run, startedAt, endedAt }).accounts[0]
    assert.equal(account.startedAt, startedAt)
    assert.equal(account.endedAt, endedAt)
    assert.equal(account.finalPoints, null)
    const output = buildPublicState({
        status: { state: 'running', run }, points: {}, historySummary: {},
        configuredAccounts: { accounts: [{ email, index: 1 }, { email: 'next@example.invalid', index: 2 }] },
        identity: { keyFor: value => value === email ? 'first' : 'second', labelFor: () => '脱敏账号' }
    })
    assert.deepEqual(output.accounts[0].timing, { startedAt, endedAt, running: false })
    assert.deepEqual(output.accounts[1].timing, { startedAt: null, endedAt: null, running: false })
    assert.doesNotMatch(JSON.stringify(output), /timing@example/)
})

test('legacy account log timestamps are not replaced with receipt or run timestamps', () => {
    const state = createRunState()
    applyLogToRunState(state, { parsed: true, title: 'ACCOUNT-START', message: 'Starting account: legacy@example.invalid | geoLocale: auto', receivedAt: startedAt })
    assert.equal(state.accounts['legacy@example.invalid'].startedAt, null)
})

test('account timing survives SQLite restart and an incomplete repeated history payload', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mrs-timing-'))
    const identity = { keyFor: () => 'fixture-account', labelFor: () => '脱敏账号' }
    let store = new HistoryStore(directory, identity)
    try {
        const account = { email: 'fixture@example.invalid', telemetryVersion: 2, startedAt, endedAt, status: 'completed' }
        const history = { runs: [{ id: 'fixture-run', startedAt, endedAt, exit: { code: 0 }, accounts: [account] }] }
        store.ingest(null, history)
        store.close()
        store = new HistoryStore(directory, identity)
        account.startedAt = null
        account.endedAt = null
        store.ingest(null, history)
        assert.deepEqual(store.getRun('fixture-run').accounts[0].timing, { startedAt, endedAt, running: false })
    } finally {
        store.close()
        fs.rmSync(directory, { recursive: true, force: true })
    }
})
