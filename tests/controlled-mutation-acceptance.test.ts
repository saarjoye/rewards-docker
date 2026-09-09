import { describe, expect, it, vi } from 'vitest'

import type { DashboardClient } from '../src/browser/DashboardClient.js'
import { createEvidence } from '../src/domain/Evidence.js'
import type { TaskRecord } from '../src/domain/Task.js'
import {
  controlledAccountIndex,
  controlledExecutionPath,
  controlledMutationFingerprint,
  controlledTaskType,
  createControlledClaimAdapter,
  createControlledClaimUiAdapter,
  createControlledNavigationAdapter,
  createControlledMutationAdapter,
  selectControlledClaimCandidate,
  selectControlledClaimUiCandidate,
  selectControlledNavigationCandidate,
  selectControlledMutationCandidate,
  summarizeControlledMutationCandidates
} from '../src/acceptance/ControlledMutationAcceptance.js'
import type { DiscoveryOutput } from '../src/rewards/RewardsDiscoveryService.js'
import type { RewardOffer, RewardsDiscoverySnapshot } from '../src/rewards/RewardsModel.js'

const observedAt = '2026-09-04T00:00:00.000Z'

function evidence<T>(value: T) {
  return createEvidence({
    availability: 'valid' as const,
    source: 'rsc' as const,
    confidence: 0.9,
    observedAt,
    value
  })
}

function task(id: string): TaskRecord {
  return {
    taskId: `account:date:${id}`,
    accountId: 'account',
    localDate: '2026-09-04',
    sourceTaskId: id,
    type: 'more-promotion',
    source: 'rsc',
    displayName: 'Synthetic promotion',
    executable: true,
    required: false,
    status: 'discovered',
    progress: { completed: 0, total: 5 },
    updatedAt: observedAt
  }
}

function offer(id: string, attributes: Record<string, string> = {}): RewardOffer {
  return {
    sourceTaskId: id,
    type: 'more-promotion',
    source: 'rsc',
    displayName: 'Synthetic promotion',
    completed: 0,
    total: 5,
    complete: false,
    executable: true,
    hash: `hash-${id}`,
    attributes
  }
}

function snapshot(offers: readonly RewardOffer[]): RewardsDiscoverySnapshot {
  return {
    rewardsUser: evidence(true),
    market: evidence('CN'),
    availablePoints: evidence(100),
    pcSearch: evidence({ completed: 0, total: 60, remaining: 60 }),
    mobileSearch: evidence({ completed: 0, total: 30, remaining: 30 }),
    offers,
    actionIds: { reportActivity: 'synthetic-action' },
    deploymentId: 'synthetic-deployment',
    routerStateTree: 'synthetic-router-state'
  }
}

function discovery(entries: readonly [TaskRecord, RewardOffer][]): DiscoveryOutput {
  const rewardsSnapshot = snapshot(entries.map(([, reward]) => reward))
  return {
    snapshot: rewardsSnapshot,
    tasks: entries.map(([record]) => record),
    descriptors: new Map(
      entries.map(([record, reward]) => [record.taskId, { task: record, offer: reward }])
    ),
    dataSources: {
      rsc: true,
      dom: true,
      dashboard: false,
      flyout: true,
      'app-dashboard': false
    }
  }
}

