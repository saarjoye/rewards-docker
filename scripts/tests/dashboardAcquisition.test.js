const assert = require('node:assert/strict')
const BrowserFunc = require('../../dist/browser/BrowserFunc').default
const { DashboardFetchError } = require('../../dist/util/DashboardError')
const { safeAxiosDiagnostic } = require('../../dist/util/Axios')

function dashboard(points = 888) {
    return {
        userStatus: { availablePoints: points, counters: { pcSearch: [], mobileSearch: [] } },
        dailySetPromotions: {},
        promotionalItems: [],
        morePromotions: [],
        morePromotionsWithoutPromotionalItems: [],
        punchCards: [],
        userProfile: { attributes: { country: 'CN' } }
    }
}

function flyoutDashboard(points = 1888) {
    return {
        isRewardsUser: true,
        accessToken: 'FLYOUT-TOKEN-CANARY',
        userInfo: {
            isRewardsUser: true,
            balance: points,
            profile: { attributes: { country: 'CN' } }
        },
        flyoutResult: {
            userStatus: {
                isRewardsUser: true,
                availablePoints: points,
                counters: {
                    PCSearch: [{ pointProgress: 10, pointProgressMax: 30 }],
                    MobileSearch: [{ pointProgress: 5, pointProgressMax: 20 }]
                }
            },
            highValueActionPromotions: [{ offerId: 'flyout-promo-1' }],
            dailySetPromotions: {},
            morePromotions: [],
            impressionPromotions: []
        }
    }
}

function axiosError(status, code = 'ERR_BAD_RESPONSE') {
    return {
        isAxiosError: true,
        code,
        config: {
            headers: {
                Cookie: 'COOKIE-CANARY',
                Authorization: 'AUTH-CANARY',
                RequestVerificationToken: 'VERIFY-CANARY'
            },
            data: 'oauth_code=OAUTH-CANARY&access_token=TOKEN-CANARY'
        },
        response:
            status === null
                ? undefined
                : {
                      status,
                      headers: { 'content-type': 'application/json' },
                      data: {
                          accessToken: 'TOKEN-CANARY',
                          Authorization: 'AUTH-CANARY',
                          explanation: 'BODY-CANARY'
                      }
                  }
    }
}

function apiResponse({
    status,
    contentType,
    body,
    url = 'https://rewards.bing.com/api/getuserinfo?type=1',
    onDispose
}) {
    return {
        status: () => status,
        headers: () => ({ 'content-type': contentType }),
        text: async () => body,
        url: () => url,
        dispose: async () => onDispose?.()
    }
}

function fakeBot(apiResult, fallbackResult = '<html>modern but incomplete</html>', flyoutResult = axiosError(404)) {
    const logs = []
    let apiRequests = 0
    let flyoutRequests = 0
    const flyoutUrls = []
    return {
        logs,
        get apiRequests() {
            return apiRequests
        },
        get flyoutRequests() {
            return flyoutRequests
        },
        flyoutUrls,
        isMobile: true,
        fingerprint: { headers: {} },
        cookies: { mobile: [], desktop: [] },
        config: { baseURL: 'https://rewards.bing.com/dashboard' },
        mainMobilePage: undefined,
        logger: {
            debug: (...args) => logs.push(args.join(' ')),
            warn: (...args) => logs.push(args.join(' ')),
            error: (...args) => logs.push(args.join(' '))
        },
        axios: {
            request: async request => {
                if (String(request.url).includes('/api/getuserinfo')) {
                    apiRequests += 1
                    if (apiResult instanceof Error || apiResult?.isAxiosError) throw apiResult
                    return apiResult
                }
                if (String(request.url).includes('/rewards/panelflyout/getuserinfo')) {
                    flyoutRequests += 1
                    flyoutUrls.push(String(request.url))
                    const result =
                        typeof flyoutResult === 'function' ? await flyoutResult(request, flyoutRequests) : flyoutResult
                    if (result instanceof Error || result?.isAxiosError) throw result
                    return {
                        status: 200,
                        headers: { 'content-type': 'application/json; charset=utf-8' },
                        data: result
                    }
                }
                if (fallbackResult instanceof Error || fallbackResult?.isAxiosError) throw fallbackResult
                return {
                    status: 200,
                    headers: { 'content-type': 'text/html; charset=utf-8' },
                    data: fallbackResult
                }
            }
        }
    }
}

async function expectFailure(apiResult, expectedStatus, expectedKind) {
    const bot = fakeBot(apiResult)
    const func = new BrowserFunc(bot)
    await assert.rejects(
        () => func.getDashboardData(),
        error => {
            assert.ok(error instanceof DashboardFetchError)
            assert.equal(error.apiStatus, expectedStatus)
            assert.equal(error.apiFailureKind, expectedKind)
            assert.equal(error.stage, 'dashboard')
            assert.match(error.fallbackReason, /HTML/)
            return true
        }
    )
    return bot.logs.join('\n')
}

