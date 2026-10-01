import { describe, expect, it, vi } from 'vitest'
import type { Locator, Page } from 'patchright'

import { LoginStateError, type LoginState } from '../src/auth/LoginState.js'
import { LoginController } from '../src/browser/LoginController.js'
import type { StructuredLogger } from '../src/infra/StructuredLogger.js'

function locator(
  visible: boolean,
  text = '',
  fallback = '',
  click = vi.fn().mockResolvedValue(undefined),
  enabled = true
): Locator {
  const item = {
    first: () => item,
    nth: () => item,
    count: vi.fn().mockResolvedValue(1),
    isVisible: vi.fn().mockResolvedValue(visible),
    isEnabled: vi.fn().mockResolvedValue(enabled),
    innerText:
      text === '[throw]'
        ? vi.fn().mockRejectedValue(new Error('detached'))
        : vi.fn().mockResolvedValue(text),
    textContent: vi.fn().mockResolvedValue(fallback),
    getAttribute: vi.fn().mockResolvedValue(''),
    click,
    press: vi.fn().mockResolvedValue(undefined),
    fill: vi.fn().mockResolvedValue(undefined),
    filter: () => item
  }
  return item as unknown as Locator
}

function locatorCollection(items: readonly Locator[]): Locator {
  return {
    first: () => items[0],
    nth: (index: number) => items[index],
    count: vi.fn().mockResolvedValue(items.length)
  } as unknown as Locator
}

function page(input: {
  url: string
  alert?: Locator
  identity?: Locator
  email?: Locator
  proofPrompt?: Locator
  passwordChoice?: Locator
  accountTile?: Locator
  otherAccount?: Locator
  authenticator?: Locator
  accountLocked?: Locator
  captcha?: Locator
  passkey?: Locator
  otp?: Locator
}): Page {
  return {
    waitForLoadState: vi.fn().mockResolvedValue(undefined),
    url: vi.fn().mockReturnValue(input.url),
    locator: vi.fn((selector: string) => {
      if (selector.includes('role="alert"')) return input.alert ?? locator(false)
      if (selector.includes('identityBanner')) return input.identity ?? locator(false)
      if (selector.includes('usernameEntry')) return input.email ?? locator(false)
      if (selector.includes('accountTile')) return input.accountTile ?? locator(false)
      if (selector.includes('otherTile')) return input.otherAccount ?? locator(false)
      if (selector.includes('deviceShieldCheckmarkVideo')) {
        return input.authenticator ?? locator(false)
      }
      if (selector.includes('captcha')) return input.captcha ?? locator(false)
      if (selector.includes('biometricVideo')) return input.passkey ?? locator(false)
      if (selector.includes('codeEntry')) return input.otp ?? locator(false)
      if (selector.includes('serviceAbuseLandingTitle')) {
        return input.accountLocked ?? locator(false)
      }
      return locator(false)
    }),
    getByRole: vi.fn().mockReturnValue(input.passwordChoice ?? locator(false)),
    getByText: vi.fn((pattern: RegExp) =>
      pattern.source.includes('associated with your account')
        ? (input.proofPrompt ?? locator(false))
        : (input.passwordChoice ?? locator(false))
    )
  } as unknown as Page
}

function controller(): LoginController {
  return new LoginController({ write: vi.fn() } as unknown as StructuredLogger)
}

function snapshot(state: LoginState, stage = `login-${state}`) {
  return {
    state,
    loginStage: stage,
    url: 'https://login.live.com/login.srf',
    host: 'login.live.com',
    path: '/login.srf'
  }
}

function statePage(input: {
  accountTile?: Locator
  primary?: Locator
  secondary?: Locator
  passwordChoice?: Locator
}): Page {
  return {
    url: vi.fn().mockReturnValue('https://login.live.com/login.srf'),
    locator: vi.fn((selector: string) => {
      if (selector.includes('accountTile')) return input.accountTile ?? locator(false)
      if (selector.includes('primaryButton')) return input.primary ?? locator(false)
      if (selector.includes('secondaryButton')) return input.secondary ?? locator(false)
      return locator(false)
    }),
    getByRole: vi.fn().mockReturnValue(input.passwordChoice ?? locator(false)),
    getByText: vi.fn().mockReturnValue(locator(false)),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    goBack: vi.fn().mockResolvedValue(null)
  } as unknown as Page
}

