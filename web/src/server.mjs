import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { ControlApiClient, ControlApiError } from './control-client.mjs'
import { HistoryStore } from './history.mjs'
import { AccountIdentity, sanitizeLog, sanitizeText, timingSafeTextEqual } from './security.mjs'
import { SettingsStore } from './settings.mjs'
import { buildPublicState, publicErrorMessage, publicLog } from './status.mjs'
import { WeComNotifier } from './wecom.mjs'
import { RunNotifications } from './run-notifications.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const publicDir = path.resolve(__dirname, '..', 'public')
const dataDir = path.resolve(process.env.WEB_DATA_DIR || path.resolve(__dirname, '..', 'data'))
const host = process.env.WEB_HOST?.trim() || '127.0.0.1'
const port = Number(process.env.WEB_PORT || 3000)
const controlUrl = process.env.CONTROL_API_URL?.trim() || 'http://127.0.0.1:3010'
const controlToken = process.env.CONTROL_API_TOKEN?.trim() || ''
const secureCookie = ['1', 'true', 'yes', 'on'].includes((process.env.WEB_COOKIE_SECURE || '').toLowerCase())

if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('WEB_PORT 无效')
if (!controlToken) throw new Error('必须配置 CONTROL_API_TOKEN')

fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })
const identity = new AccountIdentity(dataDir)
const history = new HistoryStore(dataDir, identity, {
    logRetentionDays: Number(process.env.WEB_LOG_RETENTION_DAYS || 7),
    logLimit: Number(process.env.WEB_LOG_LIMIT || 10000)
})
const control = new ControlApiClient({ baseUrl: controlUrl, token: controlToken })
const settings = new SettingsStore({ dataDir })
const wecom = new WeComNotifier({ settings })
const runNotifications = new RunNotifications({ history, notifier: wecom })
const authFile = path.join(dataDir, 'web-auth.json')
const sessions = new Map()
const loginAttempts = new Map()
const eventClients = new Set()
const SESSION_COOKIE = 'mrs_web_session'
const SESSION_TTL_MS = 12 * 60 * 60 * 1000
const BODY_LIMIT = 128 * 1024

let cache = { status: null, points: null, accounts: null, fetchedAt: null, error: '尚未连接核心' }
let refreshPromise = null
let offline = { failures: 0, since: null }
let shuttingDown = false

function readAuth() {
    try {
        if (!fs.existsSync(authFile)) return null
        const value = JSON.parse(fs.readFileSync(authFile, 'utf8'))
        if (!value?.username || !value?.salt || !value?.passwordHash || !Number.isSafeInteger(value.iterations))
            return null
        return value
    } catch {
        return null
    }
}

function hashPassword(username, password, createdAt = new Date().toISOString()) {
    const salt = crypto.randomBytes(16).toString('hex')
    const iterations = 210000
    return {
        username,
        salt,
        passwordHash: crypto.pbkdf2Sync(password, salt, iterations, 32, 'sha256').toString('hex'),
        iterations,
        createdAt,
        updatedAt: new Date().toISOString()
    }
}

