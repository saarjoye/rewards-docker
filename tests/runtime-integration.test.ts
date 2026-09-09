import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserContext, Page } from 'patchright'

import type { EncryptedSessionStore } from '../src/auth/EncryptedSessionStore.js'
import { AppOAuthClient } from '../src/browser/AppOAuthClient.js'
import { DashboardClient, type RscBootstrap } from '../src/browser/DashboardClient.js'
import type { AccountBrowserSlot, BrowserRuntime } from '../src/browser/BrowserRuntime.js'
import { LoginController } from '../src/browser/LoginController.js'
import { REWARDS_URLS } from '../src/browser/Urls.js'
import { createEvidence } from '../src/domain/Evidence.js'
import type { TaskRecord } from '../src/domain/Task.js'
import type { AccountSecretStore, AccountSummary } from '../src/infra/AccountSecretStore.js'
import { DEFAULT_CONFIG } from '../src/infra/Config.js'
import { SqliteStore } from '../src/infra/SqliteStore.js'
import type { StructuredLogger } from '../src/infra/StructuredLogger.js'
import { ApplicationRunCoordinator } from '../src/orchestration/RunCoordinator.js'
import { MutationNotStartedError } from '../src/orchestration/MutationExecutor.js'
import { SearchExecutor } from '../src/orchestration/SearchExecutor.js'
import {
  RewardsDiscoveryService,
  type DiscoveryOutput
} from '../src/rewards/RewardsDiscoveryService.js'
import type {
  RewardOffer,
  RewardsObservation,
  RewardsDiscoverySnapshot
} from '../src/rewards/RewardsModel.js'
import { RewardsTaskExecutor } from '../src/rewards/RewardsTaskExecutor.js'

const roots: string[] = []

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

function evidence<T>(value: T, source: 'rsc' | 'bing-flyout' | 'app-dashboard' = 'rsc') {
  return createEvidence({
    availability: 'valid' as const,
    source,
    confidence: 0.9,
    observedAt: '2026-09-03T00:00:00.000Z',
    value
  })
}

function offer(type: RewardOffer['type'], id: string): RewardOffer {
  return {
    sourceTaskId: id,
    type,
    source: type.startsWith('app-') || type === 'read-to-earn' ? 'app-dashboard' : 'rsc',
    displayName: id,
    completed: 0,
    total: 1,
    complete: false,
    executable: true,
    hash: `hash-${id}`
  }
}

function observation(offers: readonly RewardOffer[] = []): RewardsObservation {
  return {
    source: 'bing-flyout',
    rewardsUser: evidence(true, 'bing-flyout'),
    market: evidence('CN', 'bing-flyout'),
    availablePoints: evidence(100, 'bing-flyout'),
    pcSearch: evidence({ completed: 0, total: 60, remaining: 60 }, 'bing-flyout'),
    mobileSearch: evidence({ completed: 0, total: 30, remaining: 30 }, 'bing-flyout'),
    offers,
    topLevelFields: ['dashboard']
  }
}

function browserSlot(slot: 'web-desktop' | 'web-mobile'): {
  value: AccountBrowserSlot
  goto: ReturnType<typeof vi.fn>
  commitVerified: ReturnType<typeof vi.fn>
} {
  const goto = vi.fn().mockResolvedValue(null)
  const commitVerified = vi.fn().mockResolvedValue(undefined)
  const page = {
    goto,
    url: vi.fn().mockReturnValue('https://rewards.bing.com/dashboard')
  } as unknown as Page
  return {
    value: {
      slot,
      context: {} as BrowserContext,
      page,
      close: vi.fn().mockResolvedValue(undefined),
      commitVerified
    },
    goto,
    commitVerified
  }
}

function invokeAuthenticate(
  coordinator: ApplicationRunCoordinator,
  resources: Record<string, unknown> = {}
): Promise<{ status: string; failureStage?: string; message?: string }> {
  const callable = coordinator as unknown as {
    authenticate(
      context: {
        runId: string
        accountId: string
        runAccountIndex: number
        localDate: string
        signal: AbortSignal
      },
      credentials: { email: string; password: string },
      accountResources: Record<string, unknown>
    ): Promise<{ status: string; failureStage?: string; message?: string }>
  }
  return callable.authenticate(
    {
      runId: 'synthetic-run',
      accountId: 'synthetic-account',
      runAccountIndex: 1,
      localDate: '2026-09-04',
      signal: new AbortController().signal
    },
    { email: 'synthetic@example.test', password: 'synthetic-password' },
    resources
  )
}

function invokeFinalVerification(input: {
  coordinator: ApplicationRunCoordinator
  client: Pick<DashboardClient, 'fetchDashboard'>
  resources: Record<string, unknown>
  signal?: AbortSignal
}): Promise<{ status: string; failureStage?: string; message?: string }> {
  const callable = input.coordinator as unknown as {
    executeStage(
      stage: 'final-verification',
      context: {
        runId: string
        accountId: string
        runAccountIndex: number
        localDate: string
        signal: AbortSignal
      },
      mode: 'mutating',
      credentials: { email: string; password: string },
      resources: Record<string, unknown>
    ): Promise<{ status: string; failureStage?: string; message?: string }>
  }
  return callable.executeStage(
    'final-verification',
    {
      runId: 'synthetic-run',
      accountId: 'synthetic-account',
      runAccountIndex: 1,
      localDate: '2026-09-04',
      signal: input.signal ?? new AbortController().signal
    },
    'mutating',
    { email: 'synthetic@example.test', password: 'synthetic-password' },
    { ...input.resources, desktopClient: input.client }
  )
}

describe('final balance settlement', () => {
  it('uses a lower observed balance instead of retaining a cached maximum', async () => {
    vi.useFakeTimers()
    const fetchDashboard = vi
      .fn()
      .mockResolvedValue({ ...observation(), availablePoints: evidence(180) })
    const input = setup(fetchDashboard)
    Object.assign(input.resources, { initialPoints: 200, finalPoints: 300 })
    const result = invokeFinalVerification(input)
    await vi.advanceTimersByTimeAsync(30_000)
    await expect(result).resolves.toMatchObject({ status: 'partial' })
    expect(fetchDashboard).toHaveBeenCalledTimes(4)
  })

  function setup(fetchDashboard: ReturnType<typeof vi.fn>) {
    const task: TaskRecord = {
      taskId: 'synthetic-account:2026-09-04:pc-search',
      accountId: 'synthetic-account',
      localDate: '2026-09-04',
      sourceTaskId: 'pc-search',
      type: 'pc-search',
      source: 'bing-flyout',
      displayName: 'PC search',
      executable: true,
      required: true,
      status: 'completed',
      progress: { completed: 60, total: 60 },
      updatedAt: '2026-09-04T00:00:00.000Z'
    }
    const store = {
      listTaskState: vi.fn().mockReturnValue([task])
    } as unknown as SqliteStore
    const loggerWrite = vi.fn().mockResolvedValue(undefined)
    const logger = { write: loggerWrite } as unknown as StructuredLogger
    const coordinator = new ApplicationRunCoordinator(
      {} as AccountSecretStore,
      store,
      {} as EncryptedSessionStore,
      {} as BrowserRuntime,
      logger,
      DEFAULT_CONFIG
    )
    const resources = {
      desktop: {},
      discovery: {} as DiscoveryOutput,
      initialPoints: 100,
      initialTaskProgress: new Map([[task.taskId, 0]]),
      initialTaskStatuses: new Map([[task.taskId, 'running']])
    }
    return { coordinator, loggerWrite, resources, client: { fetchDashboard } }
  }

  it('waits for the balance to reflect confirmed search counter progress', async () => {
    vi.useFakeTimers()
    const fetchDashboard = vi
      .fn()
      .mockResolvedValueOnce({ ...observation(), availablePoints: evidence(157) })
      .mockResolvedValueOnce({ ...observation(), availablePoints: evidence(160) })
    const input = setup(fetchDashboard)

    const result = invokeFinalVerification(input)
    await vi.advanceTimersByTimeAsync(10_000)

    await expect(result).resolves.toEqual({ status: 'completed' })
    expect(fetchDashboard).toHaveBeenCalledTimes(2)
    expect(input.loggerWrite).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'confirmed', attempt: 2 })
    )
  })

  it('marks settlement partial when three trusted balances remain below the counter gain', async () => {
    vi.useFakeTimers()
    const fetchDashboard = vi
      .fn()
      .mockResolvedValue({ ...observation(), availablePoints: evidence(157) })
    const input = setup(fetchDashboard)

    const result = invokeFinalVerification(input)
    await vi.advanceTimersByTimeAsync(30_000)

    await expect(result).resolves.toEqual({
      status: 'partial',
      message: '最终余额尚未反映已确认的搜索进度',
      failureStage: 'final-dashboard-settlement'
    })
    expect(fetchDashboard).toHaveBeenCalledTimes(4)
    expect(input.loggerWrite).toHaveBeenCalledTimes(4)
  })
})

