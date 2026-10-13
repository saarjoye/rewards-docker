import { extractNicknameFromCookie } from './FastApiEngine.js'
import type { AppToken } from '../browser/AppOAuthClient.js'
import type { BrowserStorageState } from '../browser/BrowserRuntime.js'
import type { EncryptedSessionStore } from './EncryptedSessionStore.js'

export const OAUTH_CONFIG = {
  clientId: '0000000040170455',
  scope: 'service::prod.rewardsplatform.microsoft.com::MBI_SSL',
  authorizeUrl:
    'https://login.live.com/oauth20_authorize.srf?client_id=0000000040170455&response_type=code&scope=service::prod.rewardsplatform.microsoft.com::MBI_SSL&redirect_uri=https://login.live.com/oauth20_desktop.srf',
  redirectUri: 'https://login.live.com/oauth20_desktop.srf',
  tokenUrl: 'https://login.live.com/oauth20_token.srf'
} as const

export interface CredentialsStatus {
  accountId: string
  hasPassword: boolean
  oauth: {
    bound: boolean
    hasRefreshToken: boolean
    expiresAt?: string | undefined
    validatedAt?: string | undefined
  }
  webSession: {
    bound: boolean
    desktopCookieCount: number
    mobileCookieCount: number
    validatedAt?: string | undefined
  }
}

export function extractOAuthCode(rawInput: string): string {
  const trimmed = rawInput.trim()
  if (!trimmed) {
    throw new Error('请输入有效的授权码或跳转链接')
  }

  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    try {
      const url = new URL(trimmed)
      const queryCode = url.searchParams.get('code')
      if (queryCode) return queryCode.trim()

      const hash = url.hash.replace(/^#/, '')
      if (hash) {
        const hashParams = new URLSearchParams(hash)
        const hashCode = hashParams.get('code')
        if (hashCode) return hashCode.trim()
      }
    } catch {
      // not a valid URL, fallback to raw parsing
    }
  }

  if (trimmed.startsWith('code=')) {
    const codePart = trimmed.slice(5).split('&')[0]
    if (codePart) return codePart.trim()
  }

  return trimmed
}

export async function exchangeOAuthCode(
  rawCodeOrUrl: string,
  fetchImpl: typeof fetch = globalThis.fetch
): Promise<AppToken> {
  const code = extractOAuthCode(rawCodeOrUrl)
  const body = new URLSearchParams({
    client_id: OAUTH_CONFIG.clientId,
    grant_type: 'authorization_code',
    code,
    redirect_uri: OAUTH_CONFIG.redirectUri,
    scope: OAUTH_CONFIG.scope
  })

  const controller = new AbortController()
  const timer = setTimeout(() => {
    controller.abort()
  }, 20_000)

  try {
    const response = await fetchImpl(OAUTH_CONFIG.tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json'
      },
      body: body.toString(),
      signal: controller.signal
    })

    const payload = (await response.json()) as {
      access_token?: string
      refresh_token?: string
      expires_in?: number | string
      error?: string
      error_description?: string
    }

    if (!response.ok || payload.error || typeof payload.access_token !== 'string') {
      const detail = payload.error_description || payload.error || `HTTP ${String(response.status)}`
      throw new Error(`OAuth 授权兑换失败: ${detail}`)
    }

    const expiresIn = Number(payload.expires_in) || 3600
    return {
      accessToken: payload.access_token,
      ...(typeof payload.refresh_token === 'string' ? { refreshToken: payload.refresh_token } : {}),
      expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString()
    }
  } finally {
    clearTimeout(timer)
  }
}

export async function exchangeOAuthRefreshToken(
  refreshToken: string,
  fetchImpl: typeof fetch = globalThis.fetch
): Promise<AppToken> {
  const trimmedToken = refreshToken.trim()
  if (!trimmedToken) {
    throw new Error('刷新令牌不能为空')
  }

  const body = new URLSearchParams({
    client_id: OAUTH_CONFIG.clientId,
    grant_type: 'refresh_token',
    refresh_token: trimmedToken,
    scope: OAUTH_CONFIG.scope
  })

  const controller = new AbortController()
  const timer = setTimeout(() => {
    controller.abort()
  }, 20_000)

  try {
    const response = await fetchImpl(OAUTH_CONFIG.tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json'
      },
      body: body.toString(),
      signal: controller.signal
    })

    const payload = (await response.json()) as {
      access_token?: string
      refresh_token?: string
      expires_in?: number | string
      error?: string
      error_description?: string
    }

    if (!response.ok || payload.error || typeof payload.access_token !== 'string') {
      const detail = payload.error_description || payload.error || `HTTP ${String(response.status)}`
      throw new Error(`OAuth 刷新令牌失败: ${detail}`)
    }

    const expiresIn = Number(payload.expires_in) || 3600
    return {
      accessToken: payload.access_token,
      refreshToken: typeof payload.refresh_token === 'string' ? payload.refresh_token : trimmedToken,
      expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString()
    }
  } finally {
    clearTimeout(timer)
  }
}

type CookieItem = BrowserStorageState['cookies'][number]

