import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export function keyFromFile(keyFile) {
    if (!keyFile) throw Object.assign(new Error('Web Secret 未配置'), { code: 'KEY_MISSING' })
    try {
        fs.accessSync(keyFile, fs.constants.R_OK)
    } catch (error) {
        throw Object.assign(
            new Error(error.code === 'EACCES' || error.code === 'EPERM' ? 'Web Secret 权限不足' : 'Web Secret 不存在'),
            { code: error.code === 'EACCES' || error.code === 'EPERM' ? 'KEY_PERMISSION' : 'KEY_MISSING' }
        )
    }
    let raw
    try {
        if (fs.statSync(keyFile).size > 128)
            throw Object.assign(new Error('Web Secret 格式或长度无效'), { code: 'KEY_INVALID' })
        raw = fs.readFileSync(keyFile)
    } catch (error) {
        if (error.code === 'KEY_INVALID') throw error
        throw Object.assign(new Error('Web Secret 权限不足或无法读取'), { code: 'KEY_PERMISSION' })
    }
    if (raw.length === 32) return raw
    const text = raw.toString('utf8').trim()
    if (/^[a-f0-9]{64}$/i.test(text)) return Buffer.from(text, 'hex')
    const decoded = /^[A-Za-z0-9+/]{43}=$/.test(text) ? Buffer.from(text, 'base64') : Buffer.alloc(0)
    if (decoded.length === 32) return decoded
    throw Object.assign(new Error('Web Secret 格式或长度无效'), { code: 'KEY_INVALID' })
}

export class CryptoVault {
    constructor({ keyFile, dataFile }) {
        this.keyFile = keyFile
        this.dataFile = dataFile
    }

    available() {
        return this.status().writable
    }

    status() {
        try {
            keyFromFile(this.keyFile).fill(0)
            if (this.exists()) {
                try {
                    fs.accessSync(this.dataFile, fs.constants.R_OK)
                } catch {
                    throw Object.assign(new Error('Web 加密配置库不可读'), { code: 'STORE_READ_PERMISSION' })
                }
                try {
                    fs.accessSync(this.dataFile, fs.constants.W_OK)
                } catch {
                    throw Object.assign(new Error('Web 加密配置库不可写'), { code: 'STORE_WRITE_PERMISSION' })
                }
            }
            let directory = path.dirname(this.dataFile)
            while (!fs.existsSync(directory) && path.dirname(directory) !== directory)
                directory = path.dirname(directory)
            try {
                fs.accessSync(directory, fs.constants.W_OK | fs.constants.X_OK)
            } catch {
                throw Object.assign(new Error('Web 加密配置库不可写'), { code: 'STORE_WRITE_PERMISSION' })
            }
            return { writable: true, code: null, message: null }
        } catch (error) {
            return {
                writable: false,
                code: error.code || 'STORE_PERMISSION',
                message: /^(KEY_|STORE_)/.test(error.code || '') ? error.message : 'Web 加密配置库不可读或不可写'
            }
        }
    }

    exists() {
        return fs.existsSync(this.dataFile)
    }

    read(fallback = null) {
        try {
            try {
                fs.statSync(this.dataFile)
            } catch (error) {
                if (error.code === 'ENOENT') return fallback
                throw error
            }
            const envelope = JSON.parse(fs.readFileSync(this.dataFile, 'utf8'))
            if (envelope?.version !== 1 || envelope?.algorithm !== 'aes-256-gcm') throw new Error('加密配置格式无效')
            const decipher = crypto.createDecipheriv(
                'aes-256-gcm',
                keyFromFile(this.keyFile),
                Buffer.from(envelope.iv, 'base64')
            )
            decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'))
            const plaintext = Buffer.concat([
                decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
                decipher.final()
            ])
            return JSON.parse(plaintext.toString('utf8'))
        } catch (error) {
            if (error.code?.startsWith('KEY_')) throw error
            throw Object.assign(new Error('Web 加密配置库不可读或解密失败'), { code: 'STORE_READ_FAILED' })
        }
    }

    write(value) {
        const status = this.status()
        if (!status.writable) throw Object.assign(new Error(status.message), { code: status.code })
        const iv = crypto.randomBytes(12)
        const cipher = crypto.createCipheriv('aes-256-gcm', keyFromFile(this.keyFile), iv)
        const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()])
        const envelope = {
            version: 1,
            algorithm: 'aes-256-gcm',
            iv: iv.toString('base64'),
            tag: cipher.getAuthTag().toString('base64'),
            ciphertext: ciphertext.toString('base64')
        }
        const temporary = `${this.dataFile}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
        try {
            fs.mkdirSync(path.dirname(this.dataFile), { recursive: true, mode: 0o700 })
            fs.writeFileSync(temporary, `${JSON.stringify(envelope)}\n`, { mode: 0o600, flag: 'wx' })
            fs.renameSync(temporary, this.dataFile)
        } catch {
            throw Object.assign(new Error('Web 加密配置库不可写，配置未保存'), { code: 'STORE_WRITE_FAILED' })
        } finally {
            if (fs.existsSync(temporary)) fs.unlinkSync(temporary)
        }
    }
}
