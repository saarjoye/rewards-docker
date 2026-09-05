import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { AsyncLocalStorage } from 'node:async_hooks'
import { applyLogToRunState, createRunState, summarizeRunState } from './logParser.js'
import { accountRef, structuredAccountStatus } from './taskEvents.js'

const require = createRequire(import.meta.url)
const {
    promotionEligibility,
    offerEligibility,
    questEligibility,
    appEligibility
} = require('../../dist/util/TaskEligibility.js')
const { SearchProgress } = require('../../dist/functions/activities/search/SearchProgress.js')
const { mapFlyoutToDashboard } = require('../../dist/browser/FlyoutDashboard.js')
const { MorePromotions } = require('../../dist/functions/activities/rewards/MorePromotions.js')
const { DailySet } = require('../../dist/functions/activities/rewards/DailySet.js')
const { PunchCards } = require('../../dist/functions/activities/rewards/PunchCards.js')
const { TaskTelemetry } = require('../../dist/util/TaskTelemetry.js')
const { Search } = require('../../dist/functions/activities/search/BrowserSearch.js')
const { ApiSearch } = require('../../dist/functions/activities/experimental/ApiSearch.js')
const ReactFunc = require('../../dist/browser/ReactFunc.js').default
const searchManagerPath = new URL('../../dist/functions/activities/search/SearchManager.js', import.meta.url)
const managerModule = { exports: {} }
const localRequire = createRequire(searchManagerPath)
vm.runInNewContext(readFileSync(searchManagerPath, 'utf8'), {
    exports: managerModule.exports,
    require: name => (name === '../../../index' ? { executionContext: new AsyncLocalStorage() } : localRequire(name))
})
const { SearchManager } = managerModule.exports

const config = () => ({
    workers: {
        doDailySet: true,
        doMorePromotions: true,
        doMobileSearch: true,
        doDesktopSearch: true,
        doPunchCards: true,
        doAppPromotions: true,
        doReadToEarn: true,
        doDailyCheckIn: true,
        doVisualSearch: false,
        doActivateSearchPerk: false
    },
    activities: { urlReward: true, searchOnBing: true },
    experimental: { edgeBrowsing: false },
    searchSettings: { runOnZeroPoints: false },
    skipNonPointTasks: true,
    autoClaimPunchcardRewards: false
})
const promotion = patch => ({
    offerId: 'synthetic-offer',
    name: 'synthetic-url',
    title: '合成活动',
    promotionType: 'urlreward',
    pointProgress: 0,
    pointProgressMax: 10,
    complete: false,
    priority: 0,
    attributes: {},
    ...patch
})
const counter = (current = 0, max = 90) => ({ pointProgress: current, pointProgressMax: max })
const observation = (current, total) => ({
    current,
    total,
    balance: null,
    completed: current !== null && current >= total,
    unit: 'points',
    observedAt: new Date().toISOString()
})
function fixture(counters = {}, observations = {}) {
    const logs = [],
        waits = [],
        reads = [],
        events = [],
        actions = []
    const bot = {
        config: config(),
        isMobile: true,
        currentAccountEmail: 'synthetic@example.com',
        userData: { currentPoints: 100, gainedPoints: 0 },
        cookies: { mobile: [], desktop: [] },
        logger: Object.fromEntries(
            ['info', 'warn', 'error', 'debug'].map(level => [level, (...args) => logs.push([level, ...args])])
        ),
        utils: { wait: async ms => waits.push(ms), randomDelay: () => 1, getFormattedDate: () => '09/05/2026' },
        browser: {
            func: {
                getDashboardData: async () => ({ dashboard: { userStatus: { counters } } }),
                taskDashboardSource: () => 'flyout',
                observeTask: async spec => {
                    reads.push(spec.platform)
                    const result = observations[spec.platform]?.shift() ?? observation(null, null)
                    if (result instanceof Error) throw result
                    return result
                }
            }
        },
        activities: {
            doUrlReward: async p => actions.push(['url', p.offerId]),
            doSearchOnBing: async p => actions.push(['search', p.offerId])
        }
    }
    bot.activities.telemetry = new TaskTelemetry({
        account: () => bot.currentAccountEmail,
        emit: event => events.push(event),
        observe: spec => bot.browser.func.observeTask(spec),
        wait: bot.utils.wait
    })
    return { bot, logs, waits, reads, events, actions }
}