function authenticationCoordinator(input: {
  openSlot: ReturnType<typeof vi.fn>
  config?: typeof DEFAULT_CONFIG
  store?: SqliteStore
}): ApplicationRunCoordinator {
  return new ApplicationRunCoordinator(
    {} as AccountSecretStore,
    input.store ?? ({} as SqliteStore),
    {} as EncryptedSessionStore,
    {
      openSlot: input.openSlot,
      close: vi.fn().mockResolvedValue(undefined)
    } as unknown as BrowserRuntime,
    { write: vi.fn().mockResolvedValue(undefined) } as unknown as StructuredLogger,
    input.config ?? DEFAULT_CONFIG
  )
}

describe('coordinator authentication recovery', () => {
  it('repairs a mobile Bing session before App OAuth and commits only after verification', async () => {
    const desktop = browserSlot('web-desktop')
    const mobile = browserSlot('web-mobile')
    const openSlot = vi
      .fn()
      .mockResolvedValueOnce(desktop.value)
      .mockResolvedValueOnce(mobile.value)
    const confirmed = observation()
    const verifyAuthenticated = vi
      .spyOn(RewardsDiscoveryService.prototype, 'verifyAuthenticated')
      .mockResolvedValueOnce({ verification: { valid: true }, observation: confirmed })
      .mockResolvedValueOnce({
        verification: {
          valid: false,
          failedStage: 'bing',
          reason: 'Bing Rewards identity not confirmed'
        }
      })
      .mockResolvedValueOnce({ verification: { valid: true }, observation: confirmed })
    const login = vi.spyOn(LoginController.prototype, 'login').mockResolvedValue(undefined)
    vi.spyOn(AppOAuthClient.prototype, 'readStored').mockResolvedValue({
      accessToken: 'synthetic-token',
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    })
    vi.spyOn(AppOAuthClient.prototype, 'commitVerified').mockResolvedValue(undefined)
    vi.spyOn(DashboardClient.prototype, 'fetchAppDashboard').mockResolvedValue({
      ...confirmed,
      source: 'app-dashboard'
    })

    await expect(invokeAuthenticate(authenticationCoordinator({ openSlot }))).resolves.toEqual({
      status: 'completed'
    })
    expect(verifyAuthenticated).toHaveBeenCalledTimes(3)
    expect(login).toHaveBeenCalledTimes(3)
    expect(mobile.goto).toHaveBeenNthCalledWith(
      2,
      REWARDS_URLS.bingSignIn,
      expect.objectContaining({ waitUntil: 'domcontentloaded' })
    )
    expect(desktop.commitVerified).toHaveBeenCalledTimes(1)
    expect(mobile.commitVerified).toHaveBeenCalledTimes(1)
  })

  it('keeps a repeated mobile Bing verification failure out of the app-oauth stage', async () => {
    const desktop = browserSlot('web-desktop')
    const mobile = browserSlot('web-mobile')
    const openSlot = vi
      .fn()
      .mockResolvedValueOnce(desktop.value)
      .mockResolvedValueOnce(mobile.value)
    const confirmed = observation()
    vi.spyOn(RewardsDiscoveryService.prototype, 'verifyAuthenticated')
      .mockResolvedValueOnce({ verification: { valid: true }, observation: confirmed })
      .mockResolvedValueOnce({
        verification: {
          valid: false,
          failedStage: 'bing',
          reason: 'Bing Rewards identity not confirmed'
        }
      })
      .mockResolvedValueOnce({
        verification: {
          valid: false,
          failedStage: 'bing',
          reason: 'Bing Rewards identity not confirmed'
        }
      })
    vi.spyOn(LoginController.prototype, 'login').mockResolvedValue(undefined)
    const oauthRead = vi.spyOn(AppOAuthClient.prototype, 'readStored')

    await expect(
      invokeAuthenticate(authenticationCoordinator({ openSlot }))
    ).resolves.toMatchObject({
      status: 'partial',
      failureStage: 'bing-session-error'
    })
    expect(mobile.goto).toHaveBeenCalledTimes(2)
    expect(mobile.commitVerified).not.toHaveBeenCalled()
    expect(oauthRead).not.toHaveBeenCalled()
  })
})

describe('coordinator task configuration refresh', () => {
  it('keeps a disabled claim task skipped after the claim-stage rediscovery', async () => {
    const claim: TaskRecord = {
      taskId: 'synthetic-account:2026-09-04:claim-bonus-points',
      accountId: 'synthetic-account',
      localDate: '2026-09-04',
      sourceTaskId: 'claim-bonus-points',
      type: 'claim-bonus-points',
      source: 'rsc',
      displayName: '领取奖励积分',
      executable: true,
      required: true,
      status: 'discovered',
      progress: { completed: 0, total: 1 },
      updatedAt: '2026-09-04T00:00:00.000Z'
    }
    const refreshed: DiscoveryOutput = {
      snapshot: {
        rewardsUser: evidence(true),
        market: evidence('CN'),
        availablePoints: evidence(100),
        pcSearch: evidence({ completed: 60, total: 60, remaining: 0 }),
        mobileSearch: evidence({ completed: 0, total: 0, remaining: 0 }),
        offers: [],
        actionIds: {}
      },
      tasks: [claim],
      descriptors: new Map([[claim.taskId, { task: claim, claimablePoints: 5 }]]),
      dataSources: {
        rsc: true,
        dom: true,
        dashboard: false,
        flyout: true,
        'app-dashboard': false
      }
    }
    vi.spyOn(RewardsDiscoveryService.prototype, 'discover').mockResolvedValue(refreshed)
    const upsertTask = vi.fn()
    const store = {
      upsertTask,
      listTaskState: vi.fn().mockReturnValue([])
    } as unknown as SqliteStore
    const config = {
      ...DEFAULT_CONFIG,
      tasks: { ...DEFAULT_CONFIG.tasks, claimBonusPoints: false }
    }
    const coordinator = authenticationCoordinator({ openSlot: vi.fn(), config, store })
    const desktop = browserSlot('web-desktop').value
    const callable = coordinator as unknown as {
      executeStage(
        stage: 'claim-bonus-points',
        context: {
          runId: string
          accountId: string
          runAccountIndex: number
          localDate: string
          signal: AbortSignal
        },
        mode: 'mutating',
        credentials: { email: string; password: string },
        resources: Record<string, unknown>
      ): Promise<{ status: string }>
    }

    await expect(
      callable.executeStage(
        'claim-bonus-points',
        {
          runId: 'synthetic-run',
          accountId: 'synthetic-account',
          runAccountIndex: 1,
          localDate: '2026-09-04',
          signal: new AbortController().signal
        },
        'mutating',
        { email: 'synthetic@example.test', password: 'synthetic-password' },
        { desktop, desktopClient: {}, discovery: refreshed }
      )
    ).resolves.toEqual({ status: 'completed' })
    expect(upsertTask).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: claim.taskId,
        executable: false,
        status: 'skipped',
        reason: '配置已禁用'
      }),
      'synthetic-run'
    )
  })
})

