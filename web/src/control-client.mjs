export class ControlApiError extends Error {
    constructor(message, { status = 0, code = 'CONTROL_API_ERROR' } = {}) {
        super(message)
        this.name = 'ControlApiError'
        this.status = status
        this.code = code
    }
}

export class ControlApiClient {
    constructor({ baseUrl, token, timeoutMs = 8000, fetchImpl = fetch }) {
        const parsed = new URL(baseUrl)
        if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('CONTROL_API_URL 仅支持 HTTP 或 HTTPS')
        this.baseUrl = parsed.toString().replace(/\/$/, '')
        this.token = token || ''
        this.timeoutMs = timeoutMs
        this.fetchImpl = fetchImpl
    }

    headers(extra = {}) {
        return {
            Accept: 'application/json',
            ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
            ...extra
        }
    }

    async request(pathname, options = {}) {
        const timeout = options.timeoutMs ?? this.timeoutMs
        let response
        try {
            response = await this.fetchImpl(`${this.baseUrl}${pathname}`, {
                method: options.method ?? 'GET',
                headers: this.headers(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
                body: options.body === undefined ? undefined : JSON.stringify(options.body),
                signal: AbortSignal.timeout(timeout)
            })
        } catch (error) {
            const code = error?.name === 'TimeoutError' ? 'CONTROL_TIMEOUT' : 'CONTROL_UNAVAILABLE'
            throw new ControlApiError(code === 'CONTROL_TIMEOUT' ? '核心接口请求超时' : '核心接口不可用', { code })
        }

        let data = null
        try {
            data = await response.json()
        } catch {}
        if (!response.ok) {
            throw new ControlApiError(data?.error || `核心接口返回 HTTP ${response.status}`, {
                status: response.status,
                code: data?.code || 'CONTROL_HTTP_ERROR'
            })
        }
        return data
    }

    get(pathname) {
        return this.request(pathname)
    }

    post(pathname, body) {
        return this.request(pathname, { method: 'POST', body, timeoutMs: 20000 })
    }

    patch(pathname, body) {
        return this.request(pathname, { method: 'PATCH', body, timeoutMs: 20000 })
    }

    delete(pathname, body = {}) {
        return this.request(pathname, { method: 'DELETE', body, timeoutMs: 20000 })
    }

    async openEventStream({ signal, onEvent }) {
        let response
        try {
            response = await this.fetchImpl(`${this.baseUrl}/events?replay=100`, {
                headers: this.headers({ Accept: 'text/event-stream' }),
                signal
            })
        } catch {
            if (signal.aborted) return
            throw new ControlApiError('核心事件流不可用', { code: 'CONTROL_UNAVAILABLE' })
        }
        if (!response.ok || !response.body) {
            throw new ControlApiError(`核心事件流返回 HTTP ${response.status}`, {
                status: response.status,
                code: 'CONTROL_HTTP_ERROR'
            })
        }

        const decoder = new TextDecoder()
        let buffer = ''
        for await (const chunk of response.body) {
            buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n')
            let boundary
            while ((boundary = buffer.indexOf('\n\n')) >= 0) {
                const frame = buffer.slice(0, boundary)
                buffer = buffer.slice(boundary + 2)
                const parsed = parseSseFrame(frame)
                if (parsed) onEvent(parsed)
            }
        }
    }
}

export function parseSseFrame(frame) {
    let event = 'message'
    let id = null
    const data = []
    for (const line of String(frame).split('\n')) {
        if (!line || line.startsWith(':')) continue
        const colon = line.indexOf(':')
        const field = colon < 0 ? line : line.slice(0, colon)
        const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '')
        if (field === 'event') event = value
        else if (field === 'id') id = value
        else if (field === 'data') data.push(value)
    }
    if (!data.length) return null
    try {
        return { event, id, data: JSON.parse(data.join('\n')) }
    } catch {
        return null
    }
}
