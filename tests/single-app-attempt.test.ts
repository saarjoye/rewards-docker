import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import {
  reserveSingleAppAttempt,
  selectSingleAppOffer
} from '../src/acceptance/SingleAppAttempt.js'
import type { RewardOffer } from '../src/rewards/RewardsModel.js'

it('reserves only once, including concurrent attempts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'synthetic-app-gate-'))
  try {
    const results = await Promise.all(
      [1, 2].map(() => reserveSingleAppAttempt(root, 'synthetic', '2026-09-08'))
    )
    expect(results.sort()).toEqual([false, true])
    expect(await reserveSingleAppAttempt(root, 'synthetic', '2026-09-08')).toBe(false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('does not select completed, unknown or ambiguous daily check-in tasks', () => {
  const offer: RewardOffer = {
    sourceTaskId: 'synthetic',
    type: 'app-check-in',
    source: 'app-dashboard',
    displayName: 'Synthetic',
    complete: false,
    completed: 0,
    total: 10,
    executable: true
  }
  const now = new Date('2026-09-08T04:00:00Z')
  expect(selectSingleAppOffer([offer], now)).toBeUndefined()
  expect(
    selectSingleAppOffer([{ ...offer, attributes: { last_updated: now.toISOString() } }], now)
  ).toBeUndefined()
  expect(selectSingleAppOffer([{ ...offer, complete: true }], now)).toBeUndefined()
})
