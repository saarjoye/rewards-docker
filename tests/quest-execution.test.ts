import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserContext } from 'patchright'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DashboardClient } from '../src/browser/DashboardClient.js'
import type { TaskRecord } from '../src/domain/Task.js'
import { DEFAULT_CONFIG } from '../src/infra/Config.js'
import { SqliteStore } from '../src/infra/SqliteStore.js'
import type { StructuredLogger } from '../src/infra/StructuredLogger.js'
import {
  OfferActivationError,
  OfferUnavailableError
} from '../src/orchestration/MutationExecutor.js'
import {
  RewardsDiscoveryService,
  type DiscoveryOutput
} from '../src/rewards/RewardsDiscoveryService.js'
import { RewardsTaskExecutor } from '../src/rewards/RewardsTaskExecutor.js'
import {
  accountId,
  bootstrap,
  childId,
  childOffer,
  childTask,
  date,
  observation,
  parentId,
  quest,
  questObservation
} from './fixtures/quests.js'

const stores: SqliteStore[] = []
const roots: string[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) store.close()
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
  vi.useRealTimers()
})

function fixture(input: { store?: SqliteStore; task?: TaskRecord; runId?: string } = {}) {
  const store = input.store ?? new SqliteStore(':memory:')
  if (!input.store) stores.push(store)
  const task = input.task ?? childTask()
  const offer = childOffer()
  const navigateQuestOffer = vi.fn().mockResolvedValue(undefined)
  const readQuest = vi.fn<DashboardClient['readQuest']>().mockResolvedValue(
    questObservation({
      offers: [],
      rows: [{ title: quest.title, state: 'completed', actionCount: 0 }]
    })
  )
  const reportServerAction = vi.fn()
  const navigateOffer = vi.fn()
  const bootstrapRsc = vi.fn().mockResolvedValue(bootstrap())
  const client = {
    navigateQuestOffer,
    readQuest,
    reportServerAction,
    navigateOffer,
    bootstrapRsc,
    fetchDashboard: vi.fn().mockResolvedValue(observation()),
    fetchFlyout: vi.fn().mockResolvedValue(observation()),
    readClaimablePoints: vi.fn().mockResolvedValue(0)
  } as unknown as DashboardClient
  const guardDate = vi.fn()
  const runId = input.runId ?? 'synthetic-run'
  const executor = new RewardsTaskExecutor(
    {} as BrowserContext,
    client,
    store,
    { write: vi.fn().mockResolvedValue(undefined) } as unknown as StructuredLogger,
    DEFAULT_CONFIG,
    runId,
    'account-2',
    undefined,
    store,
    guardDate
  )
  const profile = observation()
  const discovery: DiscoveryOutput = {
    snapshot: {
      ...profile,
      offers: [offer],
      actionIds: { reportActivity: 'synthetic-action' }
    },
    tasks: [task],
    descriptors: new Map([[task.taskId, { task, offer, quest }]]),
    dataSources: {
      rsc: true,
      dom: false,
      dashboard: true,
      flyout: true,
      'app-dashboard': false
    }
  }
  const execute = (
    signal = new AbortController().signal,
    mode: 'mutating' | 'read-only' = 'mutating',
    source = discovery
  ) => executor.executeTypes({ discovery: source, types: ['punch-card'], mode, signal })
  return {
    store,
    task,
    offer,
    client,
    executor,
    execute,
    discovery,
    navigateQuestOffer,
    readQuest,
    reportServerAction,
    navigateOffer,
    bootstrapRsc,
    guardDate
  }
}

async function settle<T>(promise: Promise<T>) {
  await vi.advanceTimersByTimeAsync(1_100)
  return promise
}

