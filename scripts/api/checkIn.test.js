import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { checkInState, CHECK_IN_OFFER, CHECK_IN_CHANNEL } = require('../../dist/util/CheckIn.js')
const { evidenceFromPayload } = require('../../dist/util/TaskEvidence.js')
const { TaskTelemetry } = require('../../dist/util/TaskTelemetry.js')
const { DailyCheckIn } = require('../../dist/functions/activities/app/DailyCheckIn.js')
const BrowserFunc = require('../../dist/browser/BrowserFunc.js').default

const spec = {
    key: 'check-in',
    title: '每日签到',
    source: 'app',
    platform: 'mobile',
    offerId: CHECK_IN_OFFER,
    channel: CHECK_IN_CHANNEL
}
const attrs = { offerid: CHECK_IN_OFFER, progress: '6', last_updated: '2026-09-06', day_7_points: '20' }
const evidence = completed => ({
    balance: 100,
    current: completed ? 1 : 0,
    total: 1,
    completed,
    unit: 'items',
    observedAt: new Date().toISOString()
})

test('check-in uses Shanghai calendar dates, includes day seven, and rejects ambiguous dates', () => {
    const now = new Date('2026-09-06T16:00:01Z')
    assert.deepEqual(checkInState(attrs, now), { completed: false, expected: 20 })
    assert.equal(checkInState({ ...attrs, last_updated: '2026-08-07' }, now).completed, false)
    assert.equal(checkInState({ ...attrs, last_updated: '2026-09-06T16:00:00Z' }, now).completed, true)
    for (const last_updated of [undefined, '', 'bad', '2026-02-30', '2026-09-08', '2026-09-07T01:00:00'])
        assert.equal(checkInState({ ...attrs, last_updated }, now).completed, null)
})

test('check-in snapshots recognize today without treating streak progress or advertised rewards as credit', () => {
    const { businessDate } = require('../../dist/util/BusinessDate.js')
    const payload = {
        response: { balance: 100, promotions: [{ attributes: { ...attrs, last_updated: businessDate() } }] }
    }
    const result = evidenceFromPayload(spec, payload)
    assert.equal(result.completed, true)
    assert.equal(result.unit, 'items')
    assert.equal(result.current, 1)
    assert.equal(result.creditedPoints, undefined)
})

async function runCheckIn(data, observations) {
    const events = [],
        waits = []
    let submits = 0,
        reads = 0
    const bot = {
        isMobile: true,
        accessToken: 'synthetic-only',
        userData: { currentPoints: 100, geoLocale: 'test', langCode: 'test' },
        logger: { info() {}, warn() {}, debug() {}, error() {} },
        http: {
            request: async request => {
                submits++
                assert.equal(request.retries, 0)
                assert.equal(JSON.parse(request.data).channel, CHECK_IN_CHANNEL)
                return { status: 200, data }
            }
        }
    }
    const telemetry = new TaskTelemetry({
        account: () => 'synthetic-account',
        emit: event => events.push(event),
        wait: async ms => waits.push(ms),
        observe: async () => observations[Math.min(reads++, observations.length - 1)]
    })
    let error
    try {
        await telemetry.run(spec, () => new DailyCheckIn(bot).doDailyCheckIn())
    } catch (caught) {
        error = caught
    }
    return { last: events.at(-1), submits, reads, waits, error }
}

test('business rejection, missing code and missing result cannot pass as accepted check-in', async () => {
    for (const data of [{ code: 12345 }, {}, { code: 0 }]) {
        const r = await runCheckIn(data, [evidence(false)])
        assert.ok(r.error)
        assert.equal(r.submits, 1)
        assert.equal(r.last.status, 'failed')
        assert.equal(r.last.earnedPoints, null)
        assert.ok(r.reads <= 4)
    }
})

test('known completion or unknown eligibility never submits a check-in', async () => {
    for (const completed of [true, null]) {
        const r = await runCheckIn({}, [evidence(completed)])
        assert.equal(r.submits, 0)
        assert.equal(r.last.status, completed ? 'skipped' : 'unavailable')
    }
})

test('accepted check-in has bounded read-only confirmation; completion is not a credited reward', async () => {
    const r = await runCheckIn({ code: 0, response: { balance: 105 } }, [
        evidence(false),
        evidence(false),
        evidence(true)
    ])
    assert.equal(r.submits, 1)
    assert.equal(r.last.status, 'completed')
    assert.equal(r.last.verification, 'pending')
    assert.equal(r.last.earnedPoints, null)
    assert.equal(r.last.expectedPoints, null)
    assert.equal(r.last.remainingPoints, null)
    assert.deepEqual(r.waits, [2000])
    const exhausted = await runCheckIn({ code: 0, response: {} }, [evidence(false)])
    assert.deepEqual(exhausted.waits, [2000, 10000])
    assert.equal(exhausted.submits, 1)
    assert.match(exhausted.last.action, /本轮复核结束/)
    for (const creditedPoints of [0, 5]) {
        const direct = await runCheckIn({ code: 0, response: { creditedPoints } }, [evidence(false)])
        assert.equal(direct.last.earnedPoints, creditedPoints)
        assert.equal(direct.last.verification, 'pending')
        assert.equal(direct.last.reportedPoints, creditedPoints)
        assert.equal(direct.submits, 1)
    }
})

test('check-in estimated quota uses its submission channel and seventh-day reward', async () => {
    const channels = []
    const bot = {
        accessToken: 'synthetic-only',
        userData: { geoLocale: 'test', langCode: 'test' },
        logger: { error() {} },
        http: {
            request: async request => {
                const channel = new URL(request.url).searchParams.get('channel')
                channels.push(channel)
                return {
                    status: 200,
                    data: {
                        code: 0,
                        response: {
                            promotions:
                                channel === CHECK_IN_CHANNEL
                                    ? [{ attributes: { ...attrs, last_updated: '2000-01-01' } }]
                                    : []
                        }
                    }
                }
            }
        }
    }
    const result = await new BrowserFunc(bot).getAppEarnablePoints()
    assert.deepEqual(channels, ['SAAndroid', CHECK_IN_CHANNEL])
    assert.equal(result.checkIn, 20)
})

test('check-in observation uses the same channel and rejects business errors without a mutation', async () => {
    const requests = []
    const bot = {
        accessToken: 'synthetic-only',
        userData: { geoLocale: 'test' },
        fingerprint: { headers: {} },
        http: {
            request: async request => {
                requests.push(request)
                return { status: 200, data: { code: 12345, response: { balance: 100 } } }
            }
        }
    }
    await assert.rejects(() => new BrowserFunc(bot).observeTask(spec), /结果码 12345/)
    assert.equal(requests.length, 1)
    assert.equal(requests[0].method, 'GET')
    assert.equal(requests[0].retries, 0)
    assert.equal(new URL(requests[0].url).searchParams.get('channel'), CHECK_IN_CHANNEL)
})