test('promotion support matrix excludes known unsupported, disabled and locked tasks, not missing data', () => {
    const cfg = config()
    for (const type of ['quiz', 'findclippy', 'poll', 'search', 'purchase'])
        assert.equal(promotionEligibility(promotion({ promotionType: type }), cfg, 'more').eligibility, 'excluded')
    for (const patch of [
        { exclusiveLockedFeatureStatus: 'locked' },
        { priority: -1 },
        { attributes: { promotional: 'True' } },
        { pointProgressMax: 0 }
    ])
        assert.equal(promotionEligibility(promotion(patch), cfg, 'more').eligibility, 'excluded')
    for (const patch of [{ promotionType: null }, { pointProgressMax: null }])
        assert.equal(promotionEligibility(promotion(patch), cfg, 'more').eligibility, 'unknown')
    assert.equal(promotionEligibility(promotion({}), cfg, 'more').eligibility, 'eligible')
    assert.equal(promotionEligibility(promotion({ complete: true }), cfg, 'daily').eligibility, 'eligible')
    cfg.workers.doDailySet = false
    assert.equal(promotionEligibility(promotion({}), cfg, 'daily').eligibility, 'excluded')
    cfg.activities.searchOnBing = false
    assert.equal(promotionEligibility(promotion({ name: 'exploreonbing' }), cfg, 'more').eligibility, 'excluded')
    cfg.skipNonPointTasks = false
    assert.equal(promotionEligibility(promotion({ pointProgressMax: 0 }), cfg, 'more').eligibility, 'eligible')
})

test('page offer checks cover future dates, locks, manual claims and optional activities without guessing from title', () => {
    const cfg = config()
    const base = { offerId: 'synthetic-offer', observedPoints: 10, title: '任意标题' }
    const check = patch => offerEligibility({ ...base, ...patch }, cfg, '2026-09-05').eligibility
    assert.equal(check({}), 'unknown')
    assert.equal(check({ title: 'Xbox 不可用' }), 'unknown')
    for (const patch of [
        { isLocked: true },
        { isDisabled: true },
        { date: '2026-09-06' },
        { observedPoints: 0 },
        { offerId: 'synthetic_pcchild_claim' },
        { offerId: 'synthetic_pcchild_search_3day' },
        { offerId: 'visualsearch_streak_activation_v2' },
        { offerId: 'edge_flight_1_ww_treatment_eligible' },
        { offerId: 'synthetic_optin_2x_active' },
        { promotionType: 'quiz' }
    ])
        assert.equal(check(patch), 'excluded', JSON.stringify(patch))
    cfg.workers.doVisualSearch = true
    assert.equal(check({ offerId: 'visualsearch_streak_activation_v2', observedPoints: 0 }), 'eligible')
})

test('App and quest support matrices preserve missing metadata as unknown', () => {
    const cfg = config()
    assert.equal(appEligibility({ attributes: {} }, cfg).eligibility, 'unknown')
    assert.equal(appEligibility({ attributes: { offerid: 'x', type: 'other' } }, cfg).eligibility, 'excluded')
    assert.equal(
        appEligibility({ attributes: { offerid: 'x', type: 'sapphire', complete: 'false' } }, cfg).eligibility,
        'eligible'
    )
    const child = { offerId: 'synthetic_pcchild_url', hash: 'synthetic-placeholder' }
    assert.equal(questEligibility(child, cfg).eligibility, 'eligible')
    assert.equal(questEligibility({ ...child, hash: null }, cfg).eligibility, 'unknown')
    for (const patch of [{ isLocked: true }, { isDisabled: true }, { offerId: 'synthetic_pcchild_claim' }])
        assert.equal(questEligibility({ ...child, ...patch }, cfg).eligibility, 'excluded')
    assert.equal(questEligibility(child, cfg, promotion({ activityProgressMax: 3 })).eligibility, 'excluded')
    cfg.autoClaimPunchcardRewards = true
    assert.equal(questEligibility({ ...child, offerId: 'synthetic_pcchild_claim' }, cfg).eligibility, 'eligible')
})

