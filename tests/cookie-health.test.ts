import { describe, expect, it, vi } from 'vitest'

import { FastApiEngine } from '../src/auth/FastApiEngine.js'

const authCookie = 'WLS=ts=1&t=user; domain=.bing.com'

describe('cookie health check (anonymous /earn regression)', () => {
  it('does not treat a login-page HTML response as logged in', async () => {
    const html = '<html><body>Sign in to your Microsoft account</body></html>'
    const mockFetch = vi.fn(() =>
      Promise.resolve(new Response(html, { status: 200, headers: { 'Content-Type': 'text/html' } }))
    )
    const engine = new FastApiEngine(mockFetch)
    const res = await engine.checkCookieStatus(authCookie)
    expect(res.valid).toBe(false)
    expect(res.balance).toBeUndefined()
    expect(res.message).toContain('JSON')
  })

  it('does not map pointsCounters.totalPoints to balance', async () => {
    const payload = JSON.stringify({
      pointsCounters: { totalPoints: 222, pc: { progress: 15, max: 60 } }
    })
    const mockFetch = vi.fn(() =>
      Promise.resolve(
        new Response(payload, { status: 200, headers: { 'Content-Type': 'application/json' } })
      )
    )
    const engine = new FastApiEngine(mockFetch)
    const res = await engine.checkCookieStatus(authCookie)
    expect(res.valid).toBe(false)
    expect(res.balance).toBeUndefined()
    expect(res.message).toContain('availablePoints')
  })

  it('returns invalid on 401 without falling back to /earn', async () => {
    const mockFetch = vi.fn(() => Promise.resolve(new Response('unauthorized', { status: 401 })))
    const engine = new FastApiEngine(mockFetch)
    const res = await engine.checkCookieStatus(authCookie)
    expect(res.valid).toBe(false)
    expect(res.balance).toBeUndefined()
    expect(res.message).toContain('401')
  })

  it('accepts only authoritative balance fields', async () => {
    const payload = JSON.stringify({
      userInfo: { balance: 12993 },
      userStatus: { availablePoints: 12993 }
    })
    const mockFetch = vi.fn(() =>
      Promise.resolve(
        new Response(payload, { status: 200, headers: { 'Content-Type': 'application/json' } })
      )
    )
    const engine = new FastApiEngine(mockFetch)
    const res = await engine.checkCookieStatus(authCookie)
    expect(res.valid).toBe(true)
    expect(res.balance).toBe(12993)
  })
})