describe('runtime task discovery', () => {
  it('marks a hidden known App task as skipped instead of unknown', async () => {
    const hiddenCheckIn: RewardOffer = {
      ...offer('app-check-in', 'hidden-check-in'),
      executable: false,
      attributes: { type: 'checkin', hidden: 'true', give_eligible: 'true' }
    }
    const confirmed = observation()
    const client = {
      bootstrapRsc: vi.fn().mockResolvedValue({
        html: ['<html></html>'],
        offers: [],
        domOffers: [],
        availablePoints: evidence(100),
        actionIds: {}
      }),
      readClaimablePoints: vi.fn().mockResolvedValue(0)
    } as unknown as DashboardClient

    const result = await new RewardsDiscoveryService().discover({
      accountId: 'synthetic-account',
      localDate: '2026-09-04',
      client,
      initialObservation: confirmed,
      appObservation: { ...confirmed, source: 'app-dashboard', offers: [hiddenCheckIn] }
    })

    expect(result.tasks.find((task) => task.type === 'app-check-in')).toMatchObject({
      status: 'skipped',
      executable: false,
      reason: 'App 数据源标记为隐藏'
    })
  })

  it('emits all ten canonical task categories from independent data sources', async () => {
    const webOffers = [
      offer('daily-set', 'daily'),
      offer('special-promotion', 'special'),
      offer('more-promotion', 'more'),
      offer('punch-card', 'punch')
    ]
    const appOffers = [
      offer('app-activity', 'app'),
      offer('app-check-in', 'check-in'),
      offer('read-to-earn', 'read')
    ]
    const bootstrap: RscBootstrap = {
      html: ['<html></html>'],
      offers: webOffers,
      domOffers: [],
      availablePoints: evidence(100),
      actionIds: { reportActivity: 'synthetic-action' },
      routerStateTree: 'synthetic-dashboard-router-state'
    }
    const client = {
      bootstrapRsc: vi.fn().mockResolvedValue(bootstrap),
      fetchDashboard: vi.fn().mockResolvedValue(observation(webOffers)),
      fetchFlyout: vi.fn().mockResolvedValue(observation(webOffers)),
      readClaimablePoints: vi.fn().mockResolvedValue(5)
    } as unknown as DashboardClient

    const result = await new RewardsDiscoveryService().discover({
      accountId: 'synthetic-account',
      localDate: '2026-09-03',
      client,
      appObservation: { ...observation(appOffers), source: 'app-dashboard' }
    })

    expect(new Set(result.tasks.map((task) => task.type))).toEqual(
      new Set([
        'claim-bonus-points',
        'app-activity',
        'daily-set',
        'special-promotion',
        'more-promotion',
        'app-check-in',
        'read-to-earn',
        'punch-card',
        'mobile-search',
        'pc-search'
      ])
    )
    expect(result.snapshot.routerStateTree).toBe('synthetic-dashboard-router-state')
  })

  it('keeps only App-owned task types from the App Dashboard', async () => {
    const confirmed = observation()
    const appOffers = [
      offer('app-activity', 'app-owned'),
      offer('app-check-in', 'check-in-owned'),
      offer('read-to-earn', 'read-owned'),
      { ...offer('pc-search', 'app-search-noise'), source: 'app-dashboard' as const },
      { ...offer('more-promotion', 'app-urlreward-noise'), source: 'app-dashboard' as const },
      { ...offer('unknown', 'app-unknown-noise'), source: 'app-dashboard' as const }
    ]
    const rscUnknown = { ...offer('unknown', 'rsc-unknown'), source: 'rsc' as const }
    const client = {
      bootstrapRsc: vi.fn().mockResolvedValue({
        html: ['<html></html>'],
        offers: [rscUnknown],
        domOffers: [],
        availablePoints: evidence(100),
        actionIds: {}
      }),
      readClaimablePoints: vi.fn().mockResolvedValue(0)
    } as unknown as DashboardClient

    const result = await new RewardsDiscoveryService().discover({
      accountId: 'synthetic-account',
      localDate: '2026-09-04',
      client,
      initialObservation: confirmed,
      appObservation: { ...confirmed, source: 'app-dashboard', offers: appOffers }
    })

    expect(result.snapshot.offers.map((item) => item.sourceTaskId)).toEqual([
      'rsc-unknown',
      'app-owned',
      'check-in-owned',
      'read-owned'
    ])
    expect(result.tasks.find((task) => task.sourceTaskId === 'rsc-unknown')?.type).toBe('unknown')
    expect(result.tasks.some((task) => task.sourceTaskId === 'app-unknown-noise')).toBe(false)
  })

  it('runs PC and mobile searches in their matching browser contexts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rewards-next-search-context-'))
    roots.push(root)
    const store = new SqliteStore(join(root, 'state.sqlite'))
    try {
      const desktop = browserSlot('web-desktop').value
      const mobile = browserSlot('web-mobile').value
      const desktopClient = { name: 'desktop' } as unknown as DashboardClient
      const mobileClient = { name: 'mobile' } as unknown as DashboardClient
      const tasks = ['pc-search', 'mobile-search'].map((type) => ({
        taskId: `account:2026-09-04:${type}`,
        accountId: 'account',
        localDate: '2026-09-04',
        sourceTaskId: type,
        type: type as 'pc-search' | 'mobile-search',
        source: 'bing-flyout' as const,
        displayName: type,
        executable: true,
        required: type === 'pc-search',
        status: 'discovered' as const,
        progress: { completed: 0, total: 30 },
        updatedAt: '2026-09-04T00:00:00.000Z'
      }))
      const discovery: DiscoveryOutput = {
        snapshot: {
          rewardsUser: evidence(true),
          market: evidence('CN'),
          availablePoints: evidence(100),
          pcSearch: evidence({ completed: 0, total: 30, remaining: 30 }),
          mobileSearch: evidence({ completed: 0, total: 30, remaining: 30 }),
          offers: [],
          actionIds: {}
        },
        tasks,
        descriptors: new Map(tasks.map((task) => [task.taskId, { task }])),
        dataSources: {
          rsc: true,
          dom: true,
          dashboard: false,
          flyout: true,
          'app-dashboard': false
        }
      }
      const calls: Array<{
        context: BrowserContext
        client: DashboardClient
        mobile: boolean
      }> = []
      vi.spyOn(SearchExecutor.prototype, 'run').mockImplementation(function (
        this: SearchExecutor,
        input
      ) {
        const instance = this as unknown as {
          context: BrowserContext
          client: DashboardClient
        }
        calls.push({ context: instance.context, client: instance.client, mobile: input.mobile })
        return Promise.resolve({
          ...input.task,
          status: 'completed',
          progress: {
            completed: input.task.progress.total ?? 0,
            total: input.task.progress.total
          },
          updatedAt: new Date().toISOString()
        })
      })
      const coordinator = authenticationCoordinator({
        openSlot: vi.fn(),
        store,
        config: {
          ...DEFAULT_CONFIG,
          tasks: { ...DEFAULT_CONFIG.tasks, pcSearch: true, mobileSearch: true }
        }
      })
      const callable = coordinator as unknown as {
        executeStage(
          stage: 'search',
          context: {
            runId: string
            accountId: string
            runAccountIndex: number
            localDate: string
            signal: AbortSignal
          },
          mode: 'mutating',
          credentials: { email: string; password: string },
          resources: Record<string, unknown>
        ): Promise<{ status: string }>
      }

      await expect(
        callable.executeStage(
          'search',
          {
            runId: 'run',
            accountId: 'account',
            runAccountIndex: 1,
            localDate: '2026-09-04',
            signal: new AbortController().signal
          },
          'mutating',
          { email: 'synthetic@example.test', password: 'synthetic-password' },
          { desktop, mobile, desktopClient, mobileClient, discovery }
        )
      ).resolves.toEqual({ status: 'completed' })
      expect(calls).toEqual([
        { context: desktop.context, client: desktopClient, mobile: false },
        { context: mobile.context, client: mobileClient, mobile: true }
      ])
    } finally {
      store.close()
    }
  })

  it('fails an actionable mobile search instead of using the desktop context', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rewards-next-missing-mobile-context-'))
    roots.push(root)
    const store = new SqliteStore(join(root, 'state.sqlite'))
    try {
      const desktop = browserSlot('web-desktop').value
      const desktopClient = { name: 'desktop' } as unknown as DashboardClient
      const task: TaskRecord = {
        taskId: 'account:2026-09-04:mobile-search',
        accountId: 'account',
        localDate: '2026-09-04',
        sourceTaskId: 'mobile-search',
        type: 'mobile-search',
        source: 'bing-flyout',
        displayName: '移动搜索',
        executable: true,
        required: false,
        status: 'discovered',
        progress: { completed: 9, total: 30 },
        updatedAt: '2026-09-04T00:00:00.000Z'
      }
      const discovery: DiscoveryOutput = {
        snapshot: {
          rewardsUser: evidence(true),
          market: evidence('CN'),
          availablePoints: evidence(100),
          pcSearch: evidence({ completed: 60, total: 60, remaining: 0 }),
          mobileSearch: evidence({ completed: 9, total: 30, remaining: 21 }),
          offers: [],
          actionIds: {}
        },
        tasks: [task],
        descriptors: new Map([[task.taskId, { task }]]),
        dataSources: {
          rsc: true,
          dom: true,
          dashboard: false,
          flyout: true,
          'app-dashboard': false
        }
      }
      const runSearch = vi.spyOn(SearchExecutor.prototype, 'run')
      const coordinator = authenticationCoordinator({
        openSlot: vi.fn(),
        store,
        config: {
          ...DEFAULT_CONFIG,
          tasks: { ...DEFAULT_CONFIG.tasks, pcSearch: false, mobileSearch: true }
        }
      })
      const callable = coordinator as unknown as {
        executeStage(
          stage: 'search',
          context: {
            runId: string
            accountId: string
            runAccountIndex: number
            localDate: string
            signal: AbortSignal
          },
          mode: 'mutating',
          credentials: { email: string; password: string },
          resources: Record<string, unknown>
        ): Promise<{ status: string }>
      }

      await expect(
        callable.executeStage(
          'search',
          {
            runId: 'run',
            accountId: 'account',
            runAccountIndex: 1,
            localDate: '2026-09-04',
            signal: new AbortController().signal
          },
          'mutating',
          { email: 'synthetic@example.test', password: 'synthetic-password' },
          { desktop, desktopClient, discovery }
        )
      ).resolves.toMatchObject({ status: 'partial' })
      expect(runSearch).not.toHaveBeenCalled()
      expect(store.getTask(task.taskId)).toMatchObject({
        status: 'failed',
        progress: { completed: 9, total: 30 },
        reason: 'mobile-search context unavailable'
      })
    } finally {
      store.close()
    }
  })

  it('rechecks transiently unavailable Bing identity without requiring a legacy Dashboard read', async () => {
    const confirmed = observation()
    const fetchFlyout = vi.fn().mockResolvedValueOnce(undefined).mockResolvedValue(confirmed)
    const fetchDashboard = vi.fn().mockResolvedValue(confirmed)
    const client = {
      fetchFlyout,
      fetchDashboard
    } as unknown as DashboardClient
    const result = await new RewardsDiscoveryService().verifyAuthenticated(client)
    expect(result.verification.valid).toBe(true)
    expect(fetchFlyout).toHaveBeenCalledTimes(2)
    expect(fetchDashboard).not.toHaveBeenCalled()
  })

  it('falls back to the legacy Dashboard when flyout balance evidence is missing', async () => {
    const confirmed = observation()
    const incomplete = {
      ...confirmed,
      availablePoints: createEvidence<number>({
        availability: 'missing',
        source: 'bing-flyout',
        confidence: 0,
        observedAt: '2026-09-04T00:00:00.000Z',
        reason: 'synthetic missing balance'
      })
    }
    const fetchDashboard = vi.fn().mockResolvedValue(confirmed)
    const client = {
      fetchFlyout: vi.fn().mockResolvedValue(incomplete),
      fetchDashboard
    } as unknown as DashboardClient

    const result = await new RewardsDiscoveryService().verifyAuthenticated(client)

    expect(result.verification.valid).toBe(true)
    expect(fetchDashboard).toHaveBeenCalledTimes(1)
  })

  it('reuses verified evidence during discovery and avoids duplicate profile requests', async () => {
    const confirmed = observation()
    const fetchFlyout = vi.fn().mockResolvedValue(confirmed)
    const fetchDashboard = vi.fn().mockResolvedValue(confirmed)
    const discoverDomOffers = vi.fn().mockResolvedValue([])
    const client = {
      bootstrapRsc: vi.fn().mockResolvedValue({
        html: ['<html></html>'],
        offers: [],
        domOffers: [],
        availablePoints: evidence(100),
        actionIds: {}
      }),
      discoverDomOffers,
      fetchFlyout,
      fetchDashboard,
      readClaimablePoints: vi.fn().mockResolvedValue(0)
    } as unknown as DashboardClient

    const result = await new RewardsDiscoveryService().discover({
      accountId: 'synthetic-account',
      localDate: '2026-09-04',
      client,
      initialObservation: confirmed
    })

    expect(result.snapshot.availablePoints.value).toBe(100)
    expect(discoverDomOffers).not.toHaveBeenCalled()
    expect(fetchFlyout).not.toHaveBeenCalled()
    expect(fetchDashboard).not.toHaveBeenCalled()
  })

  it('marks an explicitly zero-point promotional card skipped', async () => {
    const zeroPointOffer: RewardOffer = {
      ...offer('more-promotion', 'zero-point-promotion'),
      total: 0,
      isPromotional: true
    }
    const confirmed = observation()
    const client = {
      bootstrapRsc: vi.fn().mockResolvedValue({
        html: [],
        offers: [zeroPointOffer],
        domOffers: [],
        availablePoints: evidence(100),
        actionIds: {}
      }),
      fetchFlyout: vi.fn(),
      fetchDashboard: vi.fn(),
      readClaimablePoints: vi.fn().mockResolvedValue(0)
    } as unknown as DashboardClient

    const result = await new RewardsDiscoveryService().discover({
      accountId: 'synthetic-account',
      localDate: '2026-09-04',
      client,
      initialObservation: confirmed
    })

    const task = result.tasks.find((item) => item.sourceTaskId === 'zero-point-promotion')
    expect(task).toMatchObject({
      executable: false,
      status: 'skipped',
      progress: { completed: 0, total: 0 },
      reason: '推广卡片明确标记为零积分'
    })
  })
})

