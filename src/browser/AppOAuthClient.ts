import { randomBytes } from 'node:crypto'

import type { BrowserContext, Page } from 'patchright'

import { EncryptedSessionStore, type StoredSession } from '../auth/EncryptedSessionStore.js'
import type { AccountCredentials } from '../infra/AccountSecretStore.js'
import type { StructuredLogger } from '../infra/StructuredLogger.js'
import { safePath } from '../security/Redactor.js'
import { LoginController } from './LoginController.js'
import { REWARDS_URLS } from './Urls.js'

const CLIENT_ID = '0000000040170455'
const SCOPE = 'service::prod.rewardsplatform.microsoft.com::MBI_SSL'

export interface AppToken {
  accessToken: string
  refreshToken?: string
  expiresAt: string
}

interface TokenResponse {
  access_token?: unknown
  refresh_token?: unknown
  expires_in?: unknown
  error?: unknown
}

export class AppOAuthClient {
  constructor(
    private readonly context: BrowserContext,
    private readonly page: Page,
    private readonly sessions: EncryptedSessionStore,
    private readonly logger: StructuredLogger,
    private readonly login: LoginController,
    private readonly runId: string,
    private readonly accountAlias: string
  ) {}

  async readStored(accountId: string): Promise<AppToken | undefined> {
    const session = await this.sessions.read<AppToken>(accountId, 'app-oauth')
    if (!session) return undefined
    return Date.parse(session.payload.expiresAt) > Date.now() + 60_000 ? session.payload : undefined
  }

  async acquire(
    accountId: string,
    credentials: AccountCredentials,
    signal: AbortSignal
  ): Promise<AppToken> {
    const stored = await this.sessions.read<AppToken>(accountId, 'app-oauth')
    if (stored?.payload.refreshToken) {
      const refreshed = await this.exchange(
        new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: CLIENT_ID,
          refresh_token: stored.payload.refreshToken,
          scope: SCOPE
        })
      ).catch(() => undefined)
      if (refreshed) return refreshed
    }

    const state = randomBytes(16).toString('hex')
    const authorize = new URL(REWARDS_URLS.oauthAuthorize)
    authorize.search = new URLSearchParams({
      response_type: 'code',
      client_id: CLIENT_ID,
      redirect_uri: REWARDS_URLS.oauthRedirect,
      scope: SCOPE,
      access_type: 'offline_access',
      state,
      login_hint: credentials.email
    }).toString()

    let code = await this.resolveCodeWithRequest(authorize)
    if (!code) code = await this.resolveCodeWithPage(authorize, credentials, signal)
    if (!code) throw new Error('app-oauth-code-missing')

    const token = await this.exchange(
      new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: CLIENT_ID,
        code,
        redirect_uri: REWARDS_URLS.oauthRedirect,
        scope: SCOPE
      })
    )
    await this.logger.write({
      level: 'info',
      event: 'app-oauth-acquired',
      runId: this.runId,
      accountAlias: this.accountAlias,
      path: safePath(REWARDS_URLS.oauthRedirect)
    })
    return token
  }

  async commitVerified(accountId: string, token: AppToken): Promise<void> {
    const session: StoredSession<AppToken> = {
      accountId,
      slot: 'app-oauth',
      validatedAt: new Date().toISOString(),
      payload: token
    }
    await this.sessions.commitVerified(session, true)
  }

  private async resolveCodeWithRequest(authorize: URL): Promise<string | undefined> {
    const response = await this.context.request
      .get(authorize.href, { timeout: 15_000, maxRedirects: 20 })
      .catch(() => undefined)
    if (!response) return undefined
    try {
      return this.extractCode(response.url())
    } finally {
      await response.dispose()
    }
  }

  private async resolveCodeWithPage(
    authorize: URL,
    credentials: AccountCredentials,
    signal: AbortSignal
  ): Promise<string | undefined> {
    const oauthPage = await this.context.newPage()
    try {
      await oauthPage.goto(authorize.href, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      let code = this.extractCode(oauthPage.url())
      if (code) return code
      await this.login.login(oauthPage, credentials, signal)
      code = this.extractCode(oauthPage.url())
      if (code) return code
      await oauthPage
        .waitForURL((url) => url.pathname.toLowerCase() === '/oauth20_desktop.srf', {
          timeout: 20_000
        })
        .catch(() => undefined)
      return this.extractCode(oauthPage.url())
    } finally {
      await oauthPage.close().catch(() => undefined)
    }
  }

  private extractCode(rawUrl: string): string | undefined {
    try {
      const url = new URL(rawUrl)
      if (url.pathname.toLowerCase() !== '/oauth20_desktop.srf') return undefined
      return url.searchParams.get('code') ?? undefined
    } catch {
      return undefined
    }
  }

  private async exchange(body: URLSearchParams): Promise<AppToken> {
    const response = await this.context.request.post(REWARDS_URLS.oauthToken, {
      timeout: 15_000,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      data: body.toString()
    })
    try {
      const payload = (await response.json()) as TokenResponse
      if (!response.ok() || typeof payload.access_token !== 'string') {
        throw new Error(`app-oauth-token-failed:${String(response.status())}`)
      }
      const expiresIn = Number(payload.expires_in)
      return {
        accessToken: payload.access_token,
        ...(typeof payload.refresh_token === 'string'
          ? { refreshToken: payload.refresh_token }
          : {}),
        expiresAt: new Date(
          Date.now() + (Number.isFinite(expiresIn) ? expiresIn : 3600) * 1000
        ).toISOString()
      }
    } finally {
      await response.dispose()
    }
  }
}