describe('login state detection', () => {
  it('captures the ERROR_ALERT text at detection time', async () => {
    const state = await controller().detectCurrentState(
      page({
        url: 'https://login.live.com/login.srf',
        alert: locator(true, 'Password is incorrect')
      })
    )
    expect(state).toMatchObject({
      state: 'error-alert',
      loginStage: 'login-error-alert',
      errorMessage: 'Password is incorrect',
      host: 'login.live.com',
      path: '/login.srf'
    })
  })

  it('uses captured fallbacks instead of unknown error when innerText detaches', async () => {
    const state = await controller().detectCurrentState(
      page({
        url: 'https://login.live.com/login.srf',
        alert: locator(true, '[throw]', 'Account temporarily unavailable')
      })
    )
    expect(state.errorMessage).toBe('Account temporarily unavailable')
  })

  it('classifies a FIDO URL and rejects about as a logged-in page', async () => {
    expect(
      await controller().detectCurrentState(
        page({ url: 'https://login.microsoft.com/consumers/fido/get' })
      )
    ).toMatchObject({ state: 'passkey-error', loginStage: 'login-passkey-error' })
    expect(
      (await controller().detectCurrentState(page({ url: 'https://rewards.bing.com/about' }))).state
    ).toBe('unknown')
  })

  it('classifies the Rewards auth callback as a login transition', async () => {
    await expect(
      controller().detectCurrentState(page({ url: 'https://rewards.bing.com/auth/callback/' }))
    ).resolves.toMatchObject({
      state: 'auth-callback',
      loginStage: 'login-auth-callback',
      host: 'rewards.bing.com',
      path: '/auth/callback/'
    })
  })

  it('keeps an explicit callback error in the error state', async () => {
    await expect(
      controller().detectCurrentState(
        page({
          url: 'https://rewards.bing.com/auth/callback',
          alert: locator(true, 'Sign in failed')
        })
      )
    ).resolves.toMatchObject({ state: 'error-alert', loginStage: 'login-error-alert' })
  })

  it('waits through a callback transition without resubmitting credentials', async () => {
    const loginController = controller()
    vi.spyOn(loginController, 'detectCurrentState')
      .mockResolvedValueOnce(snapshot('auth-callback', 'login-auth-callback'))
      .mockResolvedValueOnce(snapshot('logged-in', 'login-candidate'))
    const fill = vi.fn().mockResolvedValue(undefined)
    const click = vi.fn().mockResolvedValue(undefined)
    let now = 0
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now)
    const candidatePage = {
      url: vi.fn().mockReturnValue('https://rewards.bing.com/auth/callback'),
      waitForTimeout: vi.fn((milliseconds: number) => {
        now += milliseconds === 700 ? 30_000 : milliseconds
        return Promise.resolve()
      }),
      locator: vi.fn().mockReturnValue(locator(false, '', '', click)),
      getByRole: vi.fn().mockReturnValue(locator(false, '', '', click)),
      getByText: vi.fn().mockReturnValue(locator(false, '', '', click))
    } as unknown as Page

    try {
      await expect(
        loginController.login(
          candidatePage,
          { email: 'synthetic@example.test', password: 'password-canary' },
          new AbortController().signal
        )
      ).resolves.toBeUndefined()
    } finally {
      nowSpy.mockRestore()
    }
    expect(fill).not.toHaveBeenCalled()
    expect(click).not.toHaveBeenCalled()
  })

  it('returns auth-callback-timeout after the callback grace period', async () => {
    const loginController = controller()
    vi.spyOn(loginController, 'detectCurrentState').mockResolvedValue(
      snapshot('auth-callback', 'login-auth-callback')
    )
    let now = 0
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now)
    const callbackPage = {
      url: vi.fn().mockReturnValue('https://rewards.bing.com/auth/callback'),
      waitForTimeout: vi.fn((milliseconds: number) => {
        now += milliseconds
        return Promise.resolve()
      })
    } as unknown as Page

    try {
      await expect(
        loginController.login(
          callbackPage,
          { email: 'synthetic@example.test', password: 'password-canary' },
          new AbortController().signal
        )
      ).rejects.toMatchObject({ loginState: 'auth-callback', loginStage: 'auth-callback-timeout' })
    } finally {
      nowSpy.mockRestore()
    }
  })

  it('detects the visible login control when a hidden duplicate appears first', async () => {
    const emailControls = locatorCollection([locator(false), locator(true)])
    const candidatePage = {
      waitForLoadState: vi.fn().mockResolvedValue(undefined),
      url: vi.fn().mockReturnValue('https://login.live.com/login.srf'),
      locator: vi.fn((selector: string) =>
        selector.includes('usernameEntry') ? emailControls : locator(false)
      ),
      getByRole: vi.fn().mockReturnValue(locator(false)),
      getByText: vi.fn().mockReturnValue(locator(false))
    } as unknown as Page
    await expect(controller().detectCurrentState(candidatePage)).resolves.toMatchObject({
      state: 'email-input',
      loginStage: 'login-email'
    })
  })

  it('skips a visible disabled submit control and clicks the enabled one', async () => {
    const loginController = controller()
    vi.spyOn(loginController, 'detectCurrentState')
      .mockResolvedValueOnce(snapshot('email-input', 'login-email'))
      .mockResolvedValueOnce(snapshot('logged-in', 'login-candidate'))
    const email = locator(true)
    const disabled = locator(true, '', '', vi.fn().mockResolvedValue(undefined), false)
    const enabledClick = vi.fn().mockResolvedValue(undefined)
    const enabled = locator(true, '', '', enabledClick)
    const candidatePage = {
      url: vi.fn().mockReturnValue('https://login.live.com/login.srf'),
      locator: vi.fn((selector: string) => {
        if (selector.includes('usernameEntry')) return email
        if (selector.includes('primaryButton')) return locatorCollection([disabled, enabled])
        return locator(false)
      }),
      waitForTimeout: vi.fn().mockResolvedValue(undefined)
    } as unknown as Page

    await expect(
      loginController.login(
        candidatePage,
        { email: 'synthetic@example.test', password: 'password-canary' },
        new AbortController().signal
      )
    ).resolves.toBeUndefined()
    expect(enabledClick).toHaveBeenCalledTimes(1)
  })

  it('does not treat an identity banner on a login host as logged in', async () => {
    await expect(
      controller().detectCurrentState(
        page({
          url: 'https://login.live.com/login.srf',
          identity: locator(true)
        })
      )
    ).resolves.toMatchObject({ state: 'unknown', loginStage: 'login-unknown' })
  })

  it('detects the explicit password choice before treating the page as unknown', async () => {
    await expect(
      controller().detectCurrentState(
        page({
          url: 'https://login.live.com/login.srf',
          identity: locator(true),
          passwordChoice: locator(true)
        })
      )
    ).resolves.toMatchObject({
      state: 'password-choice',
      loginStage: 'login-password-choice'
    })
  })

  it('does not fill a reused username input on an alternate-email proof page', async () => {
    await expect(
      controller().detectCurrentState(
        page({
          url: 'https://login.live.com/login.srf',
          email: locator(true),
          proofPrompt: locator(true, 'Enter the email address associated with your account')
        })
      )
    ).resolves.toMatchObject({
      state: 'email-verification-input',
      loginStage: 'login-email-verification'
    })
  })

  it('distinguishes account picker, authenticator approval and locked accounts', async () => {
    await expect(
      controller().detectCurrentState(
        page({ url: 'https://login.live.com/login.srf', accountTile: locator(true) })
      )
    ).resolves.toMatchObject({ state: 'account-picker', loginStage: 'login-account-picker' })
    await expect(
      controller().detectCurrentState(
        page({ url: 'https://login.live.com/login.srf', authenticator: locator(true) })
      )
    ).resolves.toMatchObject({
      state: 'authenticator-approval',
      loginStage: 'login-authenticator-approval'
    })
    await expect(
      controller().detectCurrentState(
        page({ url: 'https://login.live.com/login.srf', accountLocked: locator(true) })
      )
    ).resolves.toMatchObject({
      state: 'account-locked',
      loginStage: 'login-account-locked'
    })
  })

  it('uses the password fallback on an OTP page before requesting manual action', async () => {
    const loginController = controller()
    vi.spyOn(loginController, 'detectCurrentState')
      .mockResolvedValueOnce({
        state: 'otp-code-entry',
        loginStage: 'login-otp',
        url: 'https://login.live.com/login.srf',
        host: 'login.live.com',
        path: '/login.srf'
      })
      .mockResolvedValueOnce({
        state: 'logged-in',
        loginStage: 'login-candidate',
        url: 'https://rewards.bing.com/dashboard',
        host: 'rewards.bing.com',
        path: '/dashboard'
      })
    const passwordButton = locator(true)
    const getByRole = vi.fn().mockReturnValue(passwordButton)
    const otpPage = {
      url: vi.fn().mockReturnValue('https://login.live.com/login.srf'),
      getByRole,
      getByText: vi.fn().mockReturnValue(locator(false)),
      waitForTimeout: vi.fn().mockResolvedValue(undefined)
    } as unknown as Page

    await expect(
      loginController.login(
        otpPage,
        { email: 'synthetic@example.test', password: 'password-canary' },
        new AbortController().signal
      )
    ).resolves.toBeUndefined()
    const roleCalls = getByRole.mock.calls as unknown as Array<[string, { name: RegExp }]>
    expect(roleCalls[0]?.[0]).toBe('button')
    const passwordPattern = roleCalls[0]?.[1].name
    expect(passwordPattern?.test('Use your password')).toBe(true)
    expect(passwordPattern?.test('使用你的密码登录')).toBe(true)
  })

  it('opens the method picker from the observed Chinese alternate-method label', async () => {
    const loginController = controller()
    vi.spyOn(loginController, 'detectCurrentState')
      .mockResolvedValueOnce(snapshot('email-verification-input', 'login-email-verification'))
      .mockResolvedValueOnce(snapshot('logged-in', 'login-candidate'))
    const otherMethodClick = vi.fn().mockResolvedValue(undefined)
    const candidatePage = {
      url: vi.fn().mockReturnValue('https://login.live.com/oauth20_authorize.srf'),
      locator: vi.fn().mockReturnValue(locator(false)),
      getByRole: vi.fn((_role: string, options: { name: RegExp }) =>
        locator(options.name.test('其他登录方法'), '', '', otherMethodClick)
      ),
      getByText: vi.fn().mockReturnValue(locator(false)),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
      goBack: vi.fn().mockResolvedValue(null)
    } as unknown as Page

    await expect(
      loginController.login(
        candidatePage,
        { email: 'synthetic@example.test', password: 'password-canary' },
        new AbortController().signal
      )
    ).resolves.toBeUndefined()
    expect(otherMethodClick).toHaveBeenCalledTimes(1)
  })

  it('selects only the configured account on an account picker', async () => {
    const loginController = controller()
    vi.spyOn(loginController, 'detectCurrentState')
      .mockResolvedValueOnce(snapshot('account-picker', 'login-account-picker'))
      .mockResolvedValueOnce(snapshot('logged-in', 'login-candidate'))
    const accountTileClick = vi.fn().mockResolvedValue(undefined)
    const accountTile = locator(true, '', '', accountTileClick)

    await expect(
      loginController.login(
        statePage({ accountTile }),
        { email: 'synthetic@example.test', password: 'password-canary' },
        new AbortController().signal
      )
    ).resolves.toBeUndefined()
    expect(accountTileClick).toHaveBeenCalledTimes(1)
  })

  it('accepts KMSI and handles a passkey fallback as separate branches', async () => {
    const loginController = controller()
    vi.spyOn(loginController, 'detectCurrentState')
      .mockResolvedValueOnce(snapshot('kmsi-prompt', 'login-kmsi'))
      .mockResolvedValueOnce(snapshot('passkey-error', 'login-passkey-error'))
      .mockResolvedValueOnce(snapshot('logged-in', 'login-candidate'))
    const primaryClick = vi.fn().mockResolvedValue(undefined)
    const secondaryClick = vi.fn().mockResolvedValue(undefined)
    const primary = locator(true, '', '', primaryClick)
    const secondary = locator(true, '', '', secondaryClick)

    await expect(
      loginController.login(
        statePage({ primary, secondary }),
        { email: 'synthetic@example.test', password: 'password-canary' },
        new AbortController().signal
      )
    ).resolves.toBeUndefined()
    expect(primaryClick).toHaveBeenCalledTimes(1)
    expect(secondaryClick).toHaveBeenCalledTimes(1)
  })

  it('requires explicit user action for Authenticator approval', async () => {
    const loginController = controller()
    vi.spyOn(loginController, 'detectCurrentState').mockResolvedValueOnce(
      snapshot('authenticator-approval', 'login-authenticator-approval')
    )

    await expect(
      loginController.login(
        statePage({}),
        { email: 'synthetic@example.test', password: 'password-canary' },
        new AbortController().signal
      )
    ).rejects.toMatchObject({
      name: 'LoginStateError',
      loginState: 'authenticator-approval',
      loginStage: 'login-authenticator-approval'
    } satisfies Partial<LoginStateError>)
  })

  it('fails immediately when Microsoft reports an account restriction', async () => {
    const loginController = controller()
    vi.spyOn(loginController, 'detectCurrentState').mockResolvedValueOnce({
      ...snapshot('account-locked', 'login-account-locked'),
      errorMessage: 'Microsoft 账号已被限制，无法继续登录'
    })

    await expect(
      loginController.login(
        statePage({}),
        { email: 'synthetic@example.test', password: 'password-canary' },
        new AbortController().signal
      )
    ).rejects.toMatchObject({
      name: 'LoginStateError',
      loginState: 'account-locked',
      loginStage: 'login-account-locked'
    } satisfies Partial<LoginStateError>)
  })

  it('does not click a generic secondary button on an unknown transition page', async () => {
    const loginController = controller()
    vi.spyOn(loginController, 'detectCurrentState')
      .mockResolvedValueOnce(snapshot('unknown', 'login-unknown'))
      .mockResolvedValueOnce(snapshot('logged-in', 'login-candidate'))
    const secondaryClick = vi.fn().mockResolvedValue(undefined)
    const secondary = locator(true, '', '', secondaryClick)

    await expect(
      loginController.login(
        statePage({ secondary }),
        { email: 'synthetic@example.test', password: 'password-canary' },
        new AbortController().signal
      )
    ).resolves.toBeUndefined()
    expect(secondaryClick).not.toHaveBeenCalled()
  })
})

