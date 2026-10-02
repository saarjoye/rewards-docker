export type LoginState =
  | 'email-input'
  | 'email-verification-input'
  | 'account-picker'
  | 'sign-in-method-picker'
  | 'password-input'
  | 'password-choice'
  | 'kmsi-prompt'
  | 'otp-code-entry'
  | 'authenticator-approval'
  | 'passkey-error'
  | 'captcha'
  | 'account-locked'
  | 'error-alert'
  | 'auth-callback'
  | 'logged-in'
  | 'unknown'

export type AuthenticationNavigationFailure =
  | 'timeout'
  | 'dns'
  | 'tls'
  | 'connection'
  | 'redirect'
  | 'network'
  | 'browser'
  | 'unknown'

export class LoginStateError extends Error {
  readonly loginState: LoginState
  readonly loginStage: string
  readonly url: string
  readonly host: string
  readonly path: string
  readonly navigationFailure?: AuthenticationNavigationFailure
  readonly navigationCommitted?: boolean

  constructor(input: {
    loginState: LoginState
    loginStage: string
    message: string
    url: string
    host: string
    path: string
    navigationFailure?: AuthenticationNavigationFailure
    navigationCommitted?: boolean
  }) {
    super(input.message)
    this.name = 'LoginStateError'
    this.loginState = input.loginState
    this.loginStage = input.loginStage
    this.url = input.url
    this.host = input.host
    this.path = input.path
    if (input.navigationFailure !== undefined) this.navigationFailure = input.navigationFailure
    if (input.navigationCommitted !== undefined)
      this.navigationCommitted = input.navigationCommitted
  }
}

export function requiresUserAction(state: LoginState): boolean {
  return (
    state === 'otp-code-entry' ||
    state === 'authenticator-approval' ||
    state === 'passkey-error' ||
    state === 'captcha'
  )
}
