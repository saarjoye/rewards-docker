import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const ALGORITHM = 'aes-256-gcm'

function readKey(keyFile) {
    if (!keyFile) throw Object.assign(new Error('Encryption key file is unavailable.'), { code: 'KEY_MISSING' })
    fs.accessSync(keyFile, fs.constants.R_OK)
    const raw = fs.readFileSync(keyFile)
    if (raw.length === 32) return raw

    const text = raw.toString('utf8').trim()
    if (/^[a-f0-9]{64}$/i.test(text)) return Buffer.from(text, 'hex')
    const decoded = /^[A-Za-z0-9+/]{43}=$/.test(text) ? Buffer.from(text, 'base64') : Buffer.alloc(0)
    if (decoded.length === 32) return decoded
    throw Object.assign(new Error('Encryption key must contain exactly 32 random bytes.'), { code: 'KEY_INVALID' })
}

export class CryptoVault {
    constructor({ keyFile, dataFile }) {
        this.keyFile = keyFile
        this.dataFile = dataFile
    }

    available() {
        return this.status().available
    }

    status() {
        try {
            readKey(this.keyFile).fill(0)
            return { available: true, code: null }
        } catch (error) {
            return {
                available: false,
                code:
                    error.code === 'EACCES' || error.code === 'EPERM'
                        ? 'KEY_PERMISSION'
                        : error.code === 'KEY_INVALID'
                          ? 'KEY_INVALID'
                          : 'KEY_MISSING'
            }
        }
    }

    exists() {
        return fs.existsSync(this.dataFile)
    }

    read(fallback = null) {
        if (!this.exists()) return fallback
        const envelope = JSON.parse(fs.readFileSync(this.dataFile, 'utf8'))
        if (envelope?.version !== 1 || envelope?.algorithm !== ALGORITHM) {
            throw new Error('Encrypted data format is not supported.')
        }
        const decipher = crypto.createDecipheriv(ALGORITHM, readKey(this.keyFile), Buffer.from(envelope.iv, 'base64'))
        decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'))
        const plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()])
        return JSON.parse(plaintext.toString('utf8'))
    }

    write(value) {
        if (!this.available()) throw new Error('Encryption key file is unavailable.')
        const iv = crypto.randomBytes(12)
        const cipher = crypto.createCipheriv(ALGORITHM, readKey(this.keyFile), iv)
        const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()])
        const envelope = {
            version: 1,
            algorithm: ALGORITHM,
            iv: iv.toString('base64'),
            tag: cipher.getAuthTag().toString('base64'),
            ciphertext: ciphertext.toString('base64')
        }
        fs.mkdirSync(path.dirname(this.dataFile), { recursive: true, mode: 0o700 })
        const temporary = `${this.dataFile}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
        fs.writeFileSync(temporary, `${JSON.stringify(envelope)}\n`, { mode: 0o600, flag: 'wx' })
        fs.renameSync(temporary, this.dataFile)
        try {
            fs.chmodSync(this.dataFile, 0o600)
        } catch {}
    }
}
