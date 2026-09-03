import http from 'node:http'

const port = Number(process.env.VISUAL_CORE_PORT || 3011)
const token = process.env.VISUAL_CORE_TOKEN || 'visual-token'
const startedAt = new Date(Date.now() - 24 * 60 * 1000).toISOString()

const accounts = [
    { index: 1, email: 'first@example.com', geoLocale: 'CN', langCode: 'zh-CN', hasTotp: false },
    { index: 2, email: 'second@example.com', geoLocale: 'CN', langCode: 'zh-CN', hasTotp: true },
    { index: 3, email: 'third@example.com', geoLocale: 'US', langCode: 'zh-CN', hasTotp: false }
]
const runAccounts = [
    {
        email: accounts[0].email,
        success: false,
        error: 'PASSKEY_ERROR: Microsoft requested another sign-in method',
        earnable: { mobile: null, browser: 60, app: 45 },
        live: { balance: 1080, gained: 0, bySource: {} }
    },
    {
        email: accounts[1].email,
        success: null,
        earnable: { mobile: null, browser: 60, app: 45 },
        live: { balance: 2066, gained: 66, bySource: { read: 21, checkIn: 15, urlReward: 30 } }
    }
]

const server = http.createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        return res.end('{"error":"Unauthorized"}')
    }
    const url = new URL(req.url, 'http://fixture')
    const send = (value, status = 200) => {
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(value))
    }
    if (url.pathname === '/status') {
        return send({
            state: 'running',
            version: '4.3.2',
            startedAt,
            lastExit: null,
            logCount: 16,
            latestLogId: 16,
            run: {
                version: '4.3.2',
                accountsTotal: 3,
                accountsSeen: 2,
                collected: 66,
                finished: false,
                live: { currentAccount: accounts[1].email, currentBalance: 2066, gained: 66 },
                accounts: runAccounts
            }
        })
    }
    if (url.pathname === '/points') {
        return send({
            state: 'running',
            running: true,
            currentAccount: accounts[1].email,
            balance: 2066,
            collected: 66,
            accountsTotal: 3,
            accountsSeen: 2,
            accounts: runAccounts
        })
    }
    if (url.pathname === '/accounts') return send({ accounts, count: accounts.length })
    if (url.pathname === '/history') return send({ runs: [], count: 0 })
    if (url.pathname === '/logs') {
        return send({
            latestLogId: 16,
            logs: [
                {
                    id: 14,
                    receivedAt: new Date().toISOString(),
                    level: 'error',
                    platform: 'DESKTOP',
                    title: 'ACCOUNT-ERROR',
                    message: `${accounts[0].email}: PASSKEY_ERROR during Bing verification`
                },
                {
                    id: 15,
                    receivedAt: new Date().toISOString(),
                    level: 'info',
                    platform: 'MOBILE',
                    title: 'READ-TO-EARN',
                    message: 'Read article 7/10 | pointsGained=3 | currentBalance=2066'
                },
                {
                    id: 16,
                    receivedAt: new Date().toISOString(),
                    level: 'warn',
                    platform: 'MAIN',
                    title: 'SEARCH-MANAGER',
                    message:
                        'Mobile search counter was not recognized; remaining points stay unknown instead of being treated as zero. This intentionally long diagnostic line verifies that operational text wraps without covering adjacent controls or leaving the log viewport.'
                }
            ]
        })
    }
    if (url.pathname === '/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
        res.write('event: hello\ndata: {"state":"running"}\n\n')
        const timer = setInterval(() => res.write(': ping\n\n'), 15000)
        req.on('close', () => clearInterval(timer))
        return
    }
    if (url.pathname === '/start' || url.pathname === '/stop') return send({ error: 'fixture is read-only' }, 409)
    send({ error: 'not found' }, 404)
})

server.listen(port, '127.0.0.1', () => console.log(`[FIXTURE] ${port}`))
process.on('SIGTERM', () => server.close(() => process.exit(0)))
