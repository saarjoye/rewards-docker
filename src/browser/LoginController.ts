import type { Locator, Page } from 'patchright'

import { LoginStateError, type LoginState } from '../auth/LoginState.js'
import type { AccountCredentials } from '../infra/AccountSecretStore.js'
import type { StructuredLogger } from '../infra/StructuredLogger.js'
import { redactText, safePath } from '../security/Redactor.js'
import { REWARDS_URLS } from './Urls.js'

export interface LoginStateSnapshot {
  state: LoginState
  loginStage: string
  errorMessage?: string
  url: string
  host: string
  path: string
}

const LOGIN_TIMEOUT_MS = 120_000
const AUTH_CALLBACK_GRACE_MS = 90_000
const LOGIN_POLL_MS = 700

const SELECTORS = {
  email: 'input#usernameEntry, input[name="loginfmt"]',
  password: 'input[data-testid="passwordEntry"], input[name="passwd"], input[type="password"]',
  primary: 'button[data-testid="primaryButton"], input[type="submit"], button[type="submit"]',
  secondary: 'button[data-testid="secondaryButton"]',
  footer: '[data-testid="viewFooter"] [role="button"], [data-testid="viewFooter"] button',
  methodTile: '[data-testid="tile"], [role="listitem"] button',
  accountTile: '[data-test-id="accountTile"], [data-testid="accountTile"], #tilesHolder .table-row',
  otherAccount: '#otherTileText, [data-test-id="otherTile"], [data-testid="otherTile"]',
  kmsi: '[data-testid="kmsiVideo"], form[name="KmsiInterruptForm"]',
  authenticator: '[data-testid="deviceShieldCheckmarkVideo"], [data-testid="displaySign"]',
  proofEmail:
    'input#proof-confirmation-email-input, [data-testid="proof-confirmation"], input[name="proof-confirmation"], input[name="ProofConfirmation"], input[autocomplete="email"][aria-describedby*="proof"]',
  otp: '[data-testid="codeEntry"], input[name="otc"], form[name="OneTimeCodeViewForm"]',
  captcha: 'iframe[src*="captcha"], [data-testid*="captcha"], #hipEnforcementContainer',
  passkey: '[data-testid="biometricVideo"], [data-testid="registrationImg"]',
  accountLocked: '#serviceAbuseLandingTitle, [data-testid="serviceAbuseLandingTitle"]',
  alert: 'div[role="alert"], [data-testid="error"]',
  identity: '[data-testid="identityBanner"], #id_n'
} as const

const PASSWORD_SIGN_IN_PATTERN =
  /use(?: your)? password|sign in with (?:your )?password|使用(?:你的)?密码(?:登录)?|密码登录/i
const OTHER_SIGN_IN_PATTERN =
  /other ways? to sign in|sign in another way|try another way|其他登录(?:方式|方法)|其它登录(?:方式|方法)|换一种(?:登录|验证)(?:方式|方法)|使用其他方式/i
const EMAIL_PROOF_PROMPT_PATTERN =
  /associated with your account|alternate email|recovery email|enter (?:the )?email address|与你的帐户关联|与你的账户关联|备用电子邮件|备选电子邮件|恢复电子邮件|请输入.*电子邮件地址/i

async function firstVisible(locator: Locator): Promise<Locator | undefined> {
  const count = await locator.count().catch(() => 1)
  for (let index = 0; index < Math.min(count, 20); index += 1) {
    const candidate = count === 1 ? locator.first() : locator.nth(index)
    if (await candidate.isVisible({ timeout: 800 }).catch(() => false)) return candidate
  }
  return undefined
}

async function firstEnabledVisible(locator: Locator): Promise<Locator | undefined> {
  const count = await locator.count().catch(() => 1)
  for (let index = 0; index < Math.min(count, 20); index += 1) {
    const candidate = count === 1 ? locator.first() : locator.nth(index)
    const isVisible = await candidate.isVisible({ timeout: 800 }).catch(() => false)
    if (!isVisible) continue
    if (await candidate.isEnabled({ timeout: 800 }).catch(() => false)) return candidate
  }
  return undefined
}

