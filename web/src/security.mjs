import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi
const SECRET_ASSIGNMENT_RE =
    /\b(password|passwd|pwd|token|secret|cookie|authorization|corpsecret|client_secret)(\s*[:=]\s*)([^\s|,;]+)/gi
const QUERY_SECRET_RE =
    /([?&](?:code|access_token|id_token|refresh_token|request_token|client_secret|RequestVerificationToken)=)[^&\s|]+/gi

export function maskEmail(value) {
    const email = String(value ?? '').trim()
    const at = email.lastIndexOf('@')
    if (at <= 0) return '账号'
    const local = email.slice(0, at)
    const domain = email.slice(at + 1)
    const parts = domain.split('.')
    const domainName = parts.shift() || ''
    const suffix = parts.length ? `.${parts.join('.')}` : ''
    return `${local.slice(0, 1) || '*'}***@${domainName.slice(0, 1) || '*'}***${suffix}`
}

export function sanitizeText(value, maxLength = 4000) {
    const withoutControls = [...String(value ?? '')]
        .filter(character => {
            const code = character.charCodeAt(0)
            return code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127)
        })
        .join('')
    return withoutControls
        .replace(EMAIL_RE, email => maskEmail(email))
        .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [REDACTED]')
        .replace(QUERY_SECRET_RE, '$1[REDACTED]')
        .replace(SECRET_ASSIGNMENT_RE, '$1$2[REDACTED]')
        .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[IP-REDACTED]')
        .replace(/\b[A-Za-z0-9_-]{64,}\b/g, '[TOKEN-REDACTED]')
        .slice(0, maxLength)
}

export function sanitizeLog(entry) {
    const safe = {
        id: Number.isSafeInteger(Number(entry?.id)) ? Number(entry.id) : null,
        runId: typeof entry?.runId === 'string' ? sanitizeText(entry.runId, 100) : null,
        receivedAt: typeof entry?.receivedAt === 'string' ? entry.receivedAt : null,
        ts: typeof entry?.ts === 'string' ? sanitizeText(entry.ts, 120) : null,
        level: ['debug', 'info', 'warn', 'error'].includes(entry?.level) ? entry.level : 'info',
        platform: typeof entry?.platform === 'string' ? sanitizeText(entry.platform, 30) : null,
        title: typeof entry?.title === 'string' ? sanitizeText(entry.title, 80) : null,
        message: sanitizeText(entry?.message ?? entry?.raw ?? '', 8000),
        source: typeof entry?.source === 'string' ? sanitizeText(entry.source, 30) : null,
        parsed: Boolean(entry?.parsed)
    }
    return safe
}

export class AccountIdentity {
    constructor(dataDir) {
        fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })
        this.keyFile = path.join(dataDir, 'identity.key')
        if (!fs.existsSync(this.keyFile)) {
            fs.writeFileSync(this.keyFile, crypto.randomBytes(32), { mode: 0o600, flag: 'wx' })
        }
        this.key = fs.readFileSync(this.keyFile)
        if (this.key.length < 32) throw new Error('账号脱敏密钥无效')
        try {
            fs.chmodSync(this.keyFile, 0o600)
        } catch {}
    }

    keyFor(email) {
        return crypto.createHmac('sha256', this.key).update(String(email).trim().toLowerCase()).digest('hex')
    }

    labelFor(email) {
        return maskEmail(email)
    }
}

export function timingSafeTextEqual(left, right) {
    const a = Buffer.from(String(left))
    const b = Buffer.from(String(right))
    return a.length === b.length && crypto.timingSafeEqual(a, b)
}