function writeAuth(auth) {
    const temporary = `${authFile}.${process.pid}.tmp`
    fs.writeFileSync(temporary, `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600 })
    fs.renameSync(temporary, authFile)
    try {
        fs.chmodSync(authFile, 0o600)
    } catch {}
}

function initializeAuthFromEnvironment() {
    if (readAuth()) return
    const username = process.env.WEB_ADMIN_USER?.trim()
    const password = process.env.WEB_ADMIN_PASSWORD
    if (username && password) writeAuth(hashPassword(username, password))
}

initializeAuthFromEnvironment()

function verifyPassword(password, auth) {
    const actual = crypto.pbkdf2Sync(password, auth.salt, auth.iterations, 32, 'sha256')
    const expected = Buffer.from(auth.passwordHash, 'hex')
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected)
}

function parseCookies(req) {
    const result = {}
    for (const pair of String(req.headers.cookie || '').split(';')) {
        const index = pair.indexOf('=')
        if (index <= 0) continue
        try {
            result[pair.slice(0, index).trim()] = decodeURIComponent(pair.slice(index + 1).trim())
        } catch {}
    }
    return result
}

function sessionFor(req) {
    const id = parseCookies(req)[SESSION_COOKIE]
    const session = id ? sessions.get(id) : null
    if (!session) return null
    if (session.expiresAt <= Date.now()) {
        sessions.delete(id)
        return null
    }
    session.expiresAt = Date.now() + SESSION_TTL_MS
    return session
}

function createSession(username) {
    const id = crypto.randomBytes(32).toString('hex')
    const session = {
        id,
        username,
        csrfToken: crypto.randomBytes(32).toString('hex'),
        expiresAt: Date.now() + SESSION_TTL_MS
    }
    sessions.set(id, session)
    return session
}

function cookie(value, maxAge = Math.floor(SESSION_TTL_MS / 1000)) {
    return [
        `${SESSION_COOKIE}=${encodeURIComponent(value)}`,
        'HttpOnly',
        'Path=/',
        'SameSite=Strict',
        secureCookie ? 'Secure' : '',
        `Max-Age=${maxAge}`
    ]
        .filter(Boolean)
        .join('; ')
}

function applySecurityHeaders(res) {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('X-Frame-Options', 'DENY')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
    res.setHeader(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
    )
}

function sendJson(res, status, value, headers = {}) {
    applySecurityHeaders(res)
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        ...headers
    })
    res.end(JSON.stringify(value))
}

function sendError(res, status, message, code = 'REQUEST_FAILED') {
    sendJson(res, status, { error: sanitizeText(message, 500), code })
}

async function readJson(req) {
    const chunks = []
    let size = 0
    for await (const chunk of req) {
        size += chunk.length
        if (size > BODY_LIMIT) throw Object.assign(new Error('请求内容过大'), { code: 'BODY_TOO_LARGE' })
        chunks.push(chunk)
    }
    const raw = Buffer.concat(chunks).toString('utf8').trim()
    if (!raw) return {}
    const value = JSON.parse(raw)
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('请求体必须是 JSON 对象')
    return value
}

function validCsrf(req, session) {
    const token = req.headers['x-csrf-token']
    if (typeof token !== 'string' || !timingSafeTextEqual(token, session.csrfToken)) return false
    const origin = req.headers.origin
    if (!origin) return true
    try {
        return new URL(origin).host === String(req.headers.host || '')
    } catch {
        return false
    }
}

function loginAllowed(req) {
    const key = String(req.socket.remoteAddress || 'unknown')
    const now = Date.now()
    const attempts = (loginAttempts.get(key) || []).filter(time => now - time < 60_000)
    attempts.push(now)
    loginAttempts.set(key, attempts)
    return attempts.length <= 8
}

async function notifyRuns(runKeys) {
    runNotifications.enqueue(runKeys)
    await runNotifications.drain()
}

async function noteCoreFailure() {
    offline.failures++
    offline.since ||= new Date().toISOString()
    if (offline.failures !== 3 || !wecom.configured()) return
    const eventKey = `offline:${offline.since}`
    if (history.wasNotified(eventKey)) return
    try {
        await wecom.sendCoreOffline(offline.since)
        history.recordNotification(eventKey, 'core-offline')
    } catch {}
}

async function refreshCore() {
    if (refreshPromise) return refreshPromise
    refreshPromise = (async () => {
        try {
            const [status, points, accounts, historyPayload] = await Promise.all([
                control.get('/status'),
                control.get('/points'),
                control.get('/accounts'),
                control.get('/history?limit=20')
            ])
            const newRuns = history.ingest(status, historyPayload)
            cache = { status, points, accounts, fetchedAt: new Date().toISOString(), error: null }
            offline = { failures: 0, since: null }
            void notifyRuns(newRuns)
            return cache
        } catch (error) {
            cache = {
                ...cache,
                status: null,
                points: null,
                accounts: null,
                fetchedAt: new Date().toISOString(),
                error: publicErrorMessage(error)
            }
            void noteCoreFailure()
            return cache
        } finally {
            refreshPromise = null
        }
    })()
    return refreshPromise
}

function publicState() {
    const state = buildPublicState({
        status: cache.status,
        points: cache.points,
        configuredAccounts: cache.accounts,
        identity,
        historySummary: history.summary(cache.status?.state === 'idle' ? null : cache.status?.runId),
        notificationStatus: wecom.status()
    })
    if (cache.error) state.core.error = cache.error
    return state
}

function writeSse(res, event, data, id) {
    if (res.writableEnded) return
    if (id !== undefined && id !== null) res.write(`id: ${id}\n`)
    res.write(`event: ${event}\n`)
    res.write(`data: ${JSON.stringify(data)}\n\n`)
}

function broadcast(event, data, id) {
    for (const res of eventClients) writeSse(res, event, data, id)
}

let refreshTimer = null
function scheduleRefresh() {
    if (refreshTimer) return
    refreshTimer = setTimeout(async () => {
        refreshTimer = null
        await refreshCore()
        broadcast('state', publicState())
    }, 150)
    refreshTimer.unref?.()
}

async function coreEventLoop() {
    let retryMs = 1000
    while (!shuttingDown) {
        const controller = new AbortController()
        try {
            await control.openEventStream({
                signal: controller.signal,
                onEvent: frame => {
                    retryMs = 1000
                    if (frame.event === 'log') {
                        const log = publicLog(sanitizeLog(frame.data))
                        history.recordLog(log)
                        broadcast('log', log, log.id)
                    } else if (frame.event === 'hello' || frame.event === 'status') {
                        scheduleRefresh()
                    }
                }
            })
        } catch {
            await noteCoreFailure()
        }
        if (shuttingDown) break
        await new Promise(resolve => setTimeout(resolve, retryMs))
        retryMs = Math.min(retryMs * 2, 30000)
    }
}

function serveStatic(res, pathname) {
    const files = {
        '/': ['index.html', 'text/html; charset=utf-8'],
        '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
        '/run-view.js': ['run-view.js', 'text/javascript; charset=utf-8'],
        '/calendar-view.js': ['calendar-view.js', 'text/javascript; charset=utf-8'],
        '/styles.css': ['styles.css', 'text/css; charset=utf-8']
    }
    const target = files[pathname]
    if (!target) return false
    applySecurityHeaders(res)
    res.writeHead(200, {
        'Content-Type': target[1],
        'Cache-Control': pathname === '/' ? 'no-store' : 'no-cache'
    })
    fs.createReadStream(path.join(publicDir, target[0])).pipe(res)
    return true
}

async function handleApi(req, res, url) {
    const auth = readAuth()
    const session = sessionFor(req)

    if (req.method === 'GET' && url.pathname === '/api/bootstrap') {
        return sendJson(res, 200, {
            setupRequired: !auth,
            authenticated: Boolean(session),
            username: session?.username ?? null,
            csrfToken: session?.csrfToken ?? null,
            version: '4.3.2-cn3'
        })
    }

    if (req.method === 'POST' && url.pathname === '/api/setup') {
        if (auth) return sendError(res, 409, '管理员已初始化', 'ALREADY_SETUP')
        if (!loginAllowed(req)) return sendError(res, 429, '请求过于频繁', 'RATE_LIMITED')
        const body = await readJson(req)
        const username = String(body.username || '').trim()
        const password = String(body.password || '')
        if (!/^[A-Za-z0-9._-]{3,64}$/.test(username)) return sendError(res, 400, '用户名格式无效', 'BAD_USERNAME')
        if (password.length < 12 || password.length > 256)
            return sendError(res, 400, '密码长度必须为 12 到 256 位', 'BAD_PASSWORD')
        writeAuth(hashPassword(username, password))
        const created = createSession(username)
        return sendJson(res, 201, { ok: true, csrfToken: created.csrfToken }, { 'Set-Cookie': cookie(created.id) })
    }

    if (req.method === 'POST' && url.pathname === '/api/login') {
        if (!auth) return sendError(res, 409, '请先初始化管理员', 'SETUP_REQUIRED')
        if (!loginAllowed(req)) return sendError(res, 429, '请求过于频繁', 'RATE_LIMITED')
        const body = await readJson(req)
        const usernameOk = timingSafeTextEqual(String(body.username || ''), auth.username)
        const passwordOk = verifyPassword(String(body.password || ''), auth)
        if (!usernameOk || !passwordOk) return sendError(res, 401, '用户名或密码错误', 'BAD_CREDENTIALS')
        const created = createSession(auth.username)
        return sendJson(res, 200, { ok: true, csrfToken: created.csrfToken }, { 'Set-Cookie': cookie(created.id) })
    }

    if (!session) return sendError(res, 401, '未登录或登录已过期', 'UNAUTHENTICATED')
    if (req.method !== 'GET' && !validCsrf(req, session))
        return sendError(res, 403, '请求校验失败，请刷新页面', 'BAD_CSRF')

    if (req.method === 'POST' && url.pathname === '/api/logout') {
        sessions.delete(session.id)
        return sendJson(res, 200, { ok: true }, { 'Set-Cookie': cookie('', 0) })
    }

    if (req.method === 'GET' && url.pathname === '/api/state') {
        await refreshCore()
        return sendJson(res, 200, publicState())
    }

    if (req.method === 'GET' && url.pathname === '/api/events') {
        applySecurityHeaders(res)
        res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no'
        })
        eventClients.add(res)
        writeSse(res, 'state', publicState())
        const timer = setInterval(() => res.write(': ping\n\n'), 15000)
        const cleanup = () => {
            clearInterval(timer)
            eventClients.delete(res)
        }
        req.once('close', cleanup)
        req.once('error', cleanup)
        return
    }

    if (req.method === 'GET' && url.pathname === '/api/logs') {
        const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit')) || 200, 1000))
        const level = url.searchParams.get('level')
        if (level && !['debug', 'info', 'warn', 'error'].includes(level)) return sendError(res, 400, '日志级别无效')
        const afterId = Number(url.searchParams.get('afterId'))
        const params = new URLSearchParams({ limit: String(limit) })
        if (level) params.set('level', level)
        if (Number.isSafeInteger(afterId) && afterId > 0) params.set('afterId', String(afterId))
        let latestLogId = 0
        try {
            const data = await control.get(`/logs?${params}`)
            for (const entry of data.logs || []) history.recordLog(publicLog(sanitizeLog(entry)))
            latestLogId = Number(data.latestLogId || 0)
        } catch {}
        const logs = history.listLogs({ limit })
        return sendJson(res, 200, {
            logs,
            count: logs.length,
            latestLogId,
            persistent: true,
            retentionDays: history.logRetentionDays
        })
    }

    if (req.method === 'GET' && url.pathname === '/api/history') {
        const result = history.list(url.searchParams.get('limit'))
        const current = publicState()
        return sendJson(res, 200, {
            ...result,
            active: current.run?.running
                ? {
                      id: cache.status?.runId ?? null,
                      startedAt: current.run.startedAt,
                      endedAt: null,
                      status: 'running',
                      collected: current.run.collected,
                      accounts: current.accounts
                  }
                : null
        })
    }

    if (req.method === 'GET' && url.pathname.startsWith('/api/history/')) {
        const id = decodeURIComponent(url.pathname.slice('/api/history/'.length))
        const run = history.getRun(id)
        if (!run) return sendError(res, 404, '运行记录不存在', 'RUN_NOT_FOUND')
        return sendJson(res, 200, { run, logs: history.listLogs({ runId: id, limit: 1000 }) })
    }

    if (req.method === 'GET' && url.pathname === '/api/points-calendar') {
        return sendJson(
            res,
            200,
            history.calendar({
                start: url.searchParams.get('start'),
                end: url.searchParams.get('end'),
                accountId: url.searchParams.get('accountId')
            })
        )
    }

    if (req.method === 'POST' && url.pathname === '/api/run') {
        const body = await readJson(req)
        const keys = Object.keys(body)
        if (keys.some(key => key !== 'accountIndex'))
            return sendError(res, 400, '运行参数仅允许 accountIndex', 'BAD_REQUEST')
        const accountIndex = body.accountIndex === undefined ? undefined : Number(body.accountIndex)
        if (accountIndex !== undefined && (!Number.isSafeInteger(accountIndex) || accountIndex < 1)) {
            return sendError(res, 400, 'accountIndex 必须是正整数', 'BAD_REQUEST')
        }
        const result = await control.post('/start', accountIndex ? { accountIndex } : {})
        await refreshCore()
        broadcast('state', publicState())
        return sendJson(res, 202, { started: true, startedAt: result.startedAt ?? null })
    }

    if (req.method === 'GET' && url.pathname === '/api/accounts/manage') {
        return sendJson(res, 200, await control.get('/accounts/manage'))
    }

    if (req.method === 'POST' && url.pathname === '/api/accounts/migrate-env') {
        const body = await readJson(req)
        if (Object.keys(body).length) return sendError(res, 400, '迁移请求不接受附加参数', 'BAD_REQUEST')
        const result = await control.post('/accounts/migrate-env', {})
        await refreshCore()
        broadcast('state', publicState())
        return sendJson(res, 201, result)
    }

    if (req.method === 'POST' && url.pathname === '/api/accounts') {
        const result = await control.post('/accounts', await readJson(req))
        await refreshCore()
        broadcast('state', publicState())
        return sendJson(res, 201, result)
    }

    if ((req.method === 'PATCH' || req.method === 'DELETE') && url.pathname.startsWith('/api/accounts/')) {
        const id = encodeURIComponent(decodeURIComponent(url.pathname.slice('/api/accounts/'.length)))
        const result =
            req.method === 'PATCH'
                ? await control.patch(`/accounts/${id}`, await readJson(req))
                : await control.delete(`/accounts/${id}`, await readJson(req))
        await refreshCore()
        broadcast('state', publicState())
        return sendJson(res, 200, result)
    }

    if (req.method === 'GET' && url.pathname === '/api/wecom') {
        return sendJson(res, 200, { ...wecom.status(), delivery: runNotifications.status() })
    }

    if (req.method === 'POST' && url.pathname === '/api/wecom') {
        const body = await readJson(req)
        const allowed = new Set([
            'enabled',
            'mode',
            'baseUrl',
            'corpId',
            'agentId',
            'corpSecret',
            'toUser',
            'clearSecret'
        ])
        if (Object.keys(body).some(key => !allowed.has(key))) return sendError(res, 400, '企业微信配置包含未知字段')
        const updated = wecom.update(body)
        void runNotifications.drain()
        return sendJson(res, 200, { ...updated, delivery: runNotifications.status() })
    }

    if (req.method === 'POST' && url.pathname === '/api/wecom/test') {
        const body = await readJson(req)
        if (Object.keys(body).length) return sendError(res, 400, '测试通知不接受附加参数')
        const result = await wecom.sendTest()
        return sendJson(res, result.sent ? 200 : 409, result.sent ? { sent: true } : { error: '企业微信配置未完整' })
    }

    if (req.method === 'POST' && url.pathname === '/api/stop') {
        const body = await readJson(req)
        if (Object.keys(body).length) return sendError(res, 400, '停止请求不接受附加参数', 'BAD_REQUEST')
        await control.post('/stop', {})
        await refreshCore()
        broadcast('state', publicState())
        return sendJson(res, 202, { stopping: true })
    }

    return sendError(res, 404, '接口不存在', 'NOT_FOUND')
}

const server = http.createServer(async (req, res) => {
    try {
        const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
        if (req.method === 'GET' && url.pathname === '/healthz') return sendJson(res, 200, { ok: true })
        if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url)
        if (req.method === 'GET' && serveStatic(res, url.pathname)) return
        return sendError(res, 404, '页面不存在', 'NOT_FOUND')
    } catch (error) {
        if (error instanceof SyntaxError) return sendError(res, 400, 'JSON 格式无效', 'BAD_JSON')
        const status =
            error instanceof ControlApiError
                ? error.status === 409
                    ? 409
                    : 502
                : error?.code === 'BODY_TOO_LARGE'
                  ? 413
                  : error?.code === 'WECOM_CONFIG_INVALID'
                    ? 400
                    : 500
        return sendError(res, status, publicErrorMessage(error), error?.code || 'INTERNAL_ERROR')
    }
})

const pollTimer = setInterval(async () => {
    await refreshCore()
    broadcast('state', publicState())
}, 10000)
pollTimer.unref()

await refreshCore()
void coreEventLoop()

server.listen(port, host, () => {
    console.log(`[WEB] 中文控制台已启动 | ${host}:${port}`)
})

function shutdown() {
    if (shuttingDown) return
    shuttingDown = true
    clearInterval(pollTimer)
    for (const response of eventClients) response.end()
    server.close(() => {
        history.close()
        process.exit(0)
    })
    setTimeout(() => process.exit(1), 5000).unref()
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
