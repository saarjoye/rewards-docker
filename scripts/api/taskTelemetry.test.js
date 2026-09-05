import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { applyLogToRunState, createRunState, summarizeRunState } from './logParser.js'
import { accountRef, interruptTasks, historyRecord } from './taskEvents.js'

const require = createRequire(import.meta.url)
const {
    TaskTelemetry,
    finitePoints,
    markTaskStatus,
    recordTaskError,
    reportTaskEvidence,
    confirmationContext
} = require('../../dist/util/TaskTelemetry.js')
const { evidenceFromPayload } = require('../../dist/util/TaskEvidence.js')
const { ReadToEarn } = require('../../dist/functions/activities/app/ReadToEarn.js')
const account = 'synthetic@example.com'
const spec = { key: 'read', title: '阅读', source: 'app', platform: 'mobile', offerId: 'offer' }
const evidence = (current, total = 30) => ({
    current,
    total,
    completed: current === null ? null : current >= total,
    unit: 'points',
    balance: current === null ? null : 100 + current,
    observedAt: new Date().toISOString()
})
function fixture(observations) {
    const events = [],
        delays = []
    let reads = 0
    const reporter = new TaskTelemetry({
        account: () => account,
        emit: event => events.push(event),
        wait: async ms => delays.push(ms),
        observe: async () => {
            const item = observations[Math.min(reads++, observations.length - 1)]
            if (item instanceof Error) throw item
            return item
        }
    })
    return { reporter, events, delays, reads: () => reads }
}
const last = item => item.events.at(-1)