describe('claim mutation idempotency', () => {
  it('keeps an interactive Quiz out of the mutation ledger and server action path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rewards-next-interactive-policy-'))
    roots.push(root)
    const store = new SqliteStore(join(root, 'state.sqlite'))
    try {
      const reward: RewardOffer = {
        ...offer('daily-set', 'interactive-offer'),
        destinationUrl: 'https://example.test/quiz',
        attributes: { promotionType: 'quiz' }
      }
      const task: TaskRecord = {
        taskId: 'account:2026-09-04:interactive-offer',
        accountId: 'account',
        localDate: '2026-09-04',
        sourceTaskId: reward.sourceTaskId,
        type: 'daily-set',
        source: 'rsc',
        displayName: 'Interactive offer',
        executable: true,
        required: true,
        status: 'discovered',
        progress: { completed: 0, total: 10 },
        updatedAt: '2026-09-04T00:00:00.000Z'
      }
      const discovery: DiscoveryOutput = {
        snapshot: {
          rewardsUser: evidence(true),
          market: evidence('CN'),
          availablePoints: evidence(100),
          pcSearch: evidence({ completed: 60, total: 60, remaining: 0 }),
          mobileSearch: evidence({ completed: 0, total: 30, remaining: 30 }),
          offers: [reward],
          actionIds: { reportActivity: 'synthetic-action' }
        },
        tasks: [task],
        descriptors: new Map([[task.taskId, { task, offer: reward }]]),
        dataSources: {
          rsc: true,
          dom: false,
          dashboard: false,
          flyout: false,
          'app-dashboard': false
        }
      }
      const navigateOffer = vi.fn()
      const reportServerAction = vi.fn()
      const executor = new RewardsTaskExecutor(
        {} as BrowserContext,
        { navigateOffer, reportServerAction } as unknown as DashboardClient,
        store,
        { write: vi.fn().mockResolvedValue(undefined) } as unknown as StructuredLogger,
        DEFAULT_CONFIG,
        'run',
        'account-1'
      )

      await expect(
        executor.executeTypes({
          discovery,
          types: ['daily-set'],
          mode: 'mutating',
          signal: new AbortController().signal
        })
      ).resolves.toMatchObject({ status: 'partial' })

      expect(store.getMutationState(task.taskId)).toBeUndefined()
      expect(store.getTask(task.taskId)).toMatchObject({
        executable: false,
        status: 'unknown',
        reason: '交互式 Quiz 尚未实现，禁止作为普通活动提交'
      })
      expect(navigateOffer).not.toHaveBeenCalled()
      expect(reportServerAction).not.toHaveBeenCalled()
    } finally {
      store.close()
    }
  })

  it('uses an official card for a flyout offer and never sends its hash to reportActivity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rewards-next-flyout-navigation-'))
    roots.push(root)
    const store = new SqliteStore(join(root, 'state.sqlite'))
    try {
      const reward: RewardOffer = {
        ...offer('daily-set', 'flyout-offer'),
        source: 'bing-flyout',
        destinationUrl: 'https://example.test/reward'
      }
      const completedReward: RewardOffer = {
        ...reward,
        completed: 10,
        total: 10,
        complete: true
      }
      const task: TaskRecord = {
        taskId: 'account:2026-09-04:flyout-offer',
        accountId: 'account',
        localDate: '2026-09-04',
        sourceTaskId: reward.sourceTaskId,
        type: 'daily-set',
        source: 'bing-flyout',
        displayName: 'Flyout offer',
        executable: true,
        required: true,
        status: 'discovered',
        progress: { completed: 0, total: 10 },
        updatedAt: '2026-09-04T00:00:00.000Z'
      }
      const discovery: DiscoveryOutput = {
        snapshot: {
          rewardsUser: evidence(true),
          market: evidence('CN'),
          availablePoints: evidence(100),
          pcSearch: evidence({ completed: 60, total: 60, remaining: 0 }),
          mobileSearch: evidence({ completed: 0, total: 30, remaining: 30 }),
          offers: [reward],
          actionIds: { reportActivity: 'synthetic-action' }
        },
        tasks: [task],
        descriptors: new Map([[task.taskId, { task, offer: reward }]]),
        dataSources: {
          rsc: false,
          dom: false,
          dashboard: false,
          flyout: true,
          'app-dashboard': false
        }
      }
      const navigateOffer = vi.fn().mockResolvedValue(undefined)
      const reportServerAction = vi.fn()
      const fetchFlyout = vi.fn().mockResolvedValue(observation([completedReward]))
      const executor = new RewardsTaskExecutor(
        {} as BrowserContext,
        { navigateOffer, reportServerAction, fetchFlyout } as unknown as DashboardClient,
        store,
        { write: vi.fn().mockResolvedValue(undefined) } as unknown as StructuredLogger,
        DEFAULT_CONFIG,
        'run',
        'account-1'
      )

      await expect(
        executor.executeTypes({
          discovery,
          types: ['daily-set'],
          mode: 'mutating',
          signal: new AbortController().signal
        })
      ).resolves.toMatchObject({ status: 'completed' })

      expect(navigateOffer).toHaveBeenCalledTimes(1)
      expect(reportServerAction).not.toHaveBeenCalled()
      expect(fetchFlyout).toHaveBeenCalledTimes(1)
      expect(store.getTask(task.taskId)).toMatchObject({
        status: 'completed',
        progress: { completed: 10, total: 10 }
      })
    } finally {
      store.close()
    }
  })

  it('continues after an optional offer was not started and completes the next required offer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rewards-next-optional-not-started-'))
    roots.push(root)
    const store = new SqliteStore(join(root, 'state.sqlite'))
    try {
      const optionalOffer: RewardOffer = {
        ...offer('more-promotion', 'optional-offer'),
        source: 'bing-flyout',
        destinationUrl: 'https://example.test/optional'
      }
      const requiredOffer: RewardOffer = {
        ...offer('daily-set', 'required-offer'),
        source: 'bing-flyout',
        destinationUrl: 'https://example.test/required'
      }
      const makeTask = (reward: RewardOffer, required: boolean): TaskRecord => ({
        taskId: `account:2026-09-04:${reward.sourceTaskId}`,
        accountId: 'account',
        localDate: '2026-09-04',
        sourceTaskId: reward.sourceTaskId,
        type: reward.type,
        source: reward.source,
        displayName: reward.displayName,
        executable: true,
        required,
        status: 'discovered',
        progress: { completed: 0, total: 1 },
        updatedAt: '2026-09-04T00:00:00.000Z'
      })
      const optionalTask = makeTask(optionalOffer, false)
      const requiredTask = makeTask(requiredOffer, true)
      const discovery: DiscoveryOutput = {
        snapshot: {
          rewardsUser: evidence(true),
          market: evidence('CN'),
          availablePoints: evidence(100),
          pcSearch: evidence({ completed: 60, total: 60, remaining: 0 }),
          mobileSearch: evidence({ completed: 0, total: 30, remaining: 30 }),
          offers: [optionalOffer, requiredOffer],
          actionIds: {}
        },
        tasks: [optionalTask, requiredTask],
        descriptors: new Map([
          [optionalTask.taskId, { task: optionalTask, offer: optionalOffer }],
          [requiredTask.taskId, { task: requiredTask, offer: requiredOffer }]
        ]),
        dataSources: {
          rsc: false,
          dom: false,
          dashboard: false,
          flyout: true,
          'app-dashboard': false
        }
      }
      const navigateOffer = vi
        .fn()
        .mockRejectedValueOnce(new MutationNotStartedError('Synthetic link missing'))
        .mockResolvedValueOnce(undefined)
      const client = {
        navigateOffer,
        fetchFlyout: vi
          .fn()
          .mockResolvedValue(observation([{ ...requiredOffer, complete: true, completed: 1 }]))
      } as unknown as DashboardClient
      const executor = new RewardsTaskExecutor(
        {} as BrowserContext,
        client,
        store,
        { write: vi.fn().mockResolvedValue(undefined) } as unknown as StructuredLogger,
        DEFAULT_CONFIG,
        'run',
        'account-1'
      )

      await expect(
        executor.executeTypes({
          discovery,
          types: ['more-promotion', 'daily-set'],
          mode: 'mutating',
          signal: new AbortController().signal
        })
      ).resolves.toMatchObject({ status: 'partial' })
      expect(navigateOffer).toHaveBeenCalledTimes(2)
      expect(store.getMutationState(optionalTask.taskId)).toBeUndefined()
      expect(store.getTask(optionalTask.taskId)).toMatchObject({ status: 'failed' })
      expect(store.getTask(requiredTask.taskId)).toMatchObject({ status: 'completed' })
    } finally {
      store.close()
    }
  })

  it('stops after a required offer was not started', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rewards-next-required-not-started-'))
    roots.push(root)
    const store = new SqliteStore(join(root, 'state.sqlite'))
    try {
      const requiredOffer: RewardOffer = {
        ...offer('daily-set', 'required-first'),
        source: 'bing-flyout',
        destinationUrl: 'https://example.test/required'
      }
      const optionalOffer: RewardOffer = {
        ...offer('more-promotion', 'optional-second'),
        source: 'bing-flyout',
        destinationUrl: 'https://example.test/optional'
      }
      const makeTask = (reward: RewardOffer, required: boolean): TaskRecord => ({
        taskId: `account:2026-09-04:${reward.sourceTaskId}`,
        accountId: 'account',
        localDate: '2026-09-04',
        sourceTaskId: reward.sourceTaskId,
        type: reward.type,
        source: reward.source,
        displayName: reward.displayName,
        executable: true,
        required,
        status: 'discovered',
        progress: { completed: 0, total: 1 },
        updatedAt: '2026-09-04T00:00:00.000Z'
      })
      const requiredTask = makeTask(requiredOffer, true)
      const optionalTask = makeTask(optionalOffer, false)
      const discovery: DiscoveryOutput = {
        snapshot: {
          rewardsUser: evidence(true),
          market: evidence('CN'),
          availablePoints: evidence(100),
          pcSearch: evidence({ completed: 60, total: 60, remaining: 0 }),
          mobileSearch: evidence({ completed: 0, total: 30, remaining: 30 }),
          offers: [requiredOffer, optionalOffer],
          actionIds: {}
        },
        tasks: [requiredTask, optionalTask],
        descriptors: new Map([
          [requiredTask.taskId, { task: requiredTask, offer: requiredOffer }],
          [optionalTask.taskId, { task: optionalTask, offer: optionalOffer }]
        ]),
        dataSources: {
          rsc: false,
          dom: false,
          dashboard: false,
          flyout: true,
          'app-dashboard': false
        }
      }
      const navigateOffer = vi
        .fn()
        .mockRejectedValueOnce(new MutationNotStartedError('Synthetic link missing'))
      const executor = new RewardsTaskExecutor(
        {} as BrowserContext,
        { navigateOffer } as unknown as DashboardClient,
        store,
        { write: vi.fn().mockResolvedValue(undefined) } as unknown as StructuredLogger,
        DEFAULT_CONFIG,
        'run',
        'account-1'
      )

      await expect(
        executor.executeTypes({
          discovery,
          types: ['daily-set', 'more-promotion'],
          mode: 'mutating',
          signal: new AbortController().signal
        })
      ).resolves.toMatchObject({ status: 'failed' })
      expect(navigateOffer).toHaveBeenCalledTimes(1)
      expect(store.getMutationState(requiredTask.taskId)).toBeUndefined()
      expect(store.getTask(requiredTask.taskId)).toMatchObject({ status: 'failed' })
      expect(store.getTask(optionalTask.taskId)).toBeUndefined()
    } finally {
      store.close()
    }
  })

  it('reconciles known web mutations from one discovery snapshot without resubmitting or refetching', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rewards-next-batch-reconcile-'))
    roots.push(root)
    const store = new SqliteStore(join(root, 'state.sqlite'))
    try {
      const completedOffer: RewardOffer = {
        ...offer('more-promotion', 'completed-offer'),
        completed: 10,
        total: 10,
        complete: true
      }
      const pendingOffer: RewardOffer = {
        ...offer('more-promotion', 'pending-offer'),
        completed: 0,
        total: 10,
        complete: false
      }
      const completedTask: TaskRecord = {
        taskId: 'account:2026-09-04:completed-offer',
        accountId: 'account',
        localDate: '2026-09-04',
        sourceTaskId: completedOffer.sourceTaskId,
        type: 'more-promotion',
        source: 'rsc',
        displayName: 'Completed offer',
        executable: true,
        required: false,
        status: 'completed',
        progress: { completed: 10, total: 10 },
        updatedAt: '2026-09-04T00:00:00.000Z'
      }
      const pendingTask: TaskRecord = {
        taskId: 'account:2026-09-04:pending-offer',
        accountId: 'account',
        localDate: '2026-09-04',
        sourceTaskId: pendingOffer.sourceTaskId,
        type: 'more-promotion',
        source: 'rsc',
        displayName: 'Pending offer',
        executable: true,
        required: false,
        status: 'discovered',
        progress: { completed: 0, total: 10 },
        updatedAt: '2026-09-04T00:00:00.000Z'
      }
      const tasks = [completedTask, pendingTask]
      for (const task of tasks) {
        expect(store.beginMutation(task.taskId)).toBe(true)
        store.updateMutation(task.taskId, 'verification-pending')
      }
      const bootstrapRsc = vi.fn()
      const reportServerAction = vi.fn()
      const navigateOffer = vi.fn()
      const discovery: DiscoveryOutput = {
        snapshot: {
          rewardsUser: evidence(true),
          market: evidence('CN'),
          availablePoints: evidence(100),
          pcSearch: evidence({ completed: 60, total: 60, remaining: 0 }),
          mobileSearch: evidence({ completed: 0, total: 30, remaining: 30 }),
          offers: [completedOffer, pendingOffer],
          actionIds: { reportActivity: 'synthetic-action' }
        },
        tasks,
        descriptors: new Map([
          [completedTask.taskId, { task: completedTask, offer: completedOffer }],
          [pendingTask.taskId, { task: pendingTask, offer: pendingOffer }]
        ]),
        dataSources: {
          rsc: true,
          dom: false,
          dashboard: false,
          flyout: false,
          'app-dashboard': false
        }
      }
      const executor = new RewardsTaskExecutor(
        {} as BrowserContext,
        { bootstrapRsc, reportServerAction, navigateOffer } as unknown as DashboardClient,
        store,
        { write: vi.fn().mockResolvedValue(undefined) } as unknown as StructuredLogger,
        DEFAULT_CONFIG,
        'run',
        'account-1'
      )

      await expect(
        executor.executeTypes({
          discovery,
          types: ['more-promotion'],
          mode: 'mutating',
          signal: new AbortController().signal
        })
      ).resolves.toMatchObject({ status: 'partial' })

      expect(store.getMutationState(completedTask.taskId)).toBe('verified')
      expect(store.getMutationState(pendingTask.taskId)).toBe('verification-pending')
      expect(store.getTask(completedTask.taskId)).toMatchObject({ status: 'completed' })
      expect(store.getTask(pendingTask.taskId)).toMatchObject({
        status: 'verification-pending',
        progress: { completed: 0, total: 10 }
      })
      expect(bootstrapRsc).not.toHaveBeenCalled()
      expect(reportServerAction).not.toHaveBeenCalled()
      expect(navigateOffer).not.toHaveBeenCalled()
    } finally {
      store.close()
    }
  })

  it('marks a pending claim verified from a read-only zero-claim discovery result', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rewards-next-claim-reconcile-'))
    roots.push(root)
    const store = new SqliteStore(join(root, 'state.sqlite'))
    try {
      const task: TaskRecord = {
        taskId: 'account:2026-09-04:claim-bonus-points',
        accountId: 'account',
        localDate: '2026-09-04',
        sourceTaskId: 'claim-bonus-points',
        type: 'claim-bonus-points',
        source: 'rsc',
        displayName: '领取奖励积分',
        executable: false,
        required: true,
        status: 'skipped',
        progress: { completed: 1, total: 1 },
        updatedAt: '2026-09-04T00:00:00.000Z'
      }
      expect(store.beginMutation(task.taskId)).toBe(true)
      store.updateMutation(task.taskId, 'verification-pending')
      const claimBonusByUi = vi.fn()
      const reportServerAction = vi.fn()
      const discovery: DiscoveryOutput = {
        snapshot: {
          rewardsUser: evidence(true),
          market: evidence('CN'),
          availablePoints: evidence(100),
          pcSearch: evidence({ completed: 60, total: 60, remaining: 0 }),
          mobileSearch: evidence({ completed: 0, total: 30, remaining: 30 }),
          offers: [],
          actionIds: {}
        },
        tasks: [task],
        descriptors: new Map([[task.taskId, { task, claimablePoints: 0 }]]),
        dataSources: {
          rsc: true,
          dom: false,
          dashboard: false,
          flyout: false,
          'app-dashboard': false
        }
      }
      const executor = new RewardsTaskExecutor(
        {} as BrowserContext,
        { claimBonusByUi, reportServerAction } as unknown as DashboardClient,
        store,
        { write: vi.fn().mockResolvedValue(undefined) } as unknown as StructuredLogger,
        DEFAULT_CONFIG,
        'run',
        'account-1'
      )

      await expect(
        executor.executeTypes({
          discovery,
          types: ['claim-bonus-points'],
          mode: 'read-only',
          signal: new AbortController().signal
        })
      ).resolves.toMatchObject({ status: 'completed' })

      expect(store.getMutationState(task.taskId)).toBe('verified')
      expect(store.getTask(task.taskId)).toMatchObject({
        status: 'skipped',
        progress: { completed: 1, total: 1 }
      })
      expect(claimBonusByUi).not.toHaveBeenCalled()
      expect(reportServerAction).not.toHaveBeenCalled()
    } finally {
      store.close()
    }
  })

  it('does not submit claim twice while balance verification is pending', async () => {
    vi.useFakeTimers()
    const root = await mkdtemp(join(tmpdir(), 'rewards-next-runtime-'))
    roots.push(root)
    const store = new SqliteStore(join(root, 'state.sqlite'))
    try {
      const task: TaskRecord = {
        taskId: 'account:date:claim',
        accountId: 'account',
        localDate: '2026-09-03',
        sourceTaskId: 'claim-bonus-points',
        type: 'claim-bonus-points',
        source: 'rsc',
        displayName: '领取奖励积分',
        executable: true,
        required: true,
        status: 'discovered',
        progress: { completed: 0, total: 1 },
        updatedAt: '2026-09-03T00:00:00.000Z'
      }
      const snapshot: RewardsDiscoverySnapshot = {
        rewardsUser: evidence(true),
        market: evidence('CN'),
        availablePoints: evidence(100),
        pcSearch: evidence({ completed: 60, total: 60, remaining: 0 }),
        mobileSearch: evidence({ completed: 0, total: 30, remaining: 30 }),
        offers: [],
        actionIds: { reportClaimAllPoints: 'synthetic-claim-action' }
      }
      const discovery: DiscoveryOutput = {
        snapshot,
        tasks: [task],
        descriptors: new Map([[task.taskId, { task, claimablePoints: 5 }]]),
        dataSources: {
          rsc: true,
          dom: true,
          dashboard: true,
          flyout: true,
          'app-dashboard': false
        }
      }
      const reportServerAction = vi
        .fn<DashboardClient['reportServerAction']>()
        .mockResolvedValue({ status: 200, acknowledged: true })
      const claimBonusByUi = vi.fn().mockResolvedValue(false)
      const client = {
        reportServerAction,
        claimBonusByUi,
        readClaimablePoints: vi.fn().mockResolvedValue(undefined)
      } as unknown as DashboardClient
      const executor = new RewardsTaskExecutor(
        {} as BrowserContext,
        client,
        store,
        { write: vi.fn().mockResolvedValue(undefined) } as unknown as StructuredLogger,
        DEFAULT_CONFIG,
        'run',
        'account-1'
      )
      const input = {
        discovery,
        types: ['claim-bonus-points'] as const,
        mode: 'mutating' as const,
        signal: new AbortController().signal
      }

      const first = executor.executeTypes(input)
      await vi.runAllTimersAsync()
      expect((await first).status).toBe('partial')
      const second = executor.executeTypes(input)
      await vi.runAllTimersAsync()
      expect((await second).status).toBe('partial')
      expect(reportServerAction).toHaveBeenCalledTimes(1)
      expect(claimBonusByUi).not.toHaveBeenCalled()
      const claimAction = reportServerAction.mock.calls[0]?.[0]
      expect(claimAction?.url).toBe('https://rewards.bing.com/earn')
      expect(claimAction?.referer).toBe('https://rewards.bing.com/earn')
      expect(claimAction?.routerStateTree).toEqual(expect.any(String))
      expect(store.getTask(task.taskId)).toMatchObject({ status: 'verification-pending' })
    } finally {
      store.close()
    }
  })

  it('prefers one positive UI claim control and verifies it without a server action', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rewards-next-ui-claim-'))
    roots.push(root)
    const store = new SqliteStore(join(root, 'state.sqlite'))
    try {
      const task: TaskRecord = {
        taskId: 'account:date:claim-ui',
        accountId: 'account',
        localDate: '2026-09-03',
        sourceTaskId: 'claim-bonus-points',
        type: 'claim-bonus-points',
        source: 'rsc',
        displayName: '领取奖励积分',
        executable: true,
        required: true,
        status: 'discovered',
        progress: { completed: 0, total: 1 },
        updatedAt: '2026-09-03T00:00:00.000Z'
      }
      const discovery: DiscoveryOutput = {
        snapshot: {
          rewardsUser: evidence(true),
          market: evidence('CN'),
          availablePoints: evidence(100),
          pcSearch: evidence({ completed: 60, total: 60, remaining: 0 }),
          mobileSearch: evidence({ completed: 0, total: 30, remaining: 30 }),
          offers: [],
          actionIds: {}
        },
        tasks: [task],
        descriptors: new Map([[task.taskId, { task, claimablePoints: 3 }]]),
        dataSources: {
          rsc: true,
          dom: true,
          dashboard: true,
          flyout: true,
          'app-dashboard': false
        }
      }
      const reportServerAction = vi.fn<DashboardClient['reportServerAction']>()
      const claimBonusByUiWithResult = vi.fn().mockResolvedValue({
        clicked: true,
        acknowledged: true,
        status: 200
      })
      const executor = new RewardsTaskExecutor(
        {} as BrowserContext,
        {
          reportServerAction,
          claimBonusByUiWithResult,
          readClaimablePoints: vi.fn().mockResolvedValue(0)
        } as unknown as DashboardClient,
        store,
        { write: vi.fn().mockResolvedValue(undefined) } as unknown as StructuredLogger,
        DEFAULT_CONFIG,
        'run',
        'account-1'
      )

      await expect(
        executor.executeTypes({
          discovery,
          types: ['claim-bonus-points'],
          mode: 'mutating',
          signal: new AbortController().signal
        })
      ).resolves.toMatchObject({ status: 'completed' })
      expect(claimBonusByUiWithResult).toHaveBeenCalledTimes(1)
      expect(reportServerAction).not.toHaveBeenCalled()
      expect(store.getTask(task.taskId)).toMatchObject({
        status: 'completed',
        progress: { completed: 1, total: 1 }
      })
    } finally {
      store.close()
    }
  })

  it('routes quest child activity through its quest URL and dynamic router tree', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rewards-next-quest-'))
    roots.push(root)
    const store = new SqliteStore(join(root, 'state.sqlite'))
    try {
      const reward = {
        ...offer('punch-card', 'child'),
        parentOfferId: 'parent-quest'
      }
      const task: TaskRecord = {
        taskId: 'account:date:quest-child',
        accountId: 'account',
        localDate: '2026-09-03',
        sourceTaskId: reward.sourceTaskId,
        type: 'punch-card',
        source: 'rsc',
        displayName: 'Synthetic quest child',
        executable: true,
        required: false,
        status: 'discovered',
        progress: { completed: 0, total: 1 },
        updatedAt: '2026-09-03T00:00:00.000Z'
      }
      const snapshot: RewardsDiscoverySnapshot = {
        rewardsUser: evidence(true),
        market: evidence('CN'),
        availablePoints: evidence(100),
        pcSearch: evidence({ completed: 60, total: 60, remaining: 0 }),
        mobileSearch: evidence({ completed: 30, total: 30, remaining: 0 }),
        offers: [reward],
        actionIds: { reportActivity: 'synthetic-activity-action' },
        routerStateTree: 'synthetic-dashboard-router-state'
      }
      const discovery: DiscoveryOutput = {
        snapshot,
        tasks: [task],
        descriptors: new Map([[task.taskId, { task, offer: reward }]]),
        dataSources: {
          rsc: true,
          dom: true,
          dashboard: true,
          flyout: true,
          'app-dashboard': false
        }
      }
      const reportServerAction = vi
        .fn<DashboardClient['reportServerAction']>()
        .mockResolvedValue({ status: 200, acknowledged: true })
      const client = {
        reportServerAction,
        bootstrapRsc: vi.fn().mockResolvedValue({
          html: [],
          offers: [{ ...reward, complete: true, completed: 1 }],
          availablePoints: evidence(100),
          actionIds: {}
        })
      } as unknown as DashboardClient
      const executor = new RewardsTaskExecutor(
        {} as BrowserContext,
        client,
        store,
        { write: vi.fn().mockResolvedValue(undefined) } as unknown as StructuredLogger,
        DEFAULT_CONFIG,
        'run',
        'account-1'
      )

      await expect(
        executor.executeTypes({
          discovery,
          types: ['punch-card'],
          mode: 'mutating',
          signal: new AbortController().signal
        })
      ).resolves.toMatchObject({ status: 'completed' })
      expect(reportServerAction).toHaveBeenCalledTimes(1)
      const action = reportServerAction.mock.calls[0]?.[0]
      expect(action?.url).toBe('https://rewards.bing.com/earn/quest/parent-quest')
      expect(action?.referer).toBe(action?.url)
      expect(decodeURIComponent(action?.routerStateTree ?? '')).toContain('parent-quest')
    } finally {
      store.close()
    }
  })
})

