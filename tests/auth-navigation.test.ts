import type { Page } from 'patchright'
import { describe, expect, it, vi } from 'vitest'

import { navigateForAuthentication } from '../src/browser/AuthNavigation.js'
import { REWARDS_URLS } from '../src/browser/Urls.js'

function navigationPage(goto = vi.fn().mockResolvedValue(null)) {
  const close = vi.fn().mockResolvedValue(undefined)
  const page = { goto, close, url: () => REWARDS_URLS.dashboard } as unknown as Page
  return { page, goto, close }
}

function navigationError(name: string): Error {
  const error = new Error(
    'synthetic failure https://login.live.com/login.srf?code=navigation-canary&state=state-canary'
  )
  error.name = name
  return error
}

describe('bounded authentication navigation', () => {
  it('waits for commit once without treating navigation as verified authentication', async () => {
    const f = navigationPage()
    await expect(
      navigateForAuthentication(f.page, REWARDS_URLS.dashboard, new AbortController().signal)
    ).resolves.toBeUndefined()
    expect(f.goto).toHaveBeenCalledExactlyOnceWith(REWARDS_URLS.dashboard, {
      waitUntil: 'commit',
      timeout: 30_000
    })
    expect(f.close).not.toHaveBeenCalled()
  })

  it('caps the timeout at the remaining login budget', async () => {
    const f = navigationPage()
    await navigateForAuthentication(f.page, REWARDS_URLS.login, new AbortController().signal, 1_250)
    expect(f.goto).toHaveBeenCalledWith(REWARDS_URLS.login, { waitUntil: 'commit', timeout: 1_250 })
  })

  it.each([
    ['TimeoutError', 'login-navigation-timeout'],
    ['Error', 'login-navigation-error']
  ])('keeps %s failures unknown and removes raw navigation details', async (name, stage) => {
    const f = navigationPage(vi.fn().mockRejectedValue(navigationError(name)))
    const error = await navigateForAuthentication(
      f.page,
      REWARDS_URLS.login,
      new AbortController().signal
    ).catch((value: unknown) => value)
    expect(error).toMatchObject({
      name: 'LoginStateError',
      loginState: 'unknown',
      loginStage: stage,
      url: REWARDS_URLS.dashboard
    })
    expect(String(error)).not.toContain('navigation-canary')
    expect(String(error)).not.toContain('state-canary')
    expect(f.goto).toHaveBeenCalledTimes(1)
  })

  it('does not start navigation with an exhausted timeout budget', async () => {
    const f = navigationPage()
    await expect(
      navigateForAuthentication(f.page, REWARDS_URLS.login, new AbortController().signal, 0)
    ).rejects.toMatchObject({ loginStage: 'login-navigation-timeout' })
    expect(f.goto).not.toHaveBeenCalled()
  })

  it('does not navigate or close a page when cancellation already happened', async () => {
    const f = navigationPage()
    const abort = new AbortController()
    const reason = new Error('synthetic-abort')
    abort.abort(reason)
    await expect(navigateForAuthentication(f.page, REWARDS_URLS.login, abort.signal)).rejects.toBe(
      reason
    )
    expect(f.goto).not.toHaveBeenCalled()
    expect(f.close).not.toHaveBeenCalled()
  })

  it('closes the owned page before finishing cancellation of a pending navigation', async () => {
    let rejectNavigation: (reason: Error) => void = () => undefined
    const goto = vi.fn(
      () =>
        new Promise<null>((_resolve, reject) => {
          rejectNavigation = reject
        })
    )
    const f = navigationPage(goto)
    let closed = false
    f.close.mockImplementation(() =>
      Promise.resolve().then(() => {
        closed = true
        rejectNavigation(new Error('synthetic page closed'))
      })
    )
    const abort = new AbortController()
    const reason = new Error('synthetic-navigation-cancelled')
    const running = navigateForAuthentication(f.page, REWARDS_URLS.login, abort.signal)
    const rejected = expect(running).rejects.toBe(reason)
    abort.abort(reason)
    await rejected
    expect(closed).toBe(true)
    expect(f.close).toHaveBeenCalledExactlyOnceWith({ runBeforeUnload: false })
    expect(goto).toHaveBeenCalledTimes(1)
  })

  it('removes the cancellation listener after a completed navigation', async () => {
    const f = navigationPage()
    const abort = new AbortController()
    await navigateForAuthentication(f.page, REWARDS_URLS.login, abort.signal)
    abort.abort(new Error('synthetic later cancellation'))
    await Promise.resolve()
    expect(f.close).not.toHaveBeenCalled()
  })
})
