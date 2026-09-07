import assert from 'node:assert/strict'
import test from 'node:test'

import { reconcileAccountDay, reconcileDailyPoints } from '../src/point-reconciliation.mjs'

const run = (runKey, startedAt, endedAt, initialPoints, finalPoints, accountKey = 'account-a') => ({
    runKey,
    accountKey,
    startedAt,
    endedAt,
    initialObservedAt: startedAt,
    finalObservedAt: finalPoints === null ? null : endedAt,
    initialPoints,
    finalPoints
})

test('reconciles a single run from reliable balances', () => {
    const result = reconcileAccountDay({
        date: '2026-09-05',
        accountKey: 'account-a',
        runs: [run('one', '2026-09-05T01:00:00Z', '2026-09-05T02:00:00Z', 100, 122)]
    })
    assert.equal(result.todayGained, 22)
    assert.equal(result.confirmedPoints, 0)
    assert.equal(result.unattributedPoints, 22)
})

test('daily observations do not close interrupted runs with the next initial balance', () => {
    const runs = [
        run('one', '2026-09-05T01:00:00Z', '2026-09-05T02:00:00Z', 17250, null),
        run('two', '2026-09-05T03:00:00Z', '2026-09-05T04:00:00Z', 17303, null),
        run('three', '2026-09-05T05:00:00Z', '2026-09-05T06:00:00Z', 17327, 17372)
    ]
    const result = reconcileAccountDay({
        date: '2026-09-05',
        accountKey: 'account-a',
        runs,
        pointEvents: [
            { accountKey: 'account-a', runKey: 'one', source: 'read', points: 30, confirmedAt: '2026-09-05T01:10:00Z' },
            { accountKey: 'account-a', runKey: 'two', source: 'checkIn', points: 6, confirmedAt: '2026-09-05T03:10:00Z' },
            { accountKey: 'account-a', runKey: 'three', source: 'url', points: 3, confirmedAt: '2026-09-05T05:10:00Z' }
        ]
    })
    assert.equal(result.todayGained, 122)
    assert.equal(result.confirmedPoints, null)
    assert.equal(result.reportedTaskPoints, 39)
    assert.equal(result.unattributedPoints, null)
    assert.deepEqual(result.runs.map(item => item.runGained), [null, null, 45])
})

test('does not count account-balance events as confirmed task points', () => {
    const result = reconcileAccountDay({
        date: '2026-09-05',
        accountKey: 'account-a',
        runs: [run('one', '2026-09-05T01:00:00Z', '2026-09-05T02:00:00Z', 100, 110)],
        pointEvents: [
            { accountKey: 'account-a', runKey: 'one', source: 'account-balance', points: 7, confirmedAt: '2026-09-05T01:30:00Z' },
            { accountKey: 'account-a', runKey: 'one', source: 'read', points: 3, confirmedAt: '2026-09-05T01:40:00Z' }
        ]
    })
    assert.equal(result.todayGained, 10)
    assert.equal(result.confirmedPoints, null)
    assert.equal(result.unattributedPoints, null)
})

test('pending task verification is excluded from confirmed points', () => {
    const result = reconcileAccountDay({
        date: '2026-09-05',
        accountKey: 'account-a',
        runs: [run('one', '2026-09-05T01:00:00Z', '2026-09-05T02:00:00Z', 100, 100)],
        tasks: [{ accountKey: 'account-a', runKey: 'one', status: 'completed', verification: 'pending', expectedPoints: 10 }]
    })
    assert.equal(result.confirmedPoints, 0)
    assert.equal(result.pendingPoints, null)
    assert.equal(result.pendingExpectedPoints, 10)
    assert.equal(result.pendingTaskCount, 1)
})

test('never substitutes task reports for missing balance snapshots', () => {
    const result = reconcileAccountDay({
        date: '2026-09-05',
        accountKey: 'account-a',
        runs: [run('one', '2026-09-05T01:00:00Z', '2026-09-05T02:00:00Z', null, null)],
        pointEvents: [{ accountKey: 'account-a', runKey: 'one', source: 'checkIn', points: 5, confirmedAt: '2026-09-05T01:30:00Z' }]
    })
    assert.equal(result.todayGained, null)
    assert.equal(result.confirmedPoints, null)
    assert.equal(result.reportedTaskPoints, 5)
})

test('daily reconciliation keeps event-only accounts visible', () => {
    const result = reconcileDailyPoints({
        date: '2026-09-05',
        runs: [run('one', '2026-09-05T01:00:00Z', '2026-09-05T02:00:00Z', null, null)],
        pointEvents: [{ runKey: 'one', accountKey: 'account-a', source: 'checkIn', points: 5, confirmedAt: '2026-09-05T01:30:00Z' }]
    })
    assert.equal(result.todayGained, null)
    assert.equal(result.confirmedPoints, null)
})

test('unknown balances remain pending and balance decreases retain their sign', () => {
    const unknown = reconcileAccountDay({ date: '2026-09-05', accountKey: 'account-a', runs: [] })
    assert.equal(unknown.todayGained, null)
    const decrease = reconcileAccountDay({
        date: '2026-09-05',
        accountKey: 'account-a',
        runs: [run('one', '2026-09-05T01:00:00Z', '2026-09-05T02:00:00Z', 110, 100)]
    })
    assert.equal(decrease.todayGained, -10)
    assert.equal(decrease.unattributedPoints, null)
})

test('Shanghai local dates isolate midnight and accounts and are idempotent', () => {
    const runs = [
        run('previous', '2026-09-04T15:50:00Z', '2026-09-04T15:59:00Z', 100, 110),
        run('today', '2026-09-04T16:01:00Z', '2026-09-04T16:10:00Z', 110, 115),
        run('other', '2026-09-05T01:00:00Z', '2026-09-05T02:00:00Z', 200, 250, 'account-b')
    ]
    const input = { date: '2026-09-05', runs, pointEvents: [] }
    const first = reconcileDailyPoints(input)
    const second = reconcileDailyPoints(input)
    assert.deepEqual(second, first)
    assert.equal(first.todayGained, 55)
    assert.equal(first.accounts.length, 2)
    assert.deepEqual(first.accounts.map(account => account.accountKey).sort(), ['account-a', 'account-b'])
})
