import { EventEmitter } from 'node:events'
import type { connect, OutgoingHttpHeaders } from 'node:http2'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { AppPlatformClient } from '../src/browser/AppPlatformClient.js'
import { PLATFORM_ORIGIN } from '../src/browser/Urls.js'

class Stream extends EventEmitter {
  destroyed = false
  body: string | undefined
  end = vi.fn((body?: string) => {
    this.body = body
  })
  destroy = vi.fn(() => {
    this.destroyed = true
    this.emit('close')
  })

  respond(status = 200, text = '{"response":{"balance":10}}'): void {
    this.emit('response', { ':status': status })
    this.emit('data', Buffer.from(text))
    this.emit('end')
    this.emit('close')
  }
}

class Session extends EventEmitter {
  closed = false
  destroyed = false
  streams: Stream[] = []
  headers: OutgoingHttpHeaders[] = []
  request = vi.fn((headers: OutgoingHttpHeaders) => {
    this.headers.push(headers)
    const stream = new Stream()
    this.streams.push(stream)
    return stream
  })
  destroy = vi.fn(() => {
    this.destroyed = true
    for (const stream of this.streams) stream.destroy()
  })
  close = vi.fn(() => {
    this.closed = true
  })
}

function item<T>(rows: readonly T[], index: number): T {
  const row = rows[index]
  if (row === undefined) throw new Error('Missing synthetic item')
  return row
}

function setup() {
  const sessions: Session[] = []
  const connector = vi.fn(() => {
    const session = new Session()
    sessions.push(session)
    return session
  })
  const client = new AppPlatformClient(connector as unknown as typeof connect)
  return { client, sessions, connector }
}

const headers = { Authorization: 'Bearer synthetic-private-canary', Accept: 'application/json' }

afterEach(() => {
  vi.useRealTimers()
})

