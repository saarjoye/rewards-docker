import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { TaskTelemetry } = require('../../dist/util/TaskTelemetry.js')
const { UrlReward } = require('../../dist/functions/activities/api/UrlReward.js')
const { DailyCheckIn } = require('../../dist/functions/activities/app/DailyCheckIn.js')
const { AppReward } = require('../../dist/functions/activities/app/AppReward.js')
const { ClaimBonusPoints } = require('../../dist/functions/activities/api/ClaimBonusPoints.js')
const { businessDate } = require('../../dist/util/BusinessDate.js')

function fixture(response = {}) {
    const events = [],
        waits = []
    let submissions = 0
    const bot = {
        isMobile: true,
        accessToken: 'synthetic-only',
        nextActions: { reportActivity: 'synthetic', reportClaimAllPoints: 'synthetic' },
        userData: { currentPoints: 100, geoLocale: 'test', langCode: 'test', timezoneOffset: -480 },
        config: { skipNonPointTasks: false },
        logger: { info() {}, warn() {}, error() {}, debug() {} },
        utils: { wait: async () => {}, randomDelay: () => 0 },
        http: {
            request: async request => {
                assert.equal(request.retries, 0)
                submissions++
                return { status: 200, data: { response } }
            }
        },
        browser: {
            func: {
                ensureOffer: async () => ({ hash: 'synthetic', reportable: true, points: 5 }),
                reportServerAction: async () => {
                    submissions++
                    return { status: 200, acknowledged: true, availablePoints: response.balance }
                }
            },
            react: { routerStateTree: () => 'synthetic' }
        }
    }
    const telemetry = new TaskTelemetry({
        account: () => 'fixture@example.com',
        emit: event => events.push(event),
        wait: async ms => waits.push(ms),
        observe: async () => ({
            balance: null,
            current: null,
            total: null,
            completed: null,
            unit: 'points',
            observedAt: new Date().toISOString()
        })
    })
    const spec = { key: 'fixture', title: '合成任务', source: 'app', platform: 'mobile', offerId: 'fixture' }
    return { bot, telemetry, spec, events, waits, submissions: () => submissions }
}

test('UrlReward acknowledgement without balance never becomes credit and never replays', async () => {
    const f = fixture()
    await f.telemetry.run({ ...f.spec, source: 'rsc' }, () => new UrlReward(f.bot).doUrlReward({ offerId: 'fixture' }))
    const result = f.events.at(-1)
    assert.equal(result.status, 'submitted')
    assert.equal(result.verification, 'pending')
    assert.equal(result.earnedPoints, null)
    assert.deepEqual(f.waits, [2000, 10000])
    await f.telemetry.run({ ...f.spec, source: 'rsc', platform: 'desktop' }, () => assert.fail('duplicate mutation'))
    assert.equal(f.submissions(), 1)
    assert.equal(f.events.at(-1).status, 'submitted')
})

test('App balance changes alone are unattributed; explicit credit including zero is reported', async () => {
    for (const Type of [DailyCheckIn, AppReward]) {
        for (const response of [
            {},
            { balance: 0 },
            { balance: 110 },
            { balance: 100, creditedPoints: 0 },
            { balance: 105, creditedPoints: 5 }
        ]) {
            const f = fixture(response)
            const activity = new Type(f.bot)
            await f.telemetry.run(f.spec, () =>
                Type === DailyCheckIn
                    ? activity.doDailyCheckIn()
                    : activity.doAppReward({ attributes: { offerid: 'fixture' } })
            )
            const result = f.events.at(-1)
            assert.equal(result.earnedPoints, response.creditedPoints ?? null)
            assert.equal(
                result.verification,
                response.creditedPoints === 0 ? 'confirmed-zero' : response.creditedPoints ? 'confirmed' : 'pending'
            )
            assert.equal(f.submissions(), 1)
            if (response.balance !== undefined) assert.equal(f.bot.userData.currentPoints, response.balance)
        }
    }
})

test('activity errors propagate as failures; bonus acknowledgement cannot imply payment', async () => {
    const f = fixture()
    f.bot.http.request = async () => {
        throw new Error('synthetic failure')
    }
    await assert.rejects(() => f.telemetry.run(f.spec, () => new DailyCheckIn(f.bot).doDailyCheckIn()), /synthetic/)
    assert.equal(f.events.at(-1).status, 'failed')
    const bonus = fixture({ balance: 150 })
    await bonus.telemetry.run(bonus.spec, () => new ClaimBonusPoints(bonus.bot).claimBonusPoints())
    assert.equal(bonus.events.at(-1).earnedPoints, null)
    assert.equal(bonus.events.at(-1).status, 'submitted')
})

test('business dates switch at Shanghai midnight rather than UTC midnight', () => {
    assert.equal(businessDate(new Date('2026-09-07T15:59:59Z')), '2026-09-07')
    assert.equal(businessDate(new Date('2026-09-07T16:00:00Z')), '2026-09-08')
})

test('shared offer deduplication never crosses account boundaries', async () => {
    const f = fixture()
    let account = 'first@example.com',
        calls = 0
    const reporter = new TaskTelemetry({
        account: () => account,
        emit() {},
        wait: async () => {},
        observe: async () => ({
            balance: null,
            current: null,
            total: null,
            completed: null,
            unit: 'points',
            observedAt: new Date().toISOString()
        })
    })
    await reporter.run(f.spec, async () => calls++)
    account = 'second@example.com'
    await reporter.run(f.spec, async () => calls++)
    assert.equal(calls, 2)
})

test('parallel invocations reserve a shared offer before the first read yields', async () => {
    const f = fixture()
    let calls = 0
    await Promise.all([
        f.telemetry.run({ ...f.spec, source: 'rsc' }, async () => calls++),
        f.telemetry.run({ ...f.spec, source: 'rsc', platform: 'desktop' }, async () => calls++)
    ])
    assert.equal(calls, 1)
    assert.equal(f.events.filter(event => event.terminal).length, 1)
})
