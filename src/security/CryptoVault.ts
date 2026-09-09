import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  timingSafeEqual
} from 'node:crypto'

const KEY_LENGTH = 32
const IV_LENGTH = 12
const AUTH_TAG_LENGTH = 16

export interface EncryptedEnvelope {
  version: number
  algorithm: string
  iv: string
  authTag: string
  ciphertext: string
  createdAt: string
}

export interface PasswordDigest {
  version: number
  algorithm: string
  salt: string
  digest: string
}

export function assertEncryptionKey(key: Buffer): void {
  if (key.length !== KEY_LENGTH) {
    throw new RangeError(`Encryption key must contain exactly ${String(KEY_LENGTH)} bytes`)
  }
}

export function encryptBytes(plaintext: Uint8Array, key: Buffer): EncryptedEnvelope {
  assertEncryptionKey(key)
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: AUTH_TAG_LENGTH })
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])

  return {
    version: 1,
    algorithm: 'aes-256-gcm',
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    createdAt: new Date().toISOString()
  }
}

export function decryptBytes(envelope: EncryptedEnvelope, key: Buffer): Buffer {
  assertEncryptionKey(key)
  if (envelope.version !== 1 || envelope.algorithm !== 'aes-256-gcm') {
    throw new TypeError('Unsupported encrypted envelope')
  }

  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'), {
    authTagLength: AUTH_TAG_LENGTH
  })
  decipher.setAuthTag(Buffer.from(envelope.authTag, 'base64'))
  return Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
    decipher.final()
  ])
}

export function hashPassword(password: string): PasswordDigest {
  if (password.length < 12)
    throw new RangeError('Administrator password must be at least 12 characters')
  const salt = randomBytes(16)
  const digest = scryptSync(password, salt, 32)
  return {
    version: 1,
    algorithm: 'scrypt',
    salt: salt.toString('base64'),
    digest: digest.toString('base64')
  }
}

export function verifyPassword(password: string, stored: PasswordDigest): boolean {
  if (stored.version !== 1 || stored.algorithm !== 'scrypt') return false
  const expected = Buffer.from(stored.digest, 'base64')
  const actual = scryptSync(password, Buffer.from(stored.salt, 'base64'), expected.length)
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}
