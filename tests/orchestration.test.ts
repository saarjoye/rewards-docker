import { describe, expect, it, vi } from 'vitest'

import {
  AccountPipeline,
  accountPipelineDiagnostic,
  type AccountPipelinePort
} from '../src/orchestration/AccountPipeline.js'
import {
  MutationExecutor,
  MutationNotStartedError,
  type MutationLedger
} from '../src/orchestration/MutationExecutor.js'
import {
  OperationTimeoutError,
  runAbortable,
  shouldRetry
} from '../src/orchestration/RetryPolicy.js'
import type { TaskRecord } from '../src/domain/Task.js'

function task(): TaskRecord {
  return {
    taskId: 'a:2026-09-03:t',
    accountId: 'a',
    localDate: '2026-09-03',
    sourceTaskId: 't',
    type: 'daily-set',
    source: 'rsc',
    displayName: '每日任务',
    executable: true,
    required: true,
    status: 'selected',
    progress: { completed: 0, total: 1 },
    updatedAt: '2026-09-03T00:00:00Z'
  }
}

describe('classified retries and cancellation', () => {
  it('retries transient reads but never retries mutations', () => {
    expect(shouldRetry({ kind: 'read-only', attempt: 1, maxAttempts: 3, status: 504 })).toBe(true)
    expect(shouldRetry({ kind: 'read-only', attempt: 1, maxAttempts: 3, status: 401 })).toBe(false)
    expect(shouldRetry({ kind: 'mutation', attempt: 1, maxAttempts: 3, networkError: true })).toBe(
      false
    )
  })

  it('aborts the active operation with its stage', async () => {
    let observedAbort = false
    await expect(
      runAbortable({
        stage: 'dashboard-refresh',
        timeoutMs: 10,
        operation: (signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener(
              'abort',
              () => {
                observedAbort = true
                const reason = signal.reason as unknown
                reject(reason instanceof Error ? reason : new Error('Operation was aborted'))
              },
              { once: true }
            )
          })
      })
    ).rejects.toMatchObject({ name: 'OperationTimeoutError', stage: 'dashboard-refresh' })
    expect(observedAbort).toBe(true)
    expect(new OperationTimeoutError('search-box', 20).timeoutMs).toBe(20)
  })
})

describe('mutation idempotency', () => {
  it('does not submit again after the ledger has started', async () => {
    const states: string[] = []
    const ledger: MutationLedger = {
      beginMutation: vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false),
      cancelMutation: vi.fn(),
      updateMutation: (_taskId, state) => states.push(state)
    }
    const adapter = {
      execute: vi.fn().mockResolvedValue({ accepted: true, observedAt: '2026-09-03T00:00:00Z' }),
      verify: vi.fn().mockResolvedValue({
        confirmed: false,
        progress: { completed: 0, total: 1 },
        reason: 'not observed yet'
      })
    }
    const executor = new MutationExecutor(ledger)
    const signal = new AbortController().signal

    expect((await executor.execute(task(), adapter, signal)).status).toBe('verification-pending')
    expect((await executor.execute(task(), adapter, signal)).status).toBe('verification-pending')
    expect(adapter.execute).toHaveBeenCalledTimes(1)
    expect(adapter.verify).toHaveBeenCalledTimes(2)
    expect(states).toContain('submitted')
  })

  it('performs read-only verification after an unacknowledged response without resubmitting', async () => {
    const ledger: MutationLedger = {
      beginMutation: vi.fn().mockReturnValue(true),
      cancelMutation: vi.fn(),
      updateMutation: vi.fn()
    }
    const adapter = {
      execute: vi.fn().mockResolvedValue({ accepted: false, observedAt: '2026-09-03T00:00:00Z' }),
      verify: vi.fn().mockResolvedValue({
        confirmed: true,
        progress: { completed: 1, total: 1 }
      })
    }
    const outcome = await new MutationExecutor(ledger).execute(
      task(),
      adapter,
      new AbortController().signal
    )

    expect(outcome.status).toBe('verified')
    expect(adapter.execute).toHaveBeenCalledTimes(1)
    expect(adapter.verify).toHaveBeenCalledTimes(1)
  })

  it('removes a submission-started marker when no mutation was sent', async () => {
    const cancelMutation = vi.fn()
    const updateMutation = vi.fn()
    const ledger: MutationLedger = {
      beginMutation: vi.fn().mockReturnValue(true),
      cancelMutation,
      updateMutation
    }
    const adapter = {
      execute: vi.fn().mockRejectedValue(new MutationNotStartedError('Synthetic link missing')),
      verify: vi.fn()
    }

    await expect(
      new MutationExecutor(ledger).execute(task(), adapter, new AbortController().signal)
    ).resolves.toMatchObject({ status: 'failed', message: 'Synthetic link missing' })
    expect(cancelMutation).toHaveBeenCalledWith(task().taskId)
    expect(updateMutation).not.toHaveBeenCalled()
    expect(adapter.verify).not.toHaveBeenCalled()
  })
})

