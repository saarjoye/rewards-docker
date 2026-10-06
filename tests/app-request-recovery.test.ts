import { EventEmitter } from 'node:events'
import type { BrowserContext, Page } from 'patchright'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DashboardClient, DashboardFetchError } from '../src/browser/DashboardClient.js'
import { AppAuthorizationSession } from '../src/browser/AppAuthorizationSession.js'
import type { AppOAuthClient } from '../src/browser/AppOAuthClient.js'
import { BusinessDateChanged } from '../src/orchestration/BusinessDate.js'
import type { AppPlatformTransport } from '../src/browser/AppPlatformClient.js'
import type { StructuredLogger } from '../src/infra/StructuredLogger.js'

function response(status = 200, body: unknown = { response: { balance: 42 } }) {
  return {
    ok: () => status >= 200 && status < 300,
    status: () => status,
    text: vi.fn().mockResolvedValue(typeof body === 'string' ? body : JSON.stringify(body)),
    dispose: vi.fn().mockResolvedValue(undefined)
  }
}

function setup() {
  const context = new EventEmitter()
  const get = vi.fn().mockResolvedValue(response())
  const post = vi.fn().mockResolvedValue(response())
  Object.assign(context, { request: { get, post } })
  const transport = {
    getDashboard: vi.fn<AppPlatformTransport['getDashboard']>().mockResolvedValue(response()),
    submitActivity: vi.fn<AppPlatformTransport['submitActivity']>().mockResolvedValue(response()),
    reset: vi.fn(),
    close: vi.fn()
  } satisfies AppPlatformTransport
  const logger = { write: vi.fn().mockResolvedValue(undefined) }
  const observed = vi.fn()
  const client = new DashboardClient(
    context as unknown as BrowserContext,
    {} as Page,
    logger as unknown as StructuredLogger,
    'synthetic-run',
    'synthetic-account',
    observed,
    transport
  )
  return { client, context, get, post, transport, logger, observed }
}

const token = 'synthetic-token-private-canary'
afterEach(() => {
  vi.useRealTimers()
})

