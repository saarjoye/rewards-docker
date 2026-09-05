import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(import.meta.url)
const { Login } = require('../../dist/browser/auth/Login.js')

function fixture({ states = () => 'LOGGED_IN', alerts = [], mobile = false, onWait = () => {} } = {}) {
    const logs = []
    const waits = []
    const visits = []
    let checks = 0
    let finalized = 0
    let closed = false
    let reloads = 0
    const context = {}
    const bot = {
        isMobile: mobile,
        config: { errorDiagnostics: false },
        logger: Object.fromEntries(
            ['info', 'warn', 'error', 'debug'].map(level => [
                level,
                (platform, title, message) => {
                    logs.push({ level, platform, title, message })
                }
            ])
        ),
        utils: {
            wait: async delay => {
                waits.push(delay)
                onWait(delay, () => {
                    closed = true
                })
            }
        },
        browser: { utils: { reloadBadPage: async () => {}, disableFido: async () => {} } }
    }
    const login = new Login(bot)
    const page = {
        context: () => context,
        isClosed: () => closed,
        url: () => 'https://login.live.com/',
        goto: async url => {
            assert.equal(login.passwordlessMethodSelected, false)
            assert.equal(login.signInMethodsLogged, false)
            visits.push(url)
            checks = 0
        },
        reload: async () => {
            reloads++
        },
        locator: () => {
            const items = typeof alerts === 'function' ? alerts(visits.length) : alerts
            return {
                count: async () => items.length,
                nth: index => ({
                    isVisible: async () => items[index].visible !== false,
                    innerText: async ({ timeout }) => {
                        assert.equal(timeout, 500)
                        if (items[index].innerError) throw new Error('synthetic read failure')
                        return items[index].text ?? ''
                    },
                    textContent: async ({ timeout }) => {
                        assert.equal(timeout, 500)
                        if (items[index].contentError) throw new Error('synthetic read failure')
                        return items[index].content ?? null
                    }
                })
            }
        }
    }
    // Exercise the real attempt loop and error handler without launching a browser.
    login.detectCurrentState = async () => states(visits.length, ++checks)
    login.finalizeLogin = async () => {
        finalized++
    }
    const account = { email: 'synthetic@example.com', password: 'synthetic-private-password' }
    return {
        login,
        page,
        account,
        bot,
        logs,
        waits,
        visits,
        finalized: () => finalized,
        reloads: () => reloads,
        run: () => login.login(page, account),
        delays: () => waits.filter(delay => delay >= 10000)
    }
}

test('first login succeeds without retries and finalizes once', async () => {
    const f = fixture()
    await f.run()
    assert.equal(f.visits.length, 1)
    assert.equal(f.finalized(), 1)
    assert.deepEqual(f.delays(), [])
})

test('unknown alert retries with backoff, resets method state and succeeds without rerunning tasks', async () => {
    const f = fixture({ states: attempt => (attempt < 3 ? 'ERROR_ALERT' : 'LOGGED_IN') })
    const detect = f.login.detectCurrentState
    f.login.detectCurrentState = async () => {
        f.login.passwordlessMethodSelected = true
        f.login.signInMethodsLogged = true
        return detect()
    }
    f.bot.Main = () => assert.fail('reward tasks must not be invoked by login retries')
    await f.run()
    assert.equal(f.visits.length, 3)
    assert.equal(new Set(f.visits).size, 1)
    assert.deepEqual(f.delays(), [10000, 30000])
    assert.equal(f.finalized(), 1)
    assert.equal(f.logs.filter(log => log.level === 'error').length, 0)
    assert.match(f.logs.at(-1).message, /桌面端重新登录成功/)
    assert.doesNotMatch(JSON.stringify(f.logs), /synthetic@example|synthetic-private-password/)
})

test('unknown failures allow exactly three retries and one terminal error', async () => {
    const f = fixture({ states: () => 'ERROR_ALERT', alerts: [{ text: 'Unknown Error' }] })
    await assert.rejects(f.run(), /已重试登录 3 次/)
    assert.equal(f.visits.length, 4)
    assert.deepEqual(f.delays(), [10000, 30000, 60000])
    assert.equal(f.finalized(), 0)
    assert.equal(f.logs.filter(log => log.level === 'warn').length, 3)
    assert.equal(f.logs.filter(log => log.level === 'error').length, 1)
})

