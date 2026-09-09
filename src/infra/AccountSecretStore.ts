import { randomUUID } from 'node:crypto'

import type { DatabaseSync } from 'node:sqlite'

import { decryptBytes, encryptBytes, type EncryptedEnvelope } from '../security/CryptoVault.js'
import { maskEmail } from '../security/Redactor.js'

export interface AccountCredentials {
  email: string
  password: string
}

export interface AccountSummary {
  accountId: string
  runAccountIndex: number
  displayAlias: string
  maskedEmail: string
  enabled: boolean
}

export class AccountSecretStore {
  constructor(
    private readonly database: DatabaseSync,
    private readonly key: Buffer
  ) {}

  create(
    input: { email: string; password: string; displayAlias?: string },
    now = new Date()
  ): string {
    const accountId = randomUUID()
    const credentials: AccountCredentials = { email: input.email, password: input.password }
    const encrypted = encryptBytes(Buffer.from(JSON.stringify(credentials), 'utf8'), this.key)
    const displayAlias = input.displayAlias?.trim() || maskEmail(input.email)
    const timestamp = now.toISOString()

    this.database
      .prepare(
        `
        INSERT INTO accounts(account_id, display_alias, encrypted_credentials, enabled, created_at, updated_at)
        VALUES (?, ?, ?, 1, ?, ?)
      `
      )
      .run(accountId, displayAlias, JSON.stringify(encrypted), timestamp, timestamp)
    return accountId
  }

  list(): AccountSummary[] {
    const rows = this.database
      .prepare(
        `
        SELECT account_id, display_alias, encrypted_credentials, enabled
        FROM accounts
        ORDER BY created_at, account_id
      `
      )
      .all() as Array<{
      account_id: string
      display_alias: string
      encrypted_credentials: string
      enabled: number
    }>

    return rows.map((row, index) => {
      const credentials = this.decryptCredentials(row.encrypted_credentials)
      return {
        accountId: row.account_id,
        runAccountIndex: index + 1,
        displayAlias: row.display_alias,
        maskedEmail: maskEmail(credentials.email),
        enabled: row.enabled === 1
      }
    })
  }

  getCredentials(accountId: string): AccountCredentials | undefined {
    const row = this.database
      .prepare('SELECT encrypted_credentials FROM accounts WHERE account_id = ? AND enabled = 1')
      .get(accountId) as { encrypted_credentials: string } | undefined
    return row ? this.decryptCredentials(row.encrypted_credentials) : undefined
  }

  update(
    accountId: string,
    input: { password?: string; displayAlias?: string; enabled?: boolean },
    now = new Date()
  ): boolean {
    const row = this.database
      .prepare(
        'SELECT encrypted_credentials, display_alias, enabled FROM accounts WHERE account_id = ?'
      )
      .get(accountId) as
      | { encrypted_credentials: string; display_alias: string; enabled: number }
      | undefined
    if (!row) return false

    const credentials = this.decryptCredentials(row.encrypted_credentials)
    const encryptedCredentials = input.password
      ? JSON.stringify(
          encryptBytes(
            Buffer.from(JSON.stringify({ ...credentials, password: input.password }), 'utf8'),
            this.key
          )
        )
      : row.encrypted_credentials
    const displayAlias = input.displayAlias?.trim() || row.display_alias
    const enabled = input.enabled === undefined ? row.enabled : input.enabled ? 1 : 0

    const result = this.database
      .prepare(
        `
        UPDATE accounts
        SET display_alias = ?, encrypted_credentials = ?, enabled = ?, updated_at = ?
        WHERE account_id = ?
      `
      )
      .run(displayAlias, encryptedCredentials, enabled, now.toISOString(), accountId)
    return result.changes === 1
  }

  private decryptCredentials(value: string): AccountCredentials {
    const envelope = JSON.parse(value) as EncryptedEnvelope
    return JSON.parse(decryptBytes(envelope, this.key).toString('utf8')) as AccountCredentials
  }
}
