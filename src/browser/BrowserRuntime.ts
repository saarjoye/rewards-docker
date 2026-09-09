import patchright, {
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  type Page
} from 'patchright'

import type { AuthSlot } from '../auth/AuthSlot.js'
import { EncryptedSessionStore, type StoredSession } from '../auth/EncryptedSessionStore.js'

export type BrowserStorageState = Awaited<ReturnType<BrowserContext['storageState']>>

export interface AccountBrowserSlot {
  slot: AuthSlot
  context: BrowserContext
  page: Page
  close(): Promise<void>
  commitVerified(): Promise<void>
}

export interface BrowserRuntimeOptions {
  headless: boolean
  sessions: EncryptedSessionStore
  executablePath?: string
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
    const browser = await this.getBrowser()
    const stored = await this.options.sessions.read<BrowserStorageState>(accountId, slot)
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
      ...(stored ? { storageState: stored.payload } : {})
    }
    const context = await browser.newContext(contextOptions)
    context.setDefaultTimeout(15_000)
    context.setDefaultNavigationTimeout(30_000)
    const page = await context.newPage()

    return {
      slot,
      context,
      page,
      close: async () => context.close(),
      commitVerified: async () => {
        const session: StoredSession<BrowserStorageState> = {
          accountId,
          slot,
          validatedAt: new Date().toISOString(),
          payload: await context.storageState()
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
    this.browser = await patchright.chromium.launch({
      headless: this.options.headless,
      ...(this.options.executablePath ? { executablePath: this.options.executablePath } : {}),
      args: [
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
        '--no-proxy-server'
      ]
    })
    return this.browser
  }
}
