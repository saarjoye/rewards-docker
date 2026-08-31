const assert = require('node:assert/strict')

const BrowserFunc = require('../../dist/browser/BrowserFunc').default
const { Login } = require('../../dist/browser/auth/Login')
const { MobileAccessLogin } = require('../../dist/browser/auth/methods/MobileAccessLogin')
const { SessionValidationError } = require('../../dist/util/SessionValidationError')
const { withSingleSessionRepair } = require('../../dist/util/SingleSessionRepair')

function account() {
    return {
        email: 'fixture@example.invalid',
        password: 'synthetic-password',
        recoveryEmail: 'recovery@example.invalid',
        geoLocale: 'CN',
        langCode: 'en',
        proxy: { proxyAxios: false, url: '', port: 0, password: '', username: '' },
        saveFingerprint: { mobile: false, desktop: false }
    }
}

function fakeBot() {
    const logs = []
    return {
        logs,
        isMobile: true,
        config: {
            baseURL: 'https://rewards.bing.com/dashboard',
            sessionPath: 'sessions'
        },
        userData: { geoLocale: 'CN' },
        utils: { wait: async () => {} },
        logger: {
            debug: (...args) => logs.push(args.join(' ')),
            info: (...args) => logs.push(args.join(' ')),
            warn: (...args) => logs.push(args.join(' ')),
            error: (...args) => logs.push(args.join(' '))
        },
        browser: {
            utils: {
                reloadBadPage: async () => {},
                disableFido: async () => {},
                ghostClick: async () => {},
                tryDismissAllMessages: async () => {},
                loadInCheerio: async () => ({})
            },
            func: {
                prepareDashboardCapture: () => {},
                getDashboardData: async () => {
                    throw new Error('synthetic dashboard failure')
                }
            }
        },
        axios: { request: async () => ({ status: 500, data: {} }) }
    }
}

function pageAt(rawUrl) {
    return {
        waitForLoadState: async () => {},
        waitForSelector: async () => {
            throw new Error('not visible')
        },
        url: () => rawUrl,
        isClosed: () => false
    }
}