async function visible(locator: Locator): Promise<boolean> {
  return (await firstVisible(locator)) !== undefined
}

async function firstText(locator: Locator): Promise<string> {
  const target = locator.first()
  const values = await Promise.all([
    target.innerText({ timeout: 800 }).catch(() => ''),
    target.textContent({ timeout: 800 }).catch(() => ''),
    target.getAttribute('aria-label').catch(() => ''),
    target.getAttribute('title').catch(() => '')
  ])
  return redactText(values.find((value) => value?.trim())?.trim() ?? '')
}

function location(page: Page): { url: string; host: string; path: string } {
  try {
    const parsed = new URL(page.url())
    return {
      url: safePath(parsed.href),
      host: parsed.hostname.toLowerCase(),
      path: parsed.pathname
    }
  } catch {
    return { url: '[invalid-url]', host: '', path: '' }
  }
}

export class LoginController {
  constructor(private readonly logger: StructuredLogger) {}

  async detectCurrentState(page: Page): Promise<LoginStateSnapshot> {
    await page.waitForLoadState('domcontentloaded', { timeout: 3000 }).catch(() => undefined)
    const current = location(page)
    const onLoginHost =
      current.host === 'login.live.com' ||
      current.host === 'login.microsoft.com' ||
      current.host === 'login.microsoftonline.com'
    const onRewardsAuthCallback =
      current.host === 'rewards.bing.com' &&
      (current.path.toLowerCase() === '/auth/callback' ||
        current.path.toLowerCase().startsWith('/auth/callback/'))

    if (await visible(page.locator(SELECTORS.captcha))) {
      return { state: 'captcha', loginStage: 'login-captcha', ...current }
    }
    if (await visible(page.locator(SELECTORS.accountLocked))) {
      return {
        state: 'account-locked',
        loginStage: 'login-account-locked',
        errorMessage: 'Microsoft 账号已被限制，无法继续登录',
        ...current
      }
    }
    if (
      (current.host === 'login.microsoft.com' && current.path.includes('/fido/')) ||
      (await visible(page.locator(SELECTORS.passkey)))
    ) {
      return { state: 'passkey-error', loginStage: 'login-passkey-error', ...current }
    }

    const alert = page.locator(SELECTORS.alert)
    if (await visible(alert)) {
      const text = await firstText(alert)
      const actionable =
        onLoginHost ||
        /error|incorrect|invalid|failed|locked|错误|不正确|无效|失败|锁定|暂时无法/i.test(text)
      if (actionable) {
        return {
          state: 'error-alert',
          loginStage: 'login-error-alert',
          errorMessage: text || 'Rewards 页面检测到 ERROR_ALERT，但未读取到错误文案',
          ...current
        }
      }
    }

    if (onRewardsAuthCallback) {
      return { state: 'auth-callback', loginStage: 'login-auth-callback', ...current }
    }

    if (await this.passwordSignInButton(page)) {
      return { state: 'password-choice', loginStage: 'login-password-choice', ...current }
    }

    if (await visible(page.locator(SELECTORS.password))) {
      return { state: 'password-input', loginStage: 'login-password', ...current }
    }
    if (
      (await visible(page.locator(SELECTORS.accountTile))) ||
      (await visible(page.locator(SELECTORS.otherAccount)))
    ) {
      return { state: 'account-picker', loginStage: 'login-account-picker', ...current }
    }
    if (
      (await visible(page.locator(SELECTORS.proofEmail))) ||
      (await visible(page.getByText(EMAIL_PROOF_PROMPT_PATTERN)))
    ) {
      return {
        state: 'email-verification-input',
        loginStage: 'login-email-verification',
        ...current
      }
    }
    if (await visible(page.locator(SELECTORS.email))) {
      return { state: 'email-input', loginStage: 'login-email', ...current }
    }
    if (await visible(page.locator(SELECTORS.otp))) {
      return { state: 'otp-code-entry', loginStage: 'login-otp', ...current }
    }
    if (await visible(page.locator(SELECTORS.authenticator))) {
      return {
        state: 'authenticator-approval',
        loginStage: 'login-authenticator-approval',
        ...current
      }
    }
    if (await visible(page.locator(SELECTORS.kmsi))) {
      return { state: 'kmsi-prompt', loginStage: 'login-kmsi', ...current }
    }
    if (await visible(page.locator(SELECTORS.methodTile))) {
      return { state: 'sign-in-method-picker', loginStage: 'login-method-picker', ...current }
    }

    const rewardsCandidate =
      current.host === 'rewards.bing.com' &&
      !['/about', '/createuser'].includes(current.path.toLowerCase()) &&
      !current.path.toLowerCase().startsWith('/auth/')
    const bingCandidate =
      current.host === 'bing.com' ||
      (current.host.endsWith('.bing.com') && current.host !== 'rewards.bing.com')
    const accountCandidate = current.host === 'account.microsoft.com'
    if (
      rewardsCandidate ||
      bingCandidate ||
      accountCandidate ||
      (!onLoginHost && (await visible(page.locator(SELECTORS.identity))))
    ) {
      return { state: 'logged-in', loginStage: 'login-candidate', ...current }
    }
    return { state: 'unknown', loginStage: 'login-unknown', ...current }
  }

