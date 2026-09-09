import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ApplicationRunCoordinator,
  accountExecutionState
} from '../src/orchestration/RunCoordinator.js'
import { completionTitle, Notifications } from '../src/notifications/Notifications.js'
import { SqliteStore } from '../src/infra/SqliteStore.js'
import { DEFAULT_CONFIG } from '../src/infra/Config.js'
import { RunViews } from '../src/web/RunViews.js'
import type {
  AccountPipelineContext,
  AccountPipelineStage,
  StageResult
} from '../src/orchestration/AccountPipeline.js'
import type { FieldEvidence } from '../src/domain/Evidence.js'
import { MutationExecutor, OfferUnavailableError } from '../src/orchestration/MutationExecutor.js'
import type { TaskRecord } from '../src/domain/Task.js'
import { officialCredit } from '../src/rewards/OfficialCredit.js'

const task = (accountId = 'a'): TaskRecord => ({
  accountId,
  taskId: `${accountId}:day:offer`,
  sourceTaskId: 'offer',
  localDate: '2026-09-09',
  type: 'daily-set',
  source: 'rsc',
  displayName: 'Synthetic task',
  executable: true,
  required: true,
  status: 'verification-pending',
  progress: { completed: 0, total: null },
  updatedAt: '2026-09-09T01:00:00Z'
})
const balance = (value: number, observedAt: string): FieldEvidence<number> => ({
  value,
  observedAt,
  source: 'rsc',
  availability: 'valid',
  confidence: 1
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('account result regression', () => {
  it.each([
    ['success', 'completed'],
    ['partial', 'partial'],
    ['failed', 'failed'],
    ['action-required', 'action-required'],
    ['cancelled', 'cancelled'],
    ['interrupted', 'interrupted']
  ] as const)('maps %s explicitly', (input, output) => {
    expect(accountExecutionState(input)).toBe(output)
  })
  it('does not call an unavailable offer failed or resubmit an accepted mutation', async () => {
    const store = new SqliteStore(':memory:')
    try {
      const executor = new MutationExecutor(store)
      const adapter = {
        execute: vi
          .fn()
          .mockRejectedValue(
            new OfferUnavailableError('Offer currently unavailable; no submission')
          ),
        verify: vi
          .fn()
          .mockResolvedValue({ confirmed: false, progress: { completed: 0, total: null } })
      }
      expect((await executor.execute(task(), adapter, new AbortController().signal)).status).toBe(
        'verification-pending'
      )
      expect(store.getMutationState(task().taskId)).toBeUndefined()
      adapter.execute.mockResolvedValue({ accepted: true, observedAt: '2026-09-09T01:00:00Z' })
      await executor.execute(task(), adapter, new AbortController().signal)
      await executor.execute(task(), adapter, new AbortController().signal)
      expect(adapter.execute).toHaveBeenCalledTimes(2)
      expect(adapter.verify).toHaveBeenCalledTimes(2)
    } finally {
      store.close()
    }
  })
  it('accepts only a bound explicit official receipt and never a request ID or progress', () => {
    expect(
      officialCredit(
        { response: { offerId: 'offer', officialCreditId: 'credit-1', earnedPoints: 30 } },
        'offer'
      )
    ).toMatchObject({
      evidenceSource: 'official-credit',
      verificationStatus: 'confirmed',
      earnedPoints: 30
    })
    expect(
      officialCredit({ offerId: 'other', officialCreditId: 'credit-1', earnedPoints: 30 }, 'offer')
    ).toBeUndefined()
    expect(
      officialCredit({ offerId: 'offer', id: 'request-1', amount: 30, pointProgress: 30 }, 'offer')
    ).toBeUndefined()
  })
  it('retains execution evidence without inventing empty credits; keeps official progress pending', () => {
    const store = new SqliteStore(':memory:')
    try {
      store.upsertTask(task(), 'run')
      const input = {
        runId: 'run',
        accountId: 'a',
        taskId: task().taskId,
        source: 'rsc',
        kind: 'execution' as const,
        observedAt: '2026-09-09T01:00:00Z',
        executionState: 'running'
      }
      store.ledger.recordTaskEvidence(input)
      expect(store.ledger.credits.rows('a')).toHaveLength(0)
      store.ledger.recordTaskEvidence({
        ...input,
        kind: 'verification',
        credit: { evidenceSource: 'official-progress', expectedPoints: 30, submitted: true }
      })
      expect(store.ledger.credits.rows('a')[0]).toMatchObject({
        evidenceSource: 'official-progress',
        expectedPoints: 30,
        earnedPoints: null,
        verificationStatus: 'pending'
      })
      expect(() => {
        store.ledger.recordTaskEvidence({ ...input, accountId: 'other' })
      }).toThrow('account')
      expect(store.ledger.taskEvidence('run')).toHaveLength(2)
      store.ledger.recordTaskEvidence({
        ...input,
        kind: 'response',
        accepted: true,
        credit: {
          officialCreditId: 'credit',
          evidenceSource: 'official-credit',
          earnedPoints: 30,
          verificationStatus: 'confirmed'
        }
      })
      expect(
        store.ledger.taskEvidence('run').find((row) => row.kind === 'response')?.confirmedPoints
      ).toBe(30)
    } finally {
      store.close()
    }
  })
  it.each([false, true])(
    'runs three synthetic accounts and preserves partial (final read succeeds=%s)',
    async (finalReadSucceeds) => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-09-09T01:00:00Z'))
      const store = new SqliteStore(':memory:')
      const send = vi
        .fn<typeof fetch>()
        .mockImplementation((url) =>
          Promise.resolve(
            new Response(
              JSON.stringify(
                typeof url === 'string' && url.includes('gettoken')
                  ? { errcode: 0, access_token: 'synthetic', expires_in: 7200 }
                  : { errcode: 0 }
              )
            )
          )
        )
      const notifications = new Notifications(store, Buffer.alloc(32, 1), send)
      notifications.save({
        enabled: true,
        corpId: 'synthetic',
        corpSecret: 'synthetic',
        agentId: '1',
        toUser: '@all',
        maxAttempts: 3
      })
      const accounts = {
        list: () =>
          [1, 2, 3].map((index) => ({
            accountId: `a${String(index)}`,
            runAccountIndex: index,
            enabled: true,
            maskedEmail: `a${String(index)}***@example.test`
          })),
        getCredentials: () => ({ email: 'synthetic@example.test', password: 'synthetic' })
      }
      const runner = new ApplicationRunCoordinator(
        accounts as never,
        store,
        {} as never,
        { close: vi.fn().mockResolvedValue(undefined) } as never,
        { write: vi.fn().mockResolvedValue(undefined) } as never,
        DEFAULT_CONFIG
      )
      const finalRead = vi.fn().mockRejectedValue(new Error('synthetic final read unavailable'))
      if (finalReadSucceeds)
        finalRead.mockImplementation(() =>
          Promise.resolve({ availablePoints: balance(5804, new Date().toISOString()) })
        )
      const stageRunner = runner as unknown as {
        executeStage: (
          stage: AccountPipelineStage,
          context: AccountPipelineContext,
          mode: unknown,
          credentials: unknown,
          resources: {
            discovery?: object
            desktopClient?: object
            finalEvidence?: FieldEvidence<number>
          }
        ) => Promise<StageResult>
      }
      vi.spyOn(stageRunner, 'executeStage').mockImplementation(
        async (stage, context, _mode, _credentials, resources) => {
          await Promise.resolve()
          vi.setSystemTime(Date.now() + 1000)
          if (stage === 'discover') {
            resources.discovery = {}
            resources.desktopClient = { fetchDashboard: finalRead }
            store.ledger.balance(
              context.runId,
              context.accountId,
              'start',
              balance(5804, new Date().toISOString())
            )
            store.upsertTask(task(context.accountId), context.runId)
          }
          if (stage === 'web-rewards' && !finalReadSucceeds)
            return { status: 'partial', message: 'Offer currently unavailable; no submission' }
          if (stage === 'final-verification') {
            if (context.runAccountIndex !== 1)
              return {
                status: 'failed',
                failureStage: 'final-dashboard',
                message: 'synthetic final read unavailable'
              }
            resources.finalEvidence = balance(5804, new Date().toISOString())
          }
          return { status: 'completed' }
        }
      )
      try {
        const { runId } = await runner.start({ accountMode: 'continue' })
        for (let i = 0; i < 150 && runner.activeRunId; i++) await Promise.resolve()
        expect(runner.activeRunId).toBeUndefined()
        expect(store.getRun(runId)?.status).toBe('partial')
        expect(store.ledger.accounts(runId).map((row) => row.executionState)).toEqual([
          'partial',
          'failed',
          'failed'
        ])
        expect(finalRead).toHaveBeenCalledTimes(2)
        const view = new RunViews(store).run(runId)
        if (!view) throw new Error('Synthetic run view missing')
        expect(view.accounts.map((row) => row.runBalanceDelta)).toEqual(
          finalReadSucceeds ? [0, 0, 0] : [0, null, null]
        )
        expect(view.accounts.map((row) => row.accountSuccess)).toEqual([false, false, false])
        expect(view.accounts[0]?.confirmedTaskPoints).toBeNull()
        expect(store.getLatestPointsHistory('a1', '2026-09-09')?.gainedPoints).toBe(0)
        expect(store.getLatestPointsHistory('a2', '2026-09-09')?.gainedPoints).toBe(
          finalReadSucceeds ? 0 : null
        )
        await notifications.tick()
        const messages = send.mock.calls
          .filter(([url]) => typeof url === 'string' && url.includes('message/send'))
          .map(([, init]) => (typeof init?.body === 'string' ? init.body : ''))
        expect(messages.some((message) => message.includes('账号任务部分完成'))).toBe(true)
        expect(
          messages.filter((message) => message.includes('Microsoft Rewards 账号任务失败'))
        ).toHaveLength(2)
        expect(messages.some((message) => message.includes('账号任务已完成，积分待确认'))).toBe(
          false
        )
        expect(completionTitle('failed')).toBe('账号任务失败')
      } finally {
        await notifications.close()
        store.close()
      }
    }
  )
})
