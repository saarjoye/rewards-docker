import { describe, expect, it } from 'vitest'

import type { TaskRecord } from '../src/domain/Task.js'
import { normalizeIncompleteSearchTask } from '../src/rewards/RewardsTaskExecutor.js'

function task(type: TaskRecord['type'], status: TaskRecord['status'], completed: number, total: number | null): TaskRecord {
  return {
    taskId: `synthetic:${type}`,
    accountId: 'synthetic-account',
    localDate: '2026-09-16',
    sourceTaskId: type,
    type,
    source: 'bing-flyout',
    displayName: type,
    executable: true,
    required: true,
    status,
    progress: { completed, total },
    updatedAt: '2026-09-16T00:00:00.000Z'
  }
}

describe('incomplete search task normalization', () => {
  it('moves an incomplete PC search out of running without changing progress', () => {
    const result = normalizeIncompleteSearchTask(task('pc-search', 'running', 9, 60))
    expect(result).toMatchObject({
      status: 'verification-pending',
      progress: { completed: 9, total: 60 },
      reason: 'progress-unconfirmed: 搜索仍有剩余进度'
    })
  })

  it('normalizes an incomplete mobile search and preserves an existing reason/state', () => {
    const original = {
      ...task('mobile-search', 'running', 4, 30),
      reason: 'dashboard delayed',
      searchObservation: {
        runId: 'run',
        submittedCount: 2,
        unknownSubmissionCount: 0,
        awaitingProgress: false,
        completed: 4,
        total: 30,
        observedAt: '2026-09-16T00:00:00.000Z',
        result: 'progress-unchanged',
        state: 'search-submitted' as const,
        canContinue: true
      }
    }
    const result = normalizeIncompleteSearchTask(original)
    expect(result).toMatchObject({
      status: 'verification-pending',
      reason: 'dashboard delayed',
      searchObservation: {
        state: 'search-submitted',
        canContinue: false,
        submittedCount: 2
      }
    })
  })

  it('leaves completed, failed and non-search tasks unchanged', () => {
    const completed = task('pc-search', 'completed', 60, 60)
    const failed = task('pc-search', 'failed', 24, 60)
    const other = task('read-to-earn', 'running', 0, 10)
    expect(normalizeIncompleteSearchTask(completed)).toBe(completed)
    expect(normalizeIncompleteSearchTask(failed)).toBe(failed)
    expect(normalizeIncompleteSearchTask(other)).toBe(other)
  })
})
