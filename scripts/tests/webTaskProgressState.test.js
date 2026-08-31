const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')

const projectRoot = path.resolve(__dirname, '../..')
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rewards-web-state-'))
let child = null

function accountHash(email) {
    return crypto.createHash('sha256').update(email.trim().toLowerCase()).digest('hex')
}

function copyTree(source, target) {
    fs.mkdirSync(target, { recursive: true })
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
        const sourcePath = path.join(source, entry.name)
        const targetPath = path.join(target, entry.name)
        if (entry.isDirectory()) copyTree(sourcePath, targetPath)
        else if (entry.isFile()) fs.copyFileSync(sourcePath, targetPath)
    }
}

function getFreePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer()
        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => {
            const address = server.address()
            const port = typeof address === 'object' && address ? address.port : 0
            server.close(error => (error ? reject(error) : resolve(port)))
        })
    })
}

async function waitForServer(baseUrl, output) {
    for (let attempt = 0; attempt < 80; attempt++) {
        if (child?.exitCode !== null) {
            throw new Error(`Web server exited early: ${output().slice(-1000)}`)
        }
        try {
            const response = await fetch(`${baseUrl}/api/bootstrap`)
            if (response.ok) return
        } catch {}
        await new Promise(resolve => setTimeout(resolve, 100))
    }
    throw new Error(`Web server did not become ready: ${output().slice(-1000)}`)
}

async function stopChild() {
    if (!child || child.exitCode !== null) return
    child.kill()
    await Promise.race([
        new Promise(resolve => child.once('exit', resolve)),
        new Promise(resolve => setTimeout(resolve, 3000))
    ])
    if (child.exitCode === null) child.kill('SIGKILL')
}