describe('App task execution', () => {
  it('stops Read to Earn after one unconfirmed submission and preserves point progress', async () => {
    vi.useFakeTimers()
    const root = await mkdtemp(join(tmpdir(), 'rewards-next-read-to-earn-'))
    roots.push(root)
    const store = new SqliteStore(join(root, 'state.sqlite'))
    try {
      const appOffer: RewardOffer = {
        ...offer('read-to-earn', 'synthetic-read'),
        completed: 0,
        total: 30,
        complete: false,
        attributes: {
          offerid: 'synthetic-read',
          type: 'msnreadearn',
          pointprogress: '0',
          pointmax: '30'
        }
      }
      const task: TaskRecord = {
        taskId: 'account:date:read',
        accountId: 'account',
        localDate: '2026-09-04',
        sourceTaskId: appOffer.sourceTaskId,
        type: 'read-to-earn',
        source: 'app-dashboard',
        displayName: 'Synthetic read task',
        executable: true,
        required: false,
        status: 'discovered',
        progress: { completed: 0, total: 30 },
        updatedAt: '2026-09-04T00:00:00.000Z'
      }
      const snapshot: RewardsDiscoverySnapshot = {
        rewardsUser: evidence(true),
        market: evidence('CN'),
        availablePoints: evidence(100),
        pcSearch: evidence({ completed: 60, total: 60, remaining: 0 }),
        mobileSearch: evidence({ completed: 0, total: 0, remaining: 0 }),
        offers: [appOffer],
        actionIds: {}
      }
      const discovery: DiscoveryOutput = {
        snapshot,
        tasks: [task],
        descriptors: new Map([[task.taskId, { task, offer: appOffer }]]),
        dataSources: {
          rsc: false,
          dom: false,
          dashboard: false,
          flyout: false,
          'app-dashboard': true
        }
      }
      const submitAppActivity = vi.fn().mockResolvedValue(5088)
      const fetchAppDashboard = vi.fn().mockResolvedValue({
        ...observation([appOffer]),
        source: 'app-dashboard'
      })
      const executor = new RewardsTaskExecutor(
        {} as BrowserContext,
        { submitAppActivity, fetchAppDashboard } as unknown as DashboardClient,
        store,
        { write: vi.fn().mockResolvedValue(undefined) } as unknown as StructuredLogger,
        DEFAULT_CONFIG,
        'run',
        'account-1',
        'synthetic-token'
      )

      const execution = executor.executeTypes({
        discovery,
        types: ['read-to-earn'],
        mode: 'mutating',
        signal: new AbortController().signal
      })
      await vi.runAllTimersAsync()

      await expect(execution).resolves.toMatchObject({ status: 'partial' })
      expect(submitAppActivity).toHaveBeenCalledTimes(1)
      expect(store.ledger.taskEvidence('run')).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ taskId: task.taskId, balance: 5088, confirmedPoints: null })
        ])
      )
      expect(store.ledger.balances('run')).toEqual(
        expect.arrayContaining([expect.objectContaining({ balance: 5088, phase: 'live' })])
      )
      expect(fetchAppDashboard).toHaveBeenCalledTimes(1)
      expect(store.getTask(task.taskId)).toMatchObject({
        status: 'verification-pending',
        progress: { completed: 0, total: 30 }
      })
    } finally {
      store.close()
    }
  })

  it('reconciles an existing pending Read to Earn mutation without resubmitting it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rewards-next-read-pending-'))
    roots.push(root)
    const store = new SqliteStore(join(root, 'state.sqlite'))
    try {
      const appOffer: RewardOffer = {
        ...offer('read-to-earn', 'synthetic-read-pending'),
        completed: 30,
        total: 30,
        complete: true,
        attributes: {
          offerid: 'synthetic-read-pending',
          type: 'msnreadearn',
          pointprogress: '30',
          pointmax: '30'
        }
      }
      const task: TaskRecord = {
        taskId: 'account:date:read-pending',
        accountId: 'account',
        localDate: '2026-09-04',
        sourceTaskId: appOffer.sourceTaskId,
        type: 'read-to-earn',
        source: 'app-dashboard',
        displayName: 'Synthetic pending read task',
        executable: true,
        required: false,
        status: 'verification-pending',
        progress: { completed: 0, total: 30 },
        updatedAt: '2026-09-04T00:00:00.000Z'
      }
      const snapshot: RewardsDiscoverySnapshot = {
        rewardsUser: evidence(true),
        market: evidence('CN'),
        availablePoints: evidence(100),
        pcSearch: evidence({ completed: 60, total: 60, remaining: 0 }),
        mobileSearch: evidence({ completed: 0, total: 0, remaining: 0 }),
        offers: [appOffer],
        actionIds: {}
      }
      const discovery: DiscoveryOutput = {
        snapshot,
        tasks: [task],
        descriptors: new Map([[task.taskId, { task, offer: appOffer }]]),
        dataSources: {
          rsc: false,
          dom: false,
          dashboard: false,
          flyout: false,
          'app-dashboard': true
        }
      }
      const ledgerId = `${task.taskId}:article:1`
      expect(store.beginMutation(ledgerId)).toBe(true)
      store.updateMutation(ledgerId, 'verification-pending')
      const submitAppActivity = vi.fn().mockResolvedValue(undefined)
      const fetchAppDashboard = vi.fn().mockResolvedValue({
        ...observation([appOffer]),
        source: 'app-dashboard'
      })
      const executor = new RewardsTaskExecutor(
        {} as BrowserContext,
        { submitAppActivity, fetchAppDashboard } as unknown as DashboardClient,
        store,
        { write: vi.fn().mockResolvedValue(undefined) } as unknown as StructuredLogger,
        DEFAULT_CONFIG,
        'run',
        'account-1',
        'synthetic-token'
      )

      await expect(
        executor.executeTypes({
          discovery,
          types: ['read-to-earn'],
          mode: 'mutating',
          signal: new AbortController().signal
        })
      ).resolves.toMatchObject({ status: 'completed' })
      expect(submitAppActivity).not.toHaveBeenCalled()
      expect(fetchAppDashboard).toHaveBeenCalledTimes(1)
      expect(store.getMutationState(ledgerId)).toBe('verified')
      expect(store.getTask(task.taskId)).toMatchObject({
        status: 'completed',
        progress: { completed: 30, total: 30 }
      })
    } finally {
      store.close()
    }
  })

  it('caps Read to Earn at ten confirmed submissions and preserves the last progress', async () => {
    vi.useFakeTimers()
    const root = await mkdtemp(join(tmpdir(), 'rewards-next-read-limit-'))
    roots.push(root)
    const store = new SqliteStore(join(root, 'state.sqlite'))
    try {
      const appOffer: RewardOffer = {
        ...offer('read-to-earn', 'synthetic-read-limit'),
        completed: 0,
        total: 33,
        complete: false,
        attributes: {
          offerid: 'synthetic-read-limit',
          type: 'msnreadearn',
          pointprogress: '0',
          pointmax: '33'
        }
      }
      const task: TaskRecord = {
        taskId: 'account:date:read-limit',
        accountId: 'account',
        localDate: '2026-09-04',
        sourceTaskId: appOffer.sourceTaskId,
        type: 'read-to-earn',
        source: 'app-dashboard',
        displayName: 'Synthetic limited read task',
        executable: true,
        required: false,
        status: 'discovered',
        progress: { completed: 0, total: 33 },
        updatedAt: '2026-09-04T00:00:00.000Z'
      }
      const snapshot: RewardsDiscoverySnapshot = {
        rewardsUser: evidence(true),
        market: evidence('CN'),
        availablePoints: evidence(100),
        pcSearch: evidence({ completed: 60, total: 60, remaining: 0 }),
        mobileSearch: evidence({ completed: 0, total: 0, remaining: 0 }),
        offers: [appOffer],
        actionIds: {}
      }
      const discovery: DiscoveryOutput = {
        snapshot,
        tasks: [task],
        descriptors: new Map([[task.taskId, { task, offer: appOffer }]]),
        dataSources: {
          rsc: false,
          dom: false,
          dashboard: false,
          flyout: false,
          'app-dashboard': true
        }
      }
      const submitAppActivity = vi.fn().mockResolvedValue(undefined)
      let dashboardReadCount = 0
      const fetchAppDashboard = vi.fn().mockImplementation(() => {
        dashboardReadCount += 1
        const completed = dashboardReadCount * 3
        const currentOffer = {
          ...appOffer,
          completed,
          attributes: {
            ...appOffer.attributes,
            pointprogress: String(completed)
          }
        }
        return Promise.resolve({ ...observation([currentOffer]), source: 'app-dashboard' })
      })
      const executor = new RewardsTaskExecutor(
        {} as BrowserContext,
        { submitAppActivity, fetchAppDashboard } as unknown as DashboardClient,
        store,
        { write: vi.fn().mockResolvedValue(undefined) } as unknown as StructuredLogger,
        DEFAULT_CONFIG,
        'run',
        'account-1',
        'synthetic-token'
      )

      const execution = executor.executeTypes({
        discovery,
        types: ['read-to-earn'],
        mode: 'mutating',
        signal: new AbortController().signal
      })
      await vi.runAllTimersAsync()

      await expect(execution).resolves.toMatchObject({ status: 'partial' })
      expect(submitAppActivity).toHaveBeenCalledTimes(10)
      expect(fetchAppDashboard).toHaveBeenCalledTimes(10)
      expect(store.getTask(task.taskId)).toMatchObject({
        status: 'verification-pending',
        progress: { completed: 30, total: 33 }
      })
    } finally {
      store.close()
    }
  })
})