describe('account pipeline', () => {
  it('preserves an earlier partial authentication diagnostic after later stages complete', () => {
    expect(
      accountPipelineDiagnostic({
        status: 'partial',
        stages: [
          {
            stage: 'authenticate',
            result: {
              status: 'partial',
              failureStage: 'app-oauth',
              message: 'App authentication unavailable'
            }
          },
          { stage: 'final-verification', result: { status: 'completed' } }
        ]
      })
    ).toEqual({ stage: 'app-oauth', message: 'App authentication unavailable' })
  })

  it('prefers a terminal failure over an earlier partial stage', () => {
    expect(
      accountPipelineDiagnostic({
        status: 'failed',
        stages: [
          { stage: 'authenticate', result: { status: 'partial', failureStage: 'app-oauth' } },
          {
            stage: 'search',
            result: { status: 'failed', failureStage: 'desktop-search', message: 'search failed' }
          }
        ]
      })
    ).toEqual({ stage: 'desktop-search', message: 'search failed' })
  })

  it('stops before dashboard and search stages after authentication fails', async () => {
    const execute = vi
      .fn<AccountPipelinePort['execute']>()
      .mockResolvedValue({ status: 'failed', message: 'login-error-alert' })
    const checkpoint = vi.fn<AccountPipelinePort['checkpoint']>().mockResolvedValue(undefined)
    const result = await new AccountPipeline({ execute, checkpoint }).run({
      runId: 'run',
      accountId: 'account',
      runAccountIndex: 1,
      localDate: '2026-09-03',
      signal: new AbortController().signal
    })
    expect(result.status).toBe('failed')
    expect(execute).toHaveBeenCalledTimes(1)
    expect(execute).toHaveBeenCalledWith('authenticate', expect.anything())
    expect(checkpoint).toHaveBeenCalledTimes(1)
  })

  it('checkpoints thrown failures and redacts their message', async () => {
    const checkpoint = vi.fn<AccountPipelinePort['checkpoint']>().mockResolvedValue(undefined)
    const pipeline = new AccountPipeline({
      execute: vi
        .fn()
        .mockRejectedValue(
          new Error('desktop-login failed for person@example.test Cookie: secret-cookie')
        ),
      checkpoint
    })
    const result = await pipeline.run({
      runId: 'run',
      accountId: 'account',
      runAccountIndex: 1,
      localDate: '2026-09-03',
      signal: new AbortController().signal
    })
    expect(result.status).toBe('failed')
    expect(checkpoint).toHaveBeenCalledWith(
      'authenticate',
      expect.objectContaining({ status: 'failed' }),
      expect.anything()
    )
    const message = result.stages[0]?.result.message ?? ''
    expect(message).not.toContain('person@example.test')
    expect(message).not.toContain('secret-cookie')
  })
})