async function main() {
    const runtimeRoot = path.join(tempRoot, 'dist')
    copyTree(path.join(projectRoot, 'dist'), runtimeRoot)
    fs.copyFileSync(path.join(projectRoot, 'package.json'), path.join(tempRoot, 'package.json'))

    const config = JSON.parse(fs.readFileSync(path.join(projectRoot, 'src', 'config.example.json'), 'utf8'))
    const exampleAccounts = JSON.parse(fs.readFileSync(path.join(projectRoot, 'src', 'accounts.example.json'), 'utf8'))
    const account = {
        ...exampleAccounts[0],
        email: 'web-state@example.test',
        password: 'synthetic-password',
        recoveryEmail: '',
        totpSecret: ''
    }
    fs.writeFileSync(path.join(runtimeRoot, 'config.json'), `${JSON.stringify(config, null, 2)}\n`)
    fs.writeFileSync(path.join(runtimeRoot, 'accounts.json'), `${JSON.stringify([account], null, 2)}\n`)

    const labels = [
        '领取奖励积分',
        'App 活动',
        '每日任务',
        '特殊活动',
        '更多推广',
        '每日签到',
        '打卡活动',
        '移动搜索',
        'PC搜索',
        '阅读赚取'
    ]
    const details = labels.map((label, index) => ({
        key: `synthetic-task-${index}`,
        label,
        group: label === '移动搜索' ? 'mobile' : label === 'PC搜索' ? 'desktop' : 'activity',
        completed: index + 1,
        total: index + 1,
        gained: index,
        status: index === 2 ? '已跳过' : index === 3 ? '失败' : '已完成',
        message: `合成状态 ${index + 1}`,
        updatedAt: label === '阅读赚取' ? '2026-08-31T00:01:00.000Z' : '2026-08-30T23:59:00.000Z'
    }))

    fs.mkdirSync(path.join(tempRoot, 'logs'), { recursive: true })
    fs.writeFileSync(
        path.join(tempRoot, 'logs', 'task-progress.json'),
        `${JSON.stringify(
            {
                date: '2026-08-31',
                accounts: [
                    {
                        accountHash: accountHash(account.email),
                        updatedAt: '2026-08-31T00:01:00.000Z',
                        initialPoints: 14202,
                        currentPoints: 14240,
                        finalPoints: 14240,
                        currentTask: '阅读赚取',
                        currentStage: 'activity',
                        currentMessage: '阅读赚取已完成',
                        desktop: { completed: 30, total: 30, gained: 30, status: '已完成' },
                        mobile: { completed: 20, total: 20, gained: 20, status: '已完成' },
                        daily: { completed: 8, total: 10, gained: 8, status: '进行中' },
                        details
                    }
                ]
            },
            null,
            2
        )}\n`
    )

    const preload = path.join(tempRoot, 'freeze-date.cjs')
    fs.writeFileSync(
        preload,
        [
            'const RealDate = Date',
            "const fixed = process.env.TEST_NOW || '2026-08-31T00:01:00Z'",
            'global.Date = class extends RealDate {',
            '  constructor(...args) { super(...(args.length ? args : [fixed])) }',
            '  static now() { return new RealDate(fixed).getTime() }',
            '}'
        ].join('\n')
    )

    const port = await getFreePort()
    const baseUrl = `http://127.0.0.1:${port}`
    let output = ''
    child = spawn(process.execPath, ['--require', preload, path.join(runtimeRoot, 'web', 'server.js')], {
        cwd: tempRoot,
        env: {
            ...process.env,
            TZ: 'Asia/Shanghai',
            TEST_NOW: '2026-08-31T00:01:00Z',
            NODE_PATH: path.join(projectRoot, 'node_modules'),
            WEB_UI_HOST: '127.0.0.1',
            WEB_UI_PORT: String(port),
            WEB_AUTH_FILE: path.join(tempRoot, 'config', 'web-auth.json'),
            WEB_AUTH_MIRROR_FILE: '',
            RUNTIME_LOG_FILE: path.join(tempRoot, 'logs', 'runtime.log'),
            RUN_LOCK_FILE: path.join(tempRoot, 'run.lock'),
            RUN_LOCK_META_FILE: path.join(tempRoot, 'run.lock.meta')
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
    })
    child.stdout.on('data', chunk => {
        output += chunk.toString()
    })
    child.stderr.on('data', chunk => {
        output += chunk.toString()
    })

    await waitForServer(baseUrl, () => output)

    const setupResponse = await fetch(`${baseUrl}/api/setup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            username: 'test-admin',
            password: 'synthetic-password',
            passwordConfirm: 'synthetic-password'
        })
    })
    assert.equal(setupResponse.status, 200)
    const cookie = setupResponse.headers.get('set-cookie')?.split(';')[0]
    assert.ok(cookie)

    const stateResponse = await fetch(`${baseUrl}/api/state`, { headers: { Cookie: cookie } })
    assert.equal(stateResponse.status, 200)
    const state = await stateResponse.json()
    assert.equal(state.taskProgress.length, 1)

    const progress = state.taskProgress[0]
    assert.equal(progress.initialPoints, 14202)
    assert.equal(progress.currentPoints, 14240)
    assert.equal(progress.finalPoints, 14240)
    assert.deepEqual(progress.details.map(detail => detail.label).sort(), [...labels].sort())
    assert.ok(progress.details.some(detail => detail.updatedAt === '2026-08-30T23:59:00.000Z'))
    assert.ok(progress.details.some(detail => detail.label === '阅读赚取'))
    assert.ok(progress.details.some(detail => detail.status === '已完成'))
    assert.ok(progress.details.some(detail => detail.status === '已跳过'))
    assert.ok(progress.details.some(detail => detail.status === '失败'))

    console.log('webTaskProgressState.test.js passed')
}

main()
    .catch(error => {
        console.error(error instanceof Error ? error.message : String(error))
        process.exitCode = 1
    })
    .finally(async () => {
        await stopChild()
        fs.rmSync(tempRoot, { recursive: true, force: true })
    })