describe('authentication navigation and pending submission regression', () => {
  it('recognizes a usable form without waiting for DOMContentLoaded', async () => {
    const candidate = page({ url: 'https://login.live.com/login.srf', email: locator(true) })
    const loadState = vi
      .spyOn(candidate, 'waitForLoadState')
      .mockRejectedValue(new Error('synthetic load timeout'))
    await expect(controller().detectCurrentState(candidate)).resolves.toMatchObject({
      state: 'email-input'
    })
    expect(loadState).not.toHaveBeenCalled()
  })

  it('enters the login state machine after commit when DOMContentLoaded would time out', async () => {
    const login = controller()
    vi.spyOn(login, 'detectCurrentState').mockResolvedValue(snapshot('logged-in'))
    let current = 'about:blank'
    const goto = vi.fn((_url: string, options: { waitUntil: string }) => {
      if (options.waitUntil === 'domcontentloaded')
        return Promise.reject(new Error('synthetic navigation timeout'))
      current = 'https://rewards.bing.com/dashboard'
      return Promise.resolve(null)
    })
    const candidate = { url: () => current, goto } as unknown as Page
    await expect(
      login.login(
        candidate,
        { email: 'synthetic@example.test', password: 'password-canary' },
        new AbortController().signal
      )
    ).resolves.toBeUndefined()
    expect(goto).toHaveBeenCalledTimes(1)
    expect(goto).toHaveBeenCalledWith(
      'https://rewards.bing.com/auth/login',
      expect.objectContaining({ waitUntil: 'commit' })
    )
  })

  it('does not navigate an already cancelled blank page', async () => {
    const abort = new AbortController()
    const reason = new Error('synthetic-cancellation')
    abort.abort(reason)
    const goto = vi.fn().mockResolvedValue(null)
    await expect(
      controller().login(
        { url: () => 'about:blank', goto } as unknown as Page,
        { email: 'synthetic@example.test', password: 'password-canary' },
        abort.signal
      )
    ).rejects.toBe(reason)
    expect(goto).not.toHaveBeenCalled()
  })

  it('waits for an already submitted username instead of submitting it again', async () => {
    const login = controller()
    vi.spyOn(login, 'detectCurrentState')
      .mockResolvedValueOnce(snapshot('email-input'))
      .mockResolvedValueOnce(snapshot('email-input'))
      .mockResolvedValueOnce(snapshot('logged-in'))
    const email = locator(true)
    const methods = { fill: vi.spyOn(email, 'fill'), press: vi.spyOn(email, 'press') }
    const click = vi.fn().mockResolvedValue(undefined)
    const candidate = {
      url: () => 'https://login.live.com/login.srf',
      locator: (selector: string) =>
        selector.includes('usernameEntry') ? email : locator(true, '', '', click),
      waitForTimeout: vi.fn().mockResolvedValue(undefined)
    } as unknown as Page
    await expect(
      login.login(
        candidate,
        { email: 'synthetic@example.test', password: 'password-canary' },
        new AbortController().signal
      )
    ).resolves.toBeUndefined()
    expect(methods.fill).toHaveBeenCalledTimes(1)
    expect(click).toHaveBeenCalledTimes(1)
  })

  it('does not restart the sign-in URL after credentials have been submitted', async () => {
    const login = controller()
    vi.spyOn(login, 'detectCurrentState')
      .mockResolvedValueOnce(snapshot('email-input'))
      .mockResolvedValue(snapshot('unknown'))
    let now = 0
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
    const goto = vi.fn().mockResolvedValue(null)
    const candidate = {
      url: () => 'https://login.live.com/login.srf',
      goto,
      locator: () => locator(true),
      getByRole: () => locator(false),
      getByText: () => locator(false),
      waitForTimeout: vi.fn((duration: number) => {
        now += duration === 700 ? 15_000 : duration
        return Promise.resolve()
      })
    } as unknown as Page
    try {
      await expect(
        login.login(
          candidate,
          { email: 'synthetic@example.test', password: 'password-canary' },
          new AbortController().signal
        )
      ).rejects.toMatchObject({ loginStage: 'login-timeout' })
      expect(goto).not.toHaveBeenCalled()
    } finally {
      clock.mockRestore()
    }
  })
})

