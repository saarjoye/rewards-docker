import assert from 'node:assert/strict'
import test from 'node:test'
import { accountRef, applyTaskEvent } from './taskEvents.js'
import { applyLogToRunState, createRunState, summarizeRunState } from './logParser.js'

const email = 'synthetic@example.com'
const entry = payload => applyLogToRunState(state, { parsed: true, title: 'TASK-SNAPSHOT', message: JSON.stringify(payload) })
let state

function accountStart() {
    state = createRunState()
    applyLogToRunState(state, {
        parsed: true,
        title: 'ACCOUNT-START',
        user: 'synthetic',
        message: `Starting account: ${email} | geoLocale: test`
    })
}

test('v3 snapshot maps capability, eligibility, planned and verification metadata', () => {
    accountStart()
    entry({
        version: 3,
        accountRef: accountRef(email),
        source: 'rsc',
        platform: 'desktop',
        dataStatus: 'available',
        planned: true,
        tasks: [
            {
                id: 'offer-1',
                taskType: 'quiz-v9',
                title: '未知活动',
                capability: { state: 'unsupported', adapter: 'promotion:quiz-v9' },
                eligibility: { state: 'unknown', reason: '当前版本不支持' },
                execution: { planned: false, status: 'not-planned', order: 2 },
                verification: { state: 'not-applicable', expectedPoints: 10, evidenceSource: 'task-snapshot' },
                dataStatus: 'available'
            }
        ]
    })
    const task = summarizeRunState(state).accounts[0].tasks[0]
    assert.equal(task.capability, 'unsupported')
    assert.equal(task.adapter, 'promotion:quiz-v9')
    assert.equal(task.eligibility, 'unknown')
    assert.equal(task.planned, false)
    assert.equal(task.verification, 'not-applicable')
    assert.equal(task.dataStatus, 'available')
})

test('v3 snapshot never overwrites a terminal task event', () => {
    accountStart()
    const now = new Date().toISOString()
    const event = {
        version: 2,
        eventId: 'synthetic:1',
        sequence: 1,
        accountRef: accountRef(email),
        at: now,
        kind: 'task',
        id: 'rsc:main:offer-1',
        invocationId: 'invocation-1',
        title: '活动',
        source: 'rsc',
        platform: 'desktop',
        status: 'completed',
        verification: 'confirmed',
        earnedPoints: 5,
        confirmedAt: now,
        terminal: true,
        dataStatus: 'available'
    }
    assert.equal(applyTaskEvent(state, { title: 'TASK-EVENT', message: JSON.stringify(event) }), true)
    entry({
        version: 3,
        accountRef: accountRef(email),
        source: 'rsc',
        platform: 'desktop',
        dataStatus: 'available',
        tasks: [
            {
                id: 'offer-1',
                capability: { state: 'unsupported' },
                eligibility: { state: 'locked' },
                execution: { planned: false, status: 'not-planned' },
                verification: { state: 'pending' },
                dataStatus: 'available'
            }
        ]
    })
    const task = summarizeRunState(state).accounts[0].tasks[0]
    assert.equal(task.status, 'completed')
    assert.equal(task.verification, 'confirmed')
    assert.equal(task.earnedPoints, 5)
})

test('account balance gain is visible before task-level evidence is confirmed', () => {
    accountStart()
    const at = new Date().toISOString()
    const apply = event => applyTaskEvent(state, { title: 'TASK-EVENT', message: JSON.stringify(event) })
    assert.equal(
        apply({
            version: 2,
            eventId: 'balance:1',
            sequence: 1,
            accountRef: accountRef(email),
            at,
            kind: 'balance',
            phase: 'start',
            balance: 5000
        }),
        true
    )
    assert.equal(
        apply({
            version: 2,
            eventId: 'balance:2',
            sequence: 2,
            accountRef: accountRef(email),
            at,
            kind: 'balance',
            phase: 'end',
            balance: 5135
        }),
        true
    )
    const account = summarizeRunState(state).accounts[0]
    assert.equal(account.collectedPoints, 135)
    assert.equal(account.live.gained, 135)
    assert.equal(account.balanceChange, 135)
    assert.equal(account.pendingVerification, 0)
})
