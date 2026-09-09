import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { EncryptedSessionStore } from '../src/auth/EncryptedSessionStore.js'
import { AccountSecretStore } from '../src/infra/AccountSecretStore.js'
import { SqliteStore } from '../src/infra/SqliteStore.js'
import { StructuredLogger } from '../src/infra/StructuredLogger.js'
import { decryptBytes, encryptBytes } from '../src/security/CryptoVault.js'
import { redactRecord, redactText, safePath } from '../src/security/Redactor.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  )
})

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'rewards-next-test-'))
  temporaryDirectories.push(path)
  return path
}

describe('encrypted persistence', () => {
  it('round-trips encrypted bytes and rejects unverified sessions', async () => {
    const key = Buffer.alloc(32, 7)
    expect(decryptBytes(encryptBytes(Buffer.from('secret'), key), key).toString()).toBe('secret')
    const directory = await temporaryDirectory()
    const sessions = new EncryptedSessionStore(directory, key)
    await expect(
      sessions.commitVerified(
        {
          accountId: 'account',
          slot: 'web-desktop',
          validatedAt: '2026-09-03T00:00:00Z',
          payload: { cookie: 'canary' }
        },
        false
      )
    ).rejects.toThrow('Unverified session')
    await sessions.commitVerified(
      {
        accountId: 'account',
        slot: 'web-desktop',
        validatedAt: '2026-09-03T00:00:00Z',
        payload: { cookie: 'canary' }
      },
      true
    )
    expect(await sessions.read('account', 'web-desktop')).toMatchObject({
      payload: { cookie: 'canary' }
    })
    expect(
      await readFile(join(directory, 'account', 'web-desktop.json.enc'), 'utf8')
    ).not.toContain('canary')
  })

  it('keeps account credentials encrypted and preserves one-based order', async () => {
    const directory = await temporaryDirectory()
    const store = new SqliteStore(join(directory, 'state.sqlite'))
    try {
      const accounts = new AccountSecretStore(store.database, Buffer.alloc(32, 8))
      const firstId = accounts.create({
        email: 'first@example.test',
        password: 'synthetic-password',
        displayAlias: 'First'
      })
      accounts.create({
        email: 'last@example.test',
        password: 'synthetic-password-2',
        displayAlias: 'Last'
      })
      expect(accounts.list().map(({ runAccountIndex }) => runAccountIndex)).toEqual([1, 2])
      expect(accounts.update(firstId, { enabled: false })).toBe(true)
      expect(accounts.getCredentials(firstId)).toBeUndefined()
      const encrypted = store.database
        .prepare('SELECT encrypted_credentials FROM accounts WHERE account_id = ?')
        .get(firstId) as { encrypted_credentials: string }
      expect(encrypted.encrypted_credentials).not.toContain('first@example.test')
      expect(encrypted.encrypted_credentials).not.toContain('synthetic-password')
    } finally {
      store.close()
    }
  })
})

describe('log redaction', () => {
  it('removes account and token canaries without retaining query strings in paths', () => {
    const raw =
      'person@example.test code=secret-code Authorization=Bearer abc.def Cookie: cookie-canary'
    const redacted = redactText(raw)
    expect(redacted).not.toContain('person@example.test')
    expect(redacted).not.toContain('secret-code')
    expect(redacted).not.toContain('abc.def')
    expect(redacted).not.toContain('cookie-canary')
    expect(redactRecord({ cookie: 'secret-cookie', message: raw })).not.toEqual(
      expect.objectContaining({ cookie: 'secret-cookie' })
    )
    expect(safePath('https://rewards.bing.com/api/getuserinfo?code=secret')).toBe(
      'https://rewards.bing.com/api/getuserinfo'
    )
  })

  it('redacts alternate-email proof prefixes from Microsoft errors', () => {
    const chinese = redactText('这与你的帐户关联的备选电子邮件不匹配。正确的电子邮件应以“sa”开头。')
    const english = redactText('The correct email address should start with "sa".')
    expect(chinese).toContain('[redacted-proof]')
    expect(chinese).not.toContain('“sa”')
    expect(english).toContain('[redacted-proof]')
    expect(english).not.toContain('"sa"')
  })

  it('uses local dates for files while keeping UTC timestamps', async () => {
    const previousTimezone = process.env.TZ
    process.env.TZ = 'Asia/Shanghai'
    const directory = await temporaryDirectory()
    try {
      const logger = new StructuredLogger(directory)
      await logger.write(
        {
          level: 'error',
          event: 'login-failed',
          message: 'person@example.test code=secret-code'
        },
        new Date('2026-08-30T23:59:00Z')
      )
      await logger.write(
        { level: 'info', event: 'read-progress' },
        new Date('2026-08-31T00:01:00Z')
      )
      const contents = await readFile(join(directory, '2026-08-31.log'), 'utf8')
      expect(contents).toContain('2026-08-30T23:59:00.000Z')
      expect(contents).toContain('2026-08-31T00:01:00.000Z')
      expect(contents).not.toContain('person@example.test')
      expect(contents).not.toContain('secret-code')
    } finally {
      if (previousTimezone === undefined) delete process.env.TZ
      else process.env.TZ = previousTimezone
    }
  })
})
