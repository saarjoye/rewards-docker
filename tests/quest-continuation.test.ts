import { mkdtemp, rm, rmdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserContext } from 'patchright'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DashboardClient } from '../src/browser/DashboardClient.js'
import { localDateKey } from '../src/domain/DateKey.js'
import { createTaskId, type TaskRecord } from '../src/domain/Task.js'
import { DEFAULT_CONFIG } from '../src/infra/Config.js'
import { SqliteStore } from '../src/infra/SqliteStore.js'
import type { StructuredLogger } from '../src/infra/StructuredLogger.js'
import { Scheduler } from '../src/orchestration/Scheduler.js'
import { RewardsDiscoveryService } from '../src/rewards/RewardsDiscoveryService.js'
import { RewardsTaskExecutor } from '../src/rewards/RewardsTaskExecutor.js'
import type { QuestObservation, RewardOffer } from '../src/rewards/RewardsModel.js'
import {
  accountId,
  bootstrap,
  childId,
  childOffer,
  childTask,
  date,
  observation,
  parentId,
  parentOffer,
  quest
} from './fixtures/quests.js'

const stores: SqliteStore[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  vi.useRealTimers()
})

function database() {
  const store = new SqliteStore(':memory:')
  stores.push(store)
  return store
}

function official(done: Set<number>, unlocked: number): QuestObservation {
  const offers = Array.from({ length: 5 }, (_, index) => {
    const number = index + 1
    const title = '合成子任务 ' + String(number)
    return childOffer({
      sourceTaskId: childId.replace('child1_', 'child' + String(number) + '_'),
      displayName: title,
      complete: done.has(number),
      completed: done.has(number) ? 1 : 0,
      locked: number !== unlocked,
      executable: number === unlocked && !done.has(number),
      quest: { ...quest, title, ariaLabel: '打开合成页面, ' + title }
    })
  })
  return {
    parentOfferId: parentId,
    offers: offers.filter((offer) => !offer.complete),
    rows: offers.map((offer) => ({
      title: offer.displayName,
      state: offer.complete ? 'completed' : offer.locked ? 'locked' : 'open',
      actionCount: offer.complete || offer.locked ? 0 : 1
    }))
  }
}

function services(
  store: SqliteStore,
  localDate: string,
  detail: () => QuestObservation,
  homeOffers: readonly RewardOffer[] = []
) {
  const readQuest = vi.fn().mockImplementation(() => Promise.resolve(detail()))
  const navigateQuestOffer = vi.fn().mockResolvedValue(undefined)
  const client = {
    bootstrapRsc: vi.fn().mockResolvedValue(bootstrap(homeOffers)),
    fetchFlyout: vi.fn().mockResolvedValue(observation()),
    fetchDashboard: vi.fn().mockResolvedValue(observation()),
    readQuest,
    navigateQuestOffer,
    readClaimablePoints: vi.fn().mockResolvedValue(0)
  } as unknown as DashboardClient
  const runId = 'synthetic-run-' + localDate
  const executor = new RewardsTaskExecutor(
    {} as BrowserContext,
    client,
    store,
    { write: vi.fn().mockResolvedValue(undefined) } as unknown as StructuredLogger,
    DEFAULT_CONFIG,
    runId,
    'synthetic-account-alias'
  )
  const discover = (enabled = true) =>
    new RewardsDiscoveryService().discover({
      accountId,
      localDate,
      client,
      punchCards: enabled,
      knownQuestTasks: store.ledger.continuingQuestTasks(accountId, localDate)
    })
  return { discover, executor, runId, readQuest, navigateQuestOffer }
}

