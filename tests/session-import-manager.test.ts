import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { EncryptedSessionStore } from '../src/auth/EncryptedSessionStore.js'
import {
  extractOAuthCode,
  exchangeOAuthCode,
  exchangeOAuthRefreshToken,
  parseAndNormalizeCookies,
  SessionImportManager
} from '../src/auth/SessionImportManager.js'

describe('SessionImportManager and credential helpers', () => {
  let tempDir: string
  let sessions: EncryptedSessionStore
  let manager: SessionImportManager
  const key = Buffer.alloc(32, 11)

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'rewards-session-import-test-'))
    sessions = new EncryptedSessionStore(tempDir, key)
    manager = new SessionImportManager(sessions)
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  describe('extractOAuthCode', () => {
    it('extracts code from raw string', () => {
      expect(extractOAuthCode('M.C501_BL2.0.synthetic_code')).toBe('M.C501_BL2.0.synthetic_code')
    })

    it('extracts code from code= parameter format', () => {
      expect(extractOAuthCode('code=M.C501_BL2.0.synthetic_code&state=xyz')).toBe(
        'M.C501_BL2.0.synthetic_code'
      )
    })

    it('extracts code from full redirect URL query parameter', () => {
      const url =
        'https://login.live.com/oauth20_desktop.srf?code=M.C501_BL2.0.url_code&state=abc123xyz'
      expect(extractOAuthCode(url)).toBe('M.C501_BL2.0.url_code')
    })

    it('extracts code from full redirect URL hash parameter', () => {
      const url = 'https://login.live.com/oauth20_desktop.srf#code=M.C501_BL2.0.hash_code'
      expect(extractOAuthCode(url)).toBe('M.C501_BL2.0.hash_code')
    })

    it('throws when code input is empty or blank', () => {
      expect(() => extractOAuthCode('')).toThrow('请输入有效的授权码或跳转链接')
      expect(() => extractOAuthCode('   ')).toThrow('请输入有效的授权码或跳转链接')
    })
  })

  describe('parseAndNormalizeCookies', () => {
    it('parses Cookie-Editor JSON array format', () => {
      const json = JSON.stringify([
        {
          name: 'MUID',
          value: '1234567890',
          domain: '.bing.com',
          path: '/',
          secure: true,
          httpOnly: false,
          sameSite: 'Lax'
        },
        {
          name: '_U',
          value: 'synthetic_user_token',
          domain: 'rewards.bing.com',
          path: '/'
        }
      ])

      const cookies = parseAndNormalizeCookies(json)
      expect(cookies).toHaveLength(2)
      expect(cookies[0]).toMatchObject({
        name: 'MUID',
        value: '1234567890',
        domain: '.bing.com',
        path: '/'
      })
      expect(cookies[1]?.domain).toBe('.rewards.bing.com')
    })

    it('parses Playwright storageState JSON object format', () => {
      const json = JSON.stringify({
        cookies: [
          {
            name: '_EDGE_S',
            value: 'SID=abc',
            domain: '.bing.com',
            path: '/'
          }
        ],
        origins: []
      })

      const cookies = parseAndNormalizeCookies(json)
      expect(cookies).toHaveLength(1)
      expect(cookies[0]?.name).toBe('_EDGE_S')
    })

    it('parses Netscape tab-delimited format', () => {
      const netscape = [
        '# Netscape HTTP Cookie File',
        '.bing.com\tTRUE\t/\tTRUE\t1790000000\tMUID\t99887766'
      ].join('\n')

      const cookies = parseAndNormalizeCookies(netscape)
      expect(cookies).toHaveLength(1)
      expect(cookies[0]).toMatchObject({
        name: 'MUID',
        value: '99887766',
        domain: '.bing.com',
        path: '/',
        secure: true
      })
    })

    it('parses HTTP Cookie header format string', () => {
      const header = 'MUID=1234; _U=token5678; SRCHD=AF=NOFORM'
      const cookies = parseAndNormalizeCookies(header)
      expect(cookies.length).toBeGreaterThan(0)
      const muidItem = cookies.find((c) => c.name === 'MUID' && c.domain === '.bing.com')
      expect(muidItem).toBeDefined()
      expect(muidItem?.value).toBe('1234')
    })

    it('throws when text has no valid cookies', () => {
      expect(() => parseAndNormalizeCookies('invalid plain text')).toThrow(
        '未能从输入文本中解析出有效的 Cookie'
      )
    })
  })

  describe('exchangeOAuthCode and exchangeOAuthRefreshToken', () => {
    it('successfully exchanges code with mock fetch', async () => {
      const mockFetch: typeof fetch = () =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              access_token: 'mock-access-token',
              refresh_token: 'mock-refresh-token',
              expires_in: 3600
            })
        } as unknown as Response)

      const token = await exchangeOAuthCode('synthetic-code', mockFetch)
      expect(token.accessToken).toBe('mock-access-token')
      expect(token.refreshToken).toBe('mock-refresh-token')
      expect(token.expiresAt).toBeDefined()
      expect(new Date(token.expiresAt).getTime()).toBeGreaterThan(Date.now())
    })

    it('throws error when code exchange returns failure', async () => {
      const mockFetch: typeof fetch = () =>
        Promise.resolve({
          ok: false,
          status: 400,
          json: () =>
            Promise.resolve({
              error: 'invalid_grant',
              error_description: 'The provided authorization code is invalid or expired.'
            })
        } as unknown as Response)

      await expect(exchangeOAuthCode('expired-code', mockFetch)).rejects.toThrow(
        'The provided authorization code is invalid or expired.'
      )
    })

    it('successfully refreshes token with mock fetch', async () => {
      const mockFetch: typeof fetch = () =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              access_token: 'new-refreshed-token',
              refresh_token: 'new-refresh-token',
              expires_in: 7200
            })
        } as unknown as Response)

      const token = await exchangeOAuthRefreshToken('old-refresh-token', mockFetch)
      expect(token.accessToken).toBe('new-refreshed-token')
      expect(token.refreshToken).toBe('new-refresh-token')
    })
  })

  describe('SessionImportManager storage and status', () => {
    const accountId = 'synthetic-account-uuid-001'

    it('tracks empty credential status initially', async () => {
      const status = await manager.getCredentialsStatus(accountId, false)
      expect(status).toEqual({
        accountId,
        hasPassword: false,
        oauth: {
          bound: false,
          hasRefreshToken: false,
          expiresAt: undefined,
          validatedAt: undefined
        },
        webSession: {
          bound: false,
          desktopCookieCount: 0,
          mobileCookieCount: 0,
          validatedAt: undefined
        }
      })
    })

    it('persists and reports OAuth token', async () => {
      await manager.saveOAuthToken(accountId, {
        accessToken: 'saved-access-token',
        refreshToken: 'saved-refresh-token',
        expiresAt: new Date(Date.now() + 3600_000).toISOString()
      })

      const status = await manager.getCredentialsStatus(accountId, true)
      expect(status.hasPassword).toBe(true)
      expect(status.oauth.bound).toBe(true)
      expect(status.oauth.hasRefreshToken).toBe(true)
      expect(status.oauth.expiresAt).toBeDefined()
    })

    it('persists and reports web session cookies', async () => {
      const cookies = [
        {
          name: 'MUID',
          value: 'test-value',
          domain: '.bing.com',
          path: '/',
          expires: -1,
          httpOnly: false,
          secure: true,
          sameSite: 'Lax' as const
        }
      ]

      await manager.saveWebSessionCookies(accountId, cookies)

      const status = await manager.getCredentialsStatus(accountId, false)
      expect(status.webSession.bound).toBe(true)
      expect(status.webSession.desktopCookieCount).toBe(1)
      expect(status.webSession.mobileCookieCount).toBe(1)
      expect(status.webSession.validatedAt).toBeDefined()
    })
  })
})
