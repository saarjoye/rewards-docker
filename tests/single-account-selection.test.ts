import { expect, it } from 'vitest'
import { readSingleAcceptanceAccount } from '../src/acceptance/AccountAcceptance.js'

it('reads only the explicitly selected account', () => {
  const reads: string[] = []
  const env = new Proxy<Record<string, string>>(
    {},
    {
      get: (_target, key: string) => {
        reads.push(key)
        if (key === 'ACCOUNT_3_EMAIL') return 'synthetic@example.test'
        if (key === 'ACCOUNT_3_PASSWORD') return 'synthetic-only'
        throw new Error('Unexpected configuration access')
      }
    }
  )
  expect(readSingleAcceptanceAccount(env, ['--account-index=3']).accountIndex).toBe(3)
  expect(reads).toEqual(['ACCOUNT_3_EMAIL', 'ACCOUNT_3_PASSWORD'])
  expect(() => readSingleAcceptanceAccount(env, [])).toThrow()
})
