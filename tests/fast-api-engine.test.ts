import { describe, expect, it, vi } from 'vitest'
import {
  extractNicknameFromCookie,
  FastApiEngine,
  cookieItemsToString
} from '../src/auth/FastApiEngine.js'

function urlToString(url: string | URL | Request): string {
  if (typeof url === 'string') return url
  if (url instanceof URL) return url.toString()
  return url.url
}

describe('FastApiEngine & extractNicknameFromCookie', () => {
  it('extracts nickname from N parameter in cookie string', () => {
    const cookie = 'SRCHD=AF=NOFORM; N=saarjoye; _EDGE_S=F=1'
    expect(extractNicknameFromCookie(cookie)).toBe('saarjoye')

    const encodedCookie = 'N=%E5%BC%A0%E4%B8%89; foo=bar'
    expect(extractNicknameFromCookie(encodedCookie)).toBe('张三')
  })

  it('extracts nickname from WLS parameter when N is not present', () => {
    const cookie = 'WLS=ts=123456&t=testuser123; foo=bar'
    expect(extractNicknameFromCookie(cookie)).toBe('testuser123')
  })

  it('returns undefined when no nickname is found', () => {
    const cookie = 'SRCHD=AF=NOFORM; _EDGE_S=F=1'
    expect(extractNicknameFromCookie(cookie)).toBeUndefined()
  })

  it('cookieItemsToString formats cookie list correctly', () => {
    const items = [
      { name: 'N', value: 'alice' },
      { name: 'token', value: '123' }
    ]
    expect(cookieItemsToString(items)).toBe('N=alice; token=123')
  })

  describe('checkRegionLock', () => {
    it('allows when region is CN', async () => {
      const mockFetch = vi.fn((url: string | URL | Request) => {
        const u = urlToString(url)
        if (u.includes('dispatch')) {
          return Promise.resolve(
            new Response(JSON.stringify({ code: 0, extra: { ip: '1.2.3.4' }, ipInfo: '中国上海' }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' }
            })
          )
        }
        if (u.includes('bing.com')) {
          return Promise.resolve(
            new Response('<html><script>Region:"CN",RevIpCC:"CN"</script></html>', { status: 200 })
          )
        }
        return Promise.resolve(new Response('ok', { status: 200 }))
      })

      const engine = new FastApiEngine(mockFetch)
      const res = await engine.checkRegionLock()
      expect(res.allowed).toBe(true)
      expect(res.region).toBe('CN')
      expect(res.message).toContain('中国大陆出口')
    })

    it('blocks when region is not CN (e.g. US)', async () => {
      const mockFetch = vi.fn((url: string | URL | Request) => {
        const u = urlToString(url)
        if (u.includes('dispatch')) {
          return Promise.resolve(
            new Response(JSON.stringify({ code: 0, extra: { ip: '104.28.1.1' }, ipInfo: '美国加州' }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' }
            })
          )
        }
        if (u.includes('bing.com')) {
          return Promise.resolve(
            new Response('<html><script>Region:"US",RevIpCC:"US"</script></html>', { status: 200 })
          )
        }
        return Promise.resolve(new Response('ok', { status: 200 }))
      })

      const engine = new FastApiEngine(mockFetch)
      const res = await engine.checkRegionLock()
      expect(res.allowed).toBe(false)
      expect(res.region).toBe('US')
      expect(res.message).toContain('已触发安全锁拦截')
    })
  })

  describe('checkCookieStatus', () => {
    it('returns invalid when cookie string is empty', async () => {
      const engine = new FastApiEngine()
      const res = await engine.checkCookieStatus('')
      expect(res.valid).toBe(false)
    })

    it('recognizes valid cookie with balance and counters', async () => {
      const html = `
        <html>
          <body>
            <div>每日连续打卡 5 �?/div>
            <div aria-label="收集的印�? aria-valuemax="12" aria-valuenow="4"></div>
            <script>
              var info = {
                "pointsCounters": {
                  "pc": { "progress": 15, "max": 60 },
                  "totalPoints": 8888
                }
              };
            </script>
          </body>
        </html>
      `
      const mockFetch = vi.fn(() => Promise.resolve(new Response(html, { status: 200, headers: { 'Content-Type': 'text/html' } })))
      const engine = new FastApiEngine(mockFetch)
      const res = await engine.checkCookieStatus('WLS=ts=1&t=saarjoye; session=abc; domain=.bing.com')
      expect(res.valid).toBe(false)
      expect(res.balance).toBeUndefined()
      expect(res.message).toContain('api/getuserinfo')
      expect(res.message).toContain('JSON')
    })

    it('extracts balance from Next.js Flight chunks with whitespace tolerance and ignores cookie rc counter', async () => {
      const mockFetch = vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              userStatus: {
                availablePoints: 12993,
                streakDays: 120,
                counters: { pcSearch: [{ pointProgress: 6, pointProgressMax: 12 }] }
              }
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
        )
      )
      const engine = new FastApiEngine(mockFetch)
      // Cookie contains rc=65 (Bing search request counter)
      const res = await engine.checkCookieStatus('WLS=ts=1&t=saarjoye; _EDGE_S=F=1&rc=65; rb=10; domain=.bing.com')
      expect(res.valid).toBe(true)
      expect(res.balance).toBe(12993)
      expect(res.balance).not.toBe(65)
      expect(res.streakDays).toBe(120)
    })

    it('extracts real balance and todayPoints from userStatus and does not get confused by activityCards reward points (e.g. 222)', async () => {
      const mockFetch = vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              userStatus: {
                availablePoints: 13150,
                counters: {
                  dailyPoint: [{ pointProgress: 275, pointProgressMax: 300 }],
                  pcSearch: [{ pointProgress: 30, pointProgressMax: 60 }]
                },
                streakInfo: { currentStreak: 15 }
              },
              activityCards: [{ name: 'card1', availablePoints: 222 }]
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
        )
      )
      const engine = new FastApiEngine(mockFetch)
      const res = await engine.checkCookieStatus('WLS=ts=1&t=saarjoye; _EDGE_S=F=1; domain=.bing.com')
      expect(res.valid).toBe(true)
      expect(res.balance).toBe(13150)
      expect(res.todayPoints).toBe(275)
      expect(res.balance).not.toBe(222)
      expect(res.pcSearch).toBe('30/60')
      expect(res.streakDays).toBe(15)
    })

    it('does not mistake Bing search counter rc=65 for points when balance is absent from html', async () => {
      const mockFetch = vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ userStatus: { counters: { pcSearch: [{ pointProgress: 65, pointProgressMax: 60 }] } } }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          })
        )
      )
      const engine = new FastApiEngine(mockFetch)
      const res = await engine.checkCookieStatus('WLS=ts=1&t=saarjoye; _EDGE_S=F=1&rc=65; domain=.bing.com')
      expect(res.valid).toBe(false)
      expect(res.balance).toBeUndefined()
      expect(res.message).toContain('api/getuserinfo')
    })

    it('prioritizes official authoritative api/getuserinfo JSON response for balance and todayPoints', async () => {
      const mockFetch = vi.fn((url: string | URL | Request) => {
        const u = urlToString(url)
        if (u.includes('api/getuserinfo')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                userStatus: {
                  availablePoints: 13150,
                  currentStreak: 12,
                  counters: {
                    dailyPoint: [{ pointProgress: 222, pointProgressMax: 300 }],
                    pcSearch: [{ pointProgress: 60, pointProgressMax: 60 }]
                  }
                }
              }),
              {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
              }
            )
          )
        }
        return Promise.resolve(new Response('<html></html>', { status: 200 }))
      })

      const engine = new FastApiEngine(mockFetch)
      const res = await engine.checkCookieStatus('WLS=ts=1&t=saarjoye; session=abc; domain=.bing.com')
      expect(res.valid).toBe(true)
      expect(res.balance).toBe(13150)
      expect(res.todayPoints).toBe(222)
      expect(res.streakDays).toBe(12)
      expect(res.pcSearch).toBe('60/60')
      expect(res.message).toContain('积分: 13150')
      expect(res.message).toContain('今日: +222')
    })

    it('extracts comma-formatted balance (e.g. 13,150) and todayPoints (222) from HTML text anchors', async () => {
      const html = `
        <html>
          <body>
            <div>可用积分: 13,150</div>
            <div>今日获得: +222</div>
            <div>每日连续打卡 20 �?/div>
          </body>
        </html>
      `
      const mockFetch = vi.fn((url: string | URL | Request) => {
        const u = urlToString(url)
        if (u.includes('api/getuserinfo')) {
          return Promise.resolve(new Response('not found', { status: 404 }))
        }
        return Promise.resolve(new Response(html, { status: 200 }))
      })

      const engine = new FastApiEngine(mockFetch)
      const res = await engine.checkCookieStatus('WLS=ts=1&t=saarjoye; session=abc; domain=.bing.com')
      expect(res.valid).toBe(false)
      expect(res.balance).toBeUndefined()
      expect(res.message).toContain('HTTP 404')
    })

    it('returns invalid on 401', async () => {
      const mockFetch = vi.fn(() => Promise.resolve(new Response('unauthorized', { status: 401 })))
      const engine = new FastApiEngine(mockFetch)
      const res = await engine.checkCookieStatus('WLS=ts=1&t=saarjoye; domain=.bing.com')
      expect(res.valid).toBe(false)
      expect(res.message).toContain('HTTP 401')
    })
  })

  describe('checkTokenStatus', () => {
    it('recognizes valid DAPI response', async () => {
      const mockFetch = vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              response: {
                balance: 12500,
                promotions: [
                  {
                    attributes: {
                      offerid: 'ENUS_readarticle3_30points',
                      progress: 20,
                      max: 30
                    }
                  }
                ]
              }
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
        )
      )

      const engine = new FastApiEngine(mockFetch)
      const res = await engine.checkTokenStatus({
        accessToken: 'valid-token',
        expiresAt: new Date(Date.now() + 3600_000).toISOString()
      })
      expect(res.valid).toBe(true)
      expect(res.balance).toBe(12500)
      expect(res.readProgress).toBe('20/30')
    })
  })

  describe('runVisualSearchStreak', () => {
    it('submits visual search request', async () => {
      const mockFetch = vi.fn(() => Promise.resolve(new Response('ok', { status: 200 })))
      const engine = new FastApiEngine(mockFetch)
      const ok = await engine.runVisualSearchStreak('foo=bar')
      expect(ok).toBe(true)
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('features=vsstreak,vstooltip'),
        expect.anything()
      )
    })
  })

  describe('testAccount dual-track consistency check', () => {
    it('marks conflict and sets overallValid: false when Cookie and Token balances diverge by > 100', async () => {
      const engine = new FastApiEngine()
      vi.spyOn(engine, 'checkCookieStatus').mockResolvedValue({
        valid: true,
        balance: 1017,
        userName: 'cookie-user',
        message: 'Cookie 有效'
      })
      vi.spyOn(engine, 'checkTokenStatus').mockResolvedValue({
        valid: true,
        balance: 12928,
        message: 'Token 有效'
      })

      const res = await engine.testAccount({
        accountId: 'acc-1',
        cookieStr: 'some-cookie',
        token: { accessToken: 'token-1', expiresAt: '2026-10-15T00:00:00Z' }
      })

      expect(res.conflict).toBe(true)
      expect(res.overallValid).toBe(false)
      expect(res.conflictMessage).toContain('双轨凭据冲突')
      expect(res.conflictMessage).toContain('1017')
      expect(res.conflictMessage).toContain('12928')
    })

    it('marks overallValid: true and conflict: false when Cookie and Token balances are consistent', async () => {
      const engine = new FastApiEngine()
      vi.spyOn(engine, 'checkCookieStatus').mockResolvedValue({
        valid: true,
        balance: 12928,
        userName: 'same-user',
        message: 'Cookie 有效'
      })
      vi.spyOn(engine, 'checkTokenStatus').mockResolvedValue({
        valid: true,
        balance: 12950,
        message: 'Token 有效'
      })

      const res = await engine.testAccount({
        accountId: 'acc-1',
        cookieStr: 'some-cookie',
        token: { accessToken: 'token-1', expiresAt: '2026-10-15T00:00:00Z' }
      })

      expect(res.conflict).toBeUndefined()
      expect(res.overallValid).toBe(true)
      expect(res.balance).toBe(12928)
    })

    it('does not trigger conflict when Cookie balance is undefined and Token balance is present', async () => {
      const engine = new FastApiEngine()
      vi.spyOn(engine, 'checkCookieStatus').mockResolvedValue({
        valid: true,
        userName: 'same-user',
        message: 'Cookie 有效'
      })
      vi.spyOn(engine, 'checkTokenStatus').mockResolvedValue({
        valid: true,
        balance: 12993,
        message: 'Token 有效'
      })

      const res = await engine.testAccount({
        accountId: 'acc-1',
        cookieStr: 'some-cookie',
        token: { accessToken: 'token-1', expiresAt: '2026-10-15T00:00:00Z' }
      })

      expect(res.conflict).toBeUndefined()
      expect(res.overallValid).toBe(true)
      expect(res.balance).toBe(12993)
    })


    it('self-heals and avoids false conflict when Cookie balance was misattributed to todayPoints (e.g. 222 vs 13150)', async () => {
      const engine = new FastApiEngine()
      vi.spyOn(engine, 'checkCookieStatus').mockResolvedValue({
        valid: true,
        balance: 222,
        todayPoints: 222,
        userName: 'cookie-user',
        message: 'Cookie 有效'
      })
      vi.spyOn(engine, 'checkTokenStatus').mockResolvedValue({
        valid: true,
        balance: 13150,
        message: 'Token 有效'
      })

      const res = await engine.testAccount({
        accountId: 'acc-1',
        cookieStr: 'some-cookie',
        token: { accessToken: 'token-1', expiresAt: '2026-10-15T00:00:00Z' }
      })

      expect(res.conflict).toBe(true)
      expect(res.overallValid).toBe(false)
      expect(res.balance).toBe(222)
      expect(res.todayPoints).toBe(222)
    })  })
});
