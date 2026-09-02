const assert = require('node:assert/strict')
const {
    LOGIN_ERROR_ALERT_SELECTOR,
    PASSWORD_SIGN_IN_OPTION_SELECTOR,
    classifyRewardsPageLoginState,
    hasBingAuthenticationCookies,
    isKmsiPromptText,
    LoginStateError,
    captureLoginErrorSnapshot,
    rewardsDashboardUrl,
    selectDetectedLoginState
} = require('../../dist/browser/auth/Login')

function fakePage(url, values = {}) {
    const alert = {
        isVisible: async () => true,
        innerText: async () => {
            if (values.innerTextError) throw new Error('detached')
            return values.innerText ?? ''
        },
        textContent: async () => values.textContent ?? '',
        getAttribute: async name => values[name] ?? ''
    }
    return {
        url: () => url,
        locator: () => ({
            count: async () => 1,
            nth: () => alert
        })
    }
}

async function main() {
    assert.equal(selectDetectedLoginState(['PASSWORD_INPUT', 'ERROR_ALERT']), 'ERROR_ALERT')
    assert.equal(selectDetectedLoginState(['2FA_TOTP', 'ERROR_ALERT']), 'ERROR_ALERT')
    assert.equal(selectDetectedLoginState(['EMAIL_INPUT']), 'EMAIL_INPUT')
    assert.equal(selectDetectedLoginState(['PASSKEY_ERROR', 'PASSWORD_INPUT']), 'PASSKEY_ERROR')
    assert.equal(selectDetectedLoginState(['REWARDS_SIGN_IN']), 'REWARDS_SIGN_IN')

    assert.match(PASSWORD_SIGN_IN_OPTION_SELECTOR, /\[role="button"\]/)
    assert.match(PASSWORD_SIGN_IN_OPTION_SELECTOR, /使用密码/)
    assert.equal(
        rewardsDashboardUrl('https://rewards.bing.com/about?source=test'),
        'https://rewards.bing.com/dashboard'
    )
    assert.equal(classifyRewardsPageLoginState('https://rewards.bing.com/dashboard', false), 'LOGGED_IN')
    assert.equal(classifyRewardsPageLoginState('https://rewards.bing.com/dashboard', true), 'REWARDS_SIGN_IN')
    assert.equal(classifyRewardsPageLoginState('https://rewards.bing.com/about', true), 'REWARDS_SIGN_IN')
    assert.equal(classifyRewardsPageLoginState('https://rewards.bing.com/about', false), 'UNKNOWN')
    assert.equal(classifyRewardsPageLoginState('https://rewards.bing.com/createuser', false), 'UNKNOWN')
    assert.equal(classifyRewardsPageLoginState('https://account.microsoft.com/', false), null)
    assert.equal(isKmsiPromptText('Stay signed in?'), true)
    assert.equal(isKmsiPromptText('保持登录状态'), true)
    assert.equal(isKmsiPromptText('Enter your password'), false)

    const future = 2_000_000_000
    assert.equal(
        hasBingAuthenticationCookies([
            { name: '_U', domain: '.bing.com', expires: future },
            { name: '.MSA.Auth', domain: '.bing.com', expires: future }
        ]),
        true
    )
    assert.equal(
        hasBingAuthenticationCookies([
            { name: '_U', domain: '.bing.com', expires: future },
            { name: 'WLS', domain: 'cn.bing.com', expires: -1 }
        ]),
        true
    )
    assert.equal(hasBingAuthenticationCookies([{ name: '_U', domain: '.bing.com', expires: future }]), false)
    assert.equal(
        hasBingAuthenticationCookies([
            { name: '_U', domain: '.live.com', expires: future },
            { name: '.MSA.Auth', domain: '.live.com', expires: future }
        ]),
        false
    )
    assert.equal(
        hasBingAuthenticationCookies([
            { name: '_U', domain: '.bing.com', expires: 1 },
            { name: '.MSA.Auth', domain: '.bing.com', expires: future }
        ]),
        false
    )

    assert.match(LOGIN_ERROR_ALERT_SELECTOR, /wcpConsentBannerCtrl/)
    assert.match(LOGIN_ERROR_ALERT_SELECTOR, /__next-route-announcer__/)

    const textSnapshot = await captureLoginErrorSnapshot(
        fakePage('https://login.live.com/oauth20_authorize.srf?code=SECRET', {
            innerText: '密码错误，请重试'
        })
    )
    assert.equal(textSnapshot.errorMessage, '密码错误，请重试')
    assert.equal(textSnapshot.innerText, '密码错误，请重试')
    assert.equal(textSnapshot.url, 'https://login.live.com/oauth20_authorize.srf')
    assert.equal(textSnapshot.host, 'login.live.com')
    assert.equal(textSnapshot.path, '/oauth20_authorize.srf')

    const detachedSnapshot = await captureLoginErrorSnapshot(
        fakePage('https://login.live.com/oauth20_authorize.srf', {
            innerTextError: true,
            textContent: '此密码不正确'
        })
    )
    assert.equal(detachedSnapshot.innerText, '')
    assert.equal(detachedSnapshot.errorMessage, '此密码不正确')
    assert.notEqual(detachedSnapshot.errorMessage, '未知错误')

    const emptyRewardsSnapshot = await captureLoginErrorSnapshot(fakePage('https://rewards.bing.com/about?code=SECRET'))
    assert.equal(emptyRewardsSnapshot.errorMessage, 'Rewards 页面检测到 ERROR_ALERT，但未读取到错误文案')
    assert.equal(emptyRewardsSnapshot.url, 'https://rewards.bing.com/about')

    const alertError = new LoginStateError('ERROR_ALERT', emptyRewardsSnapshot.errorMessage, {
        ...emptyRewardsSnapshot,
        loginStage: 'login-error-alert'
    })
    assert.equal(alertError.loginState, 'ERROR_ALERT')
    assert.equal(alertError.loginStage, 'login-error-alert')
    assert.equal(alertError.errorMessage, emptyRewardsSnapshot.errorMessage)
    assert.equal(alertError.url, 'https://rewards.bing.com/about')
    assert.equal(alertError.host, 'rewards.bing.com')
    assert.equal(alertError.path, '/about')

    const passkeyError = new LoginStateError('PASSKEY_ERROR', '通行密钥失败')
    assert.equal(passkeyError.loginState, 'PASSKEY_ERROR')
    assert.equal(passkeyError.loginStage, 'login-passkey-error')
    assert.equal(passkeyError.errorMessage, '通行密钥失败')

    const timeoutError = new LoginStateError('EMAIL_INPUT', '登录超时', 'login-timeout')
    assert.equal(timeoutError.loginState, 'EMAIL_INPUT')
    assert.equal(timeoutError.loginStage, 'login-timeout')

    console.log('loginStateDetection.test.js passed')
}

main().catch(error => {
    console.error(error)
    process.exitCode = 1
})