test('mobile and desktop retries have independent budgets', async () => {
    const f = fixture({ states: () => 'ERROR_ALERT', mobile: true })
    await assert.rejects(f.run(), /移动端已重试登录 3 次/)
    f.bot.isMobile = false
    await assert.rejects(f.run(), /桌面端已重试登录 3 次/)
    assert.equal(f.visits.length, 8)
    assert.deepEqual(f.delays(), [10000, 30000, 60000, 10000, 30000, 60000])
})

test('any visible known alert stops retries even when other alerts are unknown or unreadable', async () => {
    for (const items of [
        [{ text: 'Unknown Error' }, { text: 'Incorrect password synthetic-private-password' }],
        [{ innerError: true, contentError: true }, { content: 'Account locked' }],
        [{ text: '  ', content: 'Incorrect verification code' }]
    ]) {
        const f = fixture({ states: () => 'ERROR_ALERT', alerts: items })
        await assert.rejects(f.run(), /明确错误提示/)
        assert.equal(f.visits.length, 1)
        assert.deepEqual(f.delays(), [])
        assert.doesNotMatch(JSON.stringify(f.logs), /synthetic-private-password/)
    }
})

test('empty, detached, hidden and unreadable alerts are retried with short text read timeouts', async () => {
    for (const items of [
        [],
        [{}],
        [{ innerError: true, contentError: true }],
        [{ visible: false, text: 'old error' }]
    ]) {
        const f = fixture({ states: attempt => (attempt === 1 ? 'ERROR_ALERT' : 'LOGGED_IN'), alerts: items })
        await f.run()
        assert.equal(f.visits.length, 2)
        assert.deepEqual(f.delays(), [10000])
    }
})

test('known errors, missing methods and approval timeouts are never retried', async () => {
    for (const message of [
        'Passwordless authentication timeout',
        'Incorrect password',
        'TOTP secret is required',
        'Unknown Error'
    ]) {
        const f = fixture()
        f.login.detectCurrentState = async () => {
            throw new Error(message)
        }
        await assert.rejects(f.run(), { message })
        assert.equal(f.visits.length, 1)
        assert.deepEqual(f.delays(), [])
    }
    const locked = fixture({ states: () => 'ACCOUNT_LOCKED' })
    await assert.rejects(locked.run(), /locked/)
    assert.equal(locked.visits.length, 1)
})

test('persistent unknown states retry after the iteration budget, while known-state timeouts do not', async () => {
    const unknown = fixture({ states: attempt => (attempt === 1 ? 'UNKNOWN' : 'LOGGED_IN') })
    await unknown.run()
    assert.equal(unknown.visits.length, 2)
    assert.deepEqual(unknown.delays(), [10000])
    const known = fixture({ states: () => 'KMSI_PROMPT' })
    known.login.handleState = async () => true
    await assert.rejects(known.run(), /Login timeout/)
    assert.equal(known.visits.length, 1)
    assert.ok(known.reloads() > 0)
    assert.deepEqual(known.delays(), [])
})

test('successful last state check is not treated as iteration exhaustion', async () => {
    const f = fixture({ states: (_attempt, iteration) => (iteration === 25 ? 'LOGGED_IN' : 'UNKNOWN') })
    await f.run()
    assert.equal(f.visits.length, 1)
    assert.equal(f.finalized(), 1)
})

test('session finalization failures do not restart authentication even for a retryable error', async () => {
    const f = fixture()
    let finalizations = 0
    f.login.finalizeLogin = async () => {
        finalizations++
        await f.login.handleState('ERROR_ALERT', f.page, f.account)
    }
    await assert.rejects(f.run(), /未返回可识别/)
    assert.equal(f.visits.length, 1)
    assert.equal(finalizations, 1)
    assert.deepEqual(f.delays(), [])
})

test('closing the page during backoff cancels the next attempt', async () => {
    const f = fixture({
        states: () => 'ERROR_ALERT',
        onWait: (delay, close) => {
            if (delay >= 10000) close()
        }
    })
    await assert.rejects(f.run(), /Page closed/)
    assert.equal(f.visits.length, 1)
    assert.deepEqual(f.delays(), [10000])
})
