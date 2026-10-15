import { createHash } from 'node:crypto'
import patchright, {
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  type Page
} from 'patchright'

import type { AuthSlot } from '../auth/AuthSlot.js'
import { EncryptedSessionStore, type StoredSession } from '../auth/EncryptedSessionStore.js'

export type BrowserStorageState = Awaited<ReturnType<BrowserContext['storageState']>>

const IDENTITY_POISON_COOKIE = '_U'

export function sanitizeStorageState(state: BrowserStorageState): BrowserStorageState {
  return {
    ...state,
    cookies: state.cookies.filter((cookie) => cookie.name !== IDENTITY_POISON_COOKIE)
  }
}

const IDENTITY_COOKIE_NAMES = new Set(['WLS', 'MUID', 'SRCHUID', 'ANON'])

export function computeSessionIdentityHash(
  cookies: readonly { name: string; value: string }[]
): string | undefined {
  const parts = cookies
    .filter((cookie) => IDENTITY_COOKIE_NAMES.has(cookie.name))
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .sort()
  if (parts.length === 0) return undefined
  return createHash('sha256').update(parts.join('&')).digest('hex')
}

export function validateSessionIdentity(
  expectedHash: string | undefined,
  actualCookies: readonly { name: string; value: string }[]
): { valid: boolean; reason?: string } {
  if (!expectedHash) return { valid: true }
  const actualHash = computeSessionIdentityHash(actualCookies)
  if (actualHash !== expectedHash) {
    return { valid: false, reason: '会话身份与预期不一致' }
  }
  return { valid: true }
}

export interface AccountBrowserSlot {
  slot: AuthSlot
  context: BrowserContext
  page: Page
  authenticationContext?: { reusedBrowser: boolean; restoredSession: boolean }
  close(): Promise<void>
  commitVerified(): Promise<void>
}

export interface BrowserRuntimeOptions {
  headless: boolean
  sessions: EncryptedSessionStore
  executablePath?: string
  proxyUrl?: string
}

const DESKTOP_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0'
const MOBILE_AGENT =
  'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36 EdgA/140.0.0.0'

export class BrowserRuntime {
  private browser: Browser | undefined

  constructor(private readonly options: BrowserRuntimeOptions) {}

  async openSlot(
    accountId: string,
    slot: Exclude<AuthSlot, 'app-oauth'>
  ): Promise<AccountBrowserSlot> {
    const reusedBrowser = this.browser?.isConnected() === true
    const browser = await this.getBrowser()
    const stored = await this.options.sessions.read<BrowserStorageState>(accountId, slot)
    const expectedIdentityHash = stored
      ? (stored.payload as BrowserStorageState & { meta?: { identityHash?: string } }).meta?.identityHash
      : undefined
    if (stored && expectedIdentityHash) {
      const identity = validateSessionIdentity(expectedIdentityHash, stored.payload.cookies)
      if (!identity.valid) {
        throw new Error(
          `会话身份校验失败：${identity.reason ?? '会话身份与预期不一致'}（account ${accountId} / slot ${slot}）`
        )
      }
    }
    const storageState = stored ? sanitizeStorageState(stored.payload) : undefined
    const mobile = slot === 'web-mobile'
    const contextOptions: BrowserContextOptions = {
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
      userAgent: mobile ? MOBILE_AGENT : DESKTOP_AGENT,
      viewport: mobile ? { width: 412, height: 915 } : { width: 1365, height: 768 },
      screen: mobile ? { width: 412, height: 915 } : { width: 1365, height: 768 },
      isMobile: mobile,
      hasTouch: mobile,
      deviceScaleFactor: mobile ? 2.625 : 1,
      extraHTTPHeaders: {
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.7',
        'Sec-CH-UA-Platform': mobile ? '"Android"' : '"Windows"'
      },
      ...(storageState ? { storageState } : {})
    }
    const context = await browser.newContext(contextOptions)
    context.setDefaultTimeout(15_000)
    context.setDefaultNavigationTimeout(30_000)
    const page = await context.newPage()

    return {
      slot,
      context,
      page,
      authenticationContext: { reusedBrowser, restoredSession: Boolean(stored) },
      close: async () => context.close(),
      commitVerified: async () => {
        const payload = sanitizeStorageState(await context.storageState())
        const identityHash = computeSessionIdentityHash(payload.cookies)
        const session: StoredSession<BrowserStorageState> = {
          accountId,
          slot,
          validatedAt: new Date().toISOString(),
          payload: {
            ...payload,
            ...(identityHash ? { meta: { identityHash } } : {})
          }
        }
        await this.options.sessions.commitVerified(session, true)
      }
    }
  }

  async close(): Promise<void> {
    const browser = this.browser
    this.browser = undefined
    await browser?.close()
  }

  private async getBrowser(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser
    const args = [
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled'
    ]
    if (this.options.proxyUrl) {
      args.push(`--proxy-server=${this.options.proxyUrl}`)
    } else {
      args.push('--no-proxy-server')
    }

    this.browser = await patchright.chromium.launch({
      headless: this.options.headless,
      ...(this.options.executablePath ? { executablePath: this.options.executablePath } : {}),
      ...(this.options.proxyUrl ? { proxy: { server: this.options.proxyUrl } } : {}),
      args
    })
    return this.browser
  }
}