describe('account App HTTP/2 transport', () => {
  it('reuses a connection, preserves headers and sends a POST exactly once to a fixed origin', async () => {
    const { client, sessions, connector } = setup()
    const first = client.getDashboard(headers, 1_000)
    item(item(sessions, 0).streams, 0).respond()
    const response = await first
    expect(response.ok()).toBe(true)
    expect(JSON.parse(await response.text())).toEqual({ response: { balance: 10 } })
    await response.dispose()
    expect(await response.text()).toBe('')
    const second = client.getDashboard(headers, 1_000)
    item(item(sessions, 0).streams, 1).respond()
    await second
    const payload = { type: 103, amount: 1 }
    const post = client.submitActivity(headers, payload, 1_000)
    item(item(sessions, 0).streams, 2).respond(503)
    expect((await post).status()).toBe(503)
    expect(connector).toHaveBeenCalledExactlyOnceWith(PLATFORM_ORIGIN)
    expect(item(sessions, 0).request.mock.calls.map(([h]) => [h[':method'], h[':path']])).toEqual([
      ['GET', '/dapi/me?channel=SAIOS&options=613'],
      ['GET', '/dapi/me?channel=SAIOS&options=613'],
      ['POST', '/dapi/me/activities']
    ])
    expect(item(item(sessions, 0).request.mock.calls, 0)[0].authorization).toBe(
      headers.Authorization
    )
    expect(item(item(sessions, 0).streams, 2).body).toBe(JSON.stringify(payload))
    client.close()
  })

  it('never follows an authentication redirect', async () => {
    const { client, sessions, connector } = setup()
    const read = client.getDashboard(headers, 1_000)
    item(item(sessions, 0).streams, 0).respond(302, 'redirect')
    const response = await read
    expect(response.ok()).toBe(false)
    expect(response.status()).toBe(302)
    expect(connector).toHaveBeenCalledTimes(1)
    expect(item(sessions, 0).request).toHaveBeenCalledTimes(1)
    client.close()
  })

  it('bounds body size and destroys the stream without exposing its contents', async () => {
    const { client, sessions } = setup()
    const read = client.getDashboard(headers, 1_000)
    const rejection = expect(read).rejects.toThrow('App platform response-too-large')
    item(item(sessions, 0).streams, 0).respond(200, 'x'.repeat(4 * 1024 * 1024 + 1))
    await rejection
    expect(item(item(sessions, 0).streams, 0).destroyed).toBe(true)
    client.close()
  })

  it('aborts an active stream and clears its timeout, preserving the cancellation reason', async () => {
    vi.useFakeTimers()
    const { client, sessions } = setup()
    const controller = new AbortController()
    const read = client.getDashboard(headers, 15_000, controller.signal)
    const reason = new Error('synthetic-user-cancel')
    const rejection = expect(read).rejects.toBe(reason)
    controller.abort(reason)
    await rejection
    expect(item(item(sessions, 0).streams, 0).destroyed).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    // A late error is handled but never changes the cancelled result.
    item(item(sessions, 0).streams, 0).emit('error', new Error('late-private-canary'))
    client.close()
  })

  it('does not connect or send when already cancelled', async () => {
    const { client, connector } = setup()
    const controller = new AbortController()
    const reason = new Error('cancel-before-request')
    controller.abort(reason)
    await expect(
      client.submitActivity(headers, { amount: 1 }, 1_000, controller.signal)
    ).rejects.toBe(reason)
    expect(connector).not.toHaveBeenCalled()
  })

  it('times out without replaying a submission or leaving timers and streams alive', async () => {
    vi.useFakeTimers()
    const { client, sessions, connector } = setup()
    const post = client.submitActivity(headers, { amount: 1 }, 20_000)
    const rejection = expect(post).rejects.toThrow('App platform timeout')
    await vi.advanceTimersByTimeAsync(20_000)
    await rejection
    expect(item(item(sessions, 0).streams, 0).destroyed).toBe(true)
    expect(item(sessions, 0).request).toHaveBeenCalledTimes(1)
    expect(connector).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
    client.close()
  })

  it('sanitizes network failures and replaces a failed connection only on an explicit next request', async () => {
    const { client, sessions, connector } = setup()
    const read = client.getDashboard(headers, 1_000)
    const rejection = expect(read).rejects.toThrow('App platform network')
    item(sessions, 0).emit('error', new Error('private-network-canary'))
    await rejection
    expect(connector).toHaveBeenCalledTimes(1)
    const next = client.getDashboard(headers, 1_000)
    item(item(sessions, 1).streams, 0).respond()
    await next
    expect(connector).toHaveBeenCalledTimes(2)
    client.close()
  })

  it('retires a GOAWAY session for future reads', async () => {
    const { client, sessions } = setup()
    const first = client.getDashboard(headers, 1_000)
    item(item(sessions, 0).streams, 0).respond()
    await first
    item(sessions, 0).emit('goaway')
    const next = client.getDashboard(headers, 1_000)
    item(item(sessions, 1).streams, 0).respond()
    await next
    expect(item(sessions, 0).closed).toBe(true)
    client.close()
  })

  it('closes in-flight requests and permanently prevents new ones', async () => {
    const { client, sessions, connector } = setup()
    const read = client.getDashboard(headers, 1_000)
    const rejection = expect(read).rejects.toThrow('App platform network')
    client.close()
    await rejection
    expect(item(sessions, 0).destroyed).toBe(true)
    await expect(client.getDashboard(headers, 1_000)).rejects.toThrow('App platform closed')
    expect(connector).toHaveBeenCalledTimes(1)
  })

  it('keeps accounts on separate connections', async () => {
    const first = setup()
    const second = setup()
    const a = first.client.getDashboard(headers, 1_000)
    const b = second.client.getDashboard({ Authorization: 'Bearer other-synthetic-canary' }, 1_000)
    item(item(first.sessions, 0).streams, 0).respond()
    item(item(second.sessions, 0).streams, 0).respond()
    await Promise.all([a, b])
    expect(first.sessions[0]).not.toBe(second.sessions[0])
    first.client.close()
    expect(item(second.sessions, 0).destroyed).toBe(false)
    second.client.close()
  })
})