export function parseAndNormalizeCookies(rawInput: string): CookieItem[] {
  const trimmed = rawInput.trim()
  if (!trimmed) {
    throw new Error('Cookie 内容不能为空')
  }

  const result: CookieItem[] = []

  // Case 1: JSON array or object containing cookies
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown
      let rawList: unknown[] = []
      if (Array.isArray(parsed)) {
        rawList = parsed
      } else if (parsed && typeof parsed === 'object') {
        const record = parsed as Record<string, unknown>
        if (Array.isArray(record.cookies)) {
          rawList = record.cookies
        }
      }

      for (const item of rawList) {
        if (!item || typeof item !== 'object') continue
        const rec = item as Record<string, unknown>
        const name = typeof rec.name === 'string' ? rec.name.trim() : typeof rec.name === 'number' ? String(rec.name) : ''
        if (!name) continue
        const value = typeof rec.value === 'string' ? rec.value : typeof rec.value === 'number' ? String(rec.value) : ''
        let domain = typeof rec.domain === 'string' && rec.domain.trim() ? rec.domain.trim() : '.bing.com'
        if (!domain.startsWith('.') && !domain.includes('://')) domain = `.${domain}`
        const path = typeof rec.path === 'string' && rec.path.trim() ? rec.path.trim() : '/'
        const rawExpires = Number(rec.expires ?? rec.expirationDate ?? -1)
        const expires = Number.isFinite(rawExpires) ? rawExpires : -1
        const httpOnly = Boolean(rec.httpOnly)
        const secure = rec.secure !== undefined ? Boolean(rec.secure) : true
        const sameSite = (
          ['Strict', 'Lax', 'None'].includes(String(rec.sameSite)) ? rec.sameSite : 'Lax'
        ) as 'Strict' | 'Lax' | 'None'

        result.push({
          name,
          value,
          domain,
          path,
          expires,
          httpOnly,
          secure,
          sameSite
        })
      }

      if (result.length > 0) return result
    } catch (error) {
      if (error instanceof Error && error.message.includes('Cookie')) throw error
      // JSON parse failed, try next formats
    }
  }

  // Case 2: Netscape HTTP Cookie format (tab-separated lines)
  const lines = trimmed.split('\n')
  const netscapeItems: CookieItem[] = []
  for (const line of lines) {
    const lineTrimmed = line.trim()
    if (!lineTrimmed || lineTrimmed.startsWith('#')) continue
    const parts = lineTrimmed.split('\t')
    if (parts.length >= 7) {
      const domain = parts[0]?.trim() || '.bing.com'
      const path = parts[2]?.trim() || '/'
      const secure = parts[3]?.toUpperCase() === 'TRUE'
      const expires = Number(parts[4]) || -1
      const name = parts[5]?.trim()
      const value = parts[6] ?? ''
      if (name) {
        netscapeItems.push({
          name,
          value,
          domain: domain.startsWith('.') ? domain : `.${domain}`,
          path,
          expires,
          httpOnly: false,
          secure,
          sameSite: 'Lax'
        })
      }
    }
  }
  if (netscapeItems.length > 0) return netscapeItems

  // Case 3: Semicolon-separated HTTP Cookie Header string
  const pairs = trimmed.split(';')
  for (const pair of pairs) {
    const equalIndex = pair.indexOf('=')
    if (equalIndex === -1) continue
    const name = pair.slice(0, equalIndex).trim()
    const value = pair.slice(equalIndex + 1).trim()
    if (!name) continue

    for (const domain of ['.bing.com', '.rewards.bing.com', '.live.com']) {
      result.push({
        name,
        value,
        domain,
        path: '/',
        expires: -1,
        httpOnly: false,
        secure: true,
        sameSite: 'Lax'
      })
    }
  }

  if (result.length === 0) {
    throw new Error('未能从输入文本中解析出有效的 Cookie（支持 JSON 格式、Netscape 格式或 key=value; 字符串）')
  }

  return result
}

export class SessionImportManager {
  constructor(private readonly sessions: EncryptedSessionStore) {}

  async saveOAuthToken(accountId: string, token: AppToken): Promise<void> {
    await this.sessions.commitVerified(
      {
        accountId,
        slot: 'app-oauth',
        validatedAt: new Date().toISOString(),
        payload: token
      },
      true
    )
  }

  async saveWebSessionCookies(accountId: string, cookies: CookieItem[]): Promise<void> {
    const validatedAt = new Date().toISOString()
    const storageState: BrowserStorageState = {
      cookies,
      origins: [
        { origin: 'https://rewards.bing.com', localStorage: [] },
        { origin: 'https://www.bing.com', localStorage: [] }
      ]
    }

    await this.sessions.commitVerified(
      {
        accountId,
        slot: 'web-desktop',
        validatedAt,
        payload: storageState
      },
      true
    )

    await this.sessions.commitVerified(
      {
        accountId,
        slot: 'web-mobile',
        validatedAt,
        payload: storageState
      },
      true
    )
  }

  async getCredentialsStatus(
    accountId: string,
    hasPassword: boolean
  ): Promise<CredentialsStatus> {
    const oauthSession = await this.sessions.read<AppToken>(accountId, 'app-oauth')
    const desktopSession = await this.sessions.read<BrowserStorageState>(accountId, 'web-desktop')
    const mobileSession = await this.sessions.read<BrowserStorageState>(accountId, 'web-mobile')

    const oauthBound = Boolean(oauthSession?.payload.accessToken)
    const desktopCookies = desktopSession?.payload.cookies ?? []
    const mobileCookies = mobileSession?.payload.cookies ?? []
    const webBound = desktopCookies.length > 0 || mobileCookies.length > 0

    return {
      accountId,
      hasPassword,
      oauth: {
        bound: oauthBound,
        hasRefreshToken: Boolean(oauthSession?.payload.refreshToken),
        expiresAt: oauthSession?.payload.expiresAt,
        validatedAt: oauthSession?.validatedAt
      },
      webSession: {
        bound: webBound,
        desktopCookieCount: desktopCookies.length,
        mobileCookieCount: mobileCookies.length,
        validatedAt: desktopSession?.validatedAt ?? mobileSession?.validatedAt
      }
    }
  }
}

export { extractNicknameFromCookie }
