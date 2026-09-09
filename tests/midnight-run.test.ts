import { afterEach, describe, expect, it, vi } from 'vitest'
import { SqliteStore } from '../src/infra/SqliteStore.js'
import { ApplicationRunCoordinator } from '../src/orchestration/RunCoordinator.js'
import { BusinessDateChanged } from '../src/orchestration/BusinessDate.js'
import type { AccountPipelineContext, StageResult } from '../src/orchestration/AccountPipeline.js'
import type { FieldEvidence } from '../src/domain/Evidence.js'
import type { AccountSecretStore } from '../src/infra/AccountSecretStore.js'
import type { EncryptedSessionStore } from '../src/auth/EncryptedSessionStore.js'
import type { BrowserRuntime } from '../src/browser/BrowserRuntime.js'
import type { StructuredLogger } from '../src/infra/StructuredLogger.js'
import { DEFAULT_CONFIG } from '../src/infra/Config.js'

afterEach(() => {
  vi.useRealTimers()
})

describe('cross-midnight coordinator', () => {
  it('rediscovers the new business day inside the same run without confirming old tasks', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-08T15:59:00Z'))
    const store = new SqliteStore(':memory:')
    const accounts = {
      list: () => [
        {
          accountId: 'synthetic',
          runAccountIndex: 1,
          maskedEmail: 's***@example.test',
          enabled: true
        }
      ],
      getCredentials: () => ({ email: 'synthetic@example.test', password: 'synthetic-only' })
    }
    const runner = new ApplicationRunCoordinator(
      accounts as unknown as AccountSecretStore,
      store,
      {} as EncryptedSessionStore,
      { close: () => Promise.resolve() } as unknown as BrowserRuntime,
      {} as StructuredLogger,
      DEFAULT_CONFIG
    )
    const port = runner as unknown as {
      executeStage(
        stage: string,
        context: AccountPipelineContext,
        mode: string,
        credentials: unknown,
        resources: {
          initialPoints?: number
          finalPoints?: number
          finalEvidence?: FieldEvidence<number>
        }
      ): Promise<StageResult>
    }
    const dates: string[] = []
    let crossed = false
    vi.spyOn(port, 'executeStage').mockImplementation(
      (stage, context, _mode, _credentials, resources) => {
        if (stage === 'discover') {
          dates.push(context.localDate)
          resources.initialPoints = 100
          store.upsertTask(
            {
              taskId: `${context.localDate}:task`,
              accountId: 'synthetic',
              localDate: context.localDate,
              sourceTaskId: 'task',
              type: 'daily-set',
              source: 'rsc',
              displayName: 'Synthetic',
              executable: true,
              required: true,
              status: 'discovered',
              progress: { completed: 0, total: 1 },
              updatedAt: new Date().toISOString()
            },
            context.runId
          )
        }
        if (stage === 'web-rewards' && !crossed) {
          crossed = true
          vi.setSystemTime(new Date('2026-09-08T16:01:00Z'))
          throw new BusinessDateChanged()
        }
        if (stage === 'final-verification') {
          resources.finalPoints = 100
          resources.finalEvidence = {
            value: 100,
            availability: 'valid',
            confidence: 0.9,
            source: 'bing-flyout',
            observedAt: new Date().toISOString()
          }
        }
        return Promise.resolve({ status: 'completed' })
      }
    )
    try {
      const result = await runner.start({ accountMode: 'continue', executionMode: 'read-only' })
      await vi.waitFor(() => {
        expect(runner.activeRunId).toBeUndefined()
      })
      expect(dates).toEqual(['2026-09-08', '2026-09-09'])
      expect(store.listRuns()).toHaveLength(1)
      expect(store.ledger.tasks(result.runId).map((row) => row.status)).toEqual([
        'discovered',
        'discovered'
      ])
      expect(store.ledger.accounts(result.runId)[0]?.executionState).toBe('partial')
    } finally {
      store.close()
    }
  })
})