test('flyout additional pools reach the actual runner once, while unsupported activities never execute', async () => {
    const f = fixture()
    const explore = promotion({ offerId: 'synthetic-explore', name: 'exploreonbing' })
    const url = promotion({})
    const unsupported = promotion({ offerId: 'synthetic-quiz', promotionType: 'quiz' })
    const data = mapFlyoutToDashboard({
        userInfo: { isRewardsUser: true, profile: { attributes: {} } },
        flyoutResult: {
            userStatus: { isRewardsUser: true, availablePoints: 100 },
            morePromotions: [url],
            highValueActionPromotions: [url, unsupported],
            exploreOnBingPromotions: [explore, url]
        }
    })
    await new MorePromotions(f.bot).run(data)
    assert.deepEqual(f.actions, [
        ['url', url.offerId],
        ['search', explore.offerId]
    ])
    assert.equal(f.waits.length, 1)
})

test('daily execution applies the same eligibility and never calls missing or unsupported tasks', async () => {
    const f = fixture()
    const pending = [
        promotion({}),
        promotion({ offerId: 'unsupported', promotionType: 'quiz' }),
        promotion({ offerId: 'locked', exclusiveLockedFeatureStatus: 'locked' }),
        promotion({ offerId: 'unknown', pointProgressMax: null }),
        promotion({ offerId: 'completed', complete: true })
    ]
    await new DailySet(f.bot).run({ dashboard: { dailySetPromotions: { '09/05/2026': pending } } })
    assert.deepEqual(f.actions, [['url', 'synthetic-offer']])
    await new DailySet(f.bot).run({ dashboard: {} })
    assert.ok(f.logs.some(entry => entry.join(' ').includes('不能判定为已完成')))
})

test('page parser retains execution metadata and does not make disabled or future offers reportable', () => {
    const f = fixture()
    const react = new ReactFunc(f.bot)
    const offers = [
        {
            offerId: 'disabled',
            hash: 'synthetic-placeholder',
            isDisabled: true,
            promotionType: 'urlreward',
            points: 10
        },
        { offerId: 'future', hash: 'synthetic-placeholder', date: '2999-01-01', points: 10 },
        { offerId: 'unsupported', promotionType: 'quiz', points: 10 }
    ]
    const html = 'self.__next_f.push([1,' + JSON.stringify(JSON.stringify({ offers })) + '])'
    const parsed = react.snapshotPage(html)
    assert.equal(parsed.offers[0].promotionType, 'urlreward')
    assert.equal(parsed.offers[0].reportable, false)
    assert.equal(parsed.offers[1].reportable, false)
    const snapshot = JSON.parse(f.logs.find(entry => entry[2] === 'TASK-SNAPSHOT')[3])
    assert.ok(snapshot.tasks.every(task => task.eligibility === 'excluded'))
})

test('missing, empty and corrupt counters do not become a completed 0/0, real zero remains valid', () => {
    const progress = new SearchProgress(fixture().bot)
    for (const counters of [
        {},
        { mobileSearch: [] },
        { mobileSearch: [counter(null)] },
        { mobileSearch: [counter('')] },
        { mobileSearch: [counter('bad')] },
        { mobileSearch: [counter(91, 90)] },
        { mobileSearch: [counter(0), null] },
        { mobileSearch: 'invalid' }
    ]) {
        assert.equal(progress.calculateQuotas(counters).mobile.known, false)
        assert.throws(() => progress.calculateMissing(counters, true), /不能判定已完成/)
    }
    assert.equal(progress.calculateMissing({ mobileSearch: [counter(0, 0)] }, true).totalPoints, 0)
    assert.equal(progress.calculateMissing({ mobileSearch: [counter(42, 57)] }, true).totalPoints, 15)
    assert.equal(progress.calculateMissing({ pcSearch: [counter(0, 90)] }, false).totalPoints, 90)
    assert.equal(progress.calculateMissing({ pcSearch: [{ ...counter(0, 20), name: 'edge' }] }, false).totalPoints, 20)
    assert.throws(() => progress.calculateMissing({ pcSearch: [null] }, false), /不能判定已完成/)
})