test('finite evidence preserves legal zero but rejects missing and non-numeric values', () => {
    for (const value of [null, undefined, '', ' ', false, NaN, Infinity, -1, {}])
        assert.equal(finitePoints(value), null)
    assert.equal(finitePoints(0), 0)
    assert.equal(finitePoints('3'), 3)
})
test('source readers never replace missing counters with completed zero', () => {
    const search = { ...spec, source: 'flyout', counter: 'pcSearch' }
    assert.equal(evidenceFromPayload(search, {}).current, null)
    assert.equal(
        evidenceFromPayload(search, { flyoutResult: { userStatus: { counters: { PCSearch: [] } } } }).completed,
        null
    )
    const result = evidenceFromPayload(search, {
        flyoutResult: {
            userStatus: { availablePoints: 0, counters: { PCSearch: [{ pointProgress: 0, pointProgressMax: 90 }] } }
        }
    })
    assert.equal(result.balance, 0)
    assert.equal(result.completed, false)
    const rsc = evidenceFromPayload(
        { ...spec, source: 'rsc' },
        { offers: [{ offerId: 'offer', isCompleted: true, points: 10 }] }
    )
    assert.equal(rsc.completed, true)
    assert.equal(rsc.current, null)
})
test('completion and task gain use official task counters, not balance deltas', async () => {
    const f = fixture([evidence(0), { ...evidence(30), balance: 999 }])
    let mutations = 0
    await f.reporter.run(spec, async () => mutations++)
    assert.equal(mutations, 1)
    assert.equal(last(f).status, 'completed')
    assert.equal(last(f).earnedPoints, 30)
    assert.equal(last(f).balanceChange, 899)
})
test('already completed task never submits another activity', async () => {
    const f = fixture([evidence(30)])
    await f.reporter.run(spec, async () => assert.fail('must not mutate'))
    assert.equal(last(f).earnedPoints, 0)
    assert.equal(last(f).status, 'completed')
})
test('confirmed zero and partial progress are not complete', async () => {
    for (const [points, status] of [
        [0, 'stopped'],
        [3, 'partial']
    ]) {
        const f = fixture([evidence(0), evidence(points)])
        await f.reporter.run(spec, async () => {})
        assert.equal(last(f).status, status)
        assert.equal(last(f).earnedPoints, points)
    }
})
test('missing evidence retries only reads with bounded waits, delayed credit is confirmed', async () => {
    const f = fixture([evidence(0), evidence(null), evidence(null), evidence(30)])
    let mutations = 0
    await f.reporter.run(spec, async () => mutations++)
    assert.deepEqual(f.delays, [2000, 10000])
    assert.equal(f.reads(), 4)
    assert.equal(mutations, 1)
    assert.equal(last(f).earnedPoints, 30)
    const unknown = fixture([evidence(null)])
    await unknown.reporter.run(spec, async () => {})
    assert.equal(last(unknown).earnedPoints, null)
    assert.equal(last(unknown).status, 'verifying')
    assert.equal(unknown.reads(), 4)
})
test('authentication and throttling stop confirmation immediately without replay', async () => {
    for (const status of [401, 403, 429]) {
        const error = Object.assign(new Error('synthetic'), { status })
        const f = fixture([evidence(0), error])
        await f.reporter.run(spec, async () => {})
        assert.equal(f.reads(), 2)
        assert.deepEqual(f.delays, [])
        assert.equal(last(f).verification, 'pending')
    }
})
test('unchanged task counters are rechecked for delayed credit without resubmission', async () => {
    const f = fixture([evidence(0), evidence(0), evidence(0), evidence(30)])
    let submissions = 0
    await f.reporter.run(spec, async () => submissions++)
    assert.equal(submissions, 1)
    assert.equal(f.reads(), 4)
    assert.deepEqual(f.delays, [2000, 10000])
    assert.equal(last(f).earnedPoints, 30)
})
test('read-only parser errors do not mark the activity execution failed', async () => {
    const events = []
    let submissions = 0
    const reporter = new TaskTelemetry({
        account: () => account,
        emit: event => events.push(event),
        wait: async () => {},
        observe: async () => {
            recordTaskError()
            throw new Error('synthetic unavailable evidence')
        }
    })
    await reporter.run(spec, async () => submissions++)
    assert.equal(submissions, 1)
    assert.equal(events.at(-1).status, 'verifying')
    assert.equal(events.at(-1).earnedPoints, null)
})
test('swallowed errors stay failed and explicit skipped tasks do not confirm', async () => {
    const f = fixture([evidence(0), evidence(3)])
    await f.reporter.run(spec, async () => recordTaskError())
    assert.equal(last(f).status, 'failed')
    assert.equal(last(f).earnedPoints, 3)
    const skipped = fixture([evidence(0)])
    await skipped.reporter.run(spec, async () => markTaskStatus('skipped', '合成跳过'))
    assert.equal(last(skipped).status, 'skipped')
    assert.equal(skipped.reads(), 1)
})
test('parent groups do not duplicate child gains and parallel contexts remain isolated', async () => {
    const events = []
    const counts = new Map()
    const reporter = new TaskTelemetry({
        account: () => account,
        emit: e => events.push(e),
        wait: async () => {},
        observe: async s => {
            const count = counts.get(s.platform) ?? 0
            counts.set(s.platform, count + 1)
            return evidence(count ? 30 : 0)
        }
    })
    await reporter.run({ ...spec, group: true, source: 'group' }, () =>
        Promise.all([
            reporter.run(spec, async () => {}),
            reporter.run({ ...spec, platform: 'desktop' }, async () => {})
        ])
    )
    const terminal = events.filter(e => e.terminal)
    assert.equal(terminal.length, 3)
    assert.equal(terminal.at(-1).earnedPoints, null)
    assert.equal(terminal.filter(e => e.earnedPoints === 30).length, 2)
    assert.notEqual(terminal[0].id, terminal[1].id)
})
test('read activity stops on first zero or missing balance without false completion', async () => {
    for (const balance of [100, undefined]) {
        let posts = 0
        const logs = []
        const log = (...args) => logs.push(args.join(' '))
        const bot = {
            accessToken: 'synthetic-placeholder',
            isMobile: true,
            config: { searchSettings: { readDelay: { min: 1, max: 2 } } },
            userData: { currentPoints: 100, gainedPoints: 0, geoLocale: 'synthetic', langCode: 'zh-CN' },
            logger: { info: log, warn: log, error: log, debug: log },
            utils: { wait: async () => {}, randomDelay: () => 1 },
            http: {
                request: async config => {
                    posts++
                    assert.equal(config.retries, 0)
                    return { status: 200, data: { response: { balance } } }
                }
            }
        }
        await new ReadToEarn(bot).doReadToEarn()
        assert.equal(posts, 1)
        assert.doesNotMatch(logs.join('\n'), /Completed Read to Earn|synthetic-placeholder/)
    }
})
function stateFixture() {
    const state = createRunState()
    applyLogToRunState(state, {
        parsed: true,
        level: 'info',
        user: 'synthetic',
        title: 'ACCOUNT-START',
        message: `Starting account: ${account} | geoLocale: test`
    })
    return state
}
test('event reducer deduplicates and ignores late running events and legacy point logs', async () => {
    const f = fixture([evidence(0), evidence(30)])
    await f.reporter.run(spec, async () => {})
    const state = stateFixture()
    const apply = e => applyLogToRunState(state, { parsed: true, title: 'TASK-EVENT', message: JSON.stringify(e) })
    for (const event of f.events) apply(event)
    for (const event of f.events.toReversed()) apply(event)
    applyLogToRunState(state, {
        parsed: true,
        title: 'READ-TO-EARN',
        user: 'synthetic',
        platform: 'MOBILE',
        message: 'Completed Read to Earn | pointsGained=500'
    })
    const result = summarizeRunState(state).accounts[0]
    assert.equal(result.pointRecords.length, 1)
    assert.equal(result.collectedPoints, 30)
    assert.equal(result.tasks.length, 1)
    assert.equal(result.tasks[0].status, 'completed')
    assert.equal(apply({ ...last(f), accountRef: accountRef('other@example.com'), sequence: 999 }), null)
})
test('interrupting a run marks unfinished tasks without changing confirmed credits', () => {
    const run = {
        accounts: [
            {
                telemetryVersion: 2,
                collectedPoints: 3,
                tasks: [{ telemetryVersion: 2, status: 'running', terminal: false }]
            }
        ]
    }
    interruptTasks(run)
    assert.equal(run.accounts[0].tasks[0].status, 'interrupted')
    assert.equal(run.accounts[0].collectedPoints, 3)
})
test('snapshots merge progress with execution and cannot restore a stale balance', async () => {
    const state = stateFixture()
    const snapshot = {
        version: 2,
        accountRef: accountRef(account),
        source: 'app',
        platform: 'mobile',
        dataStatus: 'available',
        planned: true,
        tasks: [{ id: 'offer', title: '阅读', current: 0, points: 30 }]
    }
    const apply = (title, payload) =>
        applyLogToRunState(state, {
            parsed: true,
            title,
            message: JSON.stringify(payload)
        })
    apply('TASK-SNAPSHOT', snapshot)
    let result = summarizeRunState(state).accounts[0]
    assert.equal(result.telemetryVersion, 2)
    assert.equal(result.tasks[0].remainingPoints, 30)
    assert.deepEqual(result.tasks[0].progress, { current: 0, total: 30, unit: 'points' })
    const f = fixture([evidence(0), evidence(30)])
    await f.reporter.run(spec, async () => {})
    for (const event of f.events) apply('TASK-EVENT', event)
    apply('TASK-SNAPSHOT', snapshot)
    result = summarizeRunState(state).accounts[0]
    assert.equal(result.tasks.length, 1)
    assert.equal(result.tasks[0].earnedPoints, 30)
    apply('TASK-EVENT', {
        ...last(f),
        kind: 'balance',
        phase: 'end',
        eventId: 'synthetic:999',
        sequence: 999,
        balance: null
    })
    result = summarizeRunState(state).accounts[0]
    assert.equal(result.live.balance, null)
    assert.equal(result.finalPoints, null)
    assert.equal(result.collectedPoints, 30)
})

