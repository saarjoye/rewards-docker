import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { EncryptedSessionStore } from '../src/auth/EncryptedSessionStore.js'
import {
  BrowserRuntime,
  computeSessionIdentityHash,
  validateSessionIdentity
} from '../src/browser/BrowserRuntime.js'

const mocks = vi.hoisted(() => ({ launch: vi.fn() }))
vi.mock('patchright', () => ({ default: { chromium: { launch: mocks.launch } } }))
beforeEach(() => mocks.launch.mockReset())

describe('session identity fingerprint', () => {
  const identityCookies = [
    { name: 'WLS', value: 'ts=1&t=alice' },
    { name: 'SRCHUID', value: 'guid-1111' }
  ]

  it('computes a stable hash from identity cookies', () => {
    expect(computeSessionIdentityHash(identityCookies)).toBe(
      computeSessionIdentityHash(identityCookies)
    )
    expect(computeSessionIdentityHash([])).toBeUndefined()
  })

  it('accepts matching identity and rejects mismatched identity', () => {
    const hash = computeSessionIdentityHash(identityCookies)
    expect(validateSessionIdentity(hash, identityCookies)).toEqual({ valid: true })
    expect(
      validateSessionIdentity(hash, [{ name: 'WLS', value: 'ts=1&t=bob' }])
    ).toMatchObject({ valid: false })
  })

  it('openSlot throws when restored session identity does not match stored fingerprint', async () => {
    const storedState = {
      cookies: [
        { name: 'WLS', value: 'ts=1&t=alice', domain: '.bing.com', path: '/' },
        { name: 'SRCHUID', value: 'guid-1111', domain: '.bing.com', path: '/' }
      ],
      origins: [],
      meta: { identityHash: 'deadbeef' }
    }
    const newContext = vi.fn().mockResolvedValue({
      setDefaultTimeout: vi.fn(),
      setDefaultNavigationTimeout: vi.fn(),
      newPage: vi.fn().mockResolvedValue({}),
      close: vi.fn().mockResolvedValue(undefined)
    })
    mocks.launch.mockResolvedValue({
      newContext,
      isConnected: () => true,
      close: vi.fn().mockResolvedValue(undefined)
    })
    const read = vi.fn().mockResolvedValue({ payload: storedState })
    const runtime = new BrowserRuntime({
      headless: true,
      sessions: { read } as unknown as EncryptedSessionStore
    })

    await expect(runtime.openSlot('acc-1', 'web-desktop')).rejects.toThrow()
  })
})