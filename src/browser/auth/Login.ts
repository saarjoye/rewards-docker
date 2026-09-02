import type { Cookie, Page } from 'patchright'
import type { MicrosoftRewardsBot } from '../../index'
import { saveSessionData } from '../../util/Load'

import { MobileAccessLogin } from './methods/MobileAccessLogin'
import { EmailLogin } from './methods/EmailLogin'
import { PasswordlessLogin } from './methods/PasswordlessLogin'
import { TotpLogin } from './methods/Totp2FALogin'
import { CodeLogin } from './methods/GetACodeLogin'
import { RecoveryLogin } from './methods/RecoveryEmailLogin'

import type { Account } from '../../interface/Account'

export type LoginState =
    | 'EMAIL_INPUT'
    | 'PASSWORD_INPUT'
    | 'SIGN_IN_ANOTHER_WAY'
    | 'SIGN_IN_ANOTHER_WAY_EMAIL'
    | 'PASSKEY_ERROR'
    | 'PASSKEY_VIDEO'
    | 'KMSI_PROMPT'
    | 'LOGGED_IN'
    | 'REWARDS_SIGN_IN'
    | 'RECOVERY_EMAIL_INPUT'
    | 'ACCOUNT_LOCKED'
    | 'ERROR_ALERT'
    | '2FA_TOTP'
    | 'LOGIN_PASSWORDLESS'
    | 'GET_A_CODE'
    | 'GET_A_CODE_2'
    | 'OTP_CODE_ENTRY'
    | 'UNKNOWN'
    | 'CHROMEWEBDATA_ERROR'

export const LOGIN_ERROR_ALERT_SELECTOR = 'div[role="alert"]:not(#wcpConsentBannerCtrl):not(#__next-route-announcer__)'
export const PASSWORD_SIGN_IN_OPTION_SELECTOR =
    '[data-testid="tile"]:has(svg path[d*="M11.78 10.22a.75.75"]), [role="button"]:has-text("Use your password"), [role="button"]:has-text("使用密码"), [role="button"]:has-text("使用你的密码")'
export const REWARDS_SIGN_IN_SELECTOR =
    'a[href*="login.live.com"], a[href*="/signin"], button:has-text("Sign in"), a:has-text("Sign in"), button:has-text("登录"), a:has-text("登录")'

export interface LoginErrorSnapshot {
    innerText: string
    textContent: string
    ariaLabel: string
    title: string
    errorMessage: string
    url: string
    host: string
    path: string
}

interface DetectedLoginState {
    state: LoginState
    errorSnapshot?: LoginErrorSnapshot
}

interface LoginStateErrorOptions extends Partial<LoginErrorSnapshot> {
    loginStage?: string
}

function sanitizeLoginDiagnosticText(value: unknown): string {
    return String(value ?? '')
        .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[REDACTED_EMAIL]')
        .replace(
            /([?&](?:code|access_token|refresh_token|id_token|state|RequestVerificationToken)=)[^&\s]+/gi,
            '$1[REDACTED]'
        )
        .replace(/\b(password|passwd|pwd|token|secret|cookie|authorization)(\s*[:=]\s*)([^\s|]+)/gi, '$1$2[REDACTED]')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 500)
}

function loginLocation(rawUrl: string): Pick<LoginErrorSnapshot, 'url' | 'host' | 'path'> {
    try {
        const parsed = new URL(rawUrl)
        const path = parsed.pathname || '/'
        return { url: `${parsed.protocol}//${parsed.host}${path}`, host: parsed.hostname, path }
    } catch {
        return { url: '', host: '', path: '' }
    }
}

export async function captureLoginErrorSnapshot(
    page: Page,
    selector = LOGIN_ERROR_ALERT_SELECTOR
): Promise<LoginErrorSnapshot | null> {
    const alerts = page.locator(selector)
    const count = await alerts.count().catch(() => 0)
    const candidates: Array<Omit<LoginErrorSnapshot, 'errorMessage' | 'url' | 'host' | 'path'>> = []

    for (let index = 0; index < count; index++) {
        const alert = alerts.nth(index)
        if (!(await alert.isVisible().catch(() => false))) continue

        const [innerText, textContent, ariaLabel, title] = await Promise.all([
            alert.innerText().catch(() => ''),
            alert.textContent().catch(() => ''),
            alert.getAttribute('aria-label').catch(() => ''),
            alert.getAttribute('title').catch(() => '')
        ])
        candidates.push({
            innerText: sanitizeLoginDiagnosticText(innerText),
            textContent: sanitizeLoginDiagnosticText(textContent),
            ariaLabel: sanitizeLoginDiagnosticText(ariaLabel),
            title: sanitizeLoginDiagnosticText(title)
        })
    }

    if (candidates.length === 0) return null

    const selected =
        candidates.find(candidate =>
            [candidate.innerText, candidate.textContent, candidate.ariaLabel, candidate.title].some(Boolean)
        ) ?? candidates[0]
    if (!selected) return null

    const location = loginLocation(page.url())
    const readable = selected.innerText || selected.textContent || selected.ariaLabel || selected.title
    const errorMessage =
        readable ||
        (location.host === 'rewards.bing.com'
            ? 'Rewards 页面检测到 ERROR_ALERT，但未读取到错误文案'
            : 'Microsoft 登录页面检测到 ERROR_ALERT，但未读取到错误文案')

    return { ...selected, errorMessage, ...location }
}