test('quota recovery rechecks only missing platform with bounded reads and resumes the plan', async () => {
    const f = fixture({ pcSearch: [counter(0, 90)] }, { mobile: [observation(null, null), observation(0, 60)] })
    const plan = await new SearchManager(f.bot).getSearchPoints()
    assert.equal(plan.doMobile, true)
    assert.equal(plan.doDesktop, true)
    assert.equal(plan.mobileMissing, 60)
    assert.deepEqual(f.reads, ['mobile', 'mobile'])
    assert.deepEqual(f.waits, [2000, 10000])
    assert.equal(f.actions.length, 0)
})

test('unrecoverable mobile counters leave visible pending evidence and do not block desktop', async () => {
    const f = fixture({ pcSearch: [counter(0, 90)] })
    const plan = await new SearchManager(f.bot).getSearchPoints()
    assert.equal(plan.doMobile, false)
    assert.equal(plan.mobileMissing, null)
    assert.equal(plan.doDesktop, true)
    assert.equal(f.events.length, 1)
    assert.equal(f.events[0].earnedPoints, null)
    const state = createRunState()
    applyLogToRunState(state, {
        parsed: true,
        title: 'ACCOUNT-START',
        user: 'synthetic',
        message: 'Starting account: synthetic@example.com | geoLocale: test'
    })
    applyLogToRunState(state, { parsed: true, title: 'TASK-EVENT', message: JSON.stringify(f.events[0]) })
    const task = summarizeRunState(state).accounts[0].tasks[0]
    assert.equal(task.status, 'verifying')
    assert.match(task.action, /未提交搜索/)
})

test('known zero, completed and config-disabled searches do not schedule retries', async () => {
    const f = fixture({ pcSearch: [counter(90, 90)], mobileSearch: [counter(0, 0)] })
    const plan = await new SearchManager(f.bot).getSearchPoints()
    assert.equal(plan.doMobile, false)
    assert.equal(plan.doDesktop, false)
    assert.deepEqual(f.waits, [])
    const disabled = fixture()
    disabled.bot.config.workers.doMobileSearch = false
    disabled.bot.config.workers.doDesktopSearch = false
    await new SearchManager(disabled.bot).getSearchPoints()
    assert.deepEqual(disabled.waits, [])
    assert.deepEqual(disabled.events, [])
})

test('authentication and throttling stop quota recovery immediately for the affected platform', async () => {
    for (const status of [401, 403, 429]) {
        const f = fixture(
            { pcSearch: [counter(0)] },
            {
                mobile: [Object.assign(new Error('synthetic'), { status })]
            }
        )
        const plan = await new SearchManager(f.bot).getSearchPoints()
        assert.equal(plan.doDesktop, true)
        assert.equal(plan.mobileMissing, null)
        assert.deepEqual(f.reads, ['mobile'])
        assert.deepEqual(f.waits, [2000])
    }
})

test('browser and API search cannot claim completion or send tasks when quotas remain unknown', async () => {
    for (const mode of ['browser', 'api']) {
        const f = fixture()
        const page = { goto: async () => {} }
        if (mode === 'browser') await assert.rejects(new Search(f.bot).doSearch(page, true), /不能判定已完成/)
        else await new ApiSearch(f.bot).doSearch(true)
        assert.equal(f.actions.length, 0)
        assert.equal(f.bot.userData.gainedPoints, 0)
        assert.ok(!f.logs.some(entry => /Completed Bing searches|搜索额度已完成/.test(entry.join(' '))))
    }
})