;(async () => {
    const okBot = fakeBot({
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
        data: { dashboard: dashboard(999) }
    })
    assert.equal((await new BrowserFunc(okBot).getDashboardData()).userStatus.availablePoints, 999)
    assert.equal(okBot.flyoutRequests, 0)

    const modernBot = fakeBot(axiosError(404), '<html>modern but incomplete</html>', flyoutDashboard(1888))
    const modernFunc = new BrowserFunc(modernBot)
    const modernResult = await modernFunc.getDashboardData('CN')
    assert.equal(modernResult.userStatus.availablePoints, 1888)
    assert.equal(modernResult.userStatus.counters.pcSearch[0].pointProgressMax, 30)
    assert.equal(modernResult.dashboardFieldAvailability.punchCards, 'missing')
    assert.equal(modernBot.flyoutRequests, 1)
    assert.match(modernBot.flyoutUrls[0], /^https:\/\/cn\.bing\.com\//)
    assert.match(modernBot.logs.join('\n'), /使用 Bing flyout dashboard 降级/)
    assert.equal(modernBot.logs.join('\n').includes('FLYOUT-TOKEN-CANARY'), false)
    assert.equal((await modernFunc.getPanelFlyoutData()).flyoutResult.userStatus.availablePoints, 1888)
    assert.equal(modernBot.flyoutRequests, 1)

    const globalModernBot = fakeBot(axiosError(404), '<html>modern but incomplete</html>', flyoutDashboard(1889))
    assert.equal((await new BrowserFunc(globalModernBot).getDashboardData('US')).userStatus.availablePoints, 1889)
    assert.equal(globalModernBot.flyoutRequests, 1)
    assert.match(globalModernBot.flyoutUrls[0], /^https:\/\/www\.bing\.com\//)

    const contextFlyoutRequests = []
    const contextFlyoutBot = fakeBot(axiosError(500))
    const contextFlyoutPage = {
        isClosed: () => false,
        on: () => {},
        context: () => ({
            request: {
                get: async (url, options) => {
                    contextFlyoutRequests.push({ url, options })
                    if (String(url).includes('/api/getuserinfo')) {
                        return apiResponse({
                            status: 404,
                            contentType: 'application/json',
                            body: JSON.stringify({ error: 'synthetic-not-found' }),
                            url
                        })
                    }
                    if (String(url).includes('/rewards/panelflyout/getuserinfo')) {
                        return apiResponse({
                            status: 200,
                            contentType: 'application/json',
                            body: JSON.stringify(flyoutDashboard(1891)),
                            url
                        })
                    }
                    return apiResponse({
                        status: 200,
                        contentType: 'text/html; charset=utf-8',
                        body: '<html>modern but incomplete</html>',
                        url
                    })
                }
            }
        }),
        content: async () => '<html>modern but incomplete</html>',
        title: async () => 'Rewards',
        evaluate: async () => [],
        url: () => 'https://rewards.bing.com/dashboard',
        waitForLoadState: async () => {},
        reload: async () => {}
    }
    contextFlyoutBot.mainMobilePage = contextFlyoutPage
    const contextFlyoutResult = await new BrowserFunc(contextFlyoutBot).getDashboardData('US')
    assert.equal(contextFlyoutResult.userStatus.availablePoints, 1891)
    const contextFlyoutRequest = contextFlyoutRequests.find(request =>
        request.url.includes('/rewards/panelflyout/getuserinfo')
    )
    assert.ok(contextFlyoutRequest)
    assert.match(contextFlyoutRequest.url, /^https:\/\/www\.bing\.com\//)
    assert.equal(contextFlyoutRequest.options.headers.Cookie, undefined)
    assert.equal(contextFlyoutRequest.options.headers.cookie, undefined)
    assert.equal(contextFlyoutBot.apiRequests, 0)
    assert.equal(contextFlyoutBot.flyoutRequests, 0)

    const incompleteFlyout = flyoutDashboard(1890)
    delete incompleteFlyout.flyoutResult.userStatus.availablePoints
    delete incompleteFlyout.userInfo.balance
    const incompleteFlyoutBot = fakeBot(axiosError(404), '<html>modern but incomplete</html>', incompleteFlyout)
    await assert.rejects(
        () => new BrowserFunc(incompleteFlyoutBot).getDashboardData('CN'),
        error => {
            assert.ok(error instanceof DashboardFetchError)
            assert.match(error.fallbackReason, /Bing flyout/)
            assert.equal(error.message.includes('积分 0'), false)
            return true
        }
    )
    assert.equal(incompleteFlyoutBot.flyoutRequests, 2)

    const textPlainBot = fakeBot({
        status: 200,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
        data: { dashboard: dashboard(1001) }
    })
    assert.equal((await new BrowserFunc(textPlainBot).getDashboardData()).userStatus.availablePoints, 1001)
    assert.match(textPlainBot.logs.join('\n'), /contentType=text\/plain/)

    let contextRequestOptions
    let contextResponseDisposed = false
    const contextDashboard = dashboard(1003)
    delete contextDashboard.userStatus.counters.mobileSearch
    const contextBot = fakeBot(axiosError(500))
    contextBot.fingerprint = { headers: { Cookie: 'FINGERPRINT-COOKIE-CANARY' } }
    contextBot.mainMobilePage = {
        isClosed: () => false,
        url: () => 'https://rewards.bing.com/dashboard',
        context: () => ({
            request: {
                get: async (_url, options) => {
                    contextRequestOptions = options
                    return apiResponse({
                        status: 200,
                        contentType: 'text/plain; charset=utf-8',
                        body: JSON.stringify({ dashboard: contextDashboard }),
                        onDispose: () => {
                            contextResponseDisposed = true
                        }
                    })
                }
            }
        })
    }
    const contextResult = await new BrowserFunc(contextBot).getDashboardData('CN')
    assert.equal(contextResult.userStatus.availablePoints, 1003)
    assert.equal(contextResult.dashboardFieldAvailability.mobileSearch, 'missing')
    assert.deepEqual(contextResult.userStatus.counters.mobileSearch, [])
    assert.equal(contextBot.apiRequests, 0)
    assert.equal(contextRequestOptions.headers.Cookie, undefined)
    assert.equal(contextRequestOptions.headers.cookie, undefined)
    assert.equal(contextResponseDisposed, true)
    assert.equal(contextBot.logs.join('\n').includes('FINGERPRINT-COOKIE-CANARY'), false)

    const fallbackDashboard = dashboard(777)
    const fallbackHtml = `<script>self.__next_f.push(${JSON.stringify([1, `1:${JSON.stringify(fallbackDashboard)}\n`])})</script>`
    const fallbackBot = fakeBot(
        { status: 200, headers: { 'content-type': 'application/json' }, data: { profile: {} } },
        fallbackHtml
    )
    assert.equal((await new BrowserFunc(fallbackBot).getDashboardData()).userStatus.availablePoints, 777)
    assert.equal(fallbackBot.flyoutRequests, 0)

    await expectFailure(
        { status: 200, headers: { 'content-type': 'application/json' }, data: { profile: {} } },
        200,
        'invalid-response'
    )
    await expectFailure(axiosError(401), 401, 'auth')
    await expectFailure(axiosError(403), 403, 'auth')
    await expectFailure(axiosError(429), 429, 'rate-limit')
    await expectFailure(axiosError(500), 500, 'server')
    await expectFailure(axiosError(503), 503, 'server')
    const notFoundBot = fakeBot(axiosError(404))
    await assert.rejects(
        () => new BrowserFunc(notFoundBot).getDashboardData(),
        error => {
            assert.ok(error instanceof DashboardFetchError)
            assert.equal(error.stage, 'dashboard')
            assert.equal(error.apiStatus, 404)
            assert.equal(error.apiFailureKind, 'endpoint-unavailable')
            assert.equal(error.apiReason, 'dashboard endpoint unavailable')
            assert.equal(error.message.includes('积分 0'), false)
            return true
        }
    )
    assert.equal(notFoundBot.apiRequests, 1)
    await expectFailure(axiosError(null, 'ECONNRESET'), null, 'network')
    const wrongMimeBot = fakeBot({
        status: 200,
        headers: { 'content-type': 'text/html' },
        data: { dashboard: dashboard(1002) }
    })
    assert.equal((await new BrowserFunc(wrongMimeBot).getDashboardData()).userStatus.availablePoints, 1002)

    const sensitiveLogs = await expectFailure(axiosError(401), 401, 'auth')
    for (const canary of [
        'COOKIE-CANARY',
        'AUTH-CANARY',
        'VERIFY-CANARY',
        'OAUTH-CANARY',
        'TOKEN-CANARY',
        'BODY-CANARY'
    ]) {
        assert.equal(sensitiveLogs.includes(canary), false, `log leaked ${canary}`)
    }
    const diagnostic = JSON.stringify(safeAxiosDiagnostic(axiosError(401)))
    for (const canary of [
        'COOKIE-CANARY',
        'AUTH-CANARY',
        'VERIFY-CANARY',
        'OAUTH-CANARY',
        'TOKEN-CANARY',
        'BODY-CANARY'
    ]) {
        assert.equal(diagnostic.includes(canary), false, `diagnostic leaked ${canary}`)
    }

    const pageBot = fakeBot(axiosError(401))
    pageBot.mainMobilePage = {
        isClosed: () => false,
        on: () => {},
        content: async () => '<html>incomplete modern dashboard</html>',
        title: async () => 'Rewards user@example.invalid token=TITLE-TOKEN-CANARY',
        evaluate: async () => [],
        url: () => 'https://rewards.bing.com/dashboard?code=URL-OAUTH-CANARY&access_token=URL-TOKEN-CANARY'
    }
    await assert.rejects(() => new BrowserFunc(pageBot).getDashboardData(), DashboardFetchError)
    const pageLogs = pageBot.logs.join('\n')
    for (const canary of ['user@example.invalid', 'TITLE-TOKEN-CANARY', 'URL-OAUTH-CANARY', 'URL-TOKEN-CANARY']) {
        assert.equal(pageLogs.includes(canary), false, `page diagnostic leaked ${canary}`)
    }
    assert.match(pageLogs, /pageUrl=https:\/\/rewards\.bing\.com\/dashboard/)
    assert.match(pageLogs, /pageTitle=Rewards <redacted-email> token=<redacted>/)

    const retryEvents = []
    const retryListeners = new Map()
    let contextApiRequests = 0
    let reloads = 0
    const context404Bot = fakeBot(axiosError(500))
    const context404Page = {
        isClosed: () => false,
        on: (event, listener) => {
            retryEvents.push(`listener:${event}`)
            retryListeners.set(event, listener)
        },
        context: () => ({
            request: {
                get: async () => {
                    retryEvents.push('context-get')
                    contextApiRequests += 1
                    return apiResponse({
                        status: 404,
                        contentType: 'application/json',
                        body: JSON.stringify({ error: 'synthetic-not-found' })
                    })
                }
            }
        }),
        content: async () => '<html>incomplete modern dashboard</html>',
        title: async () => 'Rewards',
        evaluate: async () => [],
        url: () => 'https://rewards.bing.com/dashboard',
        waitForLoadState: async () => {},
        reload: async () => {
            retryEvents.push('reload')
            reloads += 1
            retryListeners.get('response')({
                request: () => ({
                    resourceType: () => 'xhr',
                    frame: () => ({ url: () => 'https://rewards.bing.com/dashboard' })
                }),
                url: () => 'https://rewards.bing.com/api/getuserinfo',
                status: () => 200,
                headers: () => ({ 'content-type': 'text/plain; charset=utf-8' }),
                body: async () => Buffer.from(JSON.stringify({ dashboard: dashboard(2001) }))
            })
        }
    }
    context404Bot.mainMobilePage = context404Page
    const context404Func = new BrowserFunc(context404Bot)
    context404Func.prepareDashboardCapture(context404Page, 'CN')
    assert.equal((await context404Func.getDashboardData('CN')).userStatus.availablePoints, 2001)
    assert.equal(contextApiRequests, 1)
    assert.equal(reloads, 1)
    assert.ok(retryEvents.indexOf('listener:response') < retryEvents.indexOf('context-get'))
    assert.ok(retryEvents.indexOf('context-get') < retryEvents.indexOf('reload'))

    const listeners = new Map()
    const captureBot = fakeBot(axiosError(404))
    const capturePage = {
        isClosed: () => false,
        on: (event, listener) => listeners.set(event, listener),
        content: async () => '<html>incomplete modern dashboard</html>',
        title: async () => 'Rewards',
        evaluate: async () => [],
        url: () => 'https://rewards.bing.com/dashboard?code=REDACT-ME',
        waitForLoadState: async () => {},
        reload: async () => {
            listeners.get('response')({
                request: () => ({
                    resourceType: () => 'xhr',
                    frame: () => ({ url: () => 'https://rewards.bing.com/dashboard' })
                }),
                url: () => 'https://rewards.bing.com/api/getuserinfo?oauth_code=REDACT-ME',
                status: () => 200,
                headers: () => ({ 'content-type': 'text/plain; charset=utf-8' }),
                body: async () => Buffer.from(JSON.stringify({ dashboard: dashboard(2002) }))
            })
        }
    }
    captureBot.mainMobilePage = capturePage
    const captureFunc = new BrowserFunc(captureBot)
    captureFunc.prepareDashboardCapture(capturePage, 'CN')
    assert.equal((await captureFunc.getDashboardData('CN')).userStatus.availablePoints, 2002)
    assert.equal(captureBot.apiRequests, 1)
    const captureLogs = captureBot.logs.join('\n')
    assert.match(captureLogs, /source=capture/)
    assert.equal(captureLogs.includes('REDACT-ME'), false)

    console.log('dashboardAcquisition.test.js passed')
})().catch(error => {
    console.error(error)
    process.exit(1)
})