describe('App OAuth transport', () => {
  it('exchanges a synthetic callback without logging authorization codes or tokens', async () => {
    const code = 'synthetic-oauth-code-canary'
    const accessToken = 'synthetic-access-token-canary'
    const refreshToken = 'synthetic-refresh-token-canary'
    const apiGet = vi.fn().mockResolvedValue({
      url: () => `https://login.live.com/oauth20_desktop.srf?code=${code}&state=synthetic`,
      dispose: () => Promise.resolve()
    })
    const apiPost = vi.fn().mockResolvedValue({
      ok: () => true,
      status: () => 200,
      json: () =>
        Promise.resolve({
          access_token: accessToken,
          refresh_token: refreshToken,
          expires_in: 3600
        }),
      dispose: () => Promise.resolve()
    })
    const loggerWrite = vi.fn().mockResolvedValue(undefined)
    const commitVerified = vi.fn().mockResolvedValue(undefined)
    const sessions = {
      read: vi.fn().mockResolvedValue(undefined),
      commitVerified
    } as unknown as EncryptedSessionStore
    const client = new AppOAuthClient(
      { request: { get: apiGet, post: apiPost } } as unknown as BrowserContext,
      {} as Page,
      sessions,
      { write: loggerWrite } as unknown as StructuredLogger,
      {} as never,
      'run',
      'account-1'
    )

    const token = await client.acquire(
      'account',
      { email: 'synthetic@example.test', password: 'synthetic-password' },
      new AbortController().signal
    )
    await client.commitVerified('account', token)

    expect(apiPost).toHaveBeenCalledTimes(1)
    expect(commitVerified).toHaveBeenCalledTimes(1)
    const logOutput = JSON.stringify(loggerWrite.mock.calls)
    expect(logOutput).not.toContain(code)
    expect(logOutput).not.toContain(accessToken)
    expect(logOutput).not.toContain(refreshToken)
  })
})