describe('App request recovery', () => {
  it('shares the 401 limit across successful reads and later stages without replaying submissions', async () => {
    const { client, get, post, transport } = setup()
    get.mockResolvedValue(response(401))
    await client.fetchAppDashboard(token)
    transport.getDashboard.mockResolvedValueOnce(response(401)).mockResolvedValueOnce(response())
    await client.fetchAppDashboard(token)
    transport.getDashboard.mockResolvedValue(response(401))
    await expect(client.fetchAppDashboard(token)).rejects.toMatchObject({ status: 401 })
    const reads = transport.getDashboard.mock.calls.length
    await expect(client.fetchAppDashboard(token)).rejects.toMatchObject({ status: 401 })
    await expect(client.submitAppActivity(token, { type: 103 })).rejects.toMatchObject({
      status: 401
    })
    expect(transport.getDashboard).toHaveBeenCalledTimes(reads)
    expect(get).toHaveBeenCalledTimes(1)
    expect(post).not.toHaveBeenCalled()
    expect(transport.submitActivity).not.toHaveBeenCalled()
    const other = setup()
    expect((await other.client.fetchAppDashboard('other-token')).availablePoints.value).toBe(42)
  })

  it('uses one refreshed token for recovery and later calls, and persists it only after valid balance', async () => {
    const { client, get, transport } = setup()
    const oauth = {
      readStored: vi
        .fn<AppOAuthClient['readStored']>()
        .mockResolvedValue({ accessToken: token, expiresAt: '2099-01-01' }),
      acquire: vi
        .fn<AppOAuthClient['acquire']>()
        .mockResolvedValue({ accessToken: 'synthetic-refreshed', expiresAt: '2099-01-01' }),
      commitVerified: vi.fn<AppOAuthClient['commitVerified']>().mockResolvedValue(undefined)
    }
    const authorization = new AppAuthorizationSession(oauth, 'synthetic-account', {
      email: 'test@example.invalid',
      password: 'synthetic'
    })
    const signal = new AbortController().signal
    await authorization.initialize(signal)
    get.mockResolvedValue(response(401))
    transport.getDashboard.mockResolvedValueOnce(response(401)).mockResolvedValueOnce(response())
    await client.fetchAppDashboard(token, undefined, signal, authorization)
    expect(oauth.acquire).toHaveBeenCalledTimes(1)
    expect(
      transport.getDashboard.mock.calls.every(
        ([headers]) => headers.Authorization === 'Bearer synthetic-refreshed'
      )
    ).toBe(true)
    expect(oauth.commitVerified).toHaveBeenCalledTimes(1)
    await client.fetchAppDashboard(token, undefined, signal, authorization)
    expect(transport.getDashboard.mock.calls.at(-1)?.[0].Authorization).toBe(
      'Bearer synthetic-refreshed'
    )
    expect(oauth.commitVerified).toHaveBeenCalledTimes(1)
  })

  it('does not commit an unusable App snapshot', async () => {
    const { client, get } = setup()
    get.mockResolvedValue(response(200, { response: { promotions: [] } }))
    const authorization = { accessToken: token, refresh: vi.fn(), confirm: vi.fn() }
    const observation = await client.fetchAppDashboard(token, undefined, undefined, authorization)
    expect(observation.availablePoints.availability).not.toBe('valid')
    expect(authorization.confirm).not.toHaveBeenCalled()
  })

  it('does not swallow a business-date change during authorization recovery', async () => {
    const { client, get, transport } = setup()
    get.mockResolvedValue(response(401))
    const changed = new BusinessDateChanged()
    const authorization = {
      accessToken: token,
      refresh: vi.fn().mockRejectedValue(changed),
      confirm: vi.fn()
    }
    await expect(client.fetchAppDashboard(token, undefined, undefined, authorization)).rejects.toBe(
      changed
    )
    expect(transport.getDashboard).not.toHaveBeenCalled()
    expect(authorization.confirm).not.toHaveBeenCalled()
  })

  it('includes authorization recovery in the 45-second deadline', async () => {
    vi.useFakeTimers()
    const { client, get, transport } = setup()
    get.mockResolvedValue(response(401))
    const authorization = {
      accessToken: token,
      refresh: vi.fn(
        (signal: AbortSignal) =>
          new Promise<string>((_resolve, reject) => {
            signal.addEventListener(
              'abort',
              () => {
                reject(signal.reason instanceof Error ? signal.reason : new Error('Cancelled'))
              },
              { once: true }
            )
          })
      ),
      confirm: vi.fn()
    }
    const failed = expect(
      client.fetchAppDashboard(token, undefined, undefined, authorization)
    ).rejects.toThrow('timeout')
    await vi.advanceTimersByTimeAsync(45_000)
    await failed
    expect(transport.getDashboard).not.toHaveBeenCalled()
    expect(authorization.confirm).not.toHaveBeenCalled()
  })

  it('keeps the normal browser API path and disposes its response', async () => {
    const { client, get, transport } = setup()
    const reply = response()
    get.mockResolvedValue(reply)
    const result = await client.fetchAppDashboard(token)
    expect(result.availablePoints.value).toBe(42)
    expect(result.readMetadata).toMatchObject({ attempts: 1, usedFallback: false })
    expect(client.latestObservation).toBe(result)
    expect(transport.getDashboard).not.toHaveBeenCalled()
    expect(reply.dispose).toHaveBeenCalledTimes(1)
    expect(get.mock.calls[0]?.[1]).toMatchObject({ maxRedirects: 0, maxRetries: 0 })
  })

  it.each([401, 403, 502, 503, 504])(
    'recovers a read-only HTTP %s and retains the successful channel',
    async (status) => {
      const { client, get, post, transport } = setup()
      const failed = response(status)
      get.mockResolvedValue(failed)
      const first = await client.fetchAppDashboard(token)
      expect(first.readMetadata).toMatchObject({ attempts: 2, usedFallback: true })
      expect(failed.text).not.toHaveBeenCalled()
      expect(failed.dispose).toHaveBeenCalledTimes(1)
      await client.fetchAppDashboard(token)
      await client.submitAppActivity(token, { type: 103, amount: 1 })
      expect(get).toHaveBeenCalledTimes(1)
      expect(post).not.toHaveBeenCalled()
      expect(transport.getDashboard).toHaveBeenCalledTimes(2)
      expect(transport.submitActivity).toHaveBeenCalledTimes(1)
      expect(transport.submitActivity.mock.calls[0]?.[0]['X-Rewards-IsMobile']).toBe('true')
    }
  )

  it('preserves connections after HTTP rejections and stops after three total reads', async () => {
    const { client, get, transport, observed } = setup()
    const replies = [response(401), response(401), response(401)] as const
    get.mockResolvedValue(replies[0])
    transport.getDashboard.mockResolvedValueOnce(replies[1]).mockResolvedValueOnce(replies[2])
    await expect(client.fetchAppDashboard(token)).rejects.toMatchObject({
      name: 'DashboardFetchError',
      status: 401,
      attempts: 3,
      usedFallback: true
    })
    expect(get).toHaveBeenCalledTimes(1)
    expect(transport.getDashboard).toHaveBeenCalledTimes(2)
    expect(transport.reset).not.toHaveBeenCalled()
    expect(observed).not.toHaveBeenCalled()
    for (const reply of replies) expect(reply.dispose).toHaveBeenCalledTimes(1)
    // A failed probe does not select HTTP/2 for future mutations.
    await expect(client.submitAppActivity(token, { type: 103 })).rejects.toMatchObject({
      status: 401
    })
    expect(transport.submitActivity).not.toHaveBeenCalled()
  })

  it('can succeed on the final bounded read', async () => {
    const { client, get, transport } = setup()
    get.mockResolvedValue(response(401))
    transport.getDashboard.mockResolvedValueOnce(response(401)).mockResolvedValueOnce(response())
    expect((await client.fetchAppDashboard(token)).readMetadata).toMatchObject({ attempts: 3 })
    expect(transport.reset).not.toHaveBeenCalled()
  })

  it('replaces a failed network connection before the final read', async () => {
    const { client, get, transport } = setup()
    get.mockResolvedValue(response(401))
    transport.getDashboard
      .mockRejectedValueOnce(new Error('network synthetic disconnect'))
      .mockResolvedValueOnce(response())
    const result = await client.fetchAppDashboard(token)
    expect(result.readMetadata?.attempts).toBe(3)
    expect(transport.reset).toHaveBeenCalledTimes(1)
  })

  it('bounds elapsed time even when a request consumes the entire deadline', async () => {
    vi.useFakeTimers()
    const { client, get, transport } = setup()
    get.mockImplementation(() => {
      vi.setSystemTime(Date.now() + 45_000)
      return Promise.reject(new Error('network synthetic failure'))
    })
    await expect(client.fetchAppDashboard(token)).rejects.toThrow()
    expect(transport.getDashboard).not.toHaveBeenCalled()
  })

  it('recovers a network read failure without leaking the raw error or token', async () => {
    const { client, get, logger } = setup()
    get.mockRejectedValue(new Error(`network failure https://private.invalid/?token=${token}`))
    await client.fetchAppDashboard(token)
    const logs = JSON.stringify(logger.write.mock.calls)
    expect(logs).toContain('app-dashboard-request')
    expect(logs).not.toContain(token)
    expect(logs).not.toContain('private.invalid')
  })

  it.each([400, 429, 302])('does not probe again after HTTP %s', async (status) => {
    const { client, get, transport } = setup()
    get.mockResolvedValue(response(status))
    await expect(client.fetchAppDashboard(token)).rejects.toBeInstanceOf(DashboardFetchError)
    expect(transport.getDashboard).not.toHaveBeenCalled()
  })

  it('does not treat invalid JSON as a usable observation or replay it', async () => {
    const { client, get, transport, observed } = setup()
    const reply = response(200, 'invalid-json')
    get.mockResolvedValue(reply)
    await expect(client.fetchAppDashboard(token)).rejects.toThrow('Response body is not valid JSON')
    expect(reply.dispose).toHaveBeenCalledTimes(1)
    expect(observed).not.toHaveBeenCalled()
    expect(transport.getDashboard).not.toHaveBeenCalled()
  })

  it('preserves missing balances and does not select an unvalidated channel for POST', async () => {
    const { client, get, transport, post } = setup()
    get.mockResolvedValue(response(401))
    transport.getDashboard.mockResolvedValue(response(200, { response: {} }))
    const result = await client.fetchAppDashboard(token)
    expect(result.availablePoints.availability).not.toBe('valid')
    expect(client.latestObservation).toBeUndefined()
    await client.submitAppActivity(token, { type: 103 })
    expect(post).toHaveBeenCalledTimes(1)
    expect(transport.submitActivity).not.toHaveBeenCalled()
  })

  it('log failures never discard a valid observation', async () => {
    const { client, get, logger } = setup()
    get.mockResolvedValue(response(401))
    logger.write.mockRejectedValue(new Error('synthetic log unavailable'))
    expect((await client.fetchAppDashboard(token)).availablePoints.value).toBe(42)
  })

  it('cancels a browser read promptly and disposes late responses without accepting them', async () => {
    const { client, get, transport, observed } = setup()
    let complete: (reply: ReturnType<typeof response>) => void = () => {
      throw new Error('not started')
    }
    get.mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve
        })
    )
    const controller = new AbortController()
    const pending = client.fetchAppDashboard(token, undefined, controller.signal)
    const reason = new Error('user-cancelled')
    const rejection = expect(pending).rejects.toBe(reason)
    controller.abort(reason)
    await rejection
    const late = response()
    complete(late)
    await Promise.resolve()
    expect(late.dispose).toHaveBeenCalledTimes(1)
    expect(observed).not.toHaveBeenCalled()
    expect(transport.getDashboard).not.toHaveBeenCalled()
  })

  it('closes the account transport with its browser context and rejects new operations', async () => {
    const { client, context, get, transport } = setup()
    context.emit('close')
    await expect(client.fetchAppDashboard(token)).rejects.toThrow('App platform closed')
    await expect(client.submitAppActivity(token, { amount: 1 })).rejects.toThrow(
      'App platform closed'
    )
    expect(transport.close).toHaveBeenCalledTimes(1)
    expect(get).not.toHaveBeenCalled()
  })

  it.each(['browser-api', 'http2'])(
    'never retries or switches a failed POST via %s',
    async (source) => {
      const { client, get, post, transport } = setup()
      if (source === 'http2') {
        get.mockResolvedValue(response(401))
        await client.fetchAppDashboard(token)
        transport.submitActivity.mockResolvedValue(response(503))
      } else {
        post.mockResolvedValue(response(503))
      }
      await expect(client.submitAppActivity(token, { amount: 1 })).rejects.toThrow(
        'App activity HTTP 503'
      )
      expect(post.mock.calls.length + transport.submitActivity.mock.calls.length).toBe(1)
    }
  )

  it('cancels during read backoff without sending another request or leaking timers', async () => {
    vi.useFakeTimers()
    const { client, get, transport } = setup()
    get.mockResolvedValue(response(401))
    const controller = new AbortController()
    const reason = new Error('cancel-during-backoff')
    const pending = client.fetchAppDashboard(token, undefined, controller.signal)
    const rejection = expect(pending).rejects.toBe(reason)
    await vi.advanceTimersByTimeAsync(0)
    controller.abort(reason)
    await rejection
    expect(transport.getDashboard).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not send a pre-cancelled mutation', async () => {
    const { client, post, transport } = setup()
    const controller = new AbortController()
    const reason = new Error('cancel-before-send')
    controller.abort(reason)
    await expect(
      client.submitAppActivity(token, { amount: 1 }, undefined, undefined, controller.signal)
    ).rejects.toBe(reason)
    expect(post).not.toHaveBeenCalled()
    expect(transport.submitActivity).not.toHaveBeenCalled()
  })
})
