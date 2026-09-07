import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { SettingsStore } from '../src/settings.mjs'
import { WeComNotifier } from '../src/wecom.mjs'

test(
    'Linux non-root user creates and reloads the encrypted settings file',
    { skip: process.platform === 'win32' || process.getuid?.() === 0 },
    () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mrs-nonroot-'))
        const keyFile = path.join(dir, 'key')
        try {
            fs.writeFileSync(keyFile, Buffer.alloc(32, 25), { mode: 0o400 })
            const settings = new SettingsStore({ dataDir: dir, keyFile })
            settings.setWeCom({ enabled: false })
            assert.equal(fs.statSync(settings.vault.dataFile).mode & 0o777, 0o600)
            assert.equal(new SettingsStore({ dataDir: dir, keyFile }).getWeCom().enabled, false)
        } finally {
            fs.rmSync(dir, { recursive: true, force: true })
        }
    }
)

test('vault validates key material, persists toggles and reports corrupt stores without falling back', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mrs-vault-test-'))
    const keyFile = path.join(dir, 'key')
    const settings = new SettingsStore({ dataDir: dir, keyFile })
    try {
        assert.equal(settings.status().code, 'KEY_MISSING')
        fs.writeFileSync(keyFile, 'invalid')
        assert.equal(settings.status().code, 'KEY_INVALID')
        assert.throws(() => settings.setWeCom({ enabled: true }), /格式/)
        fs.writeFileSync(keyFile, Buffer.alloc(32, 17))
        const notifier = new WeComNotifier({ settings, fetchImpl: () => assert.fail('external request') })
        assert.equal(notifier.status().source, 'unconfigured')
        notifier.update({
            enabled: true,
            mode: 'direct',
            corpId: 'synthetic',
            agentId: '1',
            corpSecret: 'synthetic-only',
            toUser: '@all'
        })
        notifier.update({})
        assert.equal(notifier.status().enabled, true)
        assert.equal(notifier.status().source, 'encrypted')
        notifier.update({ enabled: false })
        const restarted = new WeComNotifier({ settings })
        assert.equal(restarted.status().enabled, false)
        assert.ok(restarted.status().savedAt)
        restarted.update({ clearSecret: true })
        assert.equal(new WeComNotifier({ settings }).status().hasSecret, false)
        const file = path.join(dir, 'settings.enc.json')
        fs.writeFileSync(file, '{}')
        const corrupt = new WeComNotifier({ settings })
        assert.equal(corrupt.status().configured, false)
        assert.equal(corrupt.status().storageCode, 'STORE_READ_FAILED')
        assert.throws(() => corrupt.update({ enabled: true }))
        assert.equal(fs.readFileSync(file, 'utf8'), '{}')
    } finally {
        fs.rmSync(dir, { recursive: true, force: true })
    }
})

test('environment configuration cannot send until explicitly saved into encrypted storage', async () => {
    const previous = process.env.WEB_WECOM_ENABLED
    process.env.WEB_WECOM_ENABLED = 'true'
    try {
        const notifier = new WeComNotifier({ fetchImpl: () => assert.fail('must not send') })
        assert.equal((await notifier.sendTest()).sent, false)
    } finally {
        if (previous === undefined) delete process.env.WEB_WECOM_ENABLED
        else process.env.WEB_WECOM_ENABLED = previous
    }
})

test('explicit environment migration creates encrypted authority and never overwrites existing settings', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mrs-env-migration-'))
    const keyFile = path.join(dir, 'key')
    const previous = { ...process.env }
    try {
        Object.assign(process.env, {
            WEB_WECOM_ENABLED: 'true',
            WEB_WECOM_CORP_ID: 'synthetic-corp',
            WEB_WECOM_AGENT_ID: '1',
            WEB_WECOM_CORP_SECRET: 'synthetic-only',
            WEB_WECOM_TO_USER: '@all'
        })
        fs.writeFileSync(keyFile, Buffer.alloc(32, 22))
        const settings = new SettingsStore({ dataDir: dir, keyFile })
        const notifier = new WeComNotifier({ settings })
        assert.equal(notifier.configured(), false)
        assert.equal(notifier.status().migrationAvailable, true)
        const result = notifier.update({}, { migrateEnvironment: true })
        assert.equal(result.source, 'encrypted')
        assert.equal(result.configured, true)
        assert.ok(result.savedAt)
        assert.throws(() => notifier.update({}, { migrateEnvironment: true }), /不能覆盖/)
    } finally {
        process.env = previous
        fs.rmSync(dir, { recursive: true, force: true })
    }
})

test('permission and atomic rename failures are explicit and preserve the old configuration', t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mrs-write-failure-'))
    const keyFile = path.join(dir, 'key')
    fs.writeFileSync(keyFile, Buffer.alloc(32, 23))
    const settings = new SettingsStore({ dataDir: dir, keyFile })
    try {
        settings.setWeCom({ enabled: false })
        const original = fs.readFileSync(settings.vault.dataFile, 'utf8')
        const access = fs.accessSync
        const denied = t.mock.method(fs, 'accessSync', (file, mode) => {
            if (file === keyFile) throw Object.assign(new Error('synthetic'), { code: 'EACCES' })
            return access(file, mode)
        })
        assert.equal(settings.status().code, 'KEY_PERMISSION')
        denied.mock.restore()
        const rename = t.mock.method(fs, 'renameSync', () => {
            throw Object.assign(new Error('synthetic'), { code: 'EACCES' })
        })
        assert.throws(() => settings.setWeCom({ enabled: true }), /未保存/)
        rename.mock.restore()
        assert.equal(fs.readFileSync(settings.vault.dataFile, 'utf8'), original)
        assert.deepEqual(fs.readdirSync(dir).sort(), ['key', 'settings.enc.json'])
    } finally {
        fs.rmSync(dir, { recursive: true, force: true })
    }
})

test(
    'Linux non-root key permission denial is explicit',
    { skip: process.platform === 'win32' || process.getuid?.() === 0 },
    () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mrs-permission-'))
        const keyFile = path.join(dir, 'key')
        try {
            fs.writeFileSync(keyFile, Buffer.alloc(32, 19), { mode: 0 })
            const settings = new SettingsStore({ dataDir: dir, keyFile })
            assert.equal(settings.status().code, 'KEY_PERMISSION')
        } finally {
            fs.chmodSync(keyFile, 0o600)
            fs.rmSync(dir, { recursive: true, force: true })
        }
    }
)
