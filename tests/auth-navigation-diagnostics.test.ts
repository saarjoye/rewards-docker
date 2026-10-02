import { EventEmitter } from 'node:events'
import type { Page } from 'patchright'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { navigateForAuthentication } from '../src/browser/AuthNavigation.js'
import { REWARDS_URLS } from '../src/browser/Urls.js'

function fixture() {
  const events = new EventEmitter()
  const frame = {}
  const goto = vi.fn().mockResolvedValue(null)
  const close = vi.fn().mockResolvedValue(undefined)
  const page = {
    goto,
    close,
    url: () => 'about:blank',
    mainFrame: () => frame,
    on: events.on.bind(events),
    off: events.off.bind(events)
  } as unknown as Page
  return { page, goto, close, events, frame }
}

afterEach(() => vi.useRealTimers())

describe('safe authentication navigation diagnostics', () => {
  it.each([
    ['net::ERR_NAME_NOT_RESOLVED', 'dns'],
    ['net::ERR_CERT_AUTHORITY_INVALID', 'tls'],
    ['net::ERR_CONNECTION_REFUSED', 'connection'],
    ['net::ERR_TOO_MANY_REDIRECTS', 'redirect'],
    ['net::ERR_INTERNET_DISCONNECTED', 'network'],
    ['Target page, context or browser has been closed', 'browser']
  ])('classifies %s without exposing the raw request', async (message, expected) => {
    const f = fixture()
    f.goto.mockRejectedValue(new Error(message + ' https://example.test/?code=synthetic-secret'))
    const error: unknown = await navigateForAuthentication(
      f.page,
      REWARDS_URLS.dashboard,
      new AbortController().signal
    ).catch((value: unknown) => value)
    expect(error).toMatchObject({ loginState: 'unknown', navigationFailure: expected })
    expect(String(error)).not.toContain('synthetic-secret')
    expect(f.goto).toHaveBeenCalledTimes(1)
    expect(f.close).toHaveBeenCalledTimes(1)
    expect(f.events.eventNames()).toHaveLength(0)
  })

  it('uses only failures from the main document, never a failed subresource', async () => {
    const f = fixture()
    f.goto.mockImplementation(() => {
      f.events.emit('requestfailed', {
        isNavigationRequest: () => false,
        frame: () => f.frame,
        failure: () => ({ errorText: 'net::ERR_NAME_NOT_RESOLVED' })
      })
      const error = new Error('synthetic timeout')
      error.name = 'TimeoutError'
      return Promise.reject(error)
    })
    await expect(
      navigateForAuthentication(f.page, REWARDS_URLS.dashboard, new AbortController().signal)
    ).rejects.toMatchObject({ navigationFailure: 'timeout' })
  })

  it('retains the classified main-document failure when goto ultimately reports a timeout', async () => {
    const f = fixture()
    f.goto.mockImplementation(() => {
      f.events.emit('requestfailed', {
        isNavigationRequest: () => true,
        frame: () => f.frame,
        failure: () => ({ errorText: 'net::ERR_NAME_NOT_RESOLVED' })
      })
      const error = new Error('synthetic timeout')
      error.name = 'TimeoutError'
      return Promise.reject(error)
    })
    await expect(
      navigateForAuthentication(f.page, REWARDS_URLS.dashboard, new AbortController().signal)
    ).rejects.toMatchObject({ loginStage: 'login-navigation-timeout', navigationFailure: 'dns' })
  })

  it('enforces the deadline and closes a stalled navigation even if goto does not settle', async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.goto.mockImplementation(() => new Promise<null>(() => undefined))
    const outcome = navigateForAuthentication(
      f.page,
      REWARDS_URLS.dashboard,
      new AbortController().signal,
      100
    ).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(101)
    expect(await outcome).toMatchObject({ navigationFailure: 'timeout' })
    expect(f.close).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
    expect(f.events.eventNames()).toHaveLength(0)
  })

  it('does not change successful navigation or carry a failed account into later pages', async () => {
    const failed = fixture()
    failed.goto.mockRejectedValue(new Error('net::ERR_CONNECTION_REFUSED'))
    await navigateForAuthentication(
      failed.page,
      REWARDS_URLS.dashboard,
      new AbortController().signal
    ).catch(() => undefined)
    for (let index = 0; index < 2; index += 1) {
      const successful = fixture()
      await navigateForAuthentication(
        successful.page,
        REWARDS_URLS.dashboard,
        new AbortController().signal
      )
      expect(successful.goto).toHaveBeenCalledExactlyOnceWith(REWARDS_URLS.dashboard, {
        waitUntil: 'commit',
        timeout: 30_000
      })
      expect(successful.close).not.toHaveBeenCalled()
      expect(successful.events.eventNames()).toHaveLength(0)
    }
  })
})