  async login(page: Page, credentials: AccountCredentials, signal: AbortSignal): Promise<void> {
    if (!page.url() || page.url() === 'about:blank') {
      await page.goto(REWARDS_URLS.login, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    }

    const deadline = Date.now() + LOGIN_TIMEOUT_MS
    let previousState: LoginState | undefined
    let unchangedSince = Date.now()
    let unknownRecoveryAttempted = false
    let callbackSince: number | undefined
    while (Date.now() < deadline) {
      if (signal.aborted) throw signal.reason
      let snapshot = await this.detectCurrentState(page)
      const observedAt = Date.now()
      if (snapshot.state === 'auth-callback') {
        if (callbackSince === undefined || previousState !== 'auth-callback') callbackSince = observedAt
      } else {
        callbackSince = undefined
      }
      await this.logger.write({
        level: 'debug',
        event: 'login-state',
        stage: snapshot.loginStage,
        status: snapshot.state,
        host: snapshot.host,
        path: snapshot.path,
        ...(callbackSince === undefined
          ? {}
          : { durationMs: Math.max(0, observedAt - callbackSince) })
      })

      if (snapshot.state === 'logged-in') return
      if (snapshot.state === 'auth-callback') {
        const callbackWait = observedAt - (callbackSince ?? observedAt)
        const remaining = deadline - observedAt
        if (callbackWait >= AUTH_CALLBACK_GRACE_MS || remaining <= LOGIN_POLL_MS) {
          const finalSnapshot = await this.detectCurrentState(page)
          if (finalSnapshot.state === 'logged-in') return
          if (finalSnapshot.state === 'auth-callback') {
            throw this.stateError({
              ...finalSnapshot,
              loginStage: 'auth-callback-timeout',
              errorMessage: 'Rewards 登录回调在宽限时间内未完成跳转'
            })
          }
          snapshot = finalSnapshot
        } else {
          previousState = snapshot.state
          await page.waitForTimeout(Math.min(LOGIN_POLL_MS, remaining))
          continue
        }
      }
      if (snapshot.state === 'error-alert' || snapshot.state === 'account-locked') {
        throw this.stateError(snapshot)
      }
      if (snapshot.state === 'captcha') {
        throw this.stateError({
          ...snapshot,
          errorMessage: '登录需要人工完成 CAPTCHA'
        })
      }
      if (snapshot.state === 'otp-code-entry') {
        if (await this.clickPasswordSignIn(page)) {
          await page.waitForTimeout(LOGIN_POLL_MS)
          continue
        }
        throw this.stateError({
          ...snapshot,
          errorMessage: '登录需要人工输入验证码'
        })
      }
      if (snapshot.state === 'authenticator-approval') {
        throw this.stateError({
          ...snapshot,
          errorMessage: '登录需要人工批准 Microsoft Authenticator 请求'
        })
      }

      if (previousState !== snapshot.state) unchangedSince = Date.now()
      previousState = snapshot.state
      if (Date.now() - unchangedSince >= 30_000) {
        const onLoginHost =
          snapshot.host === 'login.live.com' ||
          snapshot.host === 'login.microsoft.com' ||
          snapshot.host === 'login.microsoftonline.com'
        if (snapshot.state === 'unknown' && onLoginHost && !unknownRecoveryAttempted) {
          unknownRecoveryAttempted = true
          await page.goto(REWARDS_URLS.login, {
            waitUntil: 'domcontentloaded',
            timeout: 30_000
          })
          previousState = undefined
          unchangedSince = Date.now()
          continue
        }
        throw this.stateError({
          ...snapshot,
          loginStage: 'login-timeout',
          errorMessage: `登录状态停滞: ${snapshot.state}`
        })
      }

      await this.handleState(page, snapshot.state, credentials)
      await page.waitForTimeout(LOGIN_POLL_MS)
    }

    const currentSnapshot = await this.detectCurrentState(page)
    if (currentSnapshot.state === 'logged-in') return
    if (currentSnapshot.state === 'auth-callback') {
      throw this.stateError({
        ...currentSnapshot,
        loginStage: 'auth-callback-timeout',
        errorMessage: 'Rewards 登录回调在整体登录超时前未完成跳转'
      })
    }
    if (
      currentSnapshot.state === 'error-alert' ||
      currentSnapshot.state === 'account-locked' ||
      currentSnapshot.state === 'passkey-error'
    ) {
      throw this.stateError(currentSnapshot)
    }
    if (currentSnapshot.state === 'captcha') {
      throw this.stateError({ ...currentSnapshot, errorMessage: '登录需要人工完成 CAPTCHA' })
    }
    if (currentSnapshot.state === 'otp-code-entry') {
      throw this.stateError({ ...currentSnapshot, errorMessage: '登录需要人工输入验证码' })
    }
    if (currentSnapshot.state === 'authenticator-approval') {
      throw this.stateError({
        ...currentSnapshot,
        errorMessage: '登录需要人工批准 Microsoft Authenticator 请求'
      })
    }
    const current = location(page)
    throw new LoginStateError({
      loginState: previousState ?? 'unknown',
      loginStage: 'login-timeout',
      message: '登录流程超过 120 秒',
      ...current
    })
  }

  private stateError(snapshot: LoginStateSnapshot): LoginStateError {
    return new LoginStateError({
      loginState: snapshot.state,
      loginStage: snapshot.loginStage,
      message: snapshot.errorMessage ?? `Rewards 登录失败: ${snapshot.state}`,
      url: snapshot.url,
      host: snapshot.host,
      path: snapshot.path
    })
  }

  private async handleState(
    page: Page,
    state: LoginState,
    credentials: AccountCredentials
  ): Promise<void> {
    if (state === 'email-input') {
      const email = await firstVisible(page.locator(SELECTORS.email))
      if (!email) return
      try {
        await email.fill(credentials.email)
      } catch {
        return
      }
      try {
        await this.clickPrimary(page)
      } catch {
        const current = await this.detectCurrentState(page)
        if (current.state !== state) return
        if (await this.submitWithEnter(page, email, state)) return
        throw this.interactionError(page, state, 'login-email-submit')
      }
      return
    }
    if (state === 'password-input') {
      const password = await firstVisible(page.locator(SELECTORS.password))
      if (!password) return
      try {
        await password.fill(credentials.password)
      } catch {
        return
      }
      try {
        await this.clickPrimary(page)
      } catch {
        const current = await this.detectCurrentState(page)
        if (current.state !== state) return
        if (await this.submitWithEnter(page, password, state)) return
        throw this.interactionError(page, state, 'login-password-submit')
      }
      return
    }
    if (state === 'password-choice') {
      if (await this.clickPasswordSignIn(page)) return
      throw this.interactionError(page, state, 'login-password-choice')
    }
    if (state === 'kmsi-prompt') {
      await this.clickPrimary(page)
      return
    }
    if (state === 'account-picker') {
      const accountTile = await firstVisible(
        page.locator(SELECTORS.accountTile).filter({ hasText: credentials.email })
      )
      if (accountTile) {
        await accountTile.click({ timeout: 5000 })
        return
      }
      const otherAccount = await firstVisible(page.locator(SELECTORS.otherAccount))
      if (otherAccount) {
        await otherAccount.click({ timeout: 5000 })
        return
      }
      const otherAccountText = await firstVisible(
        page.getByText(/use another account|使用其他账号|使用另一个账号/i)
      )
      if (otherAccountText) {
        await otherAccountText.click({ timeout: 5000 })
        return
      }
      throw this.interactionError(page, state, 'login-account-picker')
    }
    if (state === 'email-verification-input' || state === 'passkey-error') {
      if (await this.clickPasswordSignIn(page)) return
      if (await this.clickOtherSignInWay(page)) return
      if (state === 'passkey-error') {
        const secondary = await firstVisible(page.locator(SELECTORS.secondary))
        if (secondary) {
          await secondary.click({ timeout: 5000 })
          return
        }
      }
      const previousUrl = page.url()
      await page.goBack({ waitUntil: 'domcontentloaded', timeout: 10_000 }).catch(() => undefined)
      if (page.url() !== previousUrl) return
      throw this.stateError({
        ...location(page),
        state,
        loginStage: state === 'passkey-error' ? 'login-passkey-error' : 'login-email-verification',
        errorMessage:
          state === 'passkey-error'
            ? '无法从通行密钥页面切换到密码登录'
            : '无法从邮箱验证页面切换到密码登录'
      })
    }
    if (state === 'sign-in-method-picker') {
      const passwordTile = await firstVisible(
        page.locator(SELECTORS.methodTile).filter({ hasText: /password|密码|使用密码/i })
      )
      if (passwordTile) {
        await passwordTile.click({ timeout: 5000 })
        return
      }
      if (await this.clickOtherSignInWay(page)) return
      throw this.stateError({
        ...location(page),
        state,
        loginStage: 'login-method-picker',
        errorMessage: '未找到密码登录方式'
      })
    }
    if (state === 'unknown') {
      if (await this.clickPasswordSignIn(page)) return
      if (await this.clickOtherSignInWay(page)) return
      await page.waitForTimeout(1000)
      return
    }
    if (state === 'auth-callback') {
      // OAuth navigation is in flight. Never refill credentials or resubmit the form.
      return
    }
    throw this.stateError({ ...location(page), state, loginStage: `login-${state}` })
  }

  private async clickPrimary(page: Page): Promise<void> {
    const primary = await firstEnabledVisible(page.locator(SELECTORS.primary))
    if (!primary) throw new Error('登录主操作按钮不可用')
    await primary.click({ timeout: 10_000 })
  }

  private async submitWithEnter(
    page: Page,
    input: Locator,
    previousState: LoginState
  ): Promise<boolean> {
    try {
      await input.press('Enter', { timeout: 5_000 })
      await page.waitForTimeout(700)
      return (await this.detectCurrentState(page)).state !== previousState
    } catch {
      return false
    }
  }

  private interactionError(page: Page, state: LoginState, loginStage: string): LoginStateError {
    return new LoginStateError({
      loginState: state,
      loginStage,
      message: `登录页面交互失败: ${loginStage}`,
      ...location(page)
    })
  }

  private async clickOtherSignInWay(page: Page): Promise<boolean> {
    const candidates = [
      page.locator(SELECTORS.footer).filter({ hasText: OTHER_SIGN_IN_PATTERN }),
      page.getByRole('button', { name: OTHER_SIGN_IN_PATTERN }),
      page.getByText(OTHER_SIGN_IN_PATTERN)
    ]
    for (const candidate of candidates) {
      const target = await firstVisible(candidate)
      if (target) {
        await target.click({ timeout: 5000 })
        return true
      }
    }
    return false
  }

  private async clickPasswordSignIn(page: Page): Promise<boolean> {
    const target = await this.passwordSignInButton(page)
    if (!target) return false
    await target.click({ timeout: 5000 })
    return true
  }

  private async passwordSignInButton(page: Page): Promise<Locator | undefined> {
    const candidates = [
      page.getByRole('button', { name: PASSWORD_SIGN_IN_PATTERN }),
      page.getByText(PASSWORD_SIGN_IN_PATTERN)
    ]
    for (const candidate of candidates) {
      const target = await firstVisible(candidate)
      if (target) return target
    }
    return undefined
  }
}