export class LoginStateError extends Error {
    public readonly loginState: LoginState
    public readonly loginStage: string
    public readonly errorMessage: string
    public readonly url: string
    public readonly host: string
    public readonly path: string

    constructor(loginState: LoginState, message: string, options: string | LoginStateErrorOptions = {}) {
        const details = typeof options === 'string' ? { loginStage: options } : options
        const fallbackMessage = sanitizeLoginDiagnosticText(message) || `登录状态 ${loginState} 失败`
        const errorMessage = sanitizeLoginDiagnosticText(details.errorMessage) || fallbackMessage
        super(errorMessage)
        this.name = 'LoginStateError'
        this.loginState = loginState
        this.loginStage = details.loginStage ?? `login-${loginState.toLowerCase().replace(/_/g, '-')}`
        this.errorMessage = errorMessage
        this.url = details.url ?? ''
        this.host = details.host ?? ''
        this.path = details.path ?? ''
    }
}

export function selectDetectedLoginState(foundStates: LoginState[]): LoginState {
    if (foundStates.includes('ERROR_ALERT')) return 'ERROR_ALERT'

    const priorities: LoginState[] = [
        'ACCOUNT_LOCKED',
        'PASSKEY_ERROR',
        'PASSKEY_VIDEO',
        'KMSI_PROMPT',
        'PASSWORD_INPUT',
        'EMAIL_INPUT',
        'REWARDS_SIGN_IN',
        'SIGN_IN_ANOTHER_WAY',
        'SIGN_IN_ANOTHER_WAY_EMAIL',
        'OTP_CODE_ENTRY',
        'GET_A_CODE',
        'GET_A_CODE_2',
        'LOGIN_PASSWORDLESS',
        '2FA_TOTP'
    ]
    return priorities.find(state => foundStates.includes(state)) ?? foundStates[0] ?? 'UNKNOWN'
}

export function rewardsDashboardUrl(baseUrl: string): string {
    const url = new URL(baseUrl)
    url.pathname = '/dashboard'
    url.search = ''
    url.hash = ''
    return url.toString()
}

export function classifyRewardsPageLoginState(
    rawUrl: string,
    hasVisibleSignInControl: boolean
): 'REWARDS_SIGN_IN' | 'LOGGED_IN' | 'UNKNOWN' | null {
    try {
        const url = new URL(rawUrl)
        if (url.hostname !== 'rewards.bing.com') return null
        if (hasVisibleSignInControl) return 'REWARDS_SIGN_IN'
        return url.pathname === '/dashboard' || url.pathname.startsWith('/dashboard/') ? 'LOGGED_IN' : 'UNKNOWN'
    } catch {
        return null
    }
}

export function isKmsiPromptText(text: string): boolean {
    return /stay signed in|保持登录状态|保持登录/i.test(text)
}

export function hasBingAuthenticationCookies(
    cookies: Array<Pick<Cookie, 'name' | 'domain' | 'expires'>>,
    nowSeconds = Date.now() / 1000
): boolean {
    const names = new Set(
        cookies
            .filter(cookie => {
                const domain = cookie.domain.replace(/^\./u, '').toLowerCase()
                const isBingCookie = domain === 'bing.com' || domain.endsWith('.bing.com')
                const isLive = cookie.expires === -1 || cookie.expires > nowSeconds
                return isBingCookie && isLive
            })
            .map(cookie => cookie.name)
    )

    return names.has('_U') && (names.has('.MSA.Auth') || names.has('WLS'))
}

export class Login {
    emailLogin: EmailLogin
    passwordlessLogin: PasswordlessLogin
    totp2FALogin: TotpLogin
    codeLogin: CodeLogin
    recoveryLogin: RecoveryLogin

    private readonly selectors = {
        primaryButton: 'button[data-testid="primaryButton"], #idSIButton9',
        secondaryButton: 'button[data-testid="secondaryButton"]',
        emailIcon: '[data-testid="tile"]:has(svg path[d*="M5.25 4h13.5a3.25"])',
        emailIconOld: 'img[data-testid="accessibleImg"][src*="picker_verify_email"]',
        recoveryEmail: '[data-testid="proof-confirmation"]',
        passwordIcon: PASSWORD_SIGN_IN_OPTION_SELECTOR,
        accountLocked: '#serviceAbuseLandingTitle',
        errorAlert: LOGIN_ERROR_ALERT_SELECTOR,
        passwordEntry: '[data-testid="passwordEntry"], input[type="password"], input[name="passwd"]',
        emailEntry: 'input#usernameEntry, input[type="email"], input[name="loginfmt"]',
        kmsiVideo: '[data-testid="kmsiVideo"]',
        passKeyVideo: '[data-testid="biometricVideo"]',
        passKeyError: '[data-testid="registrationImg"]',
        passwordlessCheck: '[data-testid="deviceShieldCheckmarkVideo"]',
        totpInput: 'input[name="otc"]',
        totpInputOld: 'form[name="OneTimeCodeViewForm"]',
        identityBanner: '[data-testid="identityBanner"]',
        viewFooter: '[data-testid="viewFooter"] >> [role="button"]',
        otherWaysToSignIn: '[data-testid="viewFooter"] span[role="button"]',
        otpCodeEntry: '[data-testid="codeEntry"]',
        backButton: '#back-button',
        rewardsSignIn: REWARDS_SIGN_IN_SELECTOR,
        requestToken: 'input[name="__RequestVerificationToken"]',
        requestTokenMeta: 'meta[name="__RequestVerificationToken"]',
        otpInput: 'div[data-testid="codeEntry"]'
    } as const

