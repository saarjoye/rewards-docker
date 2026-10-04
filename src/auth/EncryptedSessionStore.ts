import { rmdirSync, unlinkSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { AUTH_SLOTS, type AuthSlot } from './AuthSlot.js'
import { writeFileAtomic } from '../infra/AtomicFile.js'
import { decryptBytes, encryptBytes, type EncryptedEnvelope } from '../security/CryptoVault.js'

export interface StoredSession<T = unknown> {
  accountId: string
  slot: AuthSlot
  validatedAt: string
  payload: T
}

export class EncryptedSessionStore {
  constructor(
    private readonly rootDirectory: string,
    private readonly key: Buffer
  ) {}

  async read<T>(accountId: string, slot: AuthSlot): Promise<StoredSession<T> | undefined> {
    try {
      const raw = await readFile(this.sessionPath(accountId, slot), 'utf8')
      const envelope = JSON.parse(raw) as EncryptedEnvelope
      return JSON.parse(decryptBytes(envelope, this.key).toString('utf8')) as StoredSession<T>
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return undefined
      throw error
    }
  }

  async commitVerified<T>(session: StoredSession<T>, verified: boolean): Promise<void> {
    if (!verified) throw new Error('Unverified session cannot be persisted')
    const plaintext = Buffer.from(JSON.stringify(session), 'utf8')
    const encrypted = encryptBytes(plaintext, this.key)
    await writeFileAtomic(
      this.sessionPath(session.accountId, session.slot),
      JSON.stringify(encrypted),
      0o600
    )
  }

  removeAll(accountId: string): void {
    for (const slot of AUTH_SLOTS) {
      try {
        unlinkSync(this.sessionPath(accountId, slot))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    try {
      rmdirSync(this.accountDirectory(accountId))
    } catch (error) {
      if (!['ENOENT', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? ''))
        throw error
    }
  }

  private sessionPath(accountId: string, slot: AuthSlot): string {
    return join(this.accountDirectory(accountId), `${slot}.json.enc`)
  }

  private accountDirectory(accountId: string): string {
    const safeAccountId = accountId.replace(/[^A-Za-z0-9_-]/g, '_')
    return join(this.rootDirectory, safeAccountId)
  }
}
