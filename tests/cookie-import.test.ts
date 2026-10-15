import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { EncryptedSessionStore } from '../src/auth/EncryptedSessionStore.js'
import {
  parseAndNormalizeCookies,
  SessionImportManager
} from '../src/auth/SessionImportManager.js'

describe('cookie import authentication guard', () => {
  let tempDir: string
  let sessions: EncryptedSessionStore
  let manager: SessionImportManager
  const key = Buffer.alloc(32, 7)

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'rewards-cookie-import-test-'))
    sessions = new EncryptedSessionStore(tempDir, key)
    manager = new SessionImportManager(sessions)
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  const anonymousCookies = [
    {
      name: '_U',
      value: 'anon-token',
      domain: '.bing.com',
      path: '/',
      expires: -1,
      httpOnly: false,
      secure: true,
      sameSite: 'Lax' as const
    }
  ]

  const authenticatedCookies = [
    {
      name: 'WLS',
      value: 'ts=1&t=user',
      domain: '.bing.com',
      path: '/',
      expires: -1,
      httpOnly: true,
      secure: true,
      sameSite: 'Lax' as const
    }
  ]

  it('rejects cookie JSON without authentication cookies', () => {
    expect(() => parseAndNormalizeCookies(JSON.stringify(anonymousCookies))).toThrow(/WLS/)
  })

  it('rejects saving a web session without authentication cookies', async () => {
    await expect(manager.saveWebSessionCookies('acc-1', anonymousCookies)).rejects.toThrow(/WLS/)
  })

  it('reports webSession.bound=false for a stored session lacking auth cookies', async () => {
    await sessions.commitVerified(
      {
        accountId: 'acc-1',
        slot: 'web-desktop',
        validatedAt: new Date().toISOString(),
        payload: {
          cookies: anonymousCookies,
          origins: [],
          meta: { hasAuthCookies: false, authCookieNames: [] }
        }
      },
      true
    )
    const status = await manager.getCredentialsStatus('acc-1', true)
    expect(status.webSession.bound).toBe(false)
    expect(status.webSession.desktopCookieCount).toBe(1)
  })

  it('accepts and persists a web session that has authentication cookies', async () => {
    await manager.saveWebSessionCookies('acc-1', authenticatedCookies)
    const status = await manager.getCredentialsStatus('acc-1', false)
    expect(status.webSession.bound).toBe(true)
    expect(status.webSession.desktopCookieCount).toBe(1)
    expect(status.webSession.mobileCookieCount).toBe(1)
  })
})