import { randomBytes } from 'node:crypto'

import type { APIResponse, BrowserContext, Page } from 'patchright'

import { EncryptedSessionStore, type StoredSession } from '../auth/EncryptedSessionStore.js'
import type { AccountCredentials } from '../infra/AccountSecretStore.js'
import type { StructuredLogger } from '../infra/StructuredLogger.js'
import { safePath } from '../security/Redactor.js'
import { LoginController } from './LoginController.js'
import { navigateForAuthentication } from './AuthNavigation.js'
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

async function requestWithCancellation(
  request: () => Promise<APIResponse>,
  signal: AbortSignal
): Promise<APIResponse> {
  signal.throwIfAborted()
  const pending = request()
  return new Promise<APIResponse>((resolve, reject) => {
    let finished = false
    const onAbort = () => {
      if (finished) return
      finished = true
      signal.removeEventListener('abort', onAbort)
      reject(signal.reason instanceof Error ? signal.reason : new Error('Cancelled'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    void pending.then(
      (response) => {
        if (finished) {
          void response.dispose().catch(() => undefined)
          return
        }
        finished = true
        signal.removeEventListener('abort', onAbort)
        resolve(response)
      },
      (error: unknown) => {
        if (finished) return
        finished = true
        signal.removeEventListener('abort', onAbort)
        reject(error instanceof Error ? error : new Error('OAuth request failed'))
      }
    )
    if (signal.aborted) onAbort()
  })
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
    signal.throwIfAborted()
    const stored = await this.sessions.read<AppToken>(accountId, 'app-oauth')
    signal.throwIfAborted()
    if (stored?.payload.refreshToken) {
      const refreshed = await this.exchange(
        new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: CLIENT_ID,
          refresh_token: stored.payload.refreshToken,
          scope: SCOPE
        }),
        signal
      ).catch(() => {
        signal.throwIfAborted()
        return undefined
      })
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

    signal.throwIfAborted()
    let code = await this.resolveCodeWithRequest(authorize, signal)
    if (!code) code = await this.resolveCodeWithPage(authorize, credentials, signal)
    if (!code) throw new Error('app-oauth-code-missing')

    const token = await this.exchange(
      new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: CLIENT_ID,
        code,
        redirect_uri: REWARDS_URLS.oauthRedirect,
        scope: SCOPE
      }),
      signal
    )
    signal.throwIfAborted()
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

  private async resolveCodeWithRequest(
    authorize: URL,
    signal: AbortSignal
  ): Promise<string | undefined> {
    const response = await requestWithCancellation(
      () => this.context.request.get(authorize.href, { timeout: 15_000, maxRedirects: 20 }),
      signal
    ).catch(() => {
      signal.throwIfAborted()
      return undefined
    })
    if (!response) return undefined
    try {
      signal.throwIfAborted()
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
    signal.throwIfAborted()
    const oauthPage = await this.context.newPage()
    const onAbort = () => {
      void oauthPage.close().catch(() => undefined)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      signal.throwIfAborted()
      await navigateForAuthentication(oauthPage, authorize.href, signal)
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
      signal.throwIfAborted()
      return this.extractCode(oauthPage.url())
    } finally {
      signal.removeEventListener('abort', onAbort)
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

  private async exchange(body: URLSearchParams, signal: AbortSignal): Promise<AppToken> {
    const response = await requestWithCancellation(
      () =>
        this.context.request.post(REWARDS_URLS.oauthToken, {
          timeout: 15_000,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          data: body.toString()
        }),
      signal
    )
    try {
      signal.throwIfAborted()
      const payload = (await response.json()) as TokenResponse
      signal.throwIfAborted()
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