test('snapshot eligibility is scoped by account and execution plans win over incomplete page metadata', () => {
    const state = createRunState()
    const email = 'synthetic@example.com'
    applyLogToRunState(state, {
        parsed: true,
        title: 'ACCOUNT-START',
        user: 'synthetic',
        message: 'Starting account: ' + email + ' | geoLocale: test'
    })
    const apply = (planned, eligibility, ref = accountRef(email)) =>
        applyLogToRunState(state, {
            parsed: true,
            title: 'TASK-SNAPSHOT',
            message: JSON.stringify({
                version: 2,
                accountRef: ref,
                source: 'rsc',
                platform: 'mobile',
                planned,
                dataStatus: 'available',
                tasks: [{ id: 'x', title: '合成任务', eligibility, eligibilityReason: '合成原因' }]
            })
        })
    apply(true, 'excluded')
    apply(false, 'unknown')
    apply(true, 'eligible', accountRef('other@example.com'))
    assert.equal(summarizeRunState(state).accounts[0].tasks[0].eligibility, 'excluded')
    const account = state.accounts[email]
    account.error = null
    assert.equal(structuredAccountStatus(account, true), 'unknown')
    apply(true, 'eligible')
    apply(false, 'excluded')
    assert.equal(summarizeRunState(state).accounts[0].tasks[0].eligibility, 'excluded')
})

test('quest children are filtered before submitting and only executed children produce credit events', async () => {
    const f = fixture()
    const children = [
        { offerId: 'synthetic_pcchild_url', hash: 'synthetic-placeholder', points: 3, reportable: true },
        { offerId: 'synthetic_pcchild_locked', isLocked: true },
        { offerId: 'synthetic_pcchild_claim', hash: 'synthetic-placeholder', reportable: true },
        { offerId: 'synthetic_pcchild_search_3day', hash: 'synthetic-placeholder', reportable: true }
    ]
    let submissions = 0
    f.bot.nextActions = { reportActivity: 'synthetic-placeholder' }
    f.bot.browser.react = { questRouterStateTree: () => 'synthetic' }
    f.bot.browser.func.reportServerAction = async () => {
        submissions++
        return { status: 200, acknowledged: true }
    }
    f.bot.browser.func.getCurrentPoints = async () => 103
    f.bot.browser.func.observeTask = async () => observation(submissions ? 3 : 0, 3)
    const cards = new PunchCards(f.bot)
    cards.getParentQuests = async () => [{ offerId: 'synthetic_pcparent', title: '合成打卡', pointProgressMax: 10 }]
    cards.getQuestChildren = async () => children
    await f.bot.activities.telemetry.run(
        {
            key: 'punchcards',
            title: '合成打卡',
            source: 'group',
            platform: 'mobile',
            group: true
        },
        () => cards.runMobile({ dashboard: {} })
    )
    assert.equal(submissions, 1)
    const terminal = f.events.filter(event => event.terminal)
    assert.equal(terminal.length, 2)
    assert.equal(terminal[0].earnedPoints, 3)
    assert.equal(terminal[1].earnedPoints, null)
    const snapshot = JSON.parse(f.logs.find(entry => entry[2] === 'TASK-SNAPSHOT')[3])
    assert.deepEqual(
        snapshot.tasks.map(task => task.eligibility),
        ['eligible', 'excluded', 'excluded', 'excluded']
    )
})

test('quota disappearance after a valid reading rejects instead of fabricating the remaining points as gains', async () => {
    const f = fixture({ mobileSearch: [counter(0, 60)] })
    const progress = new SearchProgress(f.bot)
    assert.equal((await progress.getMissing(true)).totalPoints, 60)
    f.bot.browser.func.getDashboardData = async () => ({ dashboard: { userStatus: { counters: {} } } })
    await assert.rejects(progress.getMissing(true), /不能判定已完成/)
    assert.equal(f.bot.userData.gainedPoints, 0)
    assert.equal(f.actions.length, 0)
})
