import type { AccountCredentials } from '../infra/AccountSecretStore.js'
import type { AppOAuthClient, AppToken } from './AppOAuthClient.js'

export interface AppDashboardAuthorization {
  readonly accessToken: string | undefined
  refresh(signal: AbortSignal): Promise<string | undefined>
  confirm(signal: AbortSignal): Promise<void>
}

export class AppAuthorizationSession implements AppDashboardAuthorization {
  private currentToken: AppToken | undefined
  private acquired = false
  private confirmedToken: AppToken | undefined

  constructor(
    private readonly oauth: Pick<AppOAuthClient, 'readStored' | 'acquire' | 'commitVerified'>,
    private readonly accountId: string,
    private readonly credentials: AccountCredentials,
    private readonly guardDate?: () => void
  ) {}

  get accessToken(): string | undefined {
    return this.currentToken?.accessToken
  }

  async initialize(signal: AbortSignal): Promise<AppToken> {
    this.assertReady(signal)
    if (this.currentToken) return this.currentToken
    const stored = await this.oauth.readStored(this.accountId)
    this.assertReady(signal)
    if (stored) {
      this.currentToken = stored
      return stored
    }
    this.acquired = true
    const token = await this.oauth.acquire(this.accountId, this.credentials, signal)
    this.assertReady(signal)
    this.currentToken = token
    return token
  }

  async refresh(signal: AbortSignal): Promise<string | undefined> {
    this.assertReady(signal)
    if (this.acquired) return undefined
    // Consumed before awaiting: a rejected or cancelled refresh must not be replayed.
    this.acquired = true
    const token = await this.oauth.acquire(this.accountId, this.credentials, signal)
    this.assertReady(signal)
    this.currentToken = token
    return token.accessToken
  }

  async confirm(signal: AbortSignal): Promise<void> {
    this.assertReady(signal)
    const token = this.currentToken
    if (!token || token === this.confirmedToken) return
    await this.oauth.commitVerified(this.accountId, token)
    this.assertReady(signal)
    this.confirmedToken = token
  }

  private assertReady(signal: AbortSignal): void {
    signal.throwIfAborted()
    this.guardDate?.()
  }
}
