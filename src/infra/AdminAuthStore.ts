import { createHash, randomBytes } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

import { hashPassword, verifyPassword, type PasswordDigest } from '../security/CryptoVault.js'

const SESSION_LIFETIME_MS = 12 * 60 * 60 * 1000

function hashToken(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export class AdminAuthStore {
  constructor(private readonly database: DatabaseSync) {}

  isInitialized(): boolean {
    const row = this.database.prepare('SELECT COUNT(*) AS count FROM administrators').get() as {
      count: number
    }
    return row.count > 0
  }

  initialize(username: string, password: string, now = new Date()): void {
    if (this.isInitialized()) throw new Error('Administrator is already initialized')
    const timestamp = now.toISOString()
    this.database
      .prepare(
        `
        INSERT INTO administrators(username, password_digest, created_at, updated_at)
        VALUES (?, ?, ?, ?)
      `
      )
      .run(username.trim(), JSON.stringify(hashPassword(password)), timestamp, timestamp)
  }

  authenticate(username: string, password: string): boolean {
    const row = this.database
      .prepare('SELECT password_digest FROM administrators WHERE username = ?')
      .get(username) as { password_digest: string } | undefined
    if (!row) return false
    return verifyPassword(password, JSON.parse(row.password_digest) as PasswordDigest)
  }

  createSession(
    username: string,
    now = new Date()
  ): { token: string; csrfToken: string; expiresAt: string } {
    const token = randomBytes(32).toString('base64url')
    const csrfToken = hashToken(`csrf:${token}`)
    const expiresAt = new Date(now.getTime() + SESSION_LIFETIME_MS).toISOString()
    this.database
      .prepare(
        `
        INSERT INTO web_sessions(token_hash, username, csrf_hash, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?)
      `
      )
      .run(hashToken(token), username, hashToken(csrfToken), expiresAt, now.toISOString())
    return { token, csrfToken, expiresAt }
  }

  validateSession(token: string, csrfToken?: string, now = new Date()): boolean {
    const row = this.database
      .prepare('SELECT csrf_hash, expires_at FROM web_sessions WHERE token_hash = ?')
      .get(hashToken(token)) as { csrf_hash: string; expires_at: string } | undefined
    if (!row || Date.parse(row.expires_at) <= now.getTime()) return false
    return csrfToken === undefined || row.csrf_hash === hashToken(csrfToken)
  }

  restoreSession(token: string): { csrfToken: string } | undefined {
    const csrfToken = hashToken(`csrf:${token}`)
    return this.validateSession(token, csrfToken) ? { csrfToken } : undefined
  }

  revokeSession(token: string): void {
    this.database.prepare('DELETE FROM web_sessions WHERE token_hash = ?').run(hashToken(token))
  }

  removeExpiredSessions(now = new Date()): void {
    this.database.prepare('DELETE FROM web_sessions WHERE expires_at <= ?').run(now.toISOString())
  }
}