    constructor(private bot: MicrosoftRewardsBot) {
        this.emailLogin = new EmailLogin(this.bot)
        this.passwordlessLogin = new PasswordlessLogin(this.bot)
        this.totp2FALogin = new TotpLogin(this.bot)
        this.codeLogin = new CodeLogin(this.bot)
        this.recoveryLogin = new RecoveryLogin(this.bot)
    }

    async login(page: Page, account: Account) {
        try {
            this.bot.logger.info(this.bot.isMobile, 'LOGIN', '开始登录流程')

            await page
                .goto(rewardsDashboardUrl(this.bot.config.baseURL), {
                    waitUntil: 'domcontentloaded'
                })
                .catch(() => {})
            await this.bot.utils.wait(2000)
            await this.bot.browser.utils.reloadBadPage(page)
            await this.bot.browser.utils.disableFido(page)

            const maxIterations = 25
            let iteration = 0
            let previousState: LoginState = 'UNKNOWN'
            let sameStateCount = 0

            while (iteration < maxIterations) {
                if (page.isClosed()) throw new Error('页面意外关闭')

                iteration++
                this.bot.logger.debug(this.bot.isMobile, 'LOGIN', `状态检查迭代 ${iteration}/${maxIterations}`)

                const detection = await this.detectCurrentState(page, account)
                const state = detection.state
                this.bot.logger.debug(this.bot.isMobile, 'LOGIN', `当前状态: ${state}`)

                if (state !== previousState && previousState !== 'UNKNOWN') {
                    this.bot.logger.info(this.bot.isMobile, 'LOGIN', `状态转换: ${previousState} → ${state}`)
                }

                if (state === previousState && state !== 'LOGGED_IN' && state !== 'UNKNOWN') {
                    sameStateCount++
                    this.bot.logger.debug(
                        this.bot.isMobile,
                        'LOGIN',
                        `相同状态计数: ${sameStateCount}/4 状态为 "${state}"`
                    )
                    if (sameStateCount >= 4) {
                        this.bot.logger.warn(this.bot.isMobile, 'LOGIN', `在状态 "${state}" 停滞4次循环，刷新页面`)
                        await page.reload({ waitUntil: 'domcontentloaded' })
                        await this.bot.utils.wait(3000)
                        sameStateCount = 0
                        previousState = 'UNKNOWN'
                        continue
                    }
                } else {
                    sameStateCount = 0
                }
                previousState = state

                if (state === 'LOGGED_IN') {
                    this.bot.logger.info(this.bot.isMobile, 'LOGIN', '检测到 Dashboard 登录候选，开始最终验证')
                    break
                }

                const shouldContinue = await this.handleState(detection, page, account)
                if (!shouldContinue) {
                    throw new LoginStateError(state, `登录失败或中止于状态: ${state}`)
                }

                await this.bot.utils.wait(1000)
            }

            if (iteration >= maxIterations) {
                throw new LoginStateError(previousState, `登录超时: 超过最大迭代次数，最后状态: ${previousState}`, {
                    loginStage: 'login-timeout',
                    ...loginLocation(page.url())
                })
            }

            await this.finalizeLogin(page, account)
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'LOGIN',
                `致命错误: ${error instanceof Error ? error.message : String(error)}`
            )
            throw error
        }
    }

    private async detectCurrentState(page: Page, account?: Account): Promise<DetectedLoginState> {
        await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {})

        const url = new URL(page.url())
        this.bot.logger.debug(this.bot.isMobile, 'DETECT-STATE', `当前URL: ${url.hostname}${url.pathname}`)

        if (url.hostname === 'chromewebdata') {
            this.bot.logger.warn(this.bot.isMobile, 'DETECT-STATE', '检测到chromewebdata错误页面')
            return { state: 'CHROMEWEBDATA_ERROR' }
        }

        const isLocked = await this.checkSelector(page, this.selectors.accountLocked)
        if (isLocked) {
            this.bot.logger.debug(this.bot.isMobile, 'DETECT-STATE', '账户锁定选择器被发现')
            return { state: 'ACCOUNT_LOCKED' }
        }

        const rewardsPageState = classifyRewardsPageLoginState(
            page.url(),
            await this.checkSelector(page, this.selectors.rewardsSignIn)
        )
        if (rewardsPageState === 'REWARDS_SIGN_IN') {
            return { state: rewardsPageState }
        }
        if (rewardsPageState === 'LOGGED_IN') {
            await this.bot.browser.utils.tryDismissAllMessages(page).catch(() => {})
            return { state: rewardsPageState }
        }

        const errorSnapshot = await captureLoginErrorSnapshot(page, this.selectors.errorAlert)
        const stateChecks: Array<[string, LoginState]> = [
            [this.selectors.passwordEntry, 'PASSWORD_INPUT'],
            [this.selectors.emailEntry, 'EMAIL_INPUT'],
            [this.selectors.recoveryEmail, 'RECOVERY_EMAIL_INPUT'],
            [this.selectors.passKeyVideo, 'PASSKEY_VIDEO'],
            [this.selectors.passKeyError, 'PASSKEY_ERROR'],
            [this.selectors.passwordIcon, 'SIGN_IN_ANOTHER_WAY'],
            [this.selectors.emailIcon, 'SIGN_IN_ANOTHER_WAY_EMAIL'],
            [this.selectors.emailIconOld, 'SIGN_IN_ANOTHER_WAY_EMAIL'],
            [this.selectors.passwordlessCheck, 'LOGIN_PASSWORDLESS'],
            [this.selectors.totpInput, '2FA_TOTP'],
            [this.selectors.totpInputOld, '2FA_TOTP'],
            [this.selectors.otpCodeEntry, 'OTP_CODE_ENTRY'], // PR 450
            [this.selectors.otpInput, 'OTP_CODE_ENTRY'] // 我的修复
        ]

        const results = await Promise.all(
            stateChecks.map(async ([sel, state]) => {
                const visible = await this.checkSelector(page, sel)
                return visible ? state : null
            })
        )

        if (
            (await this.checkSelector(page, this.selectors.kmsiVideo)) ||
            ((await this.checkSelector(page, this.selectors.primaryButton)) &&
                isKmsiPromptText(
                    await page
                        .locator('body')
                        .innerText()
                        .catch(() => '')
                ))
        ) {
            results.push('KMSI_PROMPT')
        }

        if (errorSnapshot) results.push('ERROR_ALERT')

        const visibleStates = results.filter((s): s is LoginState => s !== null)
        if (visibleStates.length > 0) {
            this.bot.logger.debug(this.bot.isMobile, 'DETECT-STATE', `可见状态: [${visibleStates.join(', ')}]`)
        }

        const [identityBanner, primaryButton, passwordEntry] = await Promise.all([
            this.checkSelector(page, this.selectors.identityBanner),
            this.checkSelector(page, this.selectors.primaryButton),
            this.checkSelector(page, this.selectors.passwordEntry)
        ])

        if (identityBanner && primaryButton && !passwordEntry && !results.includes('2FA_TOTP')) {
            const codeState = account?.password ? 'GET_A_CODE' : 'GET_A_CODE_2'
            this.bot.logger.debug(
                this.bot.isMobile,
                'DETECT-STATE',
                `检测到获取代码状态: ${codeState} (有密码: ${!!account?.password})`
            )
            results.push(codeState)
        }

        const foundStates = results.filter((s): s is LoginState => s !== null)

        if (foundStates.length === 0 && rewardsPageState) {
            this.bot.logger.debug(
                this.bot.isMobile,
                'DETECT-STATE',
                `Rewards 页面状态: ${rewardsPageState} (${url.hostname}${url.pathname})`
            )
            return { state: rewardsPageState }
        }

        if (foundStates.length === 0) {
            this.bot.logger.debug(this.bot.isMobile, 'DETECT-STATE', '未找到匹配的状态')
            return { state: 'UNKNOWN' }
        }

        if (foundStates.includes('ERROR_ALERT')) {
            this.bot.logger.debug(
                this.bot.isMobile,
                'DETECT-STATE',
                `发现ERROR_ALERT - 主机名: ${url.hostname}, 有2FA: ${foundStates.includes('2FA_TOTP')}`
            )
            this.bot.logger.debug(
                this.bot.isMobile,
                'DETECT-STATE',
                `ERROR_ALERT 快照 | 状态=ERROR_ALERT | 位置=${errorSnapshot?.host || 'unknown'}${
                    errorSnapshot?.path || ''
                } | 文案=${errorSnapshot?.errorMessage || '未捕获'}`
            )
            return errorSnapshot ? { state: 'ERROR_ALERT', errorSnapshot } : { state: 'ERROR_ALERT' }
        }
        const selected = selectDetectedLoginState(foundStates)
        this.bot.logger.debug(this.bot.isMobile, 'DETECT-STATE', `按优先级选择状态: ${selected}`)
        return { state: selected }
    }

    private async checkSelector(page: Page, selector: string): Promise<boolean> {
        return page
            .waitForSelector(selector, { state: 'visible', timeout: 200 })
            .then(() => true)
            .catch(() => false)
    }

    private async checkAnySelector(page: Page, selectors: readonly string[]): Promise<boolean> {
        const matches = await Promise.all(selectors.map(selector => this.checkSelector(page, selector)))
        return matches.some(Boolean)
    }

    private async hasBingSessionEvidence(page: Page): Promise<boolean> {
        const [identityText, visibleProfile, cookies] = await Promise.all([
            page
                .locator('#id_n')
                .first()
                .textContent()
                .catch(() => ''),
            this.checkAnySelector(page, ['#id_avatar', '.id_avatar']),
            page
                .context()
                .cookies(['https://www.bing.com/', 'https://cn.bing.com/'])
                .catch(() => [])
        ])
        const normalizedIdentity = identityText?.trim() ?? ''
        const hasIdentityNode = Boolean(normalizedIdentity) && !/sign in|登录/iu.test(normalizedIdentity)
        const hasAuthenticationCookies = hasBingAuthenticationCookies(cookies)

        this.bot.logger.debug(
            this.bot.isMobile,
            'LOGIN-BING',
            `身份信号: identity=${hasIdentityNode} | visibleProfile=${visibleProfile} | authCookies=${hasAuthenticationCookies}`
        )

        return hasAuthenticationCookies && (hasIdentityNode || visibleProfile)
    }

    private async handleState(detection: DetectedLoginState, page: Page, account: Account): Promise<boolean> {
        const state = detection.state
        this.bot.logger.debug(this.bot.isMobile, 'HANDLE-STATE', `处理状态: ${state}`)

        switch (state) {
            case 'ACCOUNT_LOCKED': {
                const msg = '此账户已被锁定！从配置中移除并重新启动！'
                this.bot.logger.error(this.bot.isMobile, 'LOGIN', msg)
                throw new LoginStateError(state, msg, { ...loginLocation(page.url()) })
            }

            case 'ERROR_ALERT': {
                const snapshot = detection.errorSnapshot ?? {
                    innerText: '',
                    textContent: '',
                    ariaLabel: '',
                    title: '',
                    errorMessage: 'Rewards 页面检测到 ERROR_ALERT，但未读取到错误文案',
                    ...loginLocation(page.url())
                }
                this.bot.logger.error(
                    this.bot.isMobile,
                    'LOGIN',
                    `登录错误 | 状态=${state} | 阶段=login-error-alert | 位置=${snapshot.host}${snapshot.path} | 文案=${snapshot.errorMessage}`
                )
                throw new LoginStateError(state, snapshot.errorMessage, {
                    ...snapshot,
                    loginStage: 'login-error-alert'
                })
            }

            case 'LOGGED_IN':
                return true

            case 'REWARDS_SIGN_IN': {
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Rewards 页面尚未登录，点击登录入口')
                const signIn = await page
                    .waitForSelector(this.selectors.rewardsSignIn, { state: 'visible', timeout: 3000 })
                    .catch(() => null)
                if (!signIn) {
                    throw new LoginStateError(state, 'Rewards 登录入口已消失，无法继续登录', {
                        loginStage: 'rewards-sign-in',
                        ...loginLocation(page.url())
                    })
                }
                await signIn.click()
                await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {})
                return true
            }

            case 'EMAIL_INPUT': {
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', '输入邮箱')
                await this.emailLogin.enterEmail(page, account.email)
                await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {
                    this.bot.logger.debug(this.bot.isMobile, 'LOGIN', '邮箱输入后网络空闲超时')
                })
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', '邮箱输入成功')
                return true
            }

            case 'PASSWORD_INPUT': {
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', '输入密码')
                await this.emailLogin.enterPassword(page, account.password)
                await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {
                    this.bot.logger.debug(this.bot.isMobile, 'LOGIN', '密码输入后网络空闲超时')
                })
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', '密码输入成功')
                return true
            }

            case 'GET_A_CODE': {
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', '尝试跳过"获取代码"页面')

                // 尝试查找"其他登录方式"链接
                const otherWaysLink = await page
                    .waitForSelector(this.selectors.otherWaysToSignIn, { state: 'visible', timeout: 3000 })
                    .catch(() => null)

                if (otherWaysLink) {
                    this.bot.logger.info(this.bot.isMobile, 'LOGIN', '找到"其他登录方式"链接')
                    await this.bot.browser.utils.ghostClick(page, this.selectors.otherWaysToSignIn)
                    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {
                        this.bot.logger.debug(this.bot.isMobile, 'LOGIN', '点击其他方式后网络空闲超时')
                    })
                    this.bot.logger.info(this.bot.isMobile, 'LOGIN', '"其他登录方式"已点击')
                    return true
                }

                // 备用方案: 尝试通用的viewFooter选择器
                const footerLink = await page
                    .waitForSelector(this.selectors.viewFooter, { state: 'visible', timeout: 2000 })
                    .catch(() => null)

                if (footerLink) {
                    await this.bot.browser.utils.ghostClick(page, this.selectors.viewFooter)
                    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {
                        this.bot.logger.debug(this.bot.isMobile, 'LOGIN', '页脚点击后网络空闲超时')
                    })
                    this.bot.logger.info(this.bot.isMobile, 'LOGIN', '页脚链接已点击')
                    return true
                }

                // 如果没有找到链接，尝试点击返回按钮
                const backBtn = await page
                    .waitForSelector(this.selectors.backButton, { state: 'visible', timeout: 2000 })
                    .catch(() => null)

                if (backBtn) {
                    this.bot.logger.info(this.bot.isMobile, 'LOGIN', '未找到登录选项，点击返回按钮')
                    await this.bot.browser.utils.ghostClick(page, this.selectors.backButton)
                    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {
                        this.bot.logger.debug(this.bot.isMobile, 'LOGIN', '返回按钮后网络空闲超时')
                    })
                    return true
                }

                this.bot.logger.warn(this.bot.isMobile, 'LOGIN', '找不到跳过获取代码页面的方法')
                return true
            }

            case 'GET_A_CODE_2': {
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', '处理"获取代码"流程')
                await this.bot.browser.utils.ghostClick(page, this.selectors.primaryButton)
                await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {
                    this.bot.logger.debug(this.bot.isMobile, 'LOGIN', '主按钮点击后网络空闲超时')
                })
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', '启动代码登录处理器')
                await this.codeLogin.handle(page)
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', '代码登录处理器完成')
                return true
            }

            case 'SIGN_IN_ANOTHER_WAY_EMAIL': {
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', '选择"发送代码到邮箱"')

                const emailSelector = await Promise.race([
                    this.checkSelector(page, this.selectors.emailIcon).then(found =>
                        found ? this.selectors.emailIcon : null
                    ),
                    this.checkSelector(page, this.selectors.emailIconOld).then(found =>
                        found ? this.selectors.emailIconOld : null
                    )
                ])

                if (!emailSelector) {
                    this.bot.logger.warn(this.bot.isMobile, 'LOGIN', '未找到邮箱图标')
                    return false
                }

                this.bot.logger.info(
                    this.bot.isMobile,
                    'LOGIN',
                    `使用${emailSelector === this.selectors.emailIcon ? '新' : '旧'}邮箱图标选择器`
                )
                await this.bot.browser.utils.ghostClick(page, emailSelector)
                await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {
                    this.bot.logger.debug(this.bot.isMobile, 'LOGIN', '邮箱图标点击后网络空闲超时')
                })
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', '启动代码登录处理器')
                await this.codeLogin.handle(page)
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', '代码登录处理器完成')
                return true
            }

            case 'RECOVERY_EMAIL_INPUT': {
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', '检测到恢复邮箱输入')
                await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {
                    this.bot.logger.debug(this.bot.isMobile, 'LOGIN', '恢复页面网络空闲超时')
                })
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', '启动恢复邮箱处理器')
                await this.recoveryLogin.handle(page, account?.recoveryEmail)
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', '恢复邮箱处理器完成')
                return true
            }

            case 'CHROMEWEBDATA_ERROR': {
                this.bot.logger.warn(this.bot.isMobile, 'LOGIN', '检测到chromewebdata错误，尝试恢复')
                try {
                    this.bot.logger.info(this.bot.isMobile, 'LOGIN', `导航到 ${this.bot.config.baseURL}`)
                    await page
                        .goto(this.bot.config.baseURL, {
                            waitUntil: 'domcontentloaded',
                            timeout: 10000
                        })
                        .catch(() => {})
                    await this.bot.utils.wait(3000)
                    this.bot.logger.info(this.bot.isMobile, 'LOGIN', '恢复导航成功')
                    return true
                } catch {
                    this.bot.logger.warn(this.bot.isMobile, 'LOGIN', '回退到login.live.com')
                    await page
                        .goto('https://login.live.com/', {
                            waitUntil: 'domcontentloaded',
                            timeout: 10000
                        })
                        .catch(() => {})
                    await this.bot.utils.wait(3000)
                    this.bot.logger.info(this.bot.isMobile, 'LOGIN', '回退导航成功')
                    return true
                }
            }

            case '2FA_TOTP': {
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', '需要TOTP双因素认证')
                await this.totp2FALogin.handle(page, account.totpSecret)
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'TOTP双因素认证处理器完成')
                return true
            }

            case 'SIGN_IN_ANOTHER_WAY': {
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', '选择"使用我的密码"')
                await this.bot.browser.utils.ghostClick(page, this.selectors.passwordIcon)
                await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {
                    this.bot.logger.debug(this.bot.isMobile, 'LOGIN', '密码图标点击后网络空闲超时')
                })
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', '密码选项已选择')
                return true
            }

            case 'KMSI_PROMPT': {
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', '接受KMSI提示')
                await this.bot.browser.utils.ghostClick(page, this.selectors.primaryButton)
                await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {
                    this.bot.logger.debug(this.bot.isMobile, 'LOGIN', 'KMSI接受后网络空闲超时')
                })
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'KMSI提示已接受')
                return true
            }

            case 'PASSKEY_ERROR': {
                throw new LoginStateError(state, '微软登录通行密钥流程返回错误', {
                    loginStage: 'login-passkey-error',
                    ...loginLocation(page.url())
                })
            }

            case 'PASSKEY_VIDEO': {
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', '跳过Passkey提示')
                await this.bot.browser.utils.ghostClick(page, this.selectors.secondaryButton)
                await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {
                    this.bot.logger.debug(this.bot.isMobile, 'LOGIN', 'Passkey跳过后网络空闲超时')
                })
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Passkey提示已跳过')
                return true
            }

            case 'LOGIN_PASSWORDLESS': {
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', '处理无密码认证')
                await this.passwordlessLogin.handle(page)
                await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {
                    this.bot.logger.debug(this.bot.isMobile, 'LOGIN', '无密码认证后网络空闲超时')
                })
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', '无密码认证完成')
                return true
            }

            case 'OTP_CODE_ENTRY': {
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', '检测到OTP代码输入页面，尝试查找密码选项')

                // 我的修复: 点击"使用您的密码"页脚
                const footerLink = await page
                    .waitForSelector(this.selectors.viewFooter, { state: 'visible', timeout: 2000 })
                    .catch(() => null)

                if (footerLink) {
                    await this.bot.browser.utils.ghostClick(page, this.selectors.viewFooter)
                    this.bot.logger.info(this.bot.isMobile, 'LOGIN', '页脚链接已点击')
                } else {
                    // PR 450 修复: 如果未找到页脚，则点击返回按钮
                    const backButton = await page
                        .waitForSelector(this.selectors.backButton, { state: 'visible', timeout: 2000 })
                        .catch(() => null)

                    if (backButton) {
                        await this.bot.browser.utils.ghostClick(page, this.selectors.backButton)
                        this.bot.logger.info(this.bot.isMobile, 'LOGIN', '返回按钮已点击')
                    } else {
                        this.bot.logger.warn(this.bot.isMobile, 'LOGIN', 'OTP页面上未找到导航选项')
                    }
                }

                await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {
                    this.bot.logger.debug(this.bot.isMobile, 'LOGIN', 'OTP导航后网络空闲超时')
                })
                this.bot.logger.info(this.bot.isMobile, 'LOGIN', '从OTP输入页面返回')
                return true
            }

            case 'UNKNOWN': {
                const url = new URL(page.url())
                this.bot.logger.warn(this.bot.isMobile, 'LOGIN', `在 ${url.hostname}${url.pathname} 的未知状态，等待中`)
                return true
            }

            default:
                this.bot.logger.debug(this.bot.isMobile, 'HANDLE-STATE', `未处理的状态: ${state}，继续执行`)
                return true
        }
    }

    private async finalizeLogin(page: Page, account: Account) {
        this.bot.logger.info(this.bot.isMobile, 'LOGIN', '开始最终登录验证')
        this.bot.logger.info(this.bot.isMobile, 'LOGIN', '开始Bing会话验证')
        await this.verifyBingSession(page, account)

        this.bot.logger.info(this.bot.isMobile, 'LOGIN', '开始奖励会话验证')
        await this.getRewardsSession(page)

        const browser = page.context()
        const cookies = await browser.cookies()
        this.bot.logger.debug(this.bot.isMobile, 'LOGIN', `检索到 ${cookies.length} 个cookie`)
        await saveSessionData(this.bot.config.sessionPath, cookies, account.email, this.bot.isMobile)
        this.bot.browser.func.markSessionVerified(browser)

        this.bot.logger.info(this.bot.isMobile, 'LOGIN', '登录完成，会话已保存')
    }

    async verifyBingSession(page: Page, account: Account) {
        const url =
            'https://www.bing.com/fd/auth/signin?action=interactive&provider=windows_live_id&return_url=https%3A%2F%2Fwww.bing.com%2F'
        const loopMax = 10

        this.bot.logger.info(this.bot.isMobile, 'LOGIN-BING', '验证Bing会话')

        try {
            await page.goto(url, { waitUntil: 'networkidle', timeout: 10000 }).catch(() => {})

            for (let i = 0; i < loopMax; i++) {
                if (page.isClosed()) break

                this.bot.logger.debug(this.bot.isMobile, 'LOGIN-BING', `验证循环 ${i + 1}/${loopMax}`)

                const u = new URL(page.url())
                const atBingHome = ['cn.bing.com', 'www.bing.com'].includes(u.hostname) && u.pathname === '/'
                this.bot.logger.debug(
                    this.bot.isMobile,
                    'LOGIN-BING',
                    `在Bing首页: ${atBingHome} (${u.hostname}${u.pathname})`
                )

                if (atBingHome) {
                    await this.bot.browser.utils.tryDismissAllMessages(page).catch(() => {})

                    const signedIn = await this.hasBingSessionEvidence(page)

                    this.bot.logger.debug(this.bot.isMobile, 'LOGIN-BING', `找到个人资料元素: ${signedIn}`)

                    if (signedIn) {
                        this.bot.logger.info(this.bot.isMobile, 'LOGIN-BING', 'Bing会话验证成功')
                        return
                    }
                }

                const detection = await this.detectCurrentState(page, account)
                const state = detection.state
                if (state === 'PASSKEY_ERROR') {
                    throw new LoginStateError(state, 'Bing 会话验证遇到通行密钥错误', {
                        loginStage: 'bing-session-passkey-error',
                        ...loginLocation(page.url())
                    })
                }
                if (state === 'ERROR_ALERT') {
                    const snapshot = detection.errorSnapshot ?? {
                        innerText: '',
                        textContent: '',
                        ariaLabel: '',
                        title: '',
                        errorMessage: 'Bing 会话检测到 ERROR_ALERT，但未读取到错误文案',
                        ...loginLocation(page.url())
                    }
                    throw new LoginStateError(state, snapshot.errorMessage, {
                        ...snapshot,
                        loginStage: 'bing-session-error'
                    })
                }

                if (state !== 'UNKNOWN' && state !== 'LOGGED_IN' && state !== 'CHROMEWEBDATA_ERROR') {
                    await this.handleState(detection, page, account)
                }

                await this.bot.utils.wait(1000)
            }

            throw new LoginStateError('UNKNOWN', 'Bing 会话验证超时，未确认登录状态', {
                loginStage: 'bing-session-timeout',
                ...loginLocation(page.url())
            })
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'LOGIN-BING',
                `验证错误: ${error instanceof Error ? error.message : String(error)}`
            )
            throw error
        }
    }

    private async getRewardsSession(page: Page) {
        const loopMax = 5

        this.bot.logger.info(this.bot.isMobile, 'GET-REWARD-SESSION', '获取请求令牌')

        try {
            await page
                .goto(`${rewardsDashboardUrl(this.bot.config.baseURL)}?_=${Date.now()}`, {
                    waitUntil: 'domcontentloaded',
                    timeout: 15000
                })
                .catch(() => {})

            for (let i = 0; i < loopMax; i++) {
                if (page.isClosed()) break

                this.bot.logger.debug(this.bot.isMobile, 'GET-REWARD-SESSION', `令牌获取循环 ${i + 1}/${loopMax}`)

                const u = new URL(page.url())
                const atRewardHome = u.hostname === 'rewards.bing.com' && u.pathname === '/dashboard'

                if (atRewardHome) {
                    await this.bot.browser.utils.tryDismissAllMessages(page)

                    const [signInVisible, dashboardSurfaceVisible] = await Promise.all([
                        this.checkSelector(page, this.selectors.rewardsSignIn),
                        this.checkSelector(
                            page,
                            'section#dailyset, #daily-sets, main section, main article, [data-testid*="dashboard" i], [class*="point" i]'
                        )
                    ])
                    if (signInVisible || !dashboardSurfaceVisible) {
                        this.bot.logger.debug(
                            this.bot.isMobile,
                            'GET-REWARD-SESSION',
                            `Dashboard 页面证据不足 | 登录入口=${signInVisible} | 内容区=${dashboardSurfaceVisible}`
                        )
                        await this.bot.utils.wait(1000)
                        continue
                    }

                    const html = await page.content()
                    const $ = await this.bot.browser.utils.loadInCheerio(html)

                    // 检查当前使用的是哪个版本的仪表板，在新版仪表板上禁用 requestToken 请求。
                    // 新版 Rewards 使用 Next.js App Router，页面经常不再包含 __RequestVerificationToken。
                    const isModernDashboard =
                        $('section#dailyset').length > 0 ||
                        $('script[src*="/_next/"]').length > 0 ||
                        html.includes('self.__next_f') ||
                        html.includes('__NEXT_DATA__') ||
                        /[?&]dpl=\d+-\d+/.test(html)

                    if (isModernDashboard) {
                        this.bot.rewardsVersion = 'modern'

                        this.bot.logger.info(
                            this.bot.isMobile,
                            'GET-REWARD-SESSION',
                            '检测到现代 Rewards 仪表板，RequestVerificationToken 不是必需项'
                        )
                    }

                    const token =
                        $(this.selectors.requestToken).attr('value') ??
                        $(this.selectors.requestTokenMeta).attr('content') ??
                        null

                    if (token) {
                        this.bot.requestToken = token
                        this.bot.logger.info(this.bot.isMobile, 'GET-REWARD-SESSION', '请求令牌已获取')
                        return
                    }

                    if (isModernDashboard) {
                        this.bot.logger.info(
                            this.bot.isMobile,
                            'GET-REWARD-SESSION',
                            '现代仪表板未提供 RequestVerificationToken，已按预期跳过旧版令牌获取'
                        )
                        return
                    }

                    this.bot.logger.debug(this.bot.isMobile, 'GET-REWARD-SESSION', '页面上未找到令牌')
                } else {
                    this.bot.logger.debug(
                        this.bot.isMobile,
                        'GET-REWARD-SESSION',
                        `不在奖励首页: ${u.hostname}${u.pathname}`
                    )
                }

                await this.bot.utils.wait(1000)
            }

            throw new LoginStateError('UNKNOWN', 'Rewards dashboard 会话验证失败', {
                loginStage: 'rewards-session-error',
                ...loginLocation(page.url())
            })
        } catch (error) {
            throw this.bot.logger.error(
                this.bot.isMobile,
                'GET-REWARD-SESSION',
                `致命错误: ${error instanceof Error ? error.message : String(error)}`
            )
        }
    }

    async getAppAccessToken(page: Page, email: string) {
        this.bot.logger.info(this.bot.isMobile, 'GET-APP-TOKEN', '请求移动访问令牌')
        return await new MobileAccessLogin(this.bot, page).get(email)
    }
}
