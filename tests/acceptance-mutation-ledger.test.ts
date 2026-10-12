import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { BrowserContext } from 'patchright'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { HashedMutationLedger } from '../src/acceptance/HashedMutationLedger.js'
import type { DashboardClient } from '../src/browser/DashboardClient.js'
import type { TaskRecord } from '../src/domain/Task.js'
import { DEFAULT_CONFIG } from '../src/infra/Config.js'
import { SqliteStore } from '../src/infra/SqliteStore.js'
import type { StructuredLogger } from '../src/infra/StructuredLogger.js'
import type { DiscoveryOutput } from '../src/rewards/RewardsDiscoveryService.js'
import type { RewardOffer, RewardsDiscoverySnapshot } from '../src/rewards/RewardsModel.js'
import { RewardsTaskExecutor } from '../src/rewards/RewardsTaskExecutor.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('acceptance mutation ledger', () => {
  it('survives reruns with a new transient account id without storing the logical task key', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rewards-next-acceptance-ledger-'))
    roots.push(root)
    const path = join(root, 'mutation-ledger.sqlite')
    const firstTask = 'transient-account-a:2026-09-04:daily-offer:article:1'
    const secondTask = 'transient-account-b:2026-09-04:daily-offer:article:1'

    const first = new HashedMutationLedger(path, 2, '2026-09-04')
    expect(first.beginMutation(firstTask)).toBe(true)
    first.updateMutation(firstTask, 'verification-pending')
    first.close()

    const second = new HashedMutationLedger(path, 2, '2026-09-04')
    expect(second.getMutationState(secondTask)).toBe('verification-pending')
    expect(second.beginMutation(secondTask)).toBe(false)
    second.close()

    const database = new DatabaseSync(path, { readOnly: true })
    const row = database
      .prepare('SELECT account_index, local_date, task_hash, state FROM acceptance_mutations')
      .get() as { account_index: number; local_date: string; task_hash: string; state: string }
    database.close()
    expect(row).toMatchObject({
      account_index: 2,
      local_date: '2026-09-04',
      state: 'verification-pending'
    })
    expect(row.task_hash).toMatch(/^[a-f0-9]{64}$/)
    expect(row.task_hash).not.toContain('daily-offer')
    expect((await readFile(path)).includes(Buffer.from('daily-offer'))).toBe(false)
  })

  it('isolates the same logical task by account index and local date', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rewards-next-acceptance-ledger-scope-'))
    roots.push(root)
    const path = join(root, 'mutation-ledger.sqlite')
    const first = new HashedMutationLedger(path, 1, '2026-09-04')
    expect(first.beginMutation('temporary:2026-09-04:offer')).toBe(true)
    first.close()

    const otherAccount = new HashedMutationLedger(path, 2, '2026-09-04')
    expect(otherAccount.getMutationState('temporary:2026-09-04:offer')).toBeUndefined()
    otherAccount.close()
    const otherDate = new HashedMutationLedger(path, 1, '2026-09-05')
    expect(otherDate.getMutationState('temporary:2026-09-05:offer')).toBeUndefined()
    otherDate.close()
  })

  it('allows a task to start again only when submission never began', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rewards-next-acceptance-ledger-cancel-'))
    roots.push(root)
    const path = join(root, 'mutation-ledger.sqlite')
    const taskId = 'temporary:2026-09-04:missing-link'
    const ledger = new HashedMutationLedger(path, 1, '2026-09-04')

    expect(ledger.beginMutation(taskId)).toBe(true)
    expect(ledger.getMutationState(taskId)).toBe('submission-started')
    ledger.cancelMutation(taskId)
    expect(ledger.getMutationState(taskId)).toBeUndefined()
    expect(ledger.beginMutation(taskId)).toBe(true)
    ledger.updateMutation(taskId, 'submitted')
    ledger.cancelMutation(taskId)
    expect(ledger.getMutationState(taskId)).toBe('submitted')
    ledger.close()
  })

  it('ledger verified 的 quest 子任务直接判 completed', async () => {
    const store = new SqliteStore(':memory:')
    try {
      const task: TaskRecord = {
        taskId: 'synthetic:2026-10-12:quest-child-1',
        accountId: 'synthetic-account',
        localDate: '2026-10-12',
        sourceTaskId: 'quest-child-1',
        type: 'more-promotion',
        source: 'rsc',
        displayName: '合成任务1',
        executable: true,
        required: false,
        status: 'discovered',
        progress: { completed: 0, total: 1 },
        updatedAt: '2026-10-12T00:00:00Z',
        quest: {
          parentOfferId: 'parent-punch-card',
          title: '合成任务1',
          ariaLabel: '打开合成页面, 合成任务1'
        }
      }
      store.upsertTask(task, 'run-1')
      store.beginMutation(task.taskId)
      store.updateMutation(task.taskId, 'verified')

      const readQuest = vi.fn()
      const client = {
        fetchDashboard: vi.fn(),
        readQuest
      } as unknown as DashboardClient

      const executor = new RewardsTaskExecutor(
        {} as BrowserContext,
        client,
        store,
        { write: vi.fn().mockResolvedValue(undefined) } as unknown as StructuredLogger,
        DEFAULT_CONFIG,
        'run-2',
        'synthetic-account'
      )

      const discovery: DiscoveryOutput = {
        snapshot: { offers: [], actionIds: {} } as unknown as RewardsDiscoverySnapshot,
        tasks: [task],
        descriptors: new Map([[task.taskId, { task }]]),
        dataSources: {
          rsc: true,
          dom: false,
          dashboard: false,
          flyout: false,
          'app-dashboard': false
        }
      }

      const result = await executor.executeTypes({
        discovery,
        types: ['more-promotion'],
        mode: 'mutating',
        signal: new AbortController().signal
      })

      expect(result.status).toBe('completed')
      expect(result.tasks[0]?.status).toBe('completed')
      expect(readQuest).not.toHaveBeenCalled()
    } finally {
      store.close()
    }
  })

  it('executeReadToEarn: previousState=verification-pending 且 mutating 时重新提交并推进 completed', async () => {
    const store = new SqliteStore(':memory:')
    try {
      const offer: RewardOffer = {
        sourceTaskId: 'read-article',
        type: 'read-to-earn',
        source: 'app-dashboard',
        displayName: '阅读文章赚积分',
        complete: false,
        completed: 0,
        total: 1,
        executable: true,
        attributes: { offerid: 'read-article', type: 'msnreadearn' }
      }
      const task: TaskRecord = {
        taskId: 'synthetic:2026-10-12:read-to-earn',
        accountId: 'synthetic-account',
        localDate: '2026-10-12',
        sourceTaskId: 'read-article',
        type: 'read-to-earn',
        source: 'app-dashboard',
        displayName: '阅读文章赚积分',
        executable: true,
        required: false,
        status: 'verification-pending',
        progress: { completed: 0, total: 1 },
        updatedAt: '2026-10-12T00:00:00Z'
      }
      store.upsertTask(task, 'run-1')
      const ledgerId = `${task.taskId}:article:1`
      store.beginMutation(ledgerId)
      store.updateMutation(ledgerId, 'verification-pending')

      const initialObs = {
        offers: [{ ...offer, completed: 0, complete: false }],
        availablePoints: { value: 100, availability: 'valid', source: 'app-dashboard' }
      }
      const confirmedObs = {
        offers: [{ ...offer, completed: 1, complete: true }],
        availablePoints: { value: 130, availability: 'valid', source: 'app-dashboard' }
      }

      const fetchAppDashboard = vi
        .fn()
        .mockResolvedValueOnce(initialObs)
        .mockResolvedValueOnce(confirmedObs)
      const submitAppActivity = vi.fn().mockResolvedValue(130)

      const client = {
        fetchAppDashboard,
        submitAppActivity
      } as unknown as DashboardClient

      const executor = new RewardsTaskExecutor(
        {} as BrowserContext,
        client,
        store,
        { write: vi.fn().mockResolvedValue(undefined) } as unknown as StructuredLogger,
        DEFAULT_CONFIG,
        'run-2',
        'synthetic-account',
        'mock-app-token'
      )

      const discovery: DiscoveryOutput = {
        snapshot: { offers: [offer], actionIds: {} } as unknown as RewardsDiscoverySnapshot,
        tasks: [task],
        descriptors: new Map([[task.taskId, { task, offer }]]),
        dataSources: {
          rsc: false,
          dom: false,
          dashboard: false,
          flyout: false,
          'app-dashboard': true
        }
      }

      const result = await executor.executeTypes({
        discovery,
        types: ['read-to-earn'],
        mode: 'mutating',
        signal: new AbortController().signal
      })

      expect(result.status).toBe('completed')
      expect(submitAppActivity).toHaveBeenCalledTimes(1)
      expect(store.getMutationState(ledgerId)).toBe('verified')
      expect(result.tasks[0]?.status).toBe('completed')
      expect(result.tasks[0]?.progress.completed).toBe(1)
    } finally {
      store.close()
    }
  })

  it('executeReadToEarn: previousState=verification-pending 且 read-only 时保持 partial 且不提交', async () => {
    const store = new SqliteStore(':memory:')
    try {
      const offer: RewardOffer = {
        sourceTaskId: 'read-article',
        type: 'read-to-earn',
        source: 'app-dashboard',
        displayName: '阅读文章赚积分',
        complete: false,
        completed: 0,
        total: 1,
        executable: true,
        attributes: { offerid: 'read-article', type: 'msnreadearn' }
      }
      const task: TaskRecord = {
        taskId: 'synthetic:2026-10-12:read-to-earn',
        accountId: 'synthetic-account',
        localDate: '2026-10-12',
        sourceTaskId: 'read-article',
        type: 'read-to-earn',
        source: 'app-dashboard',
        displayName: '阅读文章赚积分',
        executable: true,
        required: false,
        status: 'verification-pending',
        progress: { completed: 0, total: 1 },
        updatedAt: '2026-10-12T00:00:00Z'
      }
      store.upsertTask(task, 'run-1')
      const ledgerId = `${task.taskId}:article:1`
      store.beginMutation(ledgerId)
      store.updateMutation(ledgerId, 'verification-pending')

      const initialObs = {
        offers: [{ ...offer, completed: 0, complete: false }],
        availablePoints: { value: 100, availability: 'valid', source: 'app-dashboard' }
      }

      const fetchAppDashboard = vi.fn().mockResolvedValue(initialObs)
      const submitAppActivity = vi.fn().mockResolvedValue(100)

      const client = {
        fetchAppDashboard,
        submitAppActivity
      } as unknown as DashboardClient

      const executor = new RewardsTaskExecutor(
        {} as BrowserContext,
        client,
        store,
        { write: vi.fn().mockResolvedValue(undefined) } as unknown as StructuredLogger,
        DEFAULT_CONFIG,
        'run-2',
        'synthetic-account',
        'mock-app-token'
      )

      const outcome = await (executor as unknown as {
        executeReadToEarn: (
          descriptor: { task: TaskRecord; offer?: RewardOffer },
          signal: AbortSignal,
          mode: 'read-only' | 'mutating'
        ) => Promise<'completed' | 'partial' | 'failed'>
      }).executeReadToEarn(
        { task, offer },
        new AbortController().signal,
        'read-only'
      )

      expect(outcome).toBe('partial')
      expect(submitAppActivity).not.toHaveBeenCalled()
      expect(store.getMutationState(ledgerId)).toBe('verification-pending')
      const updated = store.getTask(task.taskId)
      expect(updated?.status).toBe('verification-pending')
    } finally {
      store.close()
    }
  })
})