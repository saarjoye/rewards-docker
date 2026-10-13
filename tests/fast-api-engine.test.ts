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
            <div>每日连续打卡 5 天</div>
            <div aria-label="收集的印章" aria-valuemax="12" aria-valuenow="4"></div>
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
      const mockFetch = vi.fn(() => Promise.resolve(new Response(html, { status: 200 })))
      const engine = new FastApiEngine(mockFetch)
      const res = await engine.checkCookieStatus('N=saarjoye; session=abc')
      expect(res.valid).toBe(true)
      expect(res.balance).toBe(8888)
      expect(res.pcSearch).toBe('15/60')
      expect(res.streakDays).toBe(5)
      expect(res.stamps?.progress).toBe(4)
      expect(res.userName).toBe('saarjoye')
    })

    it('returns invalid on 401', async () => {
      const mockFetch = vi.fn(() => Promise.resolve(new Response('unauthorized', { status: 401 })))
      const engine = new FastApiEngine(mockFetch)
      const res = await engine.checkCookieStatus('foo=bar')
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
})