function credentialPage(
  input: Locator,
  primary: Locator,
  url = 'https://login.live.com/login.srf'
): Page {
  return {
    url: () => url,
    locator: (selector: string) => (selector.includes('primaryButton') ? primary : input),
    waitForTimeout: vi.fn().mockResolvedValue(undefined)
  } as unknown as Page
}

describe('credential submission safety after navigation recovery', () => {
  it('does not repeat a pending password submission', async () => {
    const login = controller()
    vi.spyOn(login, 'detectCurrentState')
      .mockResolvedValueOnce(snapshot('password-input'))
      .mockResolvedValueOnce(snapshot('password-input'))
      .mockResolvedValueOnce(snapshot('logged-in'))
    const password = locator(true)
    const fill = vi.spyOn(password, 'fill')
    const click = vi.fn().mockResolvedValue(undefined)
    await login.login(
      credentialPage(password, locator(true, '', '', click)),
      { email: 'synthetic@example.test', password: 'password-canary' },
      new AbortController().signal
    )
    expect(fill).toHaveBeenCalledTimes(1)
    expect(click).toHaveBeenCalledTimes(1)
  })

  it('does not follow a possibly transmitted click with Enter', async () => {
    const login = controller()
    vi.spyOn(login, 'detectCurrentState').mockResolvedValue(snapshot('email-input'))
    const email = locator(true)
    const methods = { fill: vi.spyOn(email, 'fill'), press: vi.spyOn(email, 'press') }
    const click = vi.fn().mockRejectedValue(new Error('synthetic click timeout'))
    await expect(
      login.login(
        credentialPage(email, locator(true, '', '', click)),
        { email: 'synthetic@example.test', password: 'password-canary' },
        new AbortController().signal
      )
    ).rejects.toMatchObject({ loginStage: 'login-submit-unconfirmed' })
    expect(click).toHaveBeenCalledTimes(1)
    expect(methods.press).not.toHaveBeenCalled()
  })

  it('uses Enter once only when no enabled primary button is available', async () => {
    const login = controller()
    vi.spyOn(login, 'detectCurrentState')
      .mockResolvedValueOnce(snapshot('email-input'))
      .mockResolvedValueOnce(snapshot('email-input'))
      .mockResolvedValueOnce(snapshot('logged-in'))
    const email = locator(true)
    const methods = { fill: vi.spyOn(email, 'fill'), press: vi.spyOn(email, 'press') }
    const primary = locator(false)
    const primaryClick = vi.spyOn(primary, 'click')
    await login.login(
      credentialPage(email, primary),
      { email: 'synthetic@example.test', password: 'password-canary' },
      new AbortController().signal
    )
    expect(methods.press).toHaveBeenCalledExactlyOnceWith('Enter', { timeout: 5_000 })
    expect(primaryClick).not.toHaveBeenCalled()
  })

  it.each(['https://untrusted.example/login', 'http://login.live.com/login.srf'])(
    'does not fill credentials on an untrusted login location %s',
    async (url) => {
      const login = controller()
      vi.spyOn(login, 'detectCurrentState').mockResolvedValue(snapshot('email-input'))
      const email = locator(true)
      const methods = { fill: vi.spyOn(email, 'fill'), press: vi.spyOn(email, 'press') }
      const primary = locator(true)
      const primaryClick = vi.spyOn(primary, 'click')
      await expect(
        login.login(
          credentialPage(email, primary, url),
          { email: 'synthetic@example.test', password: 'password-canary' },
          new AbortController().signal
        )
      ).rejects.toMatchObject({ loginStage: 'login-origin-untrusted' })
      expect(methods.fill).not.toHaveBeenCalled()
      expect(primaryClick).not.toHaveBeenCalled()
    }
  )

  it('does not submit when cancellation occurs while filling the username', async () => {
    const login = controller()
    vi.spyOn(login, 'detectCurrentState').mockResolvedValue(snapshot('email-input'))
    const abort = new AbortController()
    const reason = new Error('synthetic fill cancellation')
    const email = locator(true)
    const methods = { fill: vi.spyOn(email, 'fill'), press: vi.spyOn(email, 'press') }
    methods.fill.mockImplementation(() => {
      abort.abort(reason)
      return Promise.resolve()
    })
    const primary = locator(true)
    const primaryClick = vi.spyOn(primary, 'click')
    await expect(
      login.login(
        credentialPage(email, primary),
        { email: 'synthetic@example.test', password: 'password-canary' },
        abort.signal
      )
    ).rejects.toBe(reason)
    expect(primaryClick).not.toHaveBeenCalled()
    expect(methods.press).not.toHaveBeenCalled()
  })

  it('allows one bounded recovery navigation before any authentication interaction', async () => {
    const login = controller()
    vi.spyOn(login, 'detectCurrentState')
      .mockResolvedValueOnce(snapshot('unknown'))
      .mockResolvedValueOnce(snapshot('unknown'))
      .mockResolvedValueOnce(snapshot('logged-in'))
    let now = 0
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
    const goto = vi.fn().mockResolvedValue(null)
    const candidate = {
      url: () => 'https://login.live.com/login.srf',
      goto,
      getByRole: () => locator(false),
      getByText: () => locator(false),
      locator: () => locator(false),
      waitForTimeout: vi.fn((duration: number) => {
        now += duration === 700 ? 31_000 : duration
        return Promise.resolve()
      })
    } as unknown as Page
    try {
      await login.login(
        candidate,
        { email: 'synthetic@example.test', password: 'password-canary' },
        new AbortController().signal
      )
      expect(goto).toHaveBeenCalledExactlyOnceWith('https://rewards.bing.com/auth/login', {
        waitUntil: 'commit',
        timeout: 30_000
      })
    } finally {
      clock.mockRestore()
    }
  })
})
