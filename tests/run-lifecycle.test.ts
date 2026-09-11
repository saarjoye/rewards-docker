import { describe, expect, it, vi } from 'vitest'

import type { EncryptedSessionStore } from '../src/auth/EncryptedSessionStore.js'
import type { BrowserRuntime } from '../src/browser/BrowserRuntime.js'
import type { AccountSecretStore } from '../src/infra/AccountSecretStore.js'
import { DEFAULT_CONFIG } from '../src/infra/Config.js'
import { SqliteStore } from '../src/infra/SqliteStore.js'
import type { StructuredLogger } from '../src/infra/StructuredLogger.js'
import { ApplicationRunCoordinator } from '../src/orchestration/RunCoordinator.js'

function fixture() {
  const store = new SqliteStore(':memory:')
  const browser = { close: vi.fn().mockResolvedValue(undefined), openSlot: vi.fn() }
  const accounts = {
    list: () => [
      {
        accountId: 'synthetic',
        runAccountIndex: 1,
        enabled: true,
        maskedEmail: 's***@example.test'
      }
    ],
    getCredentials: (): { email: string; password: string } => {
      throw new Error('synthetic execution failure')
    }
  }
  const runner = new ApplicationRunCoordinator(
    accounts as unknown as AccountSecretStore,
    store,
    {} as EncryptedSessionStore,
    browser as unknown as BrowserRuntime,
    {} as StructuredLogger,
    DEFAULT_CONFIG
  )
  return { store, browser, runner, accounts }
}

describe('run lifecycle durability', () => {
  it('rejects pending-search retry in continue mode', async () => {
    const { store, runner } = fixture()
    try {
      await expect(
        runner.start({ accountMode: 'continue', retryPendingSearch: true })
      ).rejects.toThrow('retryPendingSearch requires single-account mode')
      expect(store.listRuns()).toHaveLength(0)
    } finally {
      store.close()
    }
  })

  it.each(['cancelled', 'interrupted'] as const)(
    'waits for %s cleanup and persists a terminal run and account',
    async (reason) => {
      const { store, runner, browser, accounts } = fixture()
      try {
        vi.spyOn(accounts, 'getCredentials').mockReturnValue({
          email: 'synthetic@example.test',
          password: 'synthetic'
        })
        let rejectOpen: (error: Error) => void = () => {
          throw new Error('not started')
        }
        browser.openSlot.mockImplementation(
          () =>
            new Promise((_resolve, reject) => {
              rejectOpen = reject
            })
        )
        const { runId } = await runner.start({ accountMode: 'continue' })
        const completion = runner.stopAndWait(reason)
        expect(store.listRuns()[0]?.status).toBe('cancelling')
        rejectOpen(new Error('synthetic cancellation'))
        await completion
        expect(store.listRuns()[0]).toMatchObject({ runId, status: reason })
        expect(store.listAccountRuns(runId)[0]).toMatchObject({
          status: 'partial',
          stage: 'cancelled'
        })
        expect(runner.activeRunId).toBeUndefined()
      } finally {
        store.close()
      }
    }
  )

  it('recovers only unfinished records without inventing an end time or changing points', () => {
    const { store } = fixture()
    try {
      store.createRun({
        runId: 'old',
        localDate: '2026-09-08',
        executionMode: 'read-only',
        selectedAccountIndexes: [1, 2, 3],
        startedAt: '2026-09-08T01:00:00Z'
      })
      store.updateRun('old', 'running')
      store.recordPoints({
        accountId: 'synthetic-0',
        localDate: '2026-09-08',
        initialPoints: 200,
        finalPoints: 180,
        status: 'success',
        balanceConfirmed: true,
        recordedAt: '2026-09-08T01:00:00Z'
      })
      for (const [index, status] of ['success', 'running', 'queued'].entries()) {
        store.upsertAccountRun({
          runId: 'old',
          accountId: `synthetic-${String(index)}`,
          runAccountIndex: index + 1,
          localDate: '2026-09-08',
          status: status as 'success' | 'running' | 'queued',
          updatedAt: '2026-09-08T01:00:00Z'
        })
      }
      store.recoverInterruptedRuns('2026-09-08T02:00:00Z')
      store.recoverInterruptedRuns('2026-09-08T03:00:00Z')
      expect(store.listRuns()[0]).toMatchObject({ status: 'interrupted' })
      expect(store.listRuns()[0]?.finishedAt).toBeUndefined()
      expect(store.getLatestPointsHistory('synthetic-0', '2026-09-08')).toMatchObject({
        initialPoints: 200,
        finalPoints: 180,
        gainedPoints: -20
      })
      expect(store.listAccountRuns('old').map((row) => row.status)).toEqual([
        'success',
        'partial',
        'queued'
      ])
      expect(store.listAccountRuns('old')[1]?.updatedAt).toBe('2026-09-08T02:00:00Z')
    } finally {
      store.close()
    }
  })

  it('persists an unexpected failure and releases the active run', async () => {
    const { store, runner, browser } = fixture()
    try {
      const { runId } = await runner.start({ accountMode: 'account', runAccountIndex: 1 })
      await expect(runner.stopAndWait()).rejects.toThrow('synthetic execution failure')
      expect(store.listRuns()[0]).toMatchObject({ runId, status: 'failed' })
      expect(store.listRuns()[0]?.finishedAt).toBeDefined()
      expect(runner.activeRunId).toBeUndefined()
      expect(browser.close).toHaveBeenCalledOnce()
    } finally {
      store.close()
    }
  })

  it('does not retain an active lock when creating the run fails', async () => {
    const { store, runner } = fixture()
    try {
      vi.spyOn(store, 'createRun').mockImplementation(() => {
        throw new Error('write failed')
      })
      await expect(runner.start({ accountMode: 'continue' })).rejects.toThrow('write failed')
      expect(runner.activeRunId).toBeUndefined()
    } finally {
      store.close()
    }
  })

  it('rejects concurrent coordinators sharing one store before a second run is created', async () => {
    const first = fixture()
    const second = new ApplicationRunCoordinator(
      first.accounts as unknown as AccountSecretStore,
      first.store,
      {} as EncryptedSessionStore,
      first.browser as unknown as BrowserRuntime,
      {} as StructuredLogger,
      DEFAULT_CONFIG
    )
    try {
      const firstStart = first.runner.start({ accountMode: 'continue' })
      const secondStart = second.start({ accountMode: 'continue' })
      const [firstResult, secondResult] = await Promise.all([
        firstStart.then(() => ({ status: 'fulfilled' as const })),
        secondStart.then(
          () => ({ status: 'fulfilled' as const }),
          (error: unknown) => ({ status: 'rejected' as const, reason: error })
        )
      ])
      expect(firstResult.status).toBe('fulfilled')
      expect(secondResult.status).toBe('rejected')
      if (secondResult.status === 'rejected')
        expect(secondResult.reason).toMatchObject({ name: 'RunAlreadyActiveError' })
      await first.runner.stopAndWait().catch(() => undefined)
    } finally {
      first.store.close()
    }
  })
})