describe('persistent quest continuation', () => {
  it('remembers prior-day package identity after restart while keeping day-specific recovery intact', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rewards-quest-continuation-synthetic-'))
    const path = join(root, 'synthetic.sqlite')
    const first = new SqliteStore(path)
    const task = childTask({ status: 'completed' })
    try {
      first.upsertTask(task, 'synthetic-first-run')
    } finally {
      first.close()
    }
    const restored = new SqliteStore(path)
    try {
      expect(restored.ledger.latestQuestTasks(accountId, '2026-10-06')).toEqual([])
      expect(restored.ledger.continuingQuestTasks(accountId, '2026-10-06')).toEqual([task])
      const f = services(restored, '2026-10-06', () => official(new Set([1]), 2))
      const discovery = await f.discover()
      expect(f.readQuest).toHaveBeenCalledTimes(1)
      const next = discovery.tasks.find((item) => item.sourceTaskId.includes('child2_'))
      expect(next).toMatchObject({
        localDate: '2026-10-06',
        executable: true,
        status: 'discovered'
      })
      expect(discovery.tasks.some((item) => item.sourceTaskId === childId)).toBe(false)
    } finally {
      restored.close()
      await rm(path, { force: true })
      await rmdir(root)
    }
  })

  it('selects the latest child per package without mixing another account or future dates', () => {
    const store = database()
    const old = childTask({ status: 'submitted' })
    const latest = childTask({
      taskId: createTaskId(accountId, '2026-10-06', childId),
      localDate: '2026-10-06',
      status: 'completed',
      updatedAt: '2026-10-06T01:00:00Z'
    })
    store.upsertTask(old, 'synthetic-old-run')
    store.upsertTask(latest, 'synthetic-new-run')
    store.upsertTask(
      childTask({ accountId: 'other-synthetic-account', taskId: 'other-task' }),
      'other-run'
    )
    expect(store.ledger.continuingQuestTasks(accountId, date)).toEqual([old])
    expect(store.ledger.continuingQuestTasks(accountId, '2026-10-07')).toEqual([latest])
    expect(store.ledger.continuingQuestTasks('absent-synthetic-account', '2026-10-07')).toEqual([])
  })

  it('stops remembering a prior-day package after official parent completion', () => {
    const store = database()
    store.upsertTask(childTask({ status: 'completed' }), 'synthetic-first-run')
    const parent: TaskRecord = {
      ...childTask(),
      sourceTaskId: parentId,
      taskId: createTaskId(accountId, date, parentId),
      status: 'completed',
      progress: { completed: 5, total: 5 }
    }
    delete parent.quest
    store.upsertTask(parent, 'synthetic-finished-run')
    expect(store.ledger.continuingQuestTasks(accountId, '2026-10-06')).toEqual([])
    expect(store.ledger.continuingQuestTasks(accountId, date)).toHaveLength(1)
  })

  it('keeps the next item locked across midnight and after 24 hours until the official page unlocks it', async () => {
    const store = database()
    store.upsertTask(childTask({ status: 'completed' }), 'synthetic-first-run')
    for (const localDate of ['2026-10-06', '2026-10-07']) {
      const f = services(store, localDate, () => official(new Set([1]), 0))
      const discovery = await f.discover()
      expect(discovery.tasks.find((item) => item.sourceTaskId.includes('child2_'))).toMatchObject({
        executable: false,
        status: 'skipped'
      })
      await f.executor.executeTypes({
        discovery,
        types: ['punch-card'],
        mode: 'mutating',
        signal: new AbortController().signal
      })
      expect(f.navigateQuestOffer).not.toHaveBeenCalled()
    }
  })

  it('does not revisit stored packages when punch-card execution is disabled', async () => {
    const store = database()
    store.upsertTask(childTask({ status: 'completed' }), 'synthetic-first-run')
    const f = services(store, '2026-10-06', () => official(new Set([1]), 2))
    await f.discover(false)
    expect(f.readQuest).not.toHaveBeenCalled()
  })

  it('keeps a prior-day unknown submission read-only even if the same child still appears open', async () => {
    vi.useFakeTimers()
    vi.setSystemTime('2026-10-06T00:00:00Z')
    const store = database()
    const pending = childTask({
      quest: { ...quest, title: '合成子任务 1', ariaLabel: '打开合成页面, 合成子任务 1' },
      displayName: '合成子任务 1',
      status: 'verification-pending'
    })
    store.upsertTask(pending, 'synthetic-first-run')
    store.beginMutation(pending.taskId)
    store.updateMutation(pending.taskId, 'verification-pending')
    const f = services(store, '2026-10-06', () => official(new Set(), 1))
    const discovery = await f.discover()
    expect(discovery.tasks.filter((task) => task.sourceTaskId === childId)).toEqual([
      expect.objectContaining({
        taskId: pending.taskId,
        localDate: date,
        executable: false,
        status: 'verification-pending'
      })
    ])
    const executing = f.executor.executeTypes({
      discovery,
      types: ['punch-card'],
      mode: 'mutating',
      signal: new AbortController().signal
    })
    await vi.advanceTimersByTimeAsync(1_100)
    expect((await executing).status).toBe('partial')
    expect(f.navigateQuestOffer).not.toHaveBeenCalled()
    expect(store.getMutationState(pending.taskId)).toBe('verification-pending')
    expect(store.getMutationState(createTaskId(accountId, '2026-10-06', childId))).toBeUndefined()
  })

  it.each(['submitted', 'verification-pending', 'failed'] as const)(
    'retains an attempted child with status %s instead of a newer locked snapshot',
    async (status) => {
      vi.useFakeTimers()
      vi.setSystemTime('2026-10-07T00:00:00Z')
      const store = database()
      const attempted = childTask({ status })
      store.upsertTask(attempted, 'synthetic-first-run')
      store.beginMutation(attempted.taskId)
      store.updateMutation(attempted.taskId, status)
      store.upsertTask(
        childTask({
          taskId: createTaskId(accountId, '2026-10-06', childId),
          localDate: '2026-10-06',
          status: 'skipped',
          executable: false,
          updatedAt: '2026-10-06T01:00:00Z'
        }),
        'synthetic-newer-locked-run'
      )
      const f = services(store, '2026-10-07', () => ({
        parentOfferId: parentId,
        offers: [childOffer()],
        rows: [{ title: quest.title, state: 'open', actionCount: 1 }]
      }))
      const discovery = await f.discover()
      expect(discovery.tasks.filter((task) => task.quest)).toEqual([
        expect.objectContaining({
          taskId: attempted.taskId,
          localDate: date,
          executable: false,
          status: 'verification-pending'
        })
      ])
      const executing = f.executor.executeTypes({
        discovery,
        types: ['punch-card'],
        mode: 'mutating',
        signal: new AbortController().signal
      })
      await vi.advanceTimersByTimeAsync(1_100)
      expect((await executing).status).toBe('partial')
      expect(f.navigateQuestOffer).not.toHaveBeenCalled()
      expect(store.getMutationState(createTaskId(accountId, '2026-10-07', childId))).toBeUndefined()
    }
  )

  it('does not resend an already verified child that reappears open on a later day', async () => {
    const store = database()
    const completed = childTask({ status: 'completed', progress: { completed: 1, total: 1 } })
    store.upsertTask(completed, 'synthetic-first-run')
    store.beginMutation(completed.taskId)
    store.updateMutation(completed.taskId, 'verified')
    const f = services(store, '2026-10-06', () => ({
      parentOfferId: parentId,
      offers: [childOffer()],
      rows: [{ title: quest.title, state: 'open', actionCount: 1 }]
    }))
    const discovery = await f.discover()
    expect(discovery.tasks.filter((task) => task.quest)).toEqual([
      expect.objectContaining({
        taskId: completed.taskId,
        executable: false,
        status: 'verification-pending'
      })
    ])
    const result = await f.executor.executeTypes({
      discovery,
      types: ['punch-card'],
      mode: 'mutating',
      signal: new AbortController().signal
    })
    expect(result.status).toBe('partial')
    expect(f.navigateQuestOffer).not.toHaveBeenCalled()
    expect(store.getMutationState(completed.taskId)).toBe('verified')
  })

  it('verifies the prior-day disappearing Link without clicking and executes only the next unlocked item', async () => {
    const store = database()
    const pending = childTask({
      quest: { ...quest, title: '合成子任务 1', ariaLabel: '打开合成页面, 合成子任务 1' },
      displayName: '合成子任务 1',
      status: 'verification-pending'
    })
    store.upsertTask(pending, 'synthetic-first-run')
    store.beginMutation(pending.taskId)
    store.updateMutation(pending.taskId, 'verification-pending')
    const done = new Set([1])
    const f = services(store, '2026-10-06', () => official(done, 2))
    f.navigateQuestOffer.mockImplementation((offer: RewardOffer) => {
      expect(offer.sourceTaskId).toContain('child2_')
      done.add(2)
      return Promise.resolve()
    })
    const discovery = await f.discover()
    const result = await f.executor.executeTypes({
      discovery,
      types: ['punch-card'],
      mode: 'mutating',
      signal: new AbortController().signal
    })
    expect(result.status).toBe('completed')
    expect(f.navigateQuestOffer).toHaveBeenCalledTimes(1)
    expect(store.getMutationState(pending.taskId)).toBe('verified')
    expect(store.getTask(pending.taskId)).toMatchObject({ status: 'completed', localDate: date })
    expect(store.getMutationState(createTaskId(accountId, '2026-10-06', childId))).toBeUndefined()
  })

  it('does not confirm a prior-day pending child when its official completed label has changed', async () => {
    const store = database()
    const pending = childTask({ status: 'verification-pending' })
    store.upsertTask(pending, 'synthetic-first-run')
    store.beginMutation(pending.taskId)
    store.updateMutation(pending.taskId, 'verification-pending')
    const f = services(store, '2026-10-06', () => ({
      parentOfferId: parentId,
      offers: [
        childOffer({
          complete: true,
          completed: 1,
          executable: false,
          quest: { ...quest, title: '另一项合成任务' }
        })
      ],
      rows: [{ title: '另一项合成任务', state: 'completed', actionCount: 0 }]
    }))
    const discovery = await f.discover()
    const result = await f.executor.executeTypes({
      discovery,
      types: ['punch-card'],
      mode: 'mutating',
      signal: new AbortController().signal
    })
    expect(result.status).toBe('partial')
    expect(f.navigateQuestOffer).not.toHaveBeenCalled()
    expect(store.getMutationState(pending.taskId)).toBe('verification-pending')
    expect(discovery.tasks.filter((task) => task.quest)).toEqual([
      expect.objectContaining({ taskId: pending.taskId, quest, status: 'verification-pending' })
    ])
  })

  it('allows the daily scheduler to finish five successive items even after the homepage entry disappears', async () => {
    vi.useFakeTimers()
    vi.setSystemTime('2026-10-04T22:59:59Z')
    const store = database()
    const done = new Set<number>()
    const clicks: string[] = []
    const days: string[] = []
    const scheduler = new Scheduler(store.database)
    scheduler.start(async () => {
      const localDate = localDateKey()
      // This fixture provides a fresh official unlock, rather than a local time-based inference.
      const unlocked = days.length + 1
      expect(store.isAccountCompleteForDate(accountId, localDate)).toBe(false)
      const f = services(
        store,
        localDate,
        () => official(done, unlocked),
        days.length === 0 ? [parentOffer()] : []
      )
      f.navigateQuestOffer.mockImplementation((offer: RewardOffer) => {
        const number = Number(/_pcchild(\d+)_/.exec(offer.sourceTaskId)?.[1])
        expect(number).toBe(unlocked)
        expect(done.has(number)).toBe(false)
        clicks.push(offer.sourceTaskId)
        done.add(number)
        return Promise.resolve()
      })
      const discovery = await f.discover()
      for (const task of discovery.tasks) store.upsertTask(task, f.runId)
      const result = await f.executor.executeTypes({
        discovery,
        types: ['punch-card'],
        mode: 'mutating',
        signal: new AbortController().signal
      })
      expect(result.status).toBe('completed')
      expect(f.navigateQuestOffer).toHaveBeenCalledTimes(1)
      expect(discovery.tasks.filter((task) => task.quest && task.executable)).toHaveLength(1)
      store.upsertAccountRun({
        runId: f.runId,
        accountId,
        runAccountIndex: 2,
        localDate,
        status: 'success',
        updatedAt: new Date().toISOString()
      })
      expect(store.isAccountCompleteForDate(accountId, localDate)).toBe(true)
      days.push(localDate)
    })
    try {
      await vi.advanceTimersByTimeAsync(1_000)
      for (let day = 1; day < 5; day++) await vi.advanceTimersByTimeAsync(24 * 60 * 60_000)
      expect(days).toEqual(['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09'])
      expect(done.size).toBe(5)
      expect(clicks).toHaveLength(5)
      expect(new Set(clicks).size).toBe(5)
      expect(scheduler.status().lastResult).toBe('started')
      expect(store.database.prepare('SELECT COUNT(*) AS count FROM mutation_ledger').get()).toEqual(
        { count: 5 }
      )
    } finally {
      scheduler.stop()
    }
  })
})
