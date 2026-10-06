import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

import type { BrowserContext } from 'patchright'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DashboardClient, DashboardFetchError } from '../src/browser/DashboardClient.js'
import { createEvidence } from '../src/domain/Evidence.js'
import { createTaskId, type TaskRecord } from '../src/domain/Task.js'
import { DEFAULT_CONFIG } from '../src/infra/Config.js'
import { SqliteStore } from '../src/infra/SqliteStore.js'
import type { StructuredLogger } from '../src/infra/StructuredLogger.js'
import {
  ACCOUNT_PIPELINE_STAGES,
  AccountPipeline,
  type AccountPipelinePort
} from '../src/orchestration/AccountPipeline.js'
import { BusinessDateChanged } from '../src/orchestration/BusinessDate.js'
import type { DiscoveryOutput } from '../src/rewards/RewardsDiscoveryService.js'
import type { RewardOffer, RewardsObservation } from '../src/rewards/RewardsModel.js'
import { RewardsTaskExecutor } from '../src/rewards/RewardsTaskExecutor.js'

const resources: Array<{ root: string; store: SqliteStore }> = []

afterEach(async () => {
  vi.restoreAllMocks()
  for (const { root, store } of resources.splice(0)) {
    store.close()
    if (
      resolve(dirname(root)) !== resolve(tmpdir()) ||
      !basename(root).startsWith('rewards-app-interruption-')
    ) {
      throw new Error('Unexpected test directory')
    }
    await rm(root, { recursive: true, force: true })
  }
})

function evidence<T>(value: T) {
  return createEvidence({
    value,
    availability: 'valid',
    source: 'app-dashboard',
    confidence: 1,
    observedAt: '2026-10-06T00:00:00.000Z'
  })
}

function observation(offer: RewardOffer): RewardsObservation {
  return {
    source: 'app-dashboard',
    rewardsUser: evidence(true),
    market: evidence('CN'),
    availablePoints: evidence(100),
    pcSearch: evidence({ completed: 0, total: 60, remaining: 60 }),
    mobileSearch: evidence({ completed: 0, total: 30, remaining: 30 }),
    offers: [offer],
    topLevelFields: ['response']
  }
}

async function fixture(hasToken = true) {
  const root = await mkdtemp(join(tmpdir(), 'rewards-app-interruption-'))
  const store = new SqliteStore(join(root, 'state.sqlite'))
  resources.push({ root, store })
  const offer: RewardOffer = {
    sourceTaskId: 'synthetic-reading',
    type: 'read-to-earn',
    source: 'app-dashboard',
    displayName: 'Synthetic reading',
    complete: false,
    completed: 0,
    total: 30,
    executable: true,
    attributes: { offerid: 'synthetic-reading', type: 'msnreadearn' }
  }
  const task: TaskRecord = {
    taskId: createTaskId('synthetic-account', '2026-10-06', offer.sourceTaskId),
    accountId: 'synthetic-account',
    localDate: '2026-10-06',
    sourceTaskId: offer.sourceTaskId,
    type: offer.type,
    source: 'app-dashboard',
    displayName: offer.displayName,
    executable: true,
    required: false,
    status: 'discovered',
    progress: { completed: 0, total: 30 },
    updatedAt: '2026-10-06T00:00:00.000Z'
  }
  store.upsertTask(task, 'synthetic-run')
  const initial = observation(offer)
  const discovery: DiscoveryOutput = {
    snapshot: { ...initial, actionIds: {} },
    tasks: [task],
    descriptors: new Map([[task.taskId, { task, offer }]]),
    dataSources: { rsc: false, dom: false, dashboard: false, flyout: false, 'app-dashboard': true }
  }
  const fetchAppDashboard = vi.fn<DashboardClient['fetchAppDashboard']>().mockResolvedValue(initial)
  const submitAppActivity = vi
    .fn<DashboardClient['submitAppActivity']>()
    .mockResolvedValue(undefined)
  const controller = new AbortController()
  const guardDate = vi.fn<() => void>()
  const executor = new RewardsTaskExecutor(
    {} as BrowserContext,
    { fetchAppDashboard, submitAppActivity } as unknown as DashboardClient,
    store,
    { write: vi.fn().mockResolvedValue(undefined) } as unknown as StructuredLogger,
    DEFAULT_CONFIG,
    'synthetic-run',
    'account-1',
    hasToken ? 'synthetic-token' : undefined,
    store,
    guardDate
  )
  const executeTask = (mode: 'mutating' | 'read-only' = 'mutating') =>
    executor.executeTypes({
      discovery,
      types: ['read-to-earn'],
      mode,
      signal: controller.signal
    })
  const execute = vi
    .fn<AccountPipelinePort['execute']>()
    .mockImplementation((stage) =>
      stage === 'app-tasks' ? executeTask() : Promise.resolve({ status: 'completed' })
    )
  const checkpoint = vi.fn<AccountPipelinePort['checkpoint']>().mockResolvedValue(undefined)
  const run = () =>
    new AccountPipeline({ execute, checkpoint }).run({
      runId: 'synthetic-run',
      accountId: task.accountId,
      runAccountIndex: 1,
      localDate: task.localDate,
      signal: controller.signal
    })
  return {
    store,
    task,
    offer,
    fetchAppDashboard,
    submitAppActivity,
    controller,
    guardDate,
    executeTask,
    execute,
    checkpoint,
    run,
    ledgerId: `${task.taskId}:article:1`
  }
}

