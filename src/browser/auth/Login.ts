import type { Page } from 'patchright'
import type { MicrosoftRewardsBot } from '../../index'
import { saveSessionData } from '../../util/Load'
import { SessionValidationError } from '../../util/SessionValidationError'

import { MobileAccessLogin } from './methods/MobileAccessLogin'
import { EmailLogin } from './methods/EmailLogin'
import { PasswordlessLogin } from './methods/PasswordlessLogin'
import { TotpLogin } from './methods/Totp2FALogin'
import { CodeLogin } from './methods/GetACodeLogin'
import { RecoveryLogin } from './methods/RecoveryEmailLogin'

import type { Account } from '../../interface/Account'
import type { DashboardData } from '../../interface/DashboardData'

export type LoginState =
    | 'EMAIL_INPUT'
    | 'PASSWORD_INPUT'
    | 'SIGN_IN_ANOTHER_WAY'
    | 'SIGN_IN_ANOTHER_WAY_EMAIL'
    | 'PASSKEY_ERROR'
    | 'PASSKEY_VIDEO'
    | 'KMSI_PROMPT'
    | 'LOGGED_IN'
    | 'REWARDS_DASHBOARD'
    | 'REWARDS_UNVERIFIED'
    | 'MICROSOFT_ACCOUNT'
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

export interface LoginOptions {
    rejectStoredSessionChallenge?: boolean
}

export class Login {
    emailLogin: EmailLogin
    passwordlessLogin: PasswordlessLogin
    totp2FALogin: TotpLogin
    codeLogin: CodeLogin
    recoveryLogin: RecoveryLogin