describe('application run selection', () => {
  const accounts: AccountSummary[] = [1, 2, 3].map((runAccountIndex) => ({
    accountId: `account-${String(runAccountIndex)}`,
    runAccountIndex,
    displayAlias: `Account ${String(runAccountIndex)}`,
    maskedEmail: `a***${String(runAccountIndex)}@example.test`,
    enabled: true
  }))

  function coordinator(completedIndexes: readonly number[]) {
    const close = vi.fn().mockResolvedValue(undefined)
    const accountStore = {
      list: () => accounts,
      getCredentials: () => undefined
    } as unknown as AccountSecretStore
    const stateStore = {
      createRun: vi.fn(),
      updateRun: vi.fn(),
      isAccountCompleteForDate: (accountId: string) =>
        completedIndexes.includes(Number(accountId.split('-').at(-1)))
    } as unknown as SqliteStore
    const runner = new ApplicationRunCoordinator(
      accountStore,
      stateStore,
      {} as EncryptedSessionStore,
      { close } as unknown as BrowserRuntime,
      {} as StructuredLogger,
      DEFAULT_CONFIG
    )
    return { runner, close }
  }

  it('continue selects every incomplete account while account mode ignores checkpoints', async () => {
    const first = coordinator([1])
    await expect(first.runner.start({ accountMode: 'continue' })).resolves.toMatchObject({
      selectedAccountIndexes: [2, 3]
    })
    await vi.waitFor(() => {
      expect(first.close).toHaveBeenCalled()
    })

    const second = coordinator([1, 2, 3])
    await expect(
      second.runner.start({ accountMode: 'account', runAccountIndex: 1 })
    ).resolves.toMatchObject({ selectedAccountIndexes: [1] })
    await vi.waitFor(() => {
      expect(second.close).toHaveBeenCalled()
    })
  })
})
