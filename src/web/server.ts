import crypto from 'crypto'
import { spawn, spawnSync } from 'child_process'
import fs from 'fs'
import http, { IncomingMessage, ServerResponse } from 'http'
import path from 'path'
import { URL } from 'url'

import pkg from '../../package.json'
import { ConfigSchema, AccountSchema } from '../util/Validator'
import type { Account } from '../interface/Account'
import type { Config, ConfigWorkers } from '../interface/Config'

type JsonValue = Record<string, unknown> | unknown[] | string | number | boolean | null

interface AuthFile {
    username: string
    salt: string
    passwordHash: string
    iterations: number
    createdAt: string
    updatedAt: string
}

interface SessionData {
    username: string
    expiresAt: number
}

interface PublicAccount {
    id: number
    maskedEmail: string
    geoLocale: string
    langCode: string
    hasPassword: boolean
    hasTotpSecret: boolean
    hasRecoveryEmail: boolean
    proxyEnabled: boolean
    proxyAxios: boolean
    proxyHost: string
    proxyPort: number
    proxyUsername: string
    saveFingerprint: {
        mobile: boolean
        desktop: boolean
    }
}

interface ScheduleFile {
    schedule: string
    timezone: string
    updatedAt: string
}

interface RunState {
    running: boolean
    pid?: number
    startedAt?: string
    finishedAt?: string
    exitCode?: number | null
    lastMessage: string
}

const runtimeRoot = path.resolve(__dirname, '..')
const appRoot = path.resolve(__dirname, '..', '..')
const authFile = path.join(runtimeRoot, 'web-auth.json')
const accountsFile = path.join(runtimeRoot, 'accounts.json')
const configFile = path.join(runtimeRoot, 'config.json')
const scheduleFile = path.join(runtimeRoot, 'config', 'schedule.json')
const configExampleFile = path.join(runtimeRoot, 'config.example.json')
const configExampleFallbacks = [
    configExampleFile,
    path.resolve(process.cwd(), 'src', 'config.example.json'),
    path.resolve(process.cwd(), 'config.example.json')
]
const sessions = new Map<string, SessionData>()
let runState: RunState = { running: false, lastMessage: '暂无手动运行记录' }
const SESSION_COOKIE = 'mrs_session'
const SESSION_TTL_MS = 1000 * 60 * 60 * 12
const MAX_BODY_BYTES = 1024 * 1024

function ensureRuntimeFiles(): void {
    if (!fs.existsSync(runtimeRoot)) {
        fs.mkdirSync(runtimeRoot, { recursive: true })
    }

    if (!fs.existsSync(configFile)) {
        const source = configExampleFallbacks.find(file => fs.existsSync(file))
        if (!source) {
            throw new Error(`Missing config example. Checked: ${configExampleFallbacks.join(', ')}`)
        }
        fs.copyFileSync(source, configFile)
    }

    if (!fs.existsSync(accountsFile)) {
        fs.writeFileSync(accountsFile, '[]\n', 'utf8')
    }
}

function readJsonFile<T>(file: string, fallback: T): T {
    try {
        if (!fs.existsSync(file)) return fallback
        return JSON.parse(fs.readFileSync(file, 'utf8')) as T
    } catch {
        return fallback
    }
}

function writeJsonFile(file: string, data: unknown): void {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, `${JSON.stringify(data, null, 4)}\n`, 'utf8')
}

function currentSchedule(): ScheduleFile {
    const fallback = process.env.CRON_SCHEDULE ?? '0 7 * * *'
    const saved = readJsonFile<Partial<ScheduleFile> | null>(scheduleFile, null)
    return {
        schedule: typeof saved?.schedule === 'string' && saved.schedule ? saved.schedule : fallback,
        timezone: typeof saved?.timezone === 'string' && saved.timezone ? saved.timezone : process.env.TZ ?? 'UTC',
        updatedAt: typeof saved?.updatedAt === 'string' ? saved.updatedAt : ''
    }
}

