import { afterEach, describe, expect, it } from 'vitest'

import {
  buildCookieHeaderForUrl,
  selectCookiesForUrl,
  type ScopedCookie
} from '../src/auth/CookieScope.js'
import { localDateKey } from '../src/domain/DateKey.js'
import { createEvidence, selectTrustedEvidence } from '../src/domain/Evidence.js'
import { selectAccounts } from '../src/domain/RunRequest.js'

const originalTimezone = process.env.TZ

afterEach(() => {
  if (originalTimezone === undefined) delete process.env.TZ
  else process.env.TZ = originalTimezone
})

describe('local business date', () => {
  it('changes only at the process local midnight', () => {
    process.env.TZ = 'Asia/Shanghai'
    expect(localDateKey(new Date('2026-08-30T23:59:00Z'))).toBe('2026-08-31')
    expect(localDateKey(new Date('2026-08-31T00:01:00Z'))).toBe('2026-08-31')
    expect(localDateKey(new Date('2026-08-31T15:59:00Z'))).toBe('2026-08-31')
    expect(localDateKey(new Date('2026-08-31T16:01:00Z'))).toBe('2026-09-01')
  })
})

describe('target-aware cookies', () => {
  const cookies: ScopedCookie[] = [
    {
      name: 'MUID',
      value: 'bing-wide',
      domain: '.bing.com',
      path: '/',
      hostOnly: false,
      secure: true,
      expires: -1
    },
    {
      name: 'MUID',
      value: 'live-wide',
      domain: '.live.com',
      path: '/',
      hostOnly: false,
      secure: true,
      expires: -1
    },
    {
      name: 'MUID',
      value: 'rewards-api',
      domain: 'rewards.bing.com',
      path: '/api',
      hostOnly: true,
      secure: true,
      expires: -1
    },
    {
      name: 'AUTH',
      value: 'wrong-path',
      domain: '.bing.com',
      path: '/auth',
      hostOnly: false,
      secure: true,
      expires: -1
    },
    {
      name: 'OLD',
      value: 'expired',
      domain: '.bing.com',
      path: '/',
      hostOnly: false,
      secure: true,
      expires: 100
    }
  ]

  it('keeps every valid duplicate and sorts longer paths first', () => {
    const selected = selectCookiesForUrl(cookies, 'https://rewards.bing.com/api/getuserinfo', 200)
    expect(selected.map(({ value }) => value)).toEqual(['rewards-api', 'bing-wide'])
    expect(buildCookieHeaderForUrl(cookies, 'https://rewards.bing.com/api/getuserinfo', 200)).toBe(
      'MUID=rewards-api; MUID=bing-wide'
    )
  })

  it('enforces RFC path boundaries and secure transport', () => {
    expect(buildCookieHeaderForUrl(cookies, 'https://rewards.bing.com/authentication', 200)).toBe(
      'MUID=bing-wide'
    )
    expect(buildCookieHeaderForUrl(cookies, 'http://rewards.bing.com/api/getuserinfo', 200)).toBe(
      ''
    )
  })
})

describe('account selection', () => {
  const accounts = ['first', 'middle', 'last']

  it('continue selects all incomplete accounts without using an index', () => {
    expect(
      selectAccounts(accounts, { accountMode: 'continue' }, (account) => account === 'middle')
    ).toEqual([
      { account: 'first', runAccountIndex: 1 },
      { account: 'last', runAccountIndex: 3 }
    ])
    expect(() =>
      selectAccounts(accounts, { accountMode: 'continue', runAccountIndex: 1 }, () => false)
    ).toThrow('continue mode must not include runAccountIndex')
  })

  it('account mode uses a strict one-based index', () => {
    expect(
      selectAccounts(accounts, { accountMode: 'account', runAccountIndex: 1 }, () => false)
    ).toEqual([{ account: 'first', runAccountIndex: 1 }])
    expect(
      selectAccounts(accounts, { accountMode: 'account', runAccountIndex: 3 }, () => false)
    ).toEqual([{ account: 'last', runAccountIndex: 3 }])
    for (const index of [0, -1, 4]) {
      expect(() =>
        selectAccounts(accounts, { accountMode: 'account', runAccountIndex: index }, () => false)
      ).toThrow()
    }
  })
})

describe('field evidence', () => {
  it('selects the strongest and newest valid value', () => {
    const candidates = [
      createEvidence({
        availability: 'valid',
        source: 'legacy-getuserinfo',
        confidence: 0.4,
        observedAt: '2026-09-03T00:00:00Z',
        value: 100
      }),
      createEvidence({
        availability: 'valid',
        source: 'bing-flyout',
        confidence: 0.9,
        observedAt: '2026-09-03T00:01:00Z',
        value: 120
      }),
      createEvidence<number>({
        availability: 'missing',
        source: 'rsc',
        confidence: 1,
        observedAt: '2026-09-03T00:02:00Z',
        reason: 'field absent'
      })
    ]
    expect(selectTrustedEvidence(candidates)?.value).toBe(120)
  })
})
