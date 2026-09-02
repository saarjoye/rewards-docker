const assert = require('node:assert/strict')
const {
    dashboardFromApiPayload,
    dashboardFromFlyoutPayload,
    dashboardFromFlightEntries,
    dashboardFromHtml,
    availablePointsFromApiPayload,
    validateDashboardData
} = require('../../dist/util/DashboardParser')
const { calculateMissingSearchPoints } = require('../../dist/util/SearchCounter')

function dashboard(points = 1234) {
    return {
        userStatus: {
            availablePoints: points,
            counters: { pcSearch: [], mobileSearch: [] }
        },
        dailySetPromotions: {},
        promotionalItems: [],
        morePromotions: [],
        morePromotionsWithoutPromotionalItems: [],
        punchCards: [],
        userProfile: { attributes: { country: 'CN' } }
    }
}

const valid = dashboardFromApiPayload({ dashboard: dashboard() })
assert.equal(valid.data.userStatus.availablePoints, 1234)
assert.equal(valid.source, 'api')

const missing = dashboardFromApiPayload({ profile: {} })
assert.equal(missing.data, null)
assert.match(missing.reason, /缺少 dashboard/)

assert.equal(validateDashboardData({ userStatus: { availablePoints: 0 } }).valid, false)
assert.deepEqual(availablePointsFromApiPayload({ dashboard: { userStatus: { availablePoints: 0 } } }), {
    points: 0,
    reason: 'ok'
})
assert.equal(availablePointsFromApiPayload({ dashboard: { userStatus: { availablePoints: -1 } } }).points, null)
assert.equal(availablePointsFromApiPayload({ dashboard: { userStatus: { availablePoints: 1.5 } } }).points, null)

const partial = dashboardFromApiPayload(
    {
        dashboard: {
            userStatus: { availablePoints: 456, counters: { pcSearch: [] } }
        }
    },
    { geoLocale: 'US' }
)
assert.equal(partial.data.userStatus.availablePoints, 456)
assert.deepEqual(partial.data.userStatus.counters.mobileSearch, [])
assert.equal(partial.data.dashboardFieldAvailability.mobileSearch, 'missing')
assert.equal(partial.data.dashboardFieldAvailability.pcSearch, 'empty')
assert.equal(partial.data.dashboardFieldAvailability.dailySetPromotions, 'missing')
assert.equal(partial.data.dashboardFieldAvailability.country, 'fallback')
assert.equal(partial.data.userProfile.attributes.country, 'us')
const partialSearch = calculateMissingSearchPoints(
    partial.data.userStatus.counters,
    true,
    'dashboard',
    partial.data.dashboardFieldAvailability
)
assert.equal(partialSearch.mobileStatus, 'missing-counter')
assert.equal(partialSearch.desktopCounter.status, 'empty-counter')

const invalidPc = dashboardFromApiPayload({
    dashboard: {
        ...dashboard(),
        userStatus: { availablePoints: 456, counters: { pcSearch: [{ pointProgress: 'bad' }] } }
    }
})
assert.equal(invalidPc.data.dashboardFieldAvailability.pcSearch, 'invalid')
assert.equal(
    calculateMissingSearchPoints(
        invalidPc.data.userStatus.counters,
        false,
        'dashboard',
        invalidPc.data.dashboardFieldAvailability
    ).desktopCounter.status,
    'invalid-counter'
)

const legacyValue = dashboard(2345)
legacyValue.promotionalItems.push({ title: 'brace } and semicolon; inside a string' })
const legacy = dashboardFromHtml(`<script>var dashboard = ${JSON.stringify(legacyValue)};</script>`)
assert.equal(legacy.data.userStatus.availablePoints, 2345)
assert.equal(legacy.source, 'legacy-html')

const flightPayload = `7:${JSON.stringify(dashboard(3456))}\n`
const flightEntry = [1, flightPayload]
const flightHtml = `<script>self.__next_f.push(${JSON.stringify(flightEntry)})</script>`
const flight = dashboardFromHtml(flightHtml)
assert.equal(flight.data.userStatus.availablePoints, 3456)
assert.equal(flight.source, 'next-flight')

const runtimeFlight = dashboardFromFlightEntries([[1, flightPayload]])
assert.equal(runtimeFlight.data.userStatus.availablePoints, 3456)

const flyoutPayload = {
    isRewardsUser: true,
    userInfo: {
        isRewardsUser: true,
        balance: 4567,
        profile: { attributes: { country: 'US' } }
    },
    flyoutResult: {
        userStatus: {
            isRewardsUser: true,
            availablePoints: 4567,
            counters: {
                PCSearch: [{ pointProgress: 10, pointProgressMax: 30 }],
                MobileSearch: [{ pointProgress: 5, pointProgressMax: 20 }]
            }
        },
        highValueActionPromotions: [{ offerId: 'high-value-1' }],
        edgeHighValueActionPromotions: [{ offerId: 'high-value-2' }],
        dailySetPromotions: { '08/31/2026': [{ offerId: 'daily-1' }] },
        morePromotions: [{ offerId: 'more-1' }],
        impressionPromotions: []
    }
}
const flyout = dashboardFromFlyoutPayload(flyoutPayload)
assert.equal(flyout.source, 'bing-flyout')
assert.equal(flyout.data.userStatus.availablePoints, 4567)
assert.equal(flyout.data.userStatus.counters.pcSearch[0].pointProgressMax, 30)
assert.equal(flyout.data.userStatus.counters.mobileSearch[0].pointProgressMax, 20)
assert.deepEqual(
    flyout.data.promotionalItems.map(item => item.offerId),
    ['high-value-1', 'high-value-2']
)
assert.equal(flyout.data.dashboardFieldAvailability.dailySetPromotions, 'available')
assert.equal(flyout.data.dashboardFieldAvailability.morePromotions, 'available')
assert.equal(flyout.data.dashboardFieldAvailability.morePromotionsWithoutPromotionalItems, 'available')
assert.equal(flyout.data.dashboardFieldAvailability.punchCards, 'missing')
assert.equal(flyout.data.userProfile.attributes.country, 'US')

const flyoutBalanceFallback = structuredClone(flyoutPayload)
delete flyoutBalanceFallback.flyoutResult.userStatus.availablePoints
assert.equal(dashboardFromFlyoutPayload(flyoutBalanceFallback).data.userStatus.availablePoints, 4567)

const flyoutWithoutPoints = structuredClone(flyoutPayload)
delete flyoutWithoutPoints.flyoutResult.userStatus.availablePoints
delete flyoutWithoutPoints.userInfo.balance
const invalidFlyout = dashboardFromFlyoutPayload(flyoutWithoutPoints)
assert.equal(invalidFlyout.data, null)
assert.match(invalidFlyout.reason, /availablePoints/)

const invalidModern = dashboardFromHtml('<script>self.__next_f.push([1,"1:{\\"page\\":\\"dashboard\\"}\\n"])</script>')
assert.equal(invalidModern.data, null)
assert.match(invalidModern.reason, /未找到核心字段合法/)

const ambiguous = dashboardFromFlightEntries([
    [1, `1:${JSON.stringify(dashboard(1))}\n`],
    [1, `2:${JSON.stringify(dashboard(2))}\n`]
])
assert.equal(ambiguous.data, null)
assert.match(ambiguous.reason, /多个不一致/)

console.log('dashboardParser.test.js passed')
