import { connect, type ClientHttp2Session } from 'node:http2'

import { PLATFORM_ORIGIN, REWARDS_URLS } from './Urls.js'

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024

export interface AppPlatformResponse {
  ok(): boolean
  status(): number
  text(): Promise<string>
  dispose(): Promise<void>
}

export interface AppPlatformTransport {
  getDashboard(
    headers: Readonly<Record<string, string>>,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<AppPlatformResponse>
  submitActivity(
    headers: Readonly<Record<string, string>>,
    payload: Readonly<Record<string, unknown>>,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<AppPlatformResponse>
  reset(): void
  close(): void
}

export class AppPlatformRequestError extends Error {
  constructor(readonly reason: 'closed' | 'timeout' | 'network' | 'response-too-large') {
    super(`App platform ${reason}`)
    this.name = 'AppPlatformRequestError'
  }
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('Operation was aborted')
}

/** One connection per account client, fixed destinations, and no request replay. */
export class AppPlatformClient implements AppPlatformTransport {
  private session: ClientHttp2Session | undefined
  private readonly sessions = new Set<ClientHttp2Session>()
  private closed = false

  constructor(private readonly connector: typeof connect = connect) {}

  getDashboard(
    headers: Readonly<Record<string, string>>,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<AppPlatformResponse> {
    return this.request('GET', REWARDS_URLS.appDashboard, headers, timeoutMs, signal)
  }

  submitActivity(
    headers: Readonly<Record<string, string>>,
    payload: Readonly<Record<string, unknown>>,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<AppPlatformResponse> {
    return this.request(
      'POST',
      REWARDS_URLS.appActivities,
      headers,
      timeoutMs,
      signal,
      JSON.stringify(payload)
    )
  }

  reset(): void {
    const session = this.session
    this.session = undefined
    session?.destroy()
  }

  close(): void {
    this.closed = true
    this.session = undefined
    for (const session of this.sessions) session.destroy()
    this.sessions.clear()
  }

  private connection(): ClientHttp2Session {
    if (this.closed) throw new AppPlatformRequestError('closed')
    if (this.session && !this.session.closed && !this.session.destroyed) return this.session
    const session = this.connector(PLATFORM_ORIGIN)
    this.session = session
    this.sessions.add(session)
    session.on('close', () => {
      this.sessions.delete(session)
    })
    // Keep an error listener for the entire session lifetime, including late TLS failures.
    session.on('error', () => {
      if (this.session === session) this.session = undefined
      session.destroy()
    })
    session.on('goaway', () => {
      if (this.session === session) this.session = undefined
      session.close()
    })
    return session
  }

  private async request(
    method: 'GET' | 'POST',
    url: string,
    headers: Readonly<Record<string, string>>,
    timeoutMs: number,
    signal?: AbortSignal,
    body?: string
  ): Promise<AppPlatformResponse> {
    if (signal?.aborted) throw abortReason(signal)
    const target = new URL(url)
    let session: ClientHttp2Session
    try {
      session = this.connection()
    } catch (error) {
      if (error instanceof AppPlatformRequestError) throw error
      throw new AppPlatformRequestError('network')
    }
    return new Promise<AppPlatformResponse>((resolve, reject) => {
      let stream: ReturnType<ClientHttp2Session['request']>
      try {
        stream = session.request({
          ...Object.fromEntries(
            Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])
          ),
          ':method': method,
          ':path': target.pathname + target.search
        })
      } catch {
        reject(new AppPlatformRequestError('network'))
        return
      }
      let finished = false
      let ended = false
      let status = 0
      let size = 0
      const chunks: Buffer[] = []
      const finish = (error?: Error): void => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        if (error) {
          chunks.length = 0
          stream.destroy()
          reject(error)
          return
        }
        let text = Buffer.concat(chunks).toString('utf8')
        chunks.length = 0
        resolve({
          ok: () => status >= 200 && status < 300,
          status: () => status,
          text: () => Promise.resolve(text),
          dispose: () => {
            text = ''
            return Promise.resolve()
          }
        })
      }
      const onAbort = (): void => {
        if (signal) finish(abortReason(signal))
      }
      const timer = setTimeout(() => {
        finish(new AppPlatformRequestError('timeout'))
      }, timeoutMs)
      signal?.addEventListener('abort', onAbort, { once: true })
      stream.on('response', (responseHeaders) => {
        status = Number(responseHeaders[':status']) || 0
      })
      stream.on('data', (chunk: Buffer) => {
        if (finished) return
        size += chunk.length
        if (size > MAX_RESPONSE_BYTES) {
          finish(new AppPlatformRequestError('response-too-large'))
          return
        }
        chunks.push(chunk)
      })
      stream.on('end', () => {
        ended = true
        finish(status === 0 ? new AppPlatformRequestError('network') : undefined)
      })
      stream.on('error', () => {
        finish(new AppPlatformRequestError('network'))
      })
      stream.on('close', () => {
        if (!ended) finish(new AppPlatformRequestError('network'))
      })
      if (signal?.aborted) onAbort()
      if (!stream.destroyed) {
        try {
          stream.end(body)
        } catch {
          finish(new AppPlatformRequestError('network'))
        }
      }
    })
  }
}
