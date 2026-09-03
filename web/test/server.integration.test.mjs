import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function listen(server, port = 0) {
    return new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, '127.0.0.1', () => resolve(server.address().port))
    })
}

function close(server) {
    return new Promise(resolve => server.close(resolve))
}

async function freePort() {
    const server = http.createServer()
    const port = await listen(server)
    await close(server)
    return port
}

async function waitForHealth(url, child, stderr) {
    for (let attempt = 0; attempt < 80; attempt++) {
        if (child.exitCode !== null) throw new Error(`Web exited early: ${stderr.join('')}`)
        try {
            const response = await fetch(`${url}/healthz`)
            if (response.ok) return
        } catch {}
        await new Promise(resolve => setTimeout(resolve, 50))
    }
    throw new Error(`Web did not become healthy: ${stderr.join('')}`)
}

test('BFF authenticates users, redacts state and restricts control bodies', { timeout: 15000 }, async () => {
    const token = 'test-control-token-with-sufficient-length'
    const requests = { starts: [], stops: [] }
    const eventResponses = new Set()
    const mockCore = http.createServer(async (req, res) => {
        assert.equal(req.headers.authorization, `Bearer ${token}`)
        const url = new URL(req.url, 'http://core')
        const json = value => {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify(value))
        }
        if (url.pathname === '/status') {
            return json({
                state: 'idle',
                version: '4.3.2',
                lastExit: null,
                logCount: 0,
                latestLogId: 0,
                run: { version: null, accountsTotal: null, accountsSeen: 0, accounts: [], live: {} }
            })
        }
        if (url.pathname === '/points') return json({ state: 'idle', accounts: [], collected: 0 })
        if (url.pathname === '/accounts') {
            return json({ accounts: [{ index: 1, email: 'secret@example.com', geoLocale: 'CN', langCode: 'zh-CN' }] })
        }
        if (url.pathname === '/history') return json({ runs: [] })
        if (url.pathname === '/logs') {
            return json({
                logs: [{ id: 1, level: 'info', message: 'secret@example.com token=abcdefghijklmno' }],
                latestLogId: 1
            })
        }
        if (url.pathname === '/events') {
            res.writeHead(200, { 'Content-Type': 'text/event-stream' })
            res.write('event: hello\ndata: {"state":"idle"}\n\n')
            eventResponses.add(res)
            req.once('close', () => eventResponses.delete(res))
            return
        }
        const chunks = []
        for await (const chunk of req) chunks.push(chunk)
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
        if (url.pathname === '/start') {
            requests.starts.push(body)
            res.writeHead(202, { 'Content-Type': 'application/json' })
            return res.end('{"started":true,"startedAt":"2026-09-03T01:00:00.000Z"}')
        }
        if (url.pathname === '/stop') {
            requests.stops.push(body)
            res.writeHead(202, { 'Content-Type': 'application/json' })
            return res.end('{"stopping":true}')
        }
        res.writeHead(404).end()
    })

    const corePort = await listen(mockCore)
    const webPort = await freePort()
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mrs-web-server-'))
    const stderr = []
    const child = spawn(process.execPath, ['src/server.mjs'], {
        cwd: webRoot,
        windowsHide: true,
        env: {
            ...process.env,
            NODE_OPTIONS: '--disable-warning=ExperimentalWarning',
            WEB_HOST: '127.0.0.1',
            WEB_PORT: String(webPort),
            WEB_DATA_DIR: dataDir,
            CONTROL_API_URL: `http://127.0.0.1:${corePort}`,
            CONTROL_API_TOKEN: token,
            WEB_WECOM_ENABLED: 'false'
        },
        stdio: ['ignore', 'pipe', 'pipe']
    })
    child.stderr.on('data', chunk => stderr.push(chunk.toString()))
    const baseUrl = `http://127.0.0.1:${webPort}`

    try {
        await waitForHealth(baseUrl, child, stderr)
        const stylesResponse = await fetch(`${baseUrl}/styles.css`)
        const styles = await stylesResponse.text()
        const appScript = await fetch(`${baseUrl}/app.js`).then(response => response.text())
        assert.equal(stylesResponse.headers.get('cache-control'), 'no-cache')
        assert.match(styles, /\[hidden\]\s*\{\s*display:\s*none\s*!important;/)
        assert.match(appScript, /运行历史可能缺失/)

        const initial = await fetch(`${baseUrl}/api/bootstrap`).then(response => response.json())
        assert.equal(initial.setupRequired, true)

        const setupResponse = await fetch(`${baseUrl}/api/setup`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'admin', password: 'a-secure-test-password' })
        })
        assert.equal(setupResponse.status, 201)
        const setup = await setupResponse.json()
        const cookie = setupResponse.headers.get('set-cookie').split(';')[0]
        const headers = { Cookie: cookie, 'X-CSRF-Token': setup.csrfToken, 'Content-Type': 'application/json' }

        const stateResponse = await fetch(`${baseUrl}/api/state`, { headers: { Cookie: cookie } })
        const stateText = await stateResponse.text()
        assert.equal(stateResponse.status, 200)
        assert.doesNotMatch(stateText, /secret@example\.com|test-control-token/)
        assert.match(stateText, /s\*\*\*@e\*\*\*\.com/)

        const invalidStart = await fetch(`${baseUrl}/api/run`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ args: ['unsafe'] })
        })
        assert.equal(invalidStart.status, 400)
        assert.equal(requests.starts.length, 0)

        const validStart = await fetch(`${baseUrl}/api/run`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ accountIndex: 1 })
        })
        assert.equal(validStart.status, 202)
        assert.deepEqual(requests.starts, [{ accountIndex: 1 }])

        const invalidStop = await fetch(`${baseUrl}/api/stop`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ force: true })
        })
        assert.equal(invalidStop.status, 400)
        assert.equal(requests.stops.length, 0)

        const logsText = await fetch(`${baseUrl}/api/logs`, { headers: { Cookie: cookie } }).then(response =>
            response.text()
        )
        assert.doesNotMatch(logsText, /secret@example\.com|abcdefghijklmno/)
    } finally {
        child.kill('SIGTERM')
        await Promise.race([
            new Promise(resolve => child.once('exit', resolve)),
            new Promise(resolve => setTimeout(resolve, 3000))
        ])
        for (const response of eventResponses) response.end()
        await close(mockCore)
        fs.rmSync(dataDir, { recursive: true, force: true })
    }
})
