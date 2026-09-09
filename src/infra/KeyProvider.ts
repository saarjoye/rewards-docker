import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'

import { writeFileAtomic } from './AtomicFile.js'
import { assertEncryptionKey } from '../security/CryptoVault.js'

function decodeKey(raw: Buffer): Buffer {
  if (raw.length === 32) return raw
  const decoded = Buffer.from(raw.toString('utf8').trim(), 'base64')
  assertEncryptionKey(decoded)
  return decoded
}

export async function loadOrCreateMasterKey(
  preferredSecretPath: string,
  fallbackKeyPath: string
): Promise<Buffer> {
  try {
    return decodeKey(await readFile(preferredSecretPath))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  try {
    return decodeKey(await readFile(fallbackKeyPath))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  const key = randomBytes(32)
  await writeFileAtomic(fallbackKeyPath, `${key.toString('base64')}\n`, 0o600)
  return key
}