describe('single controlled mutation acceptance', () => {
  it('uses a one-based account index and rejects invalid or ambiguous values', () => {
    expect(controlledAccountIndex([], 3)).toBe(1)
    expect(controlledAccountIndex(['--account-index=2'], 3)).toBe(2)
    expect(() => controlledAccountIndex(['--account-index=0'], 3)).toThrow(
      'controlled-account-index-out-of-range'
    )
    expect(() => controlledAccountIndex(['--account-index=4'], 3)).toThrow(
      'controlled-account-index-out-of-range'
    )
    expect(() => controlledAccountIndex(['--account-index=two'], 3)).toThrow(
      'controlled-account-index-invalid'
    )
    expect(() => controlledAccountIndex(['--account-index=1', '--account-index=2'], 3)).toThrow(
      'controlled-account-index-duplicate'
    )
  })

  it('uses an explicit controlled execution path and rejects invalid or duplicate values', () => {
    expect(controlledExecutionPath([])).toBe('report-activity')
    expect(controlledExecutionPath(['--execution-path=navigate-only'])).toBe('navigate-only')
    expect(controlledExecutionPath(['--execution-path=claim-server-action'])).toBe(
      'claim-server-action'
    )
    expect(controlledExecutionPath(['--execution-path=claim-ui'])).toBe('claim-ui')
    expect(() => controlledExecutionPath(['--execution-path=unknown'])).toThrow(
      'controlled-execution-path-invalid'
    )
    expect(() =>
      controlledExecutionPath([
        '--execution-path=navigate-only',
        '--execution-path=report-activity'
      ])
    ).toThrow('controlled-execution-path-duplicate')
  })

  it('accepts one explicit canonical task type and rejects invalid or duplicate values', () => {
    expect(controlledTaskType([])).toBeUndefined()
    expect(controlledTaskType(['--task-type=daily-set'])).toBe('daily-set')
    expect(() => controlledTaskType(['--task-type=quiz'])).toThrow('controlled-task-type-invalid')
    expect(() =>
      controlledTaskType(['--task-type=daily-set', '--task-type=more-promotion'])
    ).toThrow('controlled-task-type-duplicate')
  })

  it('selects one positive claim with a server action and respects its fingerprint', () => {
    const claimTask: TaskRecord = {
      ...task('claim-bonus-points'),
      type: 'claim-bonus-points',
      required: true,
      progress: { completed: 0, total: 1 }
    }
    const result = discovery([])
    const withClaim: DiscoveryOutput = {
      ...result,
      snapshot: {
        ...result.snapshot,
        actionIds: { reportClaimAllPoints: 'synthetic-claim-action' }
      },
      tasks: [claimTask],
      descriptors: new Map([[claimTask.taskId, { task: claimTask, claimablePoints: 3 }]])
    }

    expect(selectControlledClaimCandidate(withClaim)).toMatchObject({
      task: claimTask,
      claimablePoints: 3,
      actionId: 'synthetic-claim-action'
    })
    expect(
      selectControlledClaimCandidate(withClaim, new Set([controlledMutationFingerprint(claimTask)]))
    ).toBeUndefined()
    expect(selectControlledClaimUiCandidate(withClaim)).toMatchObject({
      task: claimTask,
      claimablePoints: 3
    })
  })

  it('selects one reportable promotion and rejects interactive quiz metadata', () => {
    const quizTask = task('quiz')
    const safeTask = task('safe')
    const candidate = selectControlledMutationCandidate(
      discovery([
        [quizTask, offer('quiz', { promotionType: 'quiz' })],
        [safeTask, offer('safe', { promotionType: 'urlreward' })]
      ])
    )
    expect(candidate?.task.taskId).toBe(safeTask.taskId)
  })

  it('rejects an incomplete hash-only fragment that discovery marked non-executable', () => {
    const partialTask = {
      ...task('partial'),
      executable: false,
      progress: { completed: 0, total: null }
    }
    const partialOffer = { ...offer('partial'), total: null, executable: false }
    delete partialOffer.attributes
    expect(
      selectControlledMutationCandidate(discovery([[partialTask, partialOffer]]))
    ).toBeUndefined()
  })

  it('excludes a previously submitted task by its non-reversible fingerprint', () => {
    const firstTask = task('first')
    const secondTask = task('second')
    const result = discovery([
      [firstTask, offer('first', { promotionType: 'urlreward' })],
      [secondTask, offer('second', { promotionType: 'urlreward' })]
    ])
    const fingerprint = controlledMutationFingerprint(firstTask)

    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/)
    expect(selectControlledMutationCandidate(result, new Set([fingerprint]))?.task.taskId).toBe(
      secondTask.taskId
    )
  })

  it('selects only a non-interactive HTTPS navigation task without a server-action hash', () => {
    const hashed = offer('hashed', { promotionType: 'urlreward' })
    hashed.destinationUrl = 'https://example.test/hashed'
    const navigable = offer('navigation', { promotionType: 'urlreward' })
    delete navigable.hash
    navigable.destinationUrl = 'https://example.test/navigation'
    const insecure = offer('insecure', { promotionType: 'urlreward' })
    delete insecure.hash
    insecure.destinationUrl = 'http://example.test/insecure'
    const quiz = offer('quiz-navigation', { promotionType: 'quiz' })
    delete quiz.hash
    quiz.destinationUrl = 'https://example.test/quiz'
    const result = discovery([
      [task('hashed'), hashed],
      [task('navigation'), navigable],
      [task('insecure'), insecure],
      [task('quiz-navigation'), quiz]
    ])

    expect(selectControlledNavigationCandidate(result)?.task.sourceTaskId).toBe('navigation')
    expect(
      selectControlledNavigationCandidate(
        result,
        new Set([controlledMutationFingerprint(task('navigation'))])
      )
    ).toBeUndefined()
    expect(selectControlledNavigationCandidate(result, new Set(), 'daily-set')).toBeUndefined()
  })

  it('summarizes candidate structure without task identifiers or attribute values', () => {
    const first = offer('first', {
      promotionType: 'urlreward',
      internalValue: 'sensitive-synthetic-value'
    })
    first.activityType = 12
    first.isPromotional = false
    first.destinationUrl = 'https://example.invalid/sensitive-path'
    const second = { ...first, sourceTaskId: 'second', hash: 'hash-second' }

    const result = summarizeControlledMutationCandidates(
      discovery([
        [task('first'), first],
        [task('second'), second]
      ])
    )

    expect(result).toEqual([
      {
        taskType: 'more-promotion',
        source: 'rsc',
        count: 2,
        activityType: 12,
        promotional: false,
        hasDestinationUrl: true,
        progressTotal: 'positive',
        attributeKeys: ['internalValue', 'promotionType']
      }
    ])
    expect(JSON.stringify(result)).not.toContain('first')
    expect(JSON.stringify(result)).not.toContain('sensitive-synthetic-value')
    expect(JSON.stringify(result)).not.toContain('sensitive-path')
  })

  it('submits once and performs bounded read-only verification', async () => {
    const record = task('safe')
    const reward = offer('safe', { promotionType: 'urlreward' })
    const candidate = selectControlledMutationCandidate(discovery([[record, reward]]))
    expect(candidate).toBeDefined()
    if (!candidate) throw new Error('Synthetic candidate was not selected')
    const completed = { ...reward, complete: true, completed: 5 }
    const reportServerAction = vi.fn().mockResolvedValue({ status: 200, acknowledged: true })
    const onTransportResult = vi.fn()
    const bootstrapRsc = vi
      .fn()
      .mockResolvedValueOnce({ html: [], offers: [reward], actionIds: {} })
      .mockResolvedValueOnce({ html: [], offers: [completed], actionIds: {} })
    const adapter = createControlledMutationAdapter({
      client: { reportServerAction, bootstrapRsc } as unknown as DashboardClient,
      candidate,
      sleep: () => Promise.resolve(),
      onTransportResult
    })
    const context = {
      accountId: record.accountId,
      task: record,
      signal: new AbortController().signal
    }

    await expect(adapter.execute(context)).resolves.toMatchObject({ accepted: true })
    await expect(adapter.verify(context)).resolves.toMatchObject({ confirmed: true })
    expect(reportServerAction).toHaveBeenCalledTimes(1)
    expect(reportServerAction).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://rewards.bing.com/dashboard',
        referer: 'https://rewards.bing.com/dashboard',
        routerStateTree: 'synthetic-router-state',
        deploymentId: 'synthetic-deployment'
      })
    )
    expect(reportServerAction.mock.calls[0]?.[0]).toMatchObject({
      body: [
        'hash-safe',
        11,
        { offerid: 'safe', isPromotional: '$undefined', timezoneOffset: '-480' }
      ]
    })
    expect(onTransportResult).toHaveBeenCalledWith({ status: 200, acknowledged: true })
    expect(bootstrapRsc).toHaveBeenCalledTimes(2)
  })

  it('serializes promotional metadata exactly like the browser client contract', async () => {
    const record = task('promotional')
    const reward = offer('promotional')
    reward.isPromotional = true
    reward.activityType = 12
    const candidate = selectControlledMutationCandidate(discovery([[record, reward]]))
    expect(candidate).toBeDefined()
    if (!candidate) throw new Error('Synthetic candidate was not selected')
    const reportServerAction = vi.fn().mockResolvedValue({ status: 200, acknowledged: false })
    const adapter = createControlledMutationAdapter({
      client: {
        reportServerAction,
        bootstrapRsc: vi.fn().mockResolvedValue({ html: [], offers: [reward], actionIds: {} })
      } as unknown as DashboardClient,
      candidate,
      verificationAttempts: 1
    })

    await adapter.execute({
      accountId: record.accountId,
      task: record,
      signal: new AbortController().signal
    })

    expect(reportServerAction).toHaveBeenCalledWith(
      expect.objectContaining({
        body: [
          'hash-promotional',
          12,
          { offerid: 'promotional', isPromotional: 'true', timezoneOffset: '-480' }
        ]
      })
    )
  })

  it('navigates once and performs bounded read-only verification', async () => {
    const record = task('navigation')
    const reward = offer('navigation', { promotionType: 'urlreward' })
    delete reward.hash
    reward.destinationUrl = 'https://example.test/navigation'
    const candidate = selectControlledNavigationCandidate(discovery([[record, reward]]))
    expect(candidate).toBeDefined()
    if (!candidate) throw new Error('Synthetic navigation candidate was not selected')
    const completed = { ...reward, complete: true, completed: 5 }
    const navigateOffer = vi.fn().mockResolvedValue(undefined)
    const bootstrapRsc = vi.fn().mockResolvedValue({
      html: [],
      offers: [completed],
      actionIds: {},
      availablePoints: evidence(105)
    })
    const onNavigation = vi.fn()
    const adapter = createControlledNavigationAdapter({
      client: { navigateOffer, bootstrapRsc } as unknown as DashboardClient,
      candidate,
      onNavigation
    })
    const context = {
      accountId: record.accountId,
      task: record,
      signal: new AbortController().signal
    }

    await expect(adapter.execute(context)).resolves.toMatchObject({ accepted: true })
    await expect(adapter.verify(context)).resolves.toMatchObject({
      confirmed: true,
      points: { availability: 'valid', value: 105 }
    })
    expect(navigateOffer).toHaveBeenCalledTimes(1)
    expect(onNavigation).toHaveBeenCalledTimes(1)
    expect(bootstrapRsc).toHaveBeenCalledTimes(1)
  })

  it('verifies a Bing flyout navigation against the flyout instead of RSC', async () => {
    const record = task('flyout-navigation')
    const reward = {
      ...offer('flyout-navigation', { promotionType: 'urlreward' }),
      source: 'bing-flyout' as const,
      destinationUrl: 'https://www.bing.com/search?q=synthetic'
    }
    delete reward.hash
    const candidate = selectControlledNavigationCandidate(discovery([[record, reward]]))
    expect(candidate).toBeDefined()
    if (!candidate) throw new Error('Synthetic flyout candidate was not selected')
    const completed = { ...reward, complete: true, completed: 5 }
    const fetchFlyout = vi.fn().mockResolvedValue({
      ...snapshot([completed]),
      source: 'bing-flyout',
      offers: [completed],
      availablePoints: evidence(105)
    })
    const bootstrapRsc = vi.fn()
    const adapter = createControlledNavigationAdapter({
      client: {
        navigateOffer: vi.fn().mockResolvedValue(undefined),
        fetchFlyout,
        bootstrapRsc
      } as unknown as DashboardClient,
      candidate
    })

    await expect(
      adapter.verify({
        accountId: record.accountId,
        task: record,
        signal: new AbortController().signal
      })
    ).resolves.toMatchObject({
      confirmed: true,
      points: { availability: 'valid', value: 105 }
    })
    expect(fetchFlyout).toHaveBeenCalledTimes(1)
    expect(bootstrapRsc).not.toHaveBeenCalled()
  })

  it('claims once and confirms both claim state and trusted balance', async () => {
    const claimTask: TaskRecord = {
      ...task('claim-bonus-points'),
      type: 'claim-bonus-points',
      required: true,
      progress: { completed: 0, total: 1 }
    }
    const result = discovery([])
    const withClaim: DiscoveryOutput = {
      ...result,
      snapshot: {
        ...result.snapshot,
        actionIds: { reportClaimAllPoints: 'synthetic-claim-action' }
      },
      tasks: [claimTask],
      descriptors: new Map([[claimTask.taskId, { task: claimTask, claimablePoints: 3 }]])
    }
    const candidate = selectControlledClaimCandidate(withClaim)
    expect(candidate).toBeDefined()
    if (!candidate) throw new Error('Synthetic claim candidate was not selected')
    const reportServerAction = vi.fn().mockResolvedValue({ status: 200, acknowledged: true })
    const readClaimablePoints = vi.fn().mockResolvedValueOnce(3).mockResolvedValueOnce(0)
    const fetchDashboard = vi.fn().mockResolvedValue({
      ...snapshot([]),
      availablePoints: evidence(103)
    })
    const sleep = vi.fn().mockResolvedValue(undefined)
    const adapter = createControlledClaimAdapter({
      client: {
        reportServerAction,
        readClaimablePoints,
        fetchDashboard
      } as unknown as DashboardClient,
      candidate,
      sleep
    })
    const context = {
      accountId: claimTask.accountId,
      task: claimTask,
      signal: new AbortController().signal
    }

    await expect(adapter.execute(context)).resolves.toMatchObject({ accepted: true })
    await expect(adapter.verify(context)).resolves.toMatchObject({
      confirmed: true,
      progress: { completed: 1, total: 1 },
      points: { availability: 'valid', value: 103 }
    })
    expect(reportServerAction).toHaveBeenCalledTimes(1)
    expect(reportServerAction).toHaveBeenCalledWith(
      expect.objectContaining({
        body: [],
        url: 'https://rewards.bing.com/earn',
        referer: 'https://rewards.bing.com/earn'
      })
    )
    expect(readClaimablePoints).toHaveBeenCalledTimes(2)
    expect(fetchDashboard).toHaveBeenCalledTimes(1)
    expect(sleep).toHaveBeenCalledTimes(1)
  })

  it('clicks the claim UI once and does not infer acknowledgement from the click', async () => {
    const claimTask: TaskRecord = {
      ...task('claim-bonus-points'),
      type: 'claim-bonus-points',
      required: true,
      progress: { completed: 0, total: 1 }
    }
    const candidate = { task: claimTask, claimablePoints: 3 }
    const claimBonusByUiWithResult = vi.fn().mockResolvedValue({
      clicked: true,
      acknowledged: false,
      status: 500
    })
    const onTransportResult = vi.fn()
    const adapter = createControlledClaimUiAdapter({
      client: { claimBonusByUiWithResult } as unknown as DashboardClient,
      candidate,
      verificationAttempts: 1,
      onTransportResult
    })

    await expect(
      adapter.execute({
        accountId: claimTask.accountId,
        task: claimTask,
        signal: new AbortController().signal
      })
    ).resolves.toMatchObject({ accepted: false })
    expect(claimBonusByUiWithResult).toHaveBeenCalledTimes(1)
    expect(onTransportResult).toHaveBeenCalledWith({ status: 500, acknowledged: false })
  })
})