    private readonly selectors = {
        primaryButton: 'button[data-testid="primaryButton"]',
        secondaryButton: 'button[data-testid="secondaryButton"]',
        emailIcon: '[data-testid="tile"]:has(svg path[d*="M5.25 4h13.5a3.25"])',
        emailIconOld: 'img[data-testid="accessibleImg"][src*="picker_verify_email"]',
        recoveryEmail: '[data-testid="proof-confirmation"]',
        passwordIcon: '[data-testid="tile"]:has(svg path[d*="M11.78 10.22a.75.75"])',
        accountLocked: '#serviceAbuseLandingTitle',
        errorAlert: 'div[role="alert"]',
        passwordEntry: '[data-testid="passwordEntry"]',
        emailEntry: 'input#usernameEntry',
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
        bingProfile: '#id_n',
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

    async login(page: Page, account: Account, options: LoginOptions = {}): Promise<DashboardData> {
        try {
            this.bot.logger.info(this.bot.isMobile, 'LOGIN', '开始登录流程')

            await page
                .goto('https://rewards.bing.com/createuser?idru=%2F&userScenarioId=anonsignin', {
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
            let reachedAuthenticatedPage = false

            while (iteration < maxIterations) {
                if (page.isClosed()) throw new Error('页面意外关闭')

                iteration++
                this.bot.logger.debug(this.bot.isMobile, 'LOGIN', `状态检查迭代 ${iteration}/${maxIterations}`)

                const state = await this.detectCurrentState(page, account)
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
                        this.bot.logger.warn(
                            this.bot.isMobile,
                            'LOGIN',
                            `在状态 "${state}" 停滞4次循环，刷新页面`
                        )
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

                if (
                    options.rejectStoredSessionChallenge &&
                    (this.isAuthenticationChallenge(state) || state === 'REWARDS_UNVERIFIED')
                ) {
                    throw new SessionValidationError(
                        'stored-session-challenge',
                        `持久会话已失效，出现认证状态 ${state}`
                    )
                }

                if (state === 'LOGGED_IN' || state === 'REWARDS_DASHBOARD' || state === 'MICROSOFT_ACCOUNT') {
                    this.bot.logger.info(this.bot.isMobile, 'LOGIN', '已到达登录验证候选页面')
                    reachedAuthenticatedPage = true
                    break
                }

                const shouldContinue = await this.handleState(state, page, account)
                if (!shouldContinue) {
                    throw new Error(`登录失败或中止于状态: ${state}`)
                }

                await this.bot.utils.wait(1000)
            }

            if (!reachedAuthenticatedPage) {
                throw new SessionValidationError('rewards-session-invalid', '登录超时：未到达可验证的登录页面')
            }

            return await this.finalizeLogin(page, account)
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'LOGIN',
                `致命错误: ${error instanceof Error ? error.message : String(error)}`
            )
            throw error
        }
    }

    private async detectCurrentState(page: Page, account?: Account): Promise<LoginState> {
        await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {})

        const url = new URL(page.url())
        this.bot.logger.debug(this.bot.isMobile, 'DETECT-STATE', `当前URL: ${url.hostname}${url.pathname}`)

        if (url.hostname === 'chromewebdata') {
            this.bot.logger.warn(this.bot.isMobile, 'DETECT-STATE', '检测到chromewebdata错误页面')
            return 'CHROMEWEBDATA_ERROR'
        }

        const isLocked = await this.checkSelector(page, this.selectors.accountLocked)
        if (isLocked) {
            this.bot.logger.debug(this.bot.isMobile, 'DETECT-STATE', '账户锁定选择器被发现')
            return 'ACCOUNT_LOCKED'
        }

        const stateChecks: Array<[string, LoginState]> = [
            [this.selectors.errorAlert, 'ERROR_ALERT'],
            [this.selectors.passwordEntry, 'PASSWORD_INPUT'],
            [this.selectors.emailEntry, 'EMAIL_INPUT'],
            [this.selectors.recoveryEmail, 'RECOVERY_EMAIL_INPUT'],
            [this.selectors.kmsiVideo, 'KMSI_PROMPT'],
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

        let foundStates = results.filter((s): s is LoginState => s !== null)

        if (foundStates.length === 0) {
            const normalizedPath = url.pathname.replace(/\/+$/, '') || '/'
            if (url.hostname === 'rewards.bing.com' && normalizedPath === '/dashboard') {
                this.bot.logger.debug(this.bot.isMobile, 'DETECT-STATE', '到达 Rewards dashboard 候选页面')
                return 'REWARDS_DASHBOARD'
            }

            if (
                url.hostname === 'rewards.bing.com' &&
                (normalizedPath === '/about' || normalizedPath === '/createuser')
            ) {
                this.bot.logger.debug(this.bot.isMobile, 'DETECT-STATE', '到达未验证的 Rewards 普通页面')
                return 'REWARDS_UNVERIFIED'
            }

            if (url.hostname === 'account.microsoft.com') {
                this.bot.logger.debug(this.bot.isMobile, 'DETECT-STATE', '到达 Microsoft 账户候选页面')
                return 'MICROSOFT_ACCOUNT'
            }

            const atBingHome =
                (url.hostname === 'www.bing.com' || url.hostname === 'cn.bing.com') && normalizedPath === '/'
            if (atBingHome && (await this.checkSelector(page, this.selectors.bingProfile))) {
                this.bot.logger.debug(this.bot.isMobile, 'DETECT-STATE', 'Bing 首页存在已登录用户标识')
                return 'LOGGED_IN'
            }

            this.bot.logger.debug(this.bot.isMobile, 'DETECT-STATE', '未找到匹配的状态')
            return 'UNKNOWN'
        }

        if (foundStates.includes('ERROR_ALERT')) {
            this.bot.logger.debug(
                this.bot.isMobile,
                'DETECT-STATE',
                `发现ERROR_ALERT - 主机名: ${url.hostname}, 有2FA: ${foundStates.includes('2FA_TOTP')}`
            )
            if (url.hostname !== 'login.live.com') {
                foundStates = foundStates.filter(s => s !== 'ERROR_ALERT')
            }
            if (foundStates.includes('2FA_TOTP')) {
                foundStates = foundStates.filter(s => s !== 'ERROR_ALERT')
            }
            if (foundStates.includes('ERROR_ALERT')) return 'ERROR_ALERT'
        }

        const priorities: LoginState[] = [
            'ACCOUNT_LOCKED',
            'PASSKEY_VIDEO',
            'PASSKEY_ERROR',
            'KMSI_PROMPT',
            'PASSWORD_INPUT',
            'EMAIL_INPUT',
            'SIGN_IN_ANOTHER_WAY', // 优先选择密码选项而不是邮箱验证码
            'SIGN_IN_ANOTHER_WAY_EMAIL',
            'OTP_CODE_ENTRY',
            'GET_A_CODE',
            'GET_A_CODE_2',
            'LOGIN_PASSWORDLESS',
            '2FA_TOTP'
        ]

        for (const priority of priorities) {
            if (foundStates.includes(priority)) {
                this.bot.logger.debug(this.bot.isMobile, 'DETECT-STATE', `按优先级选择状态: ${priority}`)
                return priority
            }
        }

        this.bot.logger.debug(this.bot.isMobile, 'DETECT-STATE', `返回第一个找到的状态: ${foundStates[0]}`)
        return foundStates[0] as LoginState
    }

    private async checkSelector(page: Page, selector: string): Promise<boolean> {
        return page
            .waitForSelector(selector, { state: 'visible', timeout: 200 })
            .then(() => true)
            .catch(() => false)
    }

    private isAuthenticationChallenge(state: LoginState): boolean {
        return [
            'EMAIL_INPUT',
            'PASSWORD_INPUT',
            'SIGN_IN_ANOTHER_WAY',
            'SIGN_IN_ANOTHER_WAY_EMAIL',
            'PASSKEY_ERROR',
            'PASSKEY_VIDEO',
            'KMSI_PROMPT',
            'RECOVERY_EMAIL_INPUT',
            '2FA_TOTP',
            'LOGIN_PASSWORDLESS',
            'GET_A_CODE',
            'GET_A_CODE_2',
            'OTP_CODE_ENTRY'
        ].includes(state)
    }

    private async handleState(state: LoginState, page: Page, account: Account): Promise<boolean> {
        this.bot.logger.debug(this.bot.isMobile, 'HANDLE-STATE', `处理状态: ${state}`)

        switch (state) {
            case 'ACCOUNT_LOCKED': {
                const msg = '此账户已被锁定！从配置中移除并重新启动！'
                this.bot.logger.error(this.bot.isMobile, 'LOGIN', msg)
                throw new Error(msg)
            }

            case 'ERROR_ALERT': {
                const alertEl = page.locator(this.selectors.errorAlert)
                const errorMsg = await alertEl.innerText().catch(() => '未知错误')
                this.bot.logger.error(this.bot.isMobile, 'LOGIN', `账户错误: ${errorMsg}`)
                throw new Error(`微软登录错误: ${errorMsg}`)
            }

            case 'LOGGED_IN':
            case 'REWARDS_DASHBOARD':
            case 'MICROSOFT_ACCOUNT':
                return true

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
                        this.bot.logger.debug(
                            this.bot.isMobile,
                            'LOGIN',
                            '点击其他方式后网络空闲超时'
                        )
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

            case 'PASSKEY_VIDEO':
            case 'PASSKEY_ERROR': {
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
                this.bot.logger.info(
                    this.bot.isMobile,
                    'LOGIN',
                    '检测到OTP代码输入页面，尝试查找密码选项'
                )

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
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'LOGIN',
                    `在 ${url.hostname}${url.pathname} 的未知状态，等待中`
                )
                return true
            }

            default:
                this.bot.logger.debug(this.bot.isMobile, 'HANDLE-STATE', `未处理的状态: ${state}，继续执行`)
                return true
        }
    }

    private async finalizeLogin(page: Page, account: Account): Promise<DashboardData> {
        this.bot.logger.info(this.bot.isMobile, 'LOGIN', '验证登录结果')
        this.bot.logger.info(this.bot.isMobile, 'LOGIN', '开始Bing会话验证')
        await this.verifyBingSession(page, account)

        this.bot.logger.info(this.bot.isMobile, 'LOGIN', '开始奖励会话验证')
        this.bot.browser.func.prepareDashboardCapture(page, account.geoLocale)
        await this.getRewardsSession(page)

        let dashboard: DashboardData
        try {
            dashboard = await this.bot.browser.func.getDashboardData(account.geoLocale, page)
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            throw new SessionValidationError('dashboard-session-invalid', `Rewards 数据验证失败：${message}`)
        }

        const browser = page.context()
        const cookies = await browser.cookies()
        this.bot.logger.debug(this.bot.isMobile, 'LOGIN', `检索到 ${cookies.length} 个cookie`)
        await saveSessionData(this.bot.config.sessionPath, cookies, account.email, this.bot.isMobile)

        this.bot.logger.info(this.bot.isMobile, 'LOGIN', '登录验证完成，会话已原子保存')
        return dashboard
    }

    async verifyBingSession(page: Page, account: Account): Promise<void> {
        const url =
            'https://www.bing.com/fd/auth/signin?action=interactive&provider=windows_live_id&return_url=https%3A%2F%2Fwww.bing.com%2F'
        const loopMax = 15

        this.bot.logger.info(this.bot.isMobile, 'LOGIN-BING', '验证Bing会话')

        await page.goto(url, { waitUntil: 'networkidle', timeout: 10000 }).catch(() => {})

        for (let i = 0; i < loopMax; i++) {
            if (page.isClosed()) break

            this.bot.logger.debug(this.bot.isMobile, 'LOGIN-BING', `验证循环 ${i + 1}/${loopMax}`)

            const state = await this.detectCurrentState(page, account)

            const u = new URL(page.url())
            const normalizedPath = u.pathname.replace(/\/+$/, '') || '/'
            const atBingHome = (u.hostname === 'www.bing.com' || u.hostname === 'cn.bing.com') && normalizedPath === '/'
            this.bot.logger.debug(
                this.bot.isMobile,
                'LOGIN-BING',
                `在Bing首页: ${atBingHome} (${u.hostname}${u.pathname})`
            )

            if (atBingHome) {
                await this.bot.browser.utils.tryDismissAllMessages(page).catch(() => {})

                const signedIn = await this.checkSelector(page, this.selectors.bingProfile)

                this.bot.logger.debug(this.bot.isMobile, 'LOGIN-BING', `找到个人资料元素: ${signedIn}`)

                if (signedIn) {
                    this.bot.logger.info(this.bot.isMobile, 'LOGIN-BING', 'Bing会话验证成功')
                    return
                }
            }

            if (this.isAuthenticationChallenge(state)) {
                const shouldContinue = await this.handleState(state, page, account)
                if (!shouldContinue) break
            }

            await this.bot.utils.wait(1000)
        }

        throw new SessionValidationError('bing-session-invalid', 'Bing 会话验证失败：未找到已登录用户标识')
    }

    private async getRewardsSession(page: Page) {
        const loopMax = 5

        this.bot.logger.info(this.bot.isMobile, 'GET-REWARD-SESSION', '获取请求令牌')

        try {
            await page
                .goto(`${this.bot.config.baseURL}?_=${Date.now()}`, { waitUntil: 'networkidle', timeout: 10000 })
                .catch(() => {})

            for (let i = 0; i < loopMax; i++) {
                if (page.isClosed()) break

                this.bot.logger.debug(this.bot.isMobile, 'GET-REWARD-SESSION', `令牌获取循环 ${i + 1}/${loopMax}`)

                const u = new URL(page.url())
                const atRewardHome = u.hostname === 'rewards.bing.com' && u.pathname === '/dashboard'

                if (atRewardHome) {
                    await this.bot.browser.utils.tryDismissAllMessages(page)

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

                    this.bot.logger.warn(
                        this.bot.isMobile,
                        'GET-REWARD-SESSION',
                        '旧版 dashboard 未找到 RequestVerificationToken，相关旧版活动将跳过'
                    )
                    return
                } else {
                    this.bot.logger.debug(
                        this.bot.isMobile,
                        'GET-REWARD-SESSION',
                        `不在奖励首页: ${u.hostname}${u.pathname}`
                    )
                }

                await this.bot.utils.wait(1000)
            }

            throw new SessionValidationError('rewards-session-invalid', 'Rewards 会话验证失败：未进入 dashboard')
        } catch (error) {
            if (error instanceof SessionValidationError) throw error
            const message = error instanceof Error ? error.message : String(error)
            this.bot.logger.error(this.bot.isMobile, 'GET-REWARD-SESSION', `验证错误: ${message}`)
            throw new SessionValidationError('rewards-session-invalid', `Rewards 会话验证失败：${message}`)
        }
    }

    async getAppAccessToken(page: Page, account: Account): Promise<string> {
        this.bot.logger.info(this.bot.isMobile, 'GET-APP-TOKEN', '请求移动访问令牌')
        const continueAuthentication = async (): Promise<boolean> => {
            const state = await this.detectCurrentState(page, account)
            if (!this.isAuthenticationChallenge(state)) return false
            return await this.handleState(state, page, account)
        }
        return await new MobileAccessLogin(this.bot, page, continueAuthentication).get(account.email)
    }
}
