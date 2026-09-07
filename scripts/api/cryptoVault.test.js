import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { CryptoVault } from './cryptoVault.js'

test('Core vault availability means a readable valid key, not merely an existing file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mrs-core-vault-'))
    const keyFile = path.join(dir, 'key')
    const vault = new CryptoVault({ keyFile, dataFile: path.join(dir, 'synthetic.enc.json') })
    try {
        assert.equal(vault.status().code, 'KEY_MISSING')
        fs.writeFileSync(keyFile, 'bad-key')
        assert.equal(vault.available(), false)
        assert.equal(vault.status().code, 'KEY_INVALID')
        fs.writeFileSync(keyFile, Buffer.alloc(32, 24))
        assert.equal(vault.available(), true)
        vault.write({ synthetic: true })
        assert.deepEqual(vault.read(), { synthetic: true })
    } finally {
        fs.rmSync(dir, { recursive: true, force: true })
    }
})
