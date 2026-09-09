import { describe, expect, it } from 'vitest'

import { verifyLogin } from '../src/auth/LoginVerification.js'
import { aggregateAccountStatus } from '../src/domain/AccountRun.js'
import { createEvidence } from '../src/domain/Evidence.js'
import { summarizeTasks, type TaskRecord } from '../src/domain/Task.js'
import { TaskRegistry } from '../src/rewards/TaskRegistry.js'

function evidence<T>(value: T, source: 'bing-flyout' | 'rsc' = 'bing-flyout') {
  return createEvidence({
    availability: 'valid' as const,
    source,
    confidence: 0.9,
    observedAt: '2026-09-03T00:00:00Z',
    value
  })
}

describe('three-layer login verification', () => {
  it('does not accept a Rewards page without Bing and profile evidence', () => {
    expect(
      verifyLogin({
        microsoftAuthenticated: true,
        bingIdentity: createEvidence({
          availability: 'missing',
          source: 'bing-flyout',
          confidence: 0,
          observedAt: '2026-09-03T00:00:00Z'
        }),
        rewardsProfile: evidence({ availablePoints: 12 })
      })
    ).toEqual({ valid: false, failedStage: 'bing', reason: 'Bing Rewards identity not confirmed' })
  })

  it('accepts only a confirmed non-negative safe balance', () => {
    expect(
      verifyLogin({
        microsoftAuthenticated: true,
        bingIdentity: evidence({ rewardsUser: true }),
        rewardsProfile: evidence({ availablePoints: 12 })
      })
    ).toEqual({ valid: true })
    expect(
      verifyLogin({
        microsoftAuthenticated: true,
        bingIdentity: evidence({ rewardsUser: true }),
        rewardsProfile: evidence({ availablePoints: -1 })
      }).valid
    ).toBe(false)
  })
})

describe('task registry and account aggregation', () => {
  const registry = new TaskRegistry()

  it('keeps unknown tasks visible and non-executable', () => {
    const known = registry.classify({
      accountId: 'account-1',
      localDate: '2026-09-03',
      sourceTaskId: 'pc',
      sourceType: 'desktop-search',
      source: 'bing-flyout',
      displayName: 'PC 搜索',
      completed: 0,
      total: 60,
      alreadyComplete: false
    })
    const unknown = registry.classify({
      accountId: 'account-1',
      localDate: '2026-09-03',
      sourceTaskId: 'new-card',
      sourceType: 'future-offer',
      source: 'rsc',
      displayName: '新活动',
      completed: 0,
      total: null,
      alreadyComplete: false
    })

    expect(known.type).toBe('pc-search')
    expect(unknown).toMatchObject({ type: 'unknown', executable: false, status: 'unknown' })
    expect(summarizeTasks([known, unknown])).toMatchObject({
      discovered: 2,
      executable: 1,
      unknown: 1
    })
    expect(aggregateAccountStatus([known, unknown])).toBe('partial')
  })

  it('requires a confirmed balance before success', () => {
    const completed = registry.classify({
      accountId: 'account-1',
      localDate: '2026-09-03',
      sourceTaskId: 'daily',
      sourceType: 'daily-set',
      source: 'rsc',
      displayName: '每日任务',
      completed: 3,
      total: 3,
      alreadyComplete: true
    })
    expect(aggregateAccountStatus([completed])).toBe('partial')
    expect(aggregateAccountStatus([completed], evidence(100))).toBe('success')

    const failed: TaskRecord = {
      ...completed,
      status: 'failed',
      progress: { completed: 9, total: 60 },
      reason: 'dashboard-refresh timed out'
    }
    expect(aggregateAccountStatus([failed], evidence(100))).toBe('failed')
    expect(failed.progress).toEqual({ completed: 9, total: 60 })
  })
})