describe('App task interruption isolation', () => {
  it.each([401, 503, 'network'] as const)(
    'keeps prior reading pending and reaches later stages after a %s verification failure',
    async (failure) => {
      const input = await fixture()
      input.store.beginMutation(input.ledgerId)
      input.store.updateMutation(input.ledgerId, 'submitted')
      input.fetchAppDashboard.mockRejectedValue(
        typeof failure === 'number'
          ? new DashboardFetchError('Synthetic App failure', failure, 3, 100, true)
          : new Error('Synthetic network failure')
      )
      const result = await input.run()
      expect(result.status).toBe('partial')
      expect(result.stages.map(({ stage }) => stage)).toEqual(ACCOUNT_PIPELINE_STAGES)
      expect(input.checkpoint).toHaveBeenCalledTimes(ACCOUNT_PIPELINE_STAGES.length)
      expect(input.fetchAppDashboard).toHaveBeenCalledTimes(1)
      expect(input.submitAppActivity).not.toHaveBeenCalled()
      expect(input.store.getMutationState(input.ledgerId)).toBe('submitted')
      expect(input.store.getTask(input.task.taskId)).toMatchObject({
        status: 'verification-pending',
        progress: { completed: 0, total: 30 }
      })
    }
  )

  it('continues the account after missing App authorization without recording a submission', async () => {
    const input = await fixture(false)
    const result = await input.run()
    expect(result.status).toBe('partial')
    expect(result.stages.map(({ stage }) => stage)).toEqual(ACCOUNT_PIPELINE_STAGES)
    expect(input.store.getMutationState(input.ledgerId)).toBeUndefined()
    expect(input.fetchAppDashboard).not.toHaveBeenCalled()
    expect(input.submitAppActivity).not.toHaveBeenCalled()
    expect(input.store.getTask(input.task.taskId)?.status).toBe('failed')
  })

  it('confirms a prior reading after recovery using only a read, without replay', async () => {
    const input = await fixture()
    input.store.beginMutation(input.ledgerId)
    input.store.updateMutation(input.ledgerId, 'verification-pending')
    input.fetchAppDashboard.mockRejectedValueOnce(
      new DashboardFetchError('Synthetic App failure', 401, 3, 100)
    )
    expect((await input.run()).status).toBe('partial')
    input.fetchAppDashboard.mockResolvedValue(
      observation({ ...input.offer, complete: true, completed: 30 })
    )
    expect((await input.run()).status).toBe('success')
    expect(input.submitAppActivity).not.toHaveBeenCalled()
    expect(input.fetchAppDashboard).toHaveBeenCalledTimes(2)
    expect(input.store.getMutationState(input.ledgerId)).toBe('verified')
    expect(input.store.getTask(input.task.taskId)).toMatchObject({
      status: 'completed',
      progress: { completed: 30, total: 30 }
    })
  })

  it('never replays a new reading whose response verification failed', async () => {
    const input = await fixture()
    input.fetchAppDashboard.mockRejectedValue(
      new DashboardFetchError('Synthetic App failure', 401, 3, 100)
    )
    expect((await input.run()).status).toBe('partial')
    expect((await input.run()).status).toBe('partial')
    expect(input.submitAppActivity).toHaveBeenCalledTimes(1)
    expect(input.fetchAppDashboard).toHaveBeenCalledTimes(2)
    expect(input.store.getMutationState(input.ledgerId)).toBe('verification-pending')
    expect(input.store.getMutationState(`${input.task.taskId}:article:2`)).toBeUndefined()
  })

  it.each([
    ['cancelled', true],
    ['cancelled', false],
    ['date-changed', true],
    ['date-changed', false]
  ] as const)(
    'propagates %s during reading verification with prior submission=%s',
    async (interruption, hasPrior) => {
      const input = await fixture()
      if (hasPrior) {
        input.store.beginMutation(input.ledgerId)
        input.store.updateMutation(input.ledgerId, 'submitted')
      }
      const reason =
        interruption === 'cancelled'
          ? new Error('Synthetic cancellation')
          : new BusinessDateChanged()
      input.fetchAppDashboard.mockImplementation(() => {
        if (interruption === 'cancelled') input.controller.abort(reason)
        else
          input.guardDate.mockImplementation(() => {
            throw reason
          })
        return Promise.resolve(observation({ ...input.offer, complete: true, completed: 30 }))
      })
      await expect(input.run()).rejects.toBe(reason)
      expect(input.execute.mock.calls.map(([stage]) => stage)).not.toContain('search')
      expect(input.store.getMutationState(input.ledgerId)).not.toBe('verified')
      expect(input.submitAppActivity).toHaveBeenCalledTimes(hasPrior ? 0 : 1)
      expect(input.store.getTask(input.task.taskId)?.status).toBe('verification-pending')
    }
  )

  it('keeps read-only mode free of verification and reward requests', async () => {
    const input = await fixture()
    input.store.beginMutation(input.ledgerId)
    input.store.updateMutation(input.ledgerId, 'submitted')
    await input.executeTask('read-only')
    expect(input.fetchAppDashboard).not.toHaveBeenCalled()
    expect(input.submitAppActivity).not.toHaveBeenCalled()
    expect(input.store.getMutationState(input.ledgerId)).toBe('submitted')
  })
})