function validateCronSchedule(schedule: string): void {
    const trimmed = schedule.trim().replace(/\s+/g, ' ')
    if (trimmed.split(' ').length !== 5) {
        throw new Error('定时表达式必须是 5 段，例如 0 7 * * *')
    }
    if (/(^|\s)(@|[A-Za-z]|;|&&|\|\||`|\$|\(|\)|<|>)/.test(trimmed)) {
        throw new Error('定时表达式包含不支持的字符')
    }
}

function saveSchedule(schedule: string): ScheduleFile {
    const trimmed = schedule.trim().replace(/\s+/g, ' ')
    validateCronSchedule(trimmed)

    const script = path.join(appRoot, 'scripts', 'docker', 'schedule.sh')
    if (process.platform === 'linux' && fs.existsSync(script) && fs.existsSync('/etc/cron.d/microsoft-rewards-cron.template')) {
        const result = spawnSync('bash', [script, 'apply', trimmed], {
            cwd: appRoot,
            env: { ...process.env, CRON_SCHEDULE: trimmed, TZ: process.env.TZ ?? 'UTC' },
            encoding: 'utf8'
        })
        if (result.status !== 0) {
            throw new Error(result.stderr.trim() || result.stdout.trim() || '更新 cron 失败')
        }
    }

    const next = {
        schedule: trimmed,
        timezone: process.env.TZ ?? 'UTC',
        updatedAt: new Date().toISOString()
    }
    writeJsonFile(scheduleFile, next)
    process.env.CRON_SCHEDULE = trimmed
    return next
}

function runOnce(): RunState {
    if (runState.running) {
        return runState
    }

    const script = path.join(appRoot, 'scripts', 'docker', 'run_daily.sh')
    if (!fs.existsSync(script)) {
        throw new Error('找不到运行脚本 scripts/docker/run_daily.sh')
    }

    const child = spawn('bash', [script], {
        cwd: appRoot,
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, SKIP_RANDOM_SLEEP: 'true' }
    })

    runState = {
        running: true,
        pid: child.pid,
        startedAt: new Date().toISOString(),
        exitCode: null,
        lastMessage: `手动运行已启动，PID ${child.pid}`
    }

    child.on('exit', code => {
        runState = {
            ...runState,
            running: false,
            finishedAt: new Date().toISOString(),
            exitCode: code,
            lastMessage: code === 0 ? '手动运行已完成' : `手动运行结束，退出码 ${code}`
        }
    })
    child.unref()
    return runState
}

function hashPassword(password: string, salt = crypto.randomBytes(16).toString('hex')): AuthFile {
    const iterations = 120000
    const passwordHash = crypto.pbkdf2Sync(password, salt, iterations, 32, 'sha256').toString('hex')
    const now = new Date().toISOString()
    return {
        username: '',
        salt,
        passwordHash,
        iterations,
        createdAt: now,
        updatedAt: now
    }
}

function verifyPassword(password: string, auth: AuthFile): boolean {
    const actual = crypto.pbkdf2Sync(password, auth.salt, auth.iterations, 32, 'sha256')
    const expected = Buffer.from(auth.passwordHash, 'hex')
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected)
}

function getConfiguredAuth(): AuthFile | null {
    const envUser = process.env.WEB_ADMIN_USER?.trim()
    const envPassword = process.env.WEB_ADMIN_PASSWORD
    if (envUser && envPassword) {
        return {
            ...hashPassword(envPassword),
            username: envUser,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        }
    }

    if (!fs.existsSync(authFile)) return null
    return readJsonFile<AuthFile | null>(authFile, null)
}

function createSession(username: string): string {
    const id = crypto.randomBytes(32).toString('hex')
    sessions.set(id, { username, expiresAt: Date.now() + SESSION_TTL_MS })
    return id
}

function cookieHeader(name: string, value: string, maxAge?: number): string {
    const pieces = [`${name}=${value}`, 'HttpOnly', 'Path=/', 'SameSite=Lax']
    if (maxAge !== undefined) pieces.push(`Max-Age=${maxAge}`)
    return pieces.join('; ')
}

function parseCookies(req: IncomingMessage): Record<string, string> {
    const out: Record<string, string> = {}
    const cookie = req.headers.cookie
    if (!cookie) return out

    for (const item of cookie.split(';')) {
        const [rawName, ...rawValue] = item.trim().split('=')
        if (!rawName) continue
        out[rawName] = decodeURIComponent(rawValue.join('='))
    }
    return out
}

function getSession(req: IncomingMessage): SessionData | null {
    const id = parseCookies(req)[SESSION_COOKIE]
    if (!id) return null

    const session = sessions.get(id)
    if (!session) return null

    if (session.expiresAt < Date.now()) {
        sessions.delete(id)
        return null
    }

    session.expiresAt = Date.now() + SESSION_TTL_MS
    return session
}

function maskEmail(email: string): string {
    const [name = '', domain = ''] = email.split('@')
    if (!domain) return email ? `${email.slice(0, 2)}***` : ''
    const left = name.length <= 2 ? `${name[0] ?? ''}***` : `${name.slice(0, 2)}***${name.slice(-1)}`
    return `${left}@${domain}`
}

function sanitizeAccount(account: Account, id: number): PublicAccount {
    return {
        id,
        maskedEmail: maskEmail(account.email),
        geoLocale: account.geoLocale,
        langCode: account.langCode,
        hasPassword: Boolean(account.password),
        hasTotpSecret: Boolean(account.totpSecret),
        hasRecoveryEmail: Boolean(account.recoveryEmail),
        proxyEnabled: Boolean(account.proxy?.url),
        proxyAxios: Boolean(account.proxy?.proxyAxios),
        proxyHost: account.proxy?.url ?? '',
        proxyPort: account.proxy?.port ?? 0,
        proxyUsername: account.proxy?.username ?? '',
        saveFingerprint: {
            mobile: Boolean(account.saveFingerprint?.mobile),
            desktop: Boolean(account.saveFingerprint?.desktop)
        }
    }
}

function loadAccounts(): Account[] {
    const raw = readJsonFile<unknown>(accountsFile, [])
    if (!Array.isArray(raw)) return []

    const result = raw.map(item => AccountSchema.safeParse(item))
    return result.filter(item => item.success).map(item => item.data)
}

function saveAccounts(accounts: Account[]): void {
    const parsed = accounts.map(account => AccountSchema.parse(account))
    writeJsonFile(accountsFile, parsed)
}

function loadConfig(): Config {
    const raw = readJsonFile<unknown>(configFile, {})
    return ConfigSchema.parse(raw)
}

function saveConfig(config: Config): void {
    writeJsonFile(configFile, ConfigSchema.parse(config))
}

function publicConfig(config: Config): Pick<
    Config,
    | 'headless'
    | 'clusters'
    | 'debugLogs'
    | 'errorDiagnostics'
    | 'ensureStreakProtection'
    | 'workers'
    | 'searchOnBingLocalQueries'
    | 'globalTimeout'
    | 'searchSettings'
> {
    return {
        headless: config.headless,
        clusters: config.clusters,
        debugLogs: config.debugLogs,
        errorDiagnostics: config.errorDiagnostics,
        ensureStreakProtection: config.ensureStreakProtection,
        workers: config.workers,
        searchOnBingLocalQueries: config.searchOnBingLocalQueries,
        globalTimeout: config.globalTimeout,
        searchSettings: {
            scrollRandomResults: config.searchSettings.scrollRandomResults,
            clickRandomResults: config.searchSettings.clickRandomResults,
            parallelSearching: config.searchSettings.parallelSearching,
            queryEngines: config.searchSettings.queryEngines,
            searchResultVisitTime: config.searchSettings.searchResultVisitTime,
            searchDelay: config.searchSettings.searchDelay,
            readDelay: config.searchSettings.readDelay
        }
    }
}

function defaultAccount(): Account {
    return {
        email: '',
        password: '',
        totpSecret: '',
        recoveryEmail: '',
        geoLocale: 'auto',
        langCode: 'zh',
        proxy: {
            proxyAxios: false,
            url: '',
            port: 0,
            username: '',
            password: ''
        },
        saveFingerprint: {
            mobile: true,
            desktop: true
        }
    }
}

function accountFromPayload(input: Record<string, unknown>, existing?: Account): Account {
    const base = existing ?? defaultAccount()
    const password = typeof input.password === 'string' && input.password.length > 0 ? input.password : base.password
    const email = String(input.email ?? '').trim() || base.email
    const account: Account = {
        email,
        password,
        totpSecret: String(input.totpSecret ?? base.totpSecret ?? '').trim(),
        recoveryEmail: String(input.recoveryEmail ?? base.recoveryEmail ?? '').trim(),
        geoLocale: String(input.geoLocale ?? base.geoLocale ?? 'auto').trim() || 'auto',
        langCode: String(input.langCode ?? base.langCode ?? 'zh').trim() || 'zh',
        proxy: {
            proxyAxios: Boolean(input.proxyAxios ?? base.proxy.proxyAxios),
            url: String(input.proxyUrl ?? base.proxy.url ?? '').trim(),
            port: Number(input.proxyPort ?? base.proxy.port ?? 0),
            username: String(input.proxyUsername ?? base.proxy.username ?? '').trim(),
            password:
                typeof input.proxyPassword === 'string' && input.proxyPassword.length > 0
                    ? input.proxyPassword
                    : base.proxy.password
        },
        saveFingerprint: {
            mobile: Boolean(input.saveFingerprintMobile ?? base.saveFingerprint.mobile),
            desktop: Boolean(input.saveFingerprintDesktop ?? base.saveFingerprint.desktop)
        }
    }

    AccountSchema.parse(account)
    return account
}

function safeConfigPatch(config: Config, input: Record<string, unknown>): Config {
    const workers = input.workers && typeof input.workers === 'object' ? (input.workers as Partial<ConfigWorkers>) : {}
    const nextWorkers: ConfigWorkers = { ...config.workers }
    for (const key of Object.keys(nextWorkers) as Array<keyof ConfigWorkers>) {
        if (key in workers) {
            nextWorkers[key] = Boolean(workers[key])
        }
    }

    const updated: Config = {
        ...config,
        clusters: Number(input.clusters ?? config.clusters),
        debugLogs: Boolean(input.debugLogs ?? config.debugLogs),
        errorDiagnostics: Boolean(input.errorDiagnostics ?? config.errorDiagnostics),
        ensureStreakProtection: Boolean(input.ensureStreakProtection ?? config.ensureStreakProtection),
        globalTimeout: String(input.globalTimeout ?? config.globalTimeout),
        searchOnBingLocalQueries: Boolean(input.searchOnBingLocalQueries ?? config.searchOnBingLocalQueries),
        workers: nextWorkers,
        searchSettings: {
            ...config.searchSettings,
            scrollRandomResults: Boolean(
                input.scrollRandomResults ?? config.searchSettings.scrollRandomResults
            ),
            clickRandomResults: Boolean(input.clickRandomResults ?? config.searchSettings.clickRandomResults),
            parallelSearching: Boolean(input.parallelSearching ?? config.searchSettings.parallelSearching),
            searchResultVisitTime: String(input.searchResultVisitTime ?? config.searchSettings.searchResultVisitTime),
            searchDelay: {
                min: String(input.searchDelayMin ?? config.searchSettings.searchDelay.min),
                max: String(input.searchDelayMax ?? config.searchSettings.searchDelay.max)
            },
            readDelay: {
                min: String(input.readDelayMin ?? config.searchSettings.readDelay.min),
                max: String(input.readDelayMax ?? config.searchSettings.readDelay.max)
            }
        }
    }

    return ConfigSchema.parse(updated)
}

function send(res: ServerResponse, status: number, body: string, contentType = 'text/html; charset=utf-8'): void {
    res.writeHead(status, {
        'Content-Type': contentType,
        'Cache-Control': 'no-store'
    })
    res.end(body)
}

function sendJson(res: ServerResponse, status: number, payload: JsonValue): void {
    send(res, status, JSON.stringify(payload), 'application/json; charset=utf-8')
}

function notFound(res: ServerResponse): void {
    sendJson(res, 404, { error: 'NOT_FOUND' })
}

function readBody(req: IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
        let size = 0
        const chunks: Buffer[] = []

        req.on('data', chunk => {
            size += chunk.length
            if (size > MAX_BODY_BYTES) {
                reject(new Error('REQUEST_TOO_LARGE'))
                req.destroy()
                return
            }
            chunks.push(Buffer.from(chunk))
        })
        req.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8')
            if (!raw.trim()) {
                resolve({})
                return
            }
            try {
                resolve(JSON.parse(raw))
            } catch {
                reject(new Error('INVALID_JSON'))
            }
        })
        req.on('error', reject)
    })
}

function requireAuth(req: IncomingMessage, res: ServerResponse): SessionData | null {
    const session = getSession(req)
    if (!session) {
        sendJson(res, 401, { error: 'UNAUTHENTICATED' })
        return null
    }
    return session
}

async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const auth = getConfiguredAuth()

    if (url.pathname === '/api/bootstrap' && req.method === 'GET') {
        sendJson(res, 200, {
            setupRequired: !auth,
            authenticated: Boolean(getSession(req)),
            version: pkg.version,
            port: Number(process.env.WEB_UI_PORT ?? process.env.PORT ?? 3000)
        })
        return
    }

    if (url.pathname === '/api/setup' && req.method === 'POST') {
        if (auth) {
            sendJson(res, 409, { error: 'SETUP_ALREADY_DONE' })
            return
        }

        const body = (await readBody(req)) as Record<string, unknown>
        const username = String(body.username ?? '').trim()
        const password = String(body.password ?? '')
        const passwordConfirm = String(body.passwordConfirm ?? '')
        if (username.length < 3 || password.length < 8) {
            sendJson(res, 400, { error: 'INVALID_SETUP', message: '用户名至少 3 位，密码至少 8 位' })
            return
        }
        if (password !== passwordConfirm) {
            sendJson(res, 400, { error: 'PASSWORD_MISMATCH', message: '两次输入的管理员密码不一致' })
            return
        }

        const nextAuth = hashPassword(password)
        nextAuth.username = username
        writeJsonFile(authFile, nextAuth)
        const sessionId = createSession(username)
        res.setHeader('Set-Cookie', cookieHeader(SESSION_COOKIE, sessionId, SESSION_TTL_MS / 1000))
        sendJson(res, 200, { ok: true })
        return
    }

    if (url.pathname === '/api/login' && req.method === 'POST') {
        if (!auth) {
            sendJson(res, 428, { error: 'SETUP_REQUIRED' })
            return
        }

        const body = (await readBody(req)) as Record<string, unknown>
        const username = String(body.username ?? '').trim()
        const password = String(body.password ?? '')
        if (username !== auth.username || !verifyPassword(password, auth)) {
            sendJson(res, 401, { error: 'LOGIN_FAILED' })
            return
        }

        const sessionId = createSession(username)
        res.setHeader('Set-Cookie', cookieHeader(SESSION_COOKIE, sessionId, SESSION_TTL_MS / 1000))
        sendJson(res, 200, { ok: true })
        return
    }

    if (url.pathname === '/api/logout' && req.method === 'POST') {
        const sessionId = parseCookies(req)[SESSION_COOKIE]
        if (sessionId) sessions.delete(sessionId)
        res.setHeader('Set-Cookie', cookieHeader(SESSION_COOKIE, '', 0))
        sendJson(res, 200, { ok: true })
        return
    }

    const session = requireAuth(req, res)
    if (!session) return

    if (url.pathname === '/api/state' && req.method === 'GET') {
        const accounts = loadAccounts()
        const config = loadConfig()
        const workersEnabled = Object.values(config.workers).filter(Boolean).length
        sendJson(res, 200, {
            user: { username: session.username },
            runtime: {
                version: pkg.version,
                root: runtimeRoot,
                webPort: Number(process.env.WEB_UI_PORT ?? process.env.PORT ?? 3000),
                nodeEnv: process.env.NODE_ENV ?? 'development'
            },
            stats: {
                accounts: accounts.length,
                workersEnabled,
                clusters: config.clusters,
                headless: config.headless,
                schedule: currentSchedule().schedule,
                lastRun: readLastRunSummary()
            },
            accounts: accounts.map(sanitizeAccount),
            config: publicConfig(config),
            schedule: currentSchedule(),
            runState
        })
        return
    }

    if (url.pathname === '/api/run' && req.method === 'POST') {
        try {
            sendJson(res, 200, { ok: true, runState: runOnce() })
        } catch (error) {
            sendJson(res, 400, {
                error: 'RUN_FAILED',
                message: error instanceof Error ? error.message : String(error)
            })
        }
        return
    }

    if (url.pathname === '/api/schedule' && req.method === 'POST') {
        const body = (await readBody(req)) as Record<string, unknown>
        const schedule = String(body.schedule ?? '')
        try {
            const next = saveSchedule(schedule)
            sendJson(res, 200, { ok: true, schedule: next })
        } catch (error) {
            sendJson(res, 400, {
                error: 'INVALID_SCHEDULE',
                message: error instanceof Error ? error.message : String(error)
            })
        }
        return
    }

    if (url.pathname === '/api/accounts' && req.method === 'POST') {
        const body = (await readBody(req)) as Record<string, unknown>
        const accounts = loadAccounts()
        const id = Number(body.id ?? -1)
        const next = accountFromPayload(body, id >= 0 ? accounts[id] : undefined)

        if (id >= 0 && id < accounts.length) {
            accounts[id] = next
        } else {
            accounts.push(next)
        }

        saveAccounts(accounts)
        sendJson(res, 200, { ok: true, accounts: accounts.map(sanitizeAccount) })
        return
    }

    const deleteMatch = url.pathname.match(/^\/api\/accounts\/(\d+)$/)
    if (deleteMatch && req.method === 'DELETE') {
        const id = Number(deleteMatch[1])
        const accounts = loadAccounts()
        if (!Number.isInteger(id) || id < 0 || id >= accounts.length) {
            sendJson(res, 404, { error: 'ACCOUNT_NOT_FOUND' })
            return
        }
        accounts.splice(id, 1)
        saveAccounts(accounts)
        sendJson(res, 200, { ok: true, accounts: accounts.map(sanitizeAccount) })
        return
    }

    if (url.pathname === '/api/config' && req.method === 'POST') {
        const body = (await readBody(req)) as Record<string, unknown>
        const config = loadConfig()
        const next = safeConfigPatch(config, body)
        saveConfig(next)
        sendJson(res, 200, { ok: true, config: publicConfig(next) })
        return
    }

    notFound(res)
}

function readLastRunSummary(): string {
    const logDir = path.resolve(process.cwd(), 'logs')
    if (!fs.existsSync(logDir)) return '暂无本地日志'

    const files = fs
        .readdirSync(logDir)
        .filter(file => file.endsWith('.log'))
        .sort()
        .reverse()

    for (const file of files) {
        const content = fs.readFileSync(path.join(logDir, file), 'utf8')
        const lines = content
            .split(/\r?\n/)
            .filter(line => /RUN-END|ACCOUNT-END|MAIN-ERROR|UNHANDLED-REJECTION/.test(line))
            .slice(-1)
        if (lines[0]) return lines[0].slice(0, 180)
    }

    return '暂无完成记录'
}

function loginHtml(setupRequired: boolean): string {
    const title = setupRequired ? '首次启动设置' : '管理员登录'
    const action = setupRequired ? '/api/setup' : '/api/login'
    const button = setupRequired ? '创建管理员账号' : '登录'
    const hint = setupRequired
        ? '创建本地管理员账号，用于保护管理入口。'
        : '使用本地管理员账号进入管理入口。'
    const confirmField = setupRequired
        ? '<label class="auth-field"><span>确认密码</span><input name="passwordConfirm" type="password" autocomplete="new-password" placeholder="再次输入管理员密码" required minlength="8"></label>'
        : ''
    const note = setupRequired
        ? '账号哈希仅保存在本机运行目录，不会展示真实凭证。'
        : '未登录时仅显示此页面，不加载任何管理内容。'

    return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} - Microsoft Rewards Script</title>
<style>${baseCss()}</style>
</head>
<body class="login-body">
<main class="login-shell ${setupRequired ? 'setup-shell' : 'signin-shell'}">
  <div class="auth-shape auth-shape-a"></div>
  <div class="auth-shape auth-shape-b"></div>
  <section class="login-panel">
    <div class="brand-lock">
      <div class="brand-mark">MR</div>
      <div>
        <strong>Microsoft Rewards Script</strong>
        <span>Local Web Admin</span>
      </div>
    </div>
    <h1>${title}</h1>
    <p class="auth-hint">${hint}</p>
    <form id="loginForm" class="login-form">
      <label class="auth-field"><span>${setupRequired ? '本地管理员账号' : '用户名'}</span><input name="username" autocomplete="username" placeholder="admin" required minlength="3"></label>
      <label class="auth-field"><span>${setupRequired ? '管理员密码' : '密码'}</span><input name="password" type="password" autocomplete="${setupRequired ? 'new-password' : 'current-password'}" placeholder="${setupRequired ? '至少 8 位' : '********'}" required minlength="8"></label>
      ${confirmField}
      <button class="primary-btn wide-btn" type="submit"><span>${button}</span></button>
      <p id="message" class="form-message" aria-live="polite"></p>
    </form>
    <div class="security-note">${note}</div>
  </section>
</main>
<script>
const form = document.querySelector('#loginForm');
const message = document.querySelector('#message');
form.addEventListener('submit', async event => {
  event.preventDefault();
  message.textContent = '处理中...';
  const data = Object.fromEntries(new FormData(form).entries());
  const res = await fetch('${action}', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(data)
  });
  if (res.ok) {
    location.href = '/';
    return;
  }
  const body = await res.json().catch(() => ({}));
  message.textContent = body.message || '登录失败，请检查账号或密码';
});
</script>
</body>
</html>`
}

function appHtml(): string {
    return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Microsoft Rewards Script 管理后台</title>
<style>${baseCss()}</style>
</head>
<body>
<div class="app">
  <aside class="sidebar">
    <div class="logo-row">
      <div class="brand-mark">MR</div>
      <div><strong>Microsoft Rewards Script</strong><span>Local Web Admin</span></div>
    </div>
    <nav>
      <button class="nav-item active" data-view="dashboard"><span class="nav-icon">⌂</span>仪表盘</button>
      <button class="nav-item" data-view="accounts"><span class="nav-icon">◎</span>账号设置</button>
      <button class="nav-item" data-view="tasks"><span class="nav-icon">☷</span>任务配置</button>
      <button class="nav-item" data-view="logs"><span class="nav-icon">≡</span>运行日志</button>
      <button class="nav-item" data-view="system"><span class="nav-icon">⚙</span>系统设置</button>
    </nav>
    <section class="sidebar-note">
      <strong>本地管理已启用</strong>
      <p>凭证与会话仅存放在本机运行目录。</p>
    </section>
  </aside>
  <main class="main">
    <header class="topbar">
      <div><h1 id="pageTitle">仪表盘</h1><p id="pageSubtitle">查看运行概况，维护账号、任务与系统参数。</p></div>
      <div class="top-actions"><span id="userBadge" class="user-badge">admin</span><span class="env-pill">Local</span><button id="logoutBtn" class="icon-btn" title="退出登录">↗</button></div>
    </header>
    <section id="dashboard" class="view active"></section>
    <section id="accounts" class="view"></section>
    <section id="tasks" class="view"></section>
    <section id="logs" class="view"></section>
    <section id="system" class="view"></section>
  </main>
</div>
<div id="modal" class="modal hidden"></div>
<script>${clientJs()}</script>
</body>
</html>`
}

function baseCss(): string {
    return `
:root{--bg:#eaf6f3;--bg-strong:#d9f0ec;--surface:#fff;--surface-soft:#f7fbfa;--line:#d7e5e1;--teal:#0f8f85;--teal-dark:#08746d;--teal-soft:#ddf3ef;--text:#17211f;--sub:#64736f;--muted:#91a19d;--danger:#b54646;--amber:#a96516;--blue:#2f6fed;--shadow:0 18px 42px rgba(15,63,58,.13)}
*{box-sizing:border-box}body{margin:0;font-family:Inter,Segoe UI,Arial,"Microsoft YaHei",sans-serif;color:var(--text);background:var(--bg)}button,input,select{font:inherit}button{cursor:pointer}button:disabled{cursor:not-allowed;opacity:.65}
.login-body{min-height:100vh;overflow:hidden;background:var(--bg)}.login-shell{min-height:100vh;position:relative;display:grid;place-items:center;padding:28px}.signin-shell{border-top:10px solid var(--teal)}.auth-shape{position:absolute;background:var(--bg-strong);border-radius:48px;pointer-events:none}.auth-shape-a{width:520px;height:520px;right:8vw;top:12vh}.auth-shape-b{width:420px;height:300px;left:-160px;bottom:-80px}.setup-shell .auth-shape-a{right:18vw;top:-110px}.setup-shell .auth-shape-b{left:-150px;bottom:-100px}.login-panel{position:relative;width:min(576px,calc(100vw - 36px));background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:48px 54px 40px;box-shadow:var(--shadow)}.signin-shell .login-panel{width:min(520px,calc(100vw - 36px));padding:46px 48px 36px}.brand-lock{display:flex;align-items:center;gap:14px;margin-bottom:28px}.brand-lock strong{display:block;font-size:15px;font-weight:800;line-height:1.2}.brand-lock span{display:block;margin-top:4px;color:var(--muted);font:12px/1.2 "Geist Mono",Consolas,monospace}.brand-mark{width:44px;height:44px;border-radius:8px;background:var(--teal);display:grid;place-items:center;color:#fff;font:800 14px/1 "Geist Mono",Consolas,monospace}.login-panel h1{margin:0;font-size:36px;line-height:1.15;font-weight:800;letter-spacing:0}.auth-hint{margin:12px 0 34px;color:var(--sub);font-size:15px;line-height:1.55}.login-form{display:grid;gap:18px}.auth-field{display:grid;gap:10px;font-size:13px;font-weight:700;color:var(--sub)}.auth-field input{height:54px;width:100%;border:1px solid var(--line);border-radius:8px;background:var(--surface-soft);padding:0 18px;color:var(--text);outline:none}.auth-field input:focus,.field input:focus,.field select:focus{border-color:var(--teal);box-shadow:0 0 0 3px rgba(15,143,133,.1)}.primary-btn{height:44px;border:0;border-radius:8px;background:var(--teal);color:#fff;font-weight:800;padding:0 18px;display:inline-flex;align-items:center;justify-content:center;gap:8px}.wide-btn{height:54px;width:100%;margin-top:2px}.form-message{min-height:18px;margin:0;color:var(--danger);font-size:13px}.security-note{margin-top:16px;padding:14px 16px 14px 44px;position:relative;background:var(--surface-soft);border:1px solid var(--line);border-radius:8px;color:var(--sub);font-size:13px;line-height:1.4}.security-note:before{content:"✓";position:absolute;left:16px;top:14px;width:18px;height:18px;border-radius:50%;display:grid;place-items:center;background:var(--teal-soft);color:var(--teal);font-size:12px;font-weight:800}
.app{display:grid;grid-template-columns:272px minmax(0,1fr);min-height:100vh;background:var(--bg)}.sidebar{background:var(--surface);border-right:1px solid var(--line);padding:28px 22px;display:flex;flex-direction:column;gap:24px}.logo-row{display:flex;align-items:center;gap:12px;min-width:0}.logo-row strong{display:block;font-size:14px;font-weight:800;line-height:1.2}.logo-row span{display:block;margin-top:4px;color:var(--muted);font:12px/1.2 "Geist Mono",Consolas,monospace}.sidebar nav{display:grid;gap:12px}.nav-item{height:44px;border:0;border-radius:8px;background:transparent;display:flex;align-items:center;gap:12px;padding:0 14px;color:var(--sub);font-size:14px;font-weight:700;text-align:left}.nav-item.active{background:var(--teal-soft);color:var(--teal-dark);font-weight:800}.nav-icon{width:18px;height:18px;display:grid;place-items:center;color:inherit}.sidebar-note{margin-top:auto;border:1px solid var(--line);background:var(--surface-soft);border-radius:8px;padding:16px}.sidebar-note strong{font-size:13px}.sidebar-note p{margin:8px 0 0;color:var(--sub);font-size:12px;line-height:1.45}.main{min-width:0}.topbar{height:118px;display:flex;align-items:center;justify-content:space-between;padding:34px 46px 22px}.topbar h1{font-size:32px;line-height:1.1;margin:0 0 10px;font-weight:800}.topbar p{margin:0;color:var(--sub);font-size:14px}.top-actions{display:flex;align-items:center;gap:10px}.user-badge,.env-pill{height:36px;display:inline-flex;align-items:center;border-radius:8px;border:1px solid var(--line);background:var(--surface);padding:0 12px;color:var(--text);font-size:13px;font-weight:800}.env-pill{color:var(--sub);font:12px/1 "Geist Mono",Consolas,monospace}.icon-btn,.ghost-btn,.small-btn,.danger-btn{height:36px;border:1px solid var(--line);border-radius:8px;background:var(--surface);color:var(--sub);padding:0 12px}.icon-btn{width:36px;padding:0}.danger-btn{color:var(--danger)}.view{display:none}.view.active{display:block}.content-grid{padding:0 46px 46px;display:grid;gap:24px}.metrics{display:grid;grid-template-columns:repeat(4,minmax(180px,1fr));gap:16px}.card{background:var(--surface);border:1px solid var(--line);border-radius:8px}.metric{min-height:132px;padding:22px;display:grid;grid-template-columns:44px 1fr;gap:16px;align-items:start}.metric-icon{width:42px;height:42px;border-radius:8px;background:var(--teal-soft);display:grid;place-items:center;color:var(--teal);font-weight:900}.metric small{display:block;color:var(--sub);font-size:13px}.metric strong{display:block;margin:8px 0 10px;font:800 28px/1 "Geist Mono",Consolas,monospace;color:var(--text)}.split-grid{display:grid;grid-template-columns:minmax(0,1fr) 474px;gap:24px}.bottom-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(360px,1fr);gap:24px}.section{padding:22px 26px}.section h2{font-size:20px;margin:0;color:var(--text)}.section-note{margin:8px 0 18px;color:var(--sub);font-size:13px;line-height:1.45}.toolbar{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:18px}.table-wrap{overflow:auto}.table{width:100%;border-collapse:collapse;min-width:720px}.table th,.table td{border-bottom:1px solid var(--line);padding:14px 12px;text-align:left;font-size:13px;white-space:nowrap}.table th{background:var(--surface-soft);color:var(--sub);font-weight:800}.pill{display:inline-flex;align-items:center;border-radius:999px;padding:4px 10px;background:var(--teal-soft);color:var(--teal-dark);font-weight:800;font-size:12px}.form-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.field{display:grid;gap:7px}.field label{font-size:12px;color:var(--sub);font-weight:800}.field input,.field select{height:40px;border:1px solid var(--line);border-radius:8px;padding:0 10px;background:#fff;color:var(--text);outline:none}.switch-row{display:grid;gap:10px}.toggle{min-height:54px;display:flex;justify-content:space-between;align-items:center;gap:14px;padding:14px 16px;border:1px solid var(--line);border-radius:8px;background:#fff;font-weight:700}.toggle input{width:44px;height:24px;accent-color:var(--teal)}.log-box{white-space:pre-wrap;background:var(--surface-soft);color:var(--text);padding:18px;border-radius:8px;min-height:180px;line-height:1.65;border:1px solid var(--line);font-family:"Geist Mono",Consolas,monospace;font-size:13px}.settings-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.setting-item{border:1px solid var(--line);border-radius:8px;background:var(--surface-soft);padding:16px}.setting-item span{display:block;color:var(--sub);font-size:12px;font-weight:800}.setting-item strong{display:block;margin-top:8px;color:var(--teal-dark);font:800 13px/1.3 "Geist Mono",Consolas,monospace;word-break:break-word}.modal{position:fixed;inset:0;background:rgba(10,31,28,.46);display:grid;place-items:center;padding:24px;z-index:20}.modal.hidden{display:none}.modal-card{width:min(760px,100%);max-height:calc(100vh - 48px);overflow:auto;background:#fff;border-radius:8px;padding:24px;box-shadow:0 24px 70px rgba(5,34,30,.22)}.modal-card h2{margin:0 0 18px}.modal-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:18px}.empty-state{padding:30px;text-align:center;color:var(--sub);background:var(--surface-soft);border:1px dashed var(--line);border-radius:8px}@media(max-width:1180px){.metrics{grid-template-columns:repeat(2,minmax(0,1fr))}.split-grid,.bottom-grid{grid-template-columns:1fr}}@media(max-width:820px){.app{grid-template-columns:1fr}.sidebar{position:static;padding:18px}.sidebar nav{grid-template-columns:repeat(2,minmax(0,1fr))}.sidebar-note{display:none}.topbar{height:auto;padding:22px;align-items:flex-start;gap:16px;flex-direction:column}.content-grid{padding:0 18px 28px}.metrics,.form-grid,.settings-list{grid-template-columns:1fr}.login-panel,.signin-shell .login-panel{padding:32px 24px}.auth-shape{display:none}}`
}

function clientJs(): string {
    return `
let state = null;
const views = ['dashboard','accounts','tasks','logs','system'];
const titles = {dashboard:'仪表盘',accounts:'账号设置',tasks:'任务配置',logs:'运行日志',system:'系统设置'};
const workerLabels = {
  doDailySet:'每日任务', doClaimBonusPoints:'领取奖励积分', doSpecialPromotions:'特殊活动',
  doMorePromotions:'更多推广', doPunchCards:'打卡活动', doAppPromotions:'App 活动',
  doDesktopSearch:'桌面搜索', doMobileSearch:'移动搜索', doDailyCheckIn:'每日签到',
  doReadToEarn:'阅读赚取'
};
const subtitles = {
  dashboard:'查看运行概况，维护账号、任务与系统参数。',
  accounts:'维护 Microsoft 账号，敏感字段保存后不在页面回显。',
  tasks:'调整任务开关、并发与延迟参数。',
  logs:'查看脱敏后的最近运行摘要。',
  system:'查看本地运行环境与基础设置。'
};
async function api(path, options = {}) {
  const res = await fetch(path, {headers:{'Content-Type':'application/json'}, ...options});
  if (res.status === 401) { location.reload(); throw new Error('UNAUTHENTICATED'); }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.message || body.error || '请求失败');
  return body;
}
function el(id){return document.getElementById(id)}
function esc(v){return String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
async function loadState(){ state = await api('/api/state'); renderAll(); }
function switchView(view){
  views.forEach(v => el(v).classList.toggle('active', v === view));
  document.querySelectorAll('.nav-item').forEach(btn => btn.classList.toggle('active', btn.dataset.view === view));
  el('pageTitle').textContent = titles[view];
  el('pageSubtitle').textContent = subtitles[view];
}
document.querySelectorAll('.nav-item').forEach(btn => btn.addEventListener('click', () => switchView(btn.dataset.view)));
el('logoutBtn').addEventListener('click', async () => { await api('/api/logout', {method:'POST', body:'{}'}); location.reload(); });
function renderAll(){
  el('userBadge').textContent = state.user.username;
  renderDashboard(); renderAccounts(); renderTasks(); renderLogs(); renderSystem();
}
function metric(name,value,sub,icon){return '<article class="card metric"><div class="metric-icon">'+icon+'</div><div><small>'+name+'</small><strong>'+value+'</strong><small>'+sub+'</small></div></article>'}
function accountTable(limit){
  const accounts = limit ? state.accounts.slice(0, limit) : state.accounts;
  const rows = accounts.map(a => '<tr><td>'+esc(a.maskedEmail)+'</td><td>'+esc(a.geoLocale)+'</td><td>'+esc(a.langCode)+'</td><td>'+(a.proxyEnabled?'<span class="pill">代理</span>':'-')+'</td><td>'+(a.hasTotpSecret?'已配置':'-')+'</td><td><button class="small-btn" onclick="openAccount('+a.id+')">编辑</button> <button class="danger-btn" onclick="deleteAccount('+a.id+')">删除</button></td></tr>').join('');
  return '<div class="table-wrap"><table class="table"><thead><tr><th>邮箱</th><th>地区</th><th>语言</th><th>代理</th><th>TOTP</th><th>操作</th></tr></thead><tbody>'+(rows || '<tr><td colspan="6">暂无账号，请新增。</td></tr>')+'</tbody></table></div>';
}
function taskToggles(limit){
  return Object.entries(state.config.workers).slice(0, limit).map(([key,val]) => '<label class="toggle"><span>'+workerLabels[key]+'</span><input type="checkbox" name="'+key+'" '+(val?'checked':'')+'></label>').join('');
}
function settingsItems(){
  const c = state.config;
  return '<div class="settings-list">'
    + setting('Headless', String(c.headless))
    + setting('Workers', state.stats.workersEnabled + ' enabled')
    + setting('Cron', state.schedule.schedule)
    + setting('Debug Logs', String(c.debugLogs))
    + '</div>';
}
function setting(name,value){return '<div class="setting-item"><span>'+esc(name)+'</span><strong>'+esc(value)+'</strong></div>'}
function runControls(){
  const r = state.runState;
  return '<section class="card section"><div class="toolbar"><div><h2>运行控制</h2><p class="section-note">立即执行会跳过随机休眠，并使用任务锁避免和定时任务并发。</p></div><button id="runOnceBtn" class="primary-btn" '+(r.running?'disabled':'')+'>立即执行一次</button></div><div class="settings-list">'
    + setting('运行状态', r.running ? '运行中' : '空闲')
    + setting('最近消息', r.lastMessage || '-')
    + setting('当前定时', state.schedule.schedule)
    + setting('时区', state.schedule.timezone)
    + '</div></section>';
}
function scheduleForm(){
  return '<form id="scheduleForm" class="card section"><h2>定时设置</h2><p class="section-note">填写 5 段 cron 表达式，保存后容器内 cron 会即时重载。例：0 7 * * *</p><div class="form-grid"><div class="field"><label>CRON_SCHEDULE</label><input name="schedule" value="'+esc(state.schedule.schedule)+'" placeholder="0 7 * * *"></div><div class="field"><label>时区</label><input value="'+esc(state.schedule.timezone)+'" disabled></div></div><div class="modal-actions"><button class="primary-btn">保存定时</button></div></form>';
}
function renderDashboard(){
  const s = state.stats;
  el('dashboard').innerHTML = '<div class="content-grid">'
    + '<div class="metrics">'
    + metric('账号数量', s.accounts, '邮箱已脱敏展示', '◎')
    + metric('启用任务', s.workersEnabled, '搜索、阅读、活动任务', '✓')
    + metric('今日状态', s.lastRun === '暂无本地日志' ? '待运行' : '有记录', '默认等待计划触发', '◷')
    + metric('安全项', '4', '敏感字段不下发前端', '◇')
    + '</div>'
    + runControls()
    + '<div class="split-grid"><section class="card section"><div class="toolbar"><div><h2>账号设置</h2><p class="section-note">密码、TOTP 与代理密码保存后不在页面回显。</p></div><button class="primary-btn" onclick="openAccount()">新增账号</button></div>'+accountTable(3)+'</section>'
    + '<section class="card section"><h2>任务配置</h2><p class="section-note">常用任务开关与执行参数。</p><form id="dashboardTaskForm" class="switch-row">'+taskToggles(3)+'<div class="modal-actions"><button class="primary-btn">保存配置</button></div></form></section></div>'
    + '<div class="bottom-grid"><section class="card section"><h2>运行日志</h2><p class="section-note">仅展示脱敏后的最近事件。</p><div class="log-box">'+esc(s.lastRun)+'</div></section>'
    + '<section class="card section"><h2>系统设置</h2><p class="section-note">运行方式、并发与调试开关。</p>'+settingsItems()+'</section></div>'
    + '</div>';
  document.querySelector('#dashboardTaskForm')?.addEventListener('submit', saveConfig);
  document.querySelector('#runOnceBtn')?.addEventListener('click', runOnceNow);
}
function renderAccounts(){
  el('accounts').innerHTML = '<div class="content-grid"><section class="card section"><div class="toolbar"><div><h2>账号设置</h2><p class="section-note">列表只展示脱敏邮箱和配置状态。</p></div><button class="primary-btn" onclick="openAccount()">新增账号</button></div>'+accountTable()+'</section></div>';
}
window.openAccount = function(id){
  const a = id === undefined ? {} : state.accounts.find(x => x.id === id);
  const modal = el('modal');
  modal.classList.remove('hidden');
  modal.innerHTML = '<form class="modal-card" id="accountForm"><h2>'+(id===undefined?'新增账号':'编辑账号')+'</h2><input type="hidden" name="id" value="'+(id ?? '')+'"><div class="form-grid">'
    + field('email','邮箱','', 'email', id === undefined ? 'name@example.com' : '留空则保持 '+(a?.maskedEmail || '原邮箱'))
    + field('password','密码', '', 'password', id === undefined ? '必填' : '留空则保持原密码')
    + field('totpSecret','TOTP Secret','')
    + field('recoveryEmail','恢复邮箱','')
    + field('geoLocale','地区',a?.geoLocale || 'auto')
    + field('langCode','语言',a?.langCode || 'zh')
    + field('proxyUrl','代理地址',a?.proxyHost || '')
    + field('proxyPort','代理端口',a?.proxyPort || 0, 'number')
    + field('proxyUsername','代理用户名',a?.proxyUsername || '')
    + field('proxyPassword','代理密码','', 'password', '留空则保持原代理密码')
    + '</div><div class="modal-actions"><button type="button" class="ghost-btn" onclick="closeModal()">取消</button><button class="primary-btn">保存</button></div></form>';
  document.querySelector('#accountForm').addEventListener('submit', saveAccount);
}
function field(name,label,value,type='text',placeholder=''){return '<div class="field"><label>'+label+'</label><input name="'+name+'" type="'+type+'" value="'+esc(value)+'" placeholder="'+placeholder+'"></div>'}
window.closeModal = function(){ el('modal').classList.add('hidden'); el('modal').innerHTML = ''; }
async function saveAccount(event){
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.target).entries());
  if (data.id === '') delete data.id;
  data.proxyPort = Number(data.proxyPort || 0);
  data.saveFingerprintMobile = true; data.saveFingerprintDesktop = true; data.proxyAxios = Boolean(data.proxyUrl);
  await api('/api/accounts', {method:'POST', body:JSON.stringify(data)});
  closeModal(); await loadState(); switchView('accounts');
}
window.deleteAccount = async function(id){
  if (!confirm('确认删除该账号？')) return;
  await api('/api/accounts/'+id, {method:'DELETE'});
  await loadState(); switchView('accounts');
}
function renderTasks(){
  const c = state.config;
  el('tasks').innerHTML = '<div class="content-grid">'+scheduleForm()+'<section class="card section"><h2>任务配置</h2><p class="section-note">保存后会写入本地配置文件。</p><form id="taskForm"><div class="switch-row">'+taskToggles()+'</div><div class="form-grid" style="margin-top:16px">'+field('clusters','集群数',c.clusters,'number')+field('globalTimeout','全局超时',c.globalTimeout)+field('searchDelayMin','搜索最小延迟',c.searchSettings.searchDelay.min)+field('searchDelayMax','搜索最大延迟',c.searchSettings.searchDelay.max)+field('readDelayMin','阅读最小延迟',c.searchSettings.readDelay.min)+field('readDelayMax','阅读最大延迟',c.searchSettings.readDelay.max)+'</div><div class="modal-actions"><button class="primary-btn">保存配置</button></div></form></section></div>';
  document.querySelector('#taskForm').addEventListener('submit', saveConfig);
  document.querySelector('#tasks #scheduleForm').addEventListener('submit', saveSchedule);
}
async function saveConfig(event){
  event.preventDefault();
  const form = event.target;
  const data = Object.fromEntries(new FormData(form).entries());
  data.workers = {};
  Object.keys(state.config.workers).forEach(k => {
    if (form.elements[k]) data.workers[k] = Boolean(form.elements[k].checked);
  });
  data.clusters = Number(data.clusters || 1);
  await api('/api/config', {method:'POST', body:JSON.stringify(data)});
  await loadState(); switchView('tasks');
}
async function runOnceNow(){
  await api('/api/run', {method:'POST', body:'{}'});
  await loadState();
  switchView('dashboard');
}
async function saveSchedule(event){
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.target).entries());
  await api('/api/schedule', {method:'POST', body:JSON.stringify(data)});
  await loadState();
  switchView('tasks');
}
function renderLogs(){ el('logs').innerHTML = '<div class="content-grid"><section class="card section"><h2>运行日志</h2><p class="section-note">Cookie、Token、密码与完整邮箱不会在前端日志中显示。</p><div class="log-box">'+esc(state.stats.lastRun)+'</div></section></div>'; }
function renderSystem(){ el('system').innerHTML = '<div class="content-grid">'+scheduleForm()+'<section class="card section"><h2>系统设置</h2><p class="section-note">基础运行环境信息。</p>'+settingsItems()+'<div class="table-wrap" style="margin-top:18px"><table class="table"><tr><th>运行目录</th><td>'+esc(state.runtime.root)+'</td></tr><tr><th>Node 环境</th><td>'+esc(state.runtime.nodeEnv)+'</td></tr><tr><th>Web 端口</th><td>'+esc(state.runtime.webPort)+'</td></tr></table></div></section></div>'; document.querySelector('#system #scheduleForm').addEventListener('submit', saveSchedule); }
loadState().catch(err => alert(err.message));`
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)

        if (url.pathname.startsWith('/api/')) {
            await handleApi(req, res, url)
            return
        }

        if (url.pathname !== '/') {
            notFound(res)
            return
        }

        const auth = getConfiguredAuth()
        const session = getSession(req)
        if (!auth || !session) {
            send(res, 200, loginHtml(!auth))
            return
        }

        send(res, 200, appHtml())
    } catch (error) {
        sendJson(res, 500, {
            error: 'INTERNAL_ERROR',
            message: error instanceof Error ? error.message : String(error)
        })
    }
}

function start(): void {
    ensureRuntimeFiles()
    const port = Number(process.env.WEB_UI_PORT ?? process.env.PORT ?? 3000)
    const host = process.env.WEB_UI_HOST ?? '0.0.0.0'
    http.createServer((req, res) => {
        void handleRequest(req, res)
    }).listen(port, host, () => {
        console.log(`[web] Microsoft Rewards Script UI listening on http://${host}:${port}`)
        if (!getConfiguredAuth()) {
            console.log('[web] First-run setup is required before project content is visible.')
        }
    })
}

start()