;(async () => {
    const stateBot = fakeBot()
    const stateLogin = new Login(stateBot)
    assert.equal(
        await stateLogin.detectCurrentState(pageAt('https://rewards.bing.com/createuser')),
        'REWARDS_UNVERIFIED'
    )
    assert.equal(await stateLogin.detectCurrentState(pageAt('https://rewards.bing.com/about')), 'REWARDS_UNVERIFIED')
    assert.equal(await stateLogin.detectCurrentState(pageAt('https://rewards.bing.com/dashboard')), 'REWARDS_DASHBOARD')
    assert.equal(await stateLogin.detectCurrentState(pageAt('https://account.microsoft.com/')), 'MICROSOFT_ACCOUNT')

    const staleLogin = new Login(fakeBot())
    const stalePage = {
        ...pageAt('https://rewards.bing.com/about'),
        goto: async () => {},
        reload: async () => {}
    }
    await assert.rejects(
        () => staleLogin.login(stalePage, account(), { rejectStoredSessionChallenge: true }),
        error => error instanceof SessionValidationError && error.reason === 'stored-session-challenge'
    )

    const bingBot = fakeBot()
    const bingLogin = new Login(bingBot)
    const handled = []
    let visibleState = 'email'
    let currentUrl = 'https://login.live.com/'
    const bingPage = {
        goto: async () => {
            currentUrl = 'https://login.live.com/'
        },
        waitForLoadState: async () => {},
        waitForSelector: async selector => {
            if (visibleState === 'email' && selector === 'input#usernameEntry') return {}
            if (visibleState === 'password' && selector === '[data-testid="passwordEntry"]') return {}
            if (visibleState === 'bing' && selector === '#id_n') return {}
            throw new Error('not visible')
        },
        url: () => currentUrl,
        isClosed: () => false
    }
    bingLogin.emailLogin.enterEmail = async () => {
        handled.push('EMAIL_INPUT')
        visibleState = 'password'
    }
    bingLogin.emailLogin.enterPassword = async () => {
        handled.push('PASSWORD_INPUT')
        visibleState = 'bing'
        currentUrl = 'https://www.bing.com/'
    }
    await bingLogin.verifyBingSession(bingPage, account())
    assert.deepEqual(handled, ['EMAIL_INPUT', 'PASSWORD_INPUT'])

    const failedBot = fakeBot()
    const failedLogin = new Login(failedBot)
    failedLogin.verifyBingSession = async () => {}
    failedLogin.getRewardsSession = async () => {}
    let cookieReads = 0
    const failedPage = {
        context: () => ({
            cookies: async () => {
                cookieReads += 1
                return []
            }
        })
    }
    await assert.rejects(
        () => failedLogin.finalizeLogin(failedPage, account()),
        error => error instanceof SessionValidationError && error.reason === 'dashboard-session-invalid'
    )
    assert.equal(cookieReads, 0)

    const attempts = []
    let repairCalls = 0
    await assert.rejects(
        () =>
            withSingleSessionRepair(
                async loadStoredSession => {
                    attempts.push(loadStoredSession)
                    throw new SessionValidationError('rewards-session-invalid', 'synthetic failure')
                },
                error => error instanceof SessionValidationError,
                () => {
                    repairCalls += 1
                }
            ),
        SessionValidationError
    )
    assert.deepEqual(attempts, [true, false])
    assert.equal(repairCalls, 1)

    const recoveredAttempts = []
    const recoveredDashboard = await withSingleSessionRepair(
        async loadStoredSession => {
            recoveredAttempts.push(loadStoredSession)
            if (loadStoredSession) {
                throw new SessionValidationError('stored-session-challenge', 'synthetic stale session')
            }
            return { userStatus: { availablePoints: 68 } }
        },
        error => error instanceof SessionValidationError,
        () => {}
    )
    assert.deepEqual(recoveredAttempts, [true, false])
    assert.equal(recoveredDashboard.userStatus.availablePoints, 68)

    const closeBot = fakeBot()
    const browserFunc = new BrowserFunc(closeBot)
    let contextClosed = 0
    await browserFunc.closeBrowser(
        {
            browser: () => null,
            cookies: async () => {
                throw new Error('closeBrowser must not read cookies')
            },
            close: async () => {
                contextClosed += 1
            }
        },
        'fixture@example.invalid'
    )
    assert.equal(contextClosed, 1)

    const oauthBot = fakeBot()
    let oauthUrl = 'about:blank'
    let oauthWaits = 0
    oauthBot.utils.wait = async () => {
        oauthWaits += 1
    }
    const oauthPage = {
        goto: async url => {
            oauthUrl = String(url).includes('oauth20_authorize')
                ? 'https://login.microsoft.com/consumers/fido/get?code=FIDO-CODE-CANARY&state=FIDO-STATE-CANARY'
                : 'https://rewards.bing.com/dashboard'
        },
        waitForSelector: async () => {
            throw new Error('not visible')
        },
        waitForLoadState: async () => {},
        url: () => oauthUrl
    }
    let now = 0
    const realNow = Date.now
    Date.now = () => (now += 10)
    try {
        const oauth = new MobileAccessLogin(oauthBot, oauthPage, async () => false)
        oauth.maxTimeout = 1000
        oauth.fidoStallTimeout = 20
        assert.equal(await oauth.get('fixture@example.invalid'), '')
    } finally {
        Date.now = realNow
    }
    assert.ok(oauthWaits < 10)
    const oauthLogs = oauthBot.logs.join('\n')
    assert.equal(oauthLogs.includes('FIDO-CODE-CANARY'), false)
    assert.equal(oauthLogs.includes('FIDO-STATE-CANARY'), false)

    console.log('authSession.test.js passed')
})().catch(error => {
    console.error(error)
    process.exit(1)
})