test('a direct per-activity credit response needs no confirmation request or baseline balance', async () => {
    const f = fixture([evidence(null)])
    await f.reporter.run(spec, async () =>
        reportTaskEvidence({
            completed: true,
            current: null,
            total: null,
            balance: 150,
            creditedPoints: 5,
            unit: 'points'
        })
    )
    assert.equal(last(f).earnedPoints, 5)
    assert.equal(last(f).status, 'completed')
    assert.equal(f.reads(), 1)
})
test('task-scoped mutations and confirmation reads disable transport retries only in scope', async () => {
    const { requestRetryLimit } = require('../../dist/util/Http.js')
    assert.equal(requestRetryLimit({ method: 'POST', retries: 2 }), 2)
    assert.equal(
        confirmationContext.run(true, () => requestRetryLimit({ method: 'GET', retries: 3 })),
        0
    )
    const f = fixture([evidence(0), evidence(30)])
    await f.reporter.run(spec, async () => {
        assert.equal(requestRetryLimit({ method: 'POST', retries: 3 }), 0)
        assert.equal(requestRetryLimit({ method: 'GET', retries: 2 }), 2)
    })
})
test('history API mapping preserves confirmation evidence and nullable totals', () => {
    const record = historyRecord({
        id: 'synthetic-run',
        run: {
            telemetryVersion: 2,
            collected: null,
            accounts: [
                {
                    email: account,
                    telemetryVersion: 2,
                    collectedPoints: null,
                    pointRecords: [],
                    pendingVerification: 1,
                    tasks: [],
                    live: { gained: null }
                }
            ]
        }
    })
    assert.equal(record.collected, null)
    assert.equal(record.accounts[0].collected, null)
    assert.equal(record.accounts[0].telemetryVersion, 2)
    assert.equal(record.accounts[0].pendingVerification, 1)
})
test('read-only confirmation selects the original source without browser navigation', async () => {
    const BrowserFunc = require('../../dist/browser/BrowserFunc.js').default
    const requests = []
    const bot = {
        accessToken: 'synthetic-placeholder',
        fingerprint: { headers: {} },
        userData: { geoLocale: 'test' },
        http: {
            request: async request => {
                requests.push(request)
                return { status: 200, data: {} }
            }
        },
        browser: {
            react: {
                snapshotPage: (_html, emit) => {
                    assert.equal(emit, false)
                    return { offers: [] }
                }
            }
        }
    }
    const func = new BrowserFunc(bot)
    func.getCachedCookies = () => []
    for (const source of ['rsc', 'flyout', 'app', 'dashboard']) await func.observeTask({ ...spec, source })
    assert.match(requests[0].url, /rewards.*\/earn/)
    assert.match(requests[1].url, /bing\.com/)
    assert.match(requests[2].url, /rewardsplatform/)
    assert.match(requests[3].url, /getuserinfo/)
    assert.ok(requests.every(request => request.method === 'GET' && request.retries === 0))
})
