import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { AccountStore } from './accountStore.js'

test('migrates environment accounts into encrypted storage and never exposes secrets', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mrs-account-store-'))
    const keyFile = path.join(dir, 'key')
    const dataFile = path.join(dir, 'accounts.enc.json')
    fs.writeFileSync(keyFile, Buffer.alloc(32, 7))
    const sourceEnv = {
        ACCOUNT_1_EMAIL: 'private@example.com',
        ACCOUNT_1_PASSWORD: 'test-password-value',
        ACCOUNT_1_TOTP_SECRET: 'TESTTOTPSECRET',
        ACCOUNT_1_GEO_LOCALE: 'cn',
        ACCOUNT_1_LANG_CODE: 'zh-cn',
        ACCOUNT_1_PROXY_URL: 'https://proxy.example.com',
        ACCOUNT_1_PROXY_PORT: '8443',
        ACCOUNT_1_PROXY_USERNAME: 'synthetic-user',
        ACCOUNT_1_PROXY_PASSWORD: 'synthetic-proxy-password'
    }

    try {
        const store = new AccountStore({ keyFile, dataFile, sourceEnv })
        assert.deepEqual(store.status(), { encrypted: false, writable: true, migrationAvailable: true })
        assert.throws(
            () => store.create({ email: 'new@example.com', geoLocale: 'auto', langCode: 'en' }),
            error => error.code === 'MIGRATION_REQUIRED'
        )
        assert.deepEqual(store.migrateEnvironment(), { migrated: 1 })

        const ciphertext = fs.readFileSync(dataFile, 'utf8')
        assert.doesNotMatch(ciphertext, /private@example\.com|test-password-value|TESTTOTPSECRET/)
        const publicAccount = store.publicAccounts()[0]
        assert.equal(publicAccount.label, 'p***@e***.com')
        assert.equal(publicAccount.hasPassword, true)
        assert.equal('email' in publicAccount, false)

        const id = publicAccount.id
        store.update(id, { email: '', password: '', geoLocale: 'US', langCode: 'en' })
        assert.equal(store.runEnvironment().ACCOUNT_1_PASSWORD, 'test-password-value')
        assert.equal(store.runEnvironment().ACCOUNT_1_PROXY_PORT, '8443')
        store.update(id, { clearSecrets: ['password'], geoLocale: 'US', langCode: 'en' })
        assert.equal(store.runEnvironment().ACCOUNT_1_PASSWORD, '')
        store.update(id, { clearProxy: true, geoLocale: 'US', langCode: 'en' })
        assert.equal(store.runEnvironment().ACCOUNT_1_PROXY_URL, '')
    } finally {
        fs.rmSync(dir, { recursive: true, force: true })
    }
})

test('uses an initialized empty encrypted store as the only account source', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mrs-account-empty-'))
    const keyFile = path.join(dir, 'key')
    const dataFile = path.join(dir, 'accounts.enc.json')
    fs.writeFileSync(keyFile, Buffer.alloc(32, 9))
    try {
        const store = new AccountStore({ keyFile, dataFile, sourceEnv: {} })
        store.create({ email: 'managed@example.com', geoLocale: 'auto', langCode: 'en' })
        store.delete(store.publicAccounts()[0].id)
        store.sourceEnv = { ACCOUNT_1_EMAIL: 'legacy@example.com' }
        assert.deepEqual(store.publicAccounts(), [])
        assert.equal(store.runEnvironment().ACCOUNT_1_EMAIL, '')
        assert.throws(
            () => store.migrateEnvironment(),
            error => error.code === 'ALREADY_MIGRATED'
        )
    } finally {
        fs.rmSync(dir, { recursive: true, force: true })
    }
})
