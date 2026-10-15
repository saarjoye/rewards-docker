import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { EncryptedSessionStore } from '../src/auth/EncryptedSessionStore.js'
import {
  BrowserRuntime,
  computeSessionIdentityHash,
  validateSessionIdentity
} from '../src/browser/BrowserRuntime.js'
import {
  createSessionIdentityAnchor,
  extractMsaAuthIdentity,
  normalizeRewardsRuid,
  validateSessionIdentityAnchor
} from '../src/domain/SessionIdentity.js'

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

const STABLE_RUID = '4022697D86736F337E815ABE68F2291F4EDF7AD3'

function msaAuth(value: unknown): { name: string; value: string } {
  return {
    name: '.MSA.Auth',
    value: Buffer.from(JSON.stringify(value), 'utf8').toString('base64')
  }
}

describe('stable session identity anchor', () => {
  it('ignores WLS clearing during flyout verification', () => {
    const expected = createSessionIdentityAnchor(
      { ruid: `hk-${STABLE_RUID}` },
      [{ name: 'WLS', value: 'C=x&N=y' }]
    )
    const actual = createSessionIdentityAnchor(
      { ruid: `hk-${STABLE_RUID}` },
      [{ name: 'WLS', value: 'C=&N=' }]
    )

    expect(expected).toEqual({ ruid: STABLE_RUID })
    expect(validateSessionIdentityAnchor(expected, actual)).toEqual({
      valid: true,
      updated: { ruid: STABLE_RUID }
    })
  })

  it('ignores SRCHUID rotation during flyout verification', () => {
    const expected = createSessionIdentityAnchor(
      { ruid: `hk-${STABLE_RUID}` },
      [{ name: 'SRCHUID', value: 'V=2&GUID=54EA359C70CE426BB8FD38AB426D1A4A' }]
    )
    const actual = createSessionIdentityAnchor(
      { ruid: `hk-${STABLE_RUID}` },
      [{ name: 'SRCHUID', value: 'V=2&GUID=933EA1FFBA3D468DB' }]
    )

    expect(validateSessionIdentityAnchor(expected, actual)).toEqual({
      valid: true,
      updated: { ruid: STABLE_RUID }
    })
  })

  it('ignores MUID domain churn during flyout verification', () => {
    const expected = createSessionIdentityAnchor({ ruid: `hk-${STABLE_RUID}` }, [])
    const actual = createSessionIdentityAnchor(
      { ruid: `hk-${STABLE_RUID}` },
      [
        { name: 'MUID', value: 'synthetic-muid-a' },
        { name: 'MUID', value: 'synthetic-muid-b' }
      ]
    )

    expect(validateSessionIdentityAnchor(expected, actual)).toEqual({
      valid: true,
      updated: { ruid: STABLE_RUID }
    })
  })

  it('normalizes a changed region prefix for the same ruid', () => {
    expect(normalizeRewardsRuid(`hk-${STABLE_RUID}`)).toBe(STABLE_RUID)
    expect(
      validateSessionIdentityAnchor(
        { ruid: `hk-${STABLE_RUID}` },
        { ruid: `usw-${STABLE_RUID}` }
      )
    ).toEqual({ valid: true, updated: { ruid: STABLE_RUID } })
  })

  it('rejects a real ruid change', () => {
    expect(
      validateSessionIdentityAnchor(
        { ruid: `hk-${STABLE_RUID}` },
        { ruid: 'usw-ACCOUNT-B-SYNTHETIC' }
      )
    ).toEqual({ valid: false, reason: '会话身份与预期不一致' })
  })

  it('rejects a real .MSA.Auth identity change', () => {
    expect(
      validateSessionIdentityAnchor(
        { msaAuth: 'cid=synthetic-account-a' },
        { msaAuth: 'cid=synthetic-account-b' }
      )
    ).toEqual({ valid: false, reason: '会话身份与预期不一致' })
  })

  it('extracts only stable identity claims from synthetic .MSA.Auth', () => {
    expect(
      extractMsaAuthIdentity([msaAuth({ cid: 'synthetic-account-a', mutable: 'ignored' })])
    ).toBe('cid=synthetic-account-a')
  })
})