describe('quest mutation accounting and recovery', () => {
  it('uses a single UI click and verifies on detail instead of reporting the hash', async () => {
    const f = fixture()
    const result = await f.execute()
    expect(result.status).toBe('completed')
    expect(f.navigateQuestOffer).toHaveBeenCalledTimes(1)
    expect(f.navigateQuestOffer).toHaveBeenCalledWith(
      f.offer,
      quest,
      expect.any(AbortSignal),
      f.guardDate
    )
    expect(f.reportServerAction).not.toHaveBeenCalled()
    expect(f.navigateOffer).not.toHaveBeenCalled()
    expect(f.bootstrapRsc).not.toHaveBeenCalled()
    expect(f.readQuest).toHaveBeenCalledTimes(1)
    expect(f.store.getMutationState(f.task.taskId)).toBe('verified')
    expect(f.store.getTask(f.task.taskId)?.status).toBe('completed')
    expect(f.store.ledger.latestQuestTasks(accountId, date)[0]?.quest).toEqual(quest)
    const credits = f.store.ledger.credits.rows(accountId)
    expect(
      credits.every(
        (credit) =>
          f.store.ledger.credits.confirmed(credit) === null ||
          f.store.ledger.credits.confirmed(credit) === 0
      )
    ).toBe(true)
  })

  it('verifies delayed official completion without another click', async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.readQuest.mockResolvedValueOnce(questObservation()).mockResolvedValueOnce(questObservation())
    expect((await settle(f.execute())).status).toBe('completed')
    expect(f.readQuest).toHaveBeenCalledTimes(3)
    expect(f.navigateQuestOffer).toHaveBeenCalledTimes(1)
    const deadlines = f.readQuest.mock.calls.map((call) => call[2])
    expect(new Set(deadlines).size).toBe(1)
  })

  it('keeps a missing completion pending and only reads when run again', async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.readQuest.mockResolvedValue(questObservation({ offers: [], rows: [] }))
    expect((await settle(f.execute())).status).toBe('partial')
    expect(f.store.getMutationState(f.task.taskId)).toBe('verification-pending')
    expect((await settle(f.execute())).status).toBe('partial')
    expect(f.navigateQuestOffer).toHaveBeenCalledTimes(1)
    expect(f.readQuest).toHaveBeenCalledTimes(6)
  })

  it('does not repeat a click after its result is unknown', async () => {
    const f = fixture()
    f.navigateQuestOffer.mockRejectedValue(new OfferActivationError())
    expect((await f.execute()).status).toBe('partial')
    expect(f.store.getMutationState(f.task.taskId)).toBe('verification-pending')
    expect(f.readQuest).not.toHaveBeenCalled()
    expect((await f.execute()).status).toBe('completed')
    expect(f.navigateQuestOffer).toHaveBeenCalledTimes(1)
    expect(f.reportServerAction).not.toHaveBeenCalled()
  })

  it('cancels only a pre-activation reservation when the task has become locked', async () => {
    const f = fixture()
    f.navigateQuestOffer.mockRejectedValue(new OfferUnavailableError())
    expect((await f.execute()).status).toBe('partial')
    expect(f.store.getMutationState(f.task.taskId)).toBeUndefined()
    expect(f.store.getTask(f.task.taskId)?.status).toBe('verification-pending')
    expect(f.reportServerAction).not.toHaveBeenCalled()
    expect(f.readQuest).not.toHaveBeenCalled()
  })

  it.each(['locked', 'completed', 'unknown'] as const)(
    'does not execute %s children',
    async (state) => {
      const task = childTask({
        executable: false,
        status: state === 'locked' ? 'skipped' : state
      })
      const f = fixture({ task })
      await f.execute()
      expect(f.navigateQuestOffer).not.toHaveBeenCalled()
      expect(f.reportServerAction).not.toHaveBeenCalled()
      expect(f.store.getMutationState(task.taskId)).toBeUndefined()
    }
  )

  it('does not begin a mutation in read-only mode', async () => {
    const f = fixture()
    await f.execute(undefined, 'read-only')
    expect(f.navigateQuestOffer).not.toHaveBeenCalled()
    expect(f.store.getMutationState(f.task.taskId)).toBeUndefined()
    expect(f.readQuest).not.toHaveBeenCalled()
  })

  it('checks cancellation before opening the execution path', async () => {
    const f = fixture()
    const controller = new AbortController()
    controller.abort(new Error('synthetic cancelled'))
    await expect(f.execute(controller.signal)).rejects.toThrow('synthetic cancelled')
    expect(f.navigateQuestOffer).not.toHaveBeenCalled()
    expect(f.store.getMutationState(f.task.taskId)).toBeUndefined()
  })

  it('keeps post-click verification cancelled and never resubmits', async () => {
    const f = fixture()
    const controller = new AbortController()
    f.readQuest.mockImplementation(() => {
      const cancelled = new Error('synthetic cancelled')
      controller.abort(cancelled)
      return Promise.reject(cancelled)
    })
    expect((await f.execute(controller.signal)).status).toBe('partial')
    expect(f.store.getMutationState(f.task.taskId)).toBe('verification-pending')
    expect(f.navigateQuestOffer).toHaveBeenCalledTimes(1)
  })

  it('cannot confirm a task after the business date changes during the read', async () => {
    const f = fixture()
    let changed = false
    f.guardDate.mockImplementation(() => {
      if (changed) throw new Error('synthetic date changed')
    })
    f.readQuest.mockImplementation(() => {
      changed = true
      return Promise.resolve(
        questObservation({
          offers: [],
          rows: [{ title: quest.title, state: 'completed', actionCount: 0 }]
        })
      )
    })
    expect((await f.execute()).status).toBe('partial')
    expect(f.store.getMutationState(f.task.taskId)).toBe('verification-pending')
    expect(f.store.getTask(f.task.taskId)?.reason).toBe('task-verification-date-changed')
    expect(f.navigateQuestOffer).toHaveBeenCalledTimes(1)
  })

  it('resumes a pending child after database restart even when its Link disappeared', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rewards-quest-synthetic-'))
    roots.push(root)
    const path = join(root, 'synthetic.sqlite')
    const initial = new SqliteStore(path)
    const pending = childTask({ status: 'verification-pending' })
    initial.upsertTask(pending, 'synthetic-old-run')
    initial.beginMutation(pending.taskId)
    initial.updateMutation(pending.taskId, 'verification-pending')
    initial.close()
    const store = new SqliteStore(path)
    stores.push(store)
    const f = fixture({ store, runId: 'synthetic-resumed-run' })
    const known = store.ledger.latestQuestTasks(accountId, date)
    expect(known[0]?.quest).toEqual(quest)
    const discovery = await new RewardsDiscoveryService().discover({
      accountId,
      localDate: date,
      client: f.client,
      punchCards: true,
      knownQuestTasks: known
    })
    expect(discovery.descriptors.get(pending.taskId)?.quest).toEqual(quest)
    expect(discovery.descriptors.get(pending.taskId)?.offer).toBeUndefined()
    expect((await f.execute(undefined, 'mutating', discovery)).status).toBe('completed')
    expect(store.getMutationState(pending.taskId)).toBe('verified')
    expect(f.navigateQuestOffer).not.toHaveBeenCalled()
    expect(f.reportServerAction).not.toHaveBeenCalled()
    expect(f.readQuest).toHaveBeenCalledTimes(2)
    const persisted = store.ledger.latestQuestTasks(accountId, date)[0]
    expect(persisted?.status).toBe('completed')
    expect(JSON.stringify(persisted)).not.toContain('synthetic-action-hash')
    expect(JSON.stringify(persisted)).not.toContain('https://')
    expect(store.ledger.latestQuestTasks('other-account', date)).toEqual([])
    expect(store.ledger.latestQuestTasks(accountId, '2026-10-06')).toEqual([])
  })

  it('retains the latest same-task identity without losing another account record', () => {
    const f = fixture()
    f.store.upsertTask(childTask({ status: 'submitted' }), 'synthetic-old-run')
    const latest = childTask({
      status: 'verification-pending',
      updatedAt: date + 'T02:00:00Z'
    })
    f.store.upsertTask(latest, 'synthetic-new-run')
    f.store.upsertTask(
      childTask({ accountId: 'other-account', taskId: 'other-task-id' }),
      'synthetic-new-run'
    )
    expect(f.store.ledger.latestQuestTasks(accountId, date)).toEqual([latest])
    expect(f.store.ledger.latestQuestTasks('other-account', date)).toHaveLength(1)
  })

  it('keeps existing ordinary card execution and verification paths', async () => {
    const f = fixture()
    const ordinary = {
      ...childOffer(),
      sourceTaskId: 'synthetic-normal',
      type: 'more-promotion' as const
    }
    delete ordinary.quest
    delete ordinary.parentOfferId
    const task = {
      ...childTask(),
      taskId: 'synthetic-normal-task',
      sourceTaskId: ordinary.sourceTaskId,
      type: ordinary.type
    }
    delete task.quest
    f.discovery.tasks = [task]
    f.discovery.descriptors = new Map([[task.taskId, { task, offer: ordinary }]])
    f.discovery.snapshot.offers = [ordinary]
    f.bootstrapRsc.mockResolvedValue(bootstrap([{ ...ordinary, completed: 1, complete: true }]))
    f.reportServerAction.mockResolvedValue({ acknowledged: true })
    const result = await f.executor.executeTypes({
      discovery: f.discovery,
      types: ['more-promotion'],
      mode: 'mutating',
      signal: new AbortController().signal
    })
    expect(result.status).toBe('completed')
    expect(f.reportServerAction).toHaveBeenCalledTimes(1)
    expect(f.bootstrapRsc).toHaveBeenCalledTimes(1)
    expect(f.navigateQuestOffer).not.toHaveBeenCalled()
    expect(f.readQuest).not.toHaveBeenCalled()
    expect(f.store.getMutationState(task.taskId)).toBe('verified')
    expect(f.store.getTask(childTask().taskId)).toBeUndefined()
    expect(
      f.discovery.tasks.some(
        (item) => item.sourceTaskId === parentId || item.sourceTaskId === childId
      )
    ).toBe(false)
  })
})
