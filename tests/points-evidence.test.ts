import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { buildAcceptancePointsEvidence } from '../src/acceptance/PointsEvidence.js'
import { SqliteStore } from '../src/infra/SqliteStore.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  )
})

async function createStore(): Promise<SqliteStore> {
  const directory = await mkdtemp(join(tmpdir(), 'rewards-next-points-'))
  temporaryDirectories.push(directory)
  return new SqliteStore(join(directory, 'state.sqlite'))
}

describe('acceptance points evidence', () => {
  it('reports only a validated before-and-after delta', async () => {
    const store = await createStore()
    try {
      store.recordPoints({
        accountId: 'account-1',
        localDate: '2026-09-04',
        initialPoints: 100,
        finalPoints: 115,
        status: 'success',
        balanceConfirmed: true,
        recordedAt: '2026-09-04T00:01:00.000Z'
      })

      const record = store.getLatestPointsHistory('account-1', '2026-09-04')
      expect(record).toMatchObject({ gainedPoints: 15, balanceConfirmed: true })
      expect(buildAcceptancePointsEvidence(record)).toEqual({
        confirmed: true,
        delta: 15,
        increased: true,
        source: 'dashboard-before-after'
      })
    } finally {
      store.close()
    }
  })

  it('does not invent zero when either balance is missing', async () => {
    const store = await createStore()
    try {
      store.recordPoints({
        accountId: 'account-1',
        localDate: '2026-09-04',
        finalPoints: 115,
        status: 'partial',
        balanceConfirmed: true,
        recordedAt: '2026-09-04T00:01:00.000Z'
      })

      const record = store.getLatestPointsHistory('account-1', '2026-09-04')
      expect(record).toMatchObject({ gainedPoints: null, balanceConfirmed: false })
      expect(buildAcceptancePointsEvidence(record)).toEqual({
        confirmed: false,
        delta: null,
        increased: null,
        source: 'unconfirmed'
      })
      expect(buildAcceptancePointsEvidence(undefined)).toEqual({
        confirmed: false,
        delta: null,
        increased: null,
        source: 'unconfirmed'
      })
    } finally {
      store.close()
    }
  })

  it('rejects inconsistent stored deltas', () => {
    expect(
      buildAcceptancePointsEvidence({
        accountId: 'account-1',
        localDate: '2026-09-04',
        initialPoints: 100,
        finalPoints: 115,
        gainedPoints: 0,
        status: 'success',
        balanceConfirmed: true,
        recordedAt: '2026-09-04T00:01:00.000Z'
      })
    ).toEqual({
      confirmed: false,
      delta: null,
      increased: null,
      source: 'unconfirmed'
    })
  })
})
