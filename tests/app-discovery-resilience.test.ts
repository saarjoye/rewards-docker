import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { APIResponse, BrowserContext, Page } from 'patchright'

import type { EncryptedSessionStore } from '../src/auth/EncryptedSessionStore.js'
import { AppOAuthClient } from '../src/browser/AppOAuthClient.js'
import type { AccountBrowserSlot, BrowserRuntime } from '../src/browser/BrowserRuntime.js'
import { DashboardClient } from '../src/browser/DashboardClient.js'
import { LoginController } from '../src/browser/LoginController.js'
import { createEvidence } from '../src/domain/Evidence.js'
import type { AccountSecretStore } from '../src/infra/AccountSecretStore.js'
import { DEFAULT_CONFIG } from '../src/infra/Config.js'
import { SqliteStore } from '../src/infra/SqliteStore.js'
import type { LogEvent, StructuredLogger } from '../src/infra/StructuredLogger.js'
import {
  AccountPipeline,
  type AccountPipelineContext,
  type AccountPipelineStage,
  type StageResult
} from '../src/orchestration/AccountPipeline.js'
import { BusinessDateChanged } from '../src/orchestration/BusinessDate.js'
import { ApplicationRunCoordinator } from '../src/orchestration/RunCoordinator.js'
import {
  RewardsDiscoveryService,
  type DiscoveryOutput
} from '../src/rewards/RewardsDiscoveryService.js'
import type { RewardsObservation } from '../src/rewards/RewardsModel.js'
import { RewardsTaskExecutor } from '../src/rewards/RewardsTaskExecutor.js'

const roots: string[] = []
const stores: SqliteStore[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  for (const store of stores.splice(0)) store.close()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function evidence<T>(value: T) {
  return createEvidence({
    availability: 'valid',
    source: 'bing-flyout',
    confidence: 0.9,
    observedAt: '2026-10-06T00:00:00.000Z',
    value
  })
}

function observation(): RewardsObservation {
  return {
    source: 'bing-flyout',
    rewardsUser: evidence(true),
    market: evidence('CN'),
    availablePoints: evidence(100),
    pcSearch: evidence({ completed: 0, total: 60, remaining: 60 }),
    mobileSearch: evidence({ completed: 0, total: 30, remaining: 30 }),
    offers: [],
    topLevelFields: ['dashboard']
  }
}

type MockResponse = Omit<APIResponse, 'dispose'> & { dispose: Mock<() => Promise<void>> }

function response(status: number, body: string): MockResponse {
  return {
    ok: () => status >= 200 && status < 300,
    status: () => status,
    text: vi.fn().mockResolvedValue(body),
    dispose: vi.fn().mockResolvedValue(undefined)
  } as unknown as MockResponse
}

async function fixture(appResponse: APIResponse | Error) {
  const root = await mkdtemp(join(tmpdir(), 'rewards-app-discovery-'))
  roots.push(root)
  const store = new SqliteStore(join(root, 'state.sqlite'))
  stores.push(store)
  const get = vi.fn()
  if (appResponse instanceof Error) get.mockRejectedValue(appResponse)
  else get.mockResolvedValue(appResponse)
  const desktopCommit = vi.fn().mockResolvedValue(undefined)
  const mobileCommit = vi.fn().mockResolvedValue(undefined)
  const slot = (name: AccountBrowserSlot['slot']): AccountBrowserSlot => ({
    slot: name,
    context: { request: { get } } as unknown as BrowserContext,
    page: {
      goto: vi.fn().mockResolvedValue(null),
      url: vi.fn().mockReturnValue('https://rewards.bing.com/dashboard')
    } as unknown as Page,
    commitVerified: name === 'web-desktop' ? desktopCommit : mobileCommit,
    close: vi.fn().mockResolvedValue(undefined)
  })
  const openSlot = vi
    .fn()
    .mockResolvedValueOnce(slot('web-desktop'))
    .mockResolvedValueOnce(slot('web-mobile'))
  const write = vi.fn<(event: LogEvent) => Promise<void>>().mockResolvedValue(undefined)
  const coordinator = new ApplicationRunCoordinator(
    {} as AccountSecretStore,
    store,
    {} as EncryptedSessionStore,
    { openSlot } as unknown as BrowserRuntime,
    { write } as unknown as StructuredLogger,
    { ...DEFAULT_CONFIG, tasks: { ...DEFAULT_CONFIG.tasks, mobileSearch: true } }
  )
  const verified = observation()
  vi.spyOn(LoginController.prototype, 'login').mockResolvedValue(undefined)
  vi.spyOn(RewardsDiscoveryService.prototype, 'verifyAuthenticated').mockResolvedValue({
    verification: { valid: true },
    observation: verified
  })
  vi.spyOn(AppOAuthClient.prototype, 'readStored').mockResolvedValue({
    accessToken: 'synthetic-token',
    expiresAt: '2026-10-06T10:00:00.000Z'
  })
  const oauthCommit = vi
    .spyOn(AppOAuthClient.prototype, 'commitVerified')
    .mockResolvedValue(undefined)
  const bootstrap = vi.spyOn(DashboardClient.prototype, 'bootstrapRsc').mockResolvedValue({
    html: ['<html></html>'],
    offers: [
      {
        sourceTaskId: 'synthetic-daily',
        type: 'daily-set',
        source: 'rsc',
        displayName: 'Synthetic daily',
        completed: 0,
        total: 1,
        complete: false,
        executable: true,
        hash: 'synthetic-hash'
      }
    ],
    domOffers: [],
    availablePoints: evidence(100),
    actionIds: {}
  })
  vi.spyOn(DashboardClient.prototype, 'fetchFlyout').mockResolvedValue(verified)
  vi.spyOn(DashboardClient.prototype, 'readClaimablePoints').mockResolvedValue(0)
  const finalRead = vi.spyOn(DashboardClient.prototype, 'fetchDashboard').mockResolvedValue({
    ...verified,
    availablePoints: evidence(1_000)
  })
  const appMutation = vi.spyOn(DashboardClient.prototype, 'submitAppActivity')
  const observer = new RewardsTaskExecutor(
    {} as BrowserContext,
    {} as DashboardClient,
    store,
    { write } as unknown as StructuredLogger,
    DEFAULT_CONFIG,
    'synthetic-run',
    'account-1'
  )
  const originalExecute = observer.executeTypes.bind(observer)
  const executed = vi
    .spyOn(RewardsTaskExecutor.prototype, 'executeTypes')
    .mockImplementation(function (this: RewardsTaskExecutor, input) {
      const selected = input.discovery.tasks.filter((task) => input.types.includes(task.type))
      if (input.mode === 'read-only' || selected.every((task) => !task.executable)) {
        return originalExecute(input)
      }
      // Only simulate the external actions; discovery, persistence and settlement are real.
      for (const task of selected) {
        if (!task.executable) continue
        store.upsertTask(
          {
            ...task,
            status: 'completed',
            progress: { ...task.progress, completed: task.progress.total ?? 1 }
          },
          'synthetic-run'
        )
      }
      return Promise.resolve({ status: 'completed', tasks: selected })
    })
  const controller = new AbortController()
  const context: AccountPipelineContext = {
    runId: 'synthetic-run',
    accountId: 'synthetic-account',
    runAccountIndex: 1,
    localDate: '2026-10-06',
    signal: controller.signal
  }
  const resources: Record<string, unknown> = {}
  const callable = coordinator as unknown as {
    executeStage(
      stage: AccountPipelineStage,
      context: AccountPipelineContext,
      mode: 'mutating' | 'read-only',
      credentials: { email: string; password: string },
      resources: Record<string, unknown>,
      singleAccountMode: boolean,
      targetAccountIndex: number | undefined,
      retryPendingSearch: boolean
    ): Promise<StageResult>
  }
  const execute = (stage: AccountPipelineStage, mode: 'mutating' | 'read-only' = 'mutating') =>
    callable.executeStage(
      stage,
      context,
      mode,
      { email: 'synthetic@example.test', password: 'synthetic-password' },
      resources,
      false,
      undefined,
      false
    )
  return {
    store,
    resources,
    controller,
    get,
    write,
    desktopCommit,
    mobileCommit,
    oauthCommit,
    bootstrap,
    finalRead,
    appMutation,
    executed,
    execute
  }
}

describe('App Dashboard discovery fault isolation', () => {
  it.each([401, 403, 429, 503])(
    'continues web tasks and settlement after App HTTP %s without confirming missing App tasks',
    async (status) => {
      const appResponse = response(status, '{}')
      const input = await fixture(appResponse)
      const stages: AccountPipelineStage[] = []
      const result = await new AccountPipeline({
        execute: (stage) => {
          stages.push(stage)
          return input.execute(stage)
        },
        checkpoint: () => Promise.resolve()
      }).run({
        runId: 'synthetic-run',
        accountId: 'synthetic-account',
        runAccountIndex: 1,
        localDate: '2026-10-06',
        signal: input.controller.signal
      })

      expect(result.status).toBe('partial')
      expect(result.stages.find(({ stage }) => stage === 'discover')?.result).toMatchObject({
        status: 'partial',
        failureStage: 'app-dashboard'
      })
      expect(stages).toContain('web-rewards')
      expect(stages).toContain('search')
      expect(stages.at(-1)).toBe('final-verification')
      const tasks = input.store.listTaskState('2026-10-06')
      expect(tasks.find((task) => task.sourceTaskId === 'synthetic-daily')?.status).toBe(
        'completed'
      )
      expect(tasks.find((task) => task.type === 'pc-search')?.status).toBe('completed')
      expect(tasks.find((task) => task.type === 'mobile-search')?.status).toBe('completed')
      for (const type of ['app-activity', 'app-check-in', 'read-to-earn']) {
        expect(tasks.find((task) => task.type === type)).toMatchObject({
          status: 'unknown',
          executable: false,
          reason: '对应数据源未确认'
        })
      }
      expect(input.resources.initialPoints).toBe(100)
      expect(input.resources.finalPoints).toBe(1_000)
      expect(input.finalRead).toHaveBeenCalledOnce()
      expect(input.get).toHaveBeenCalledTimes(2)
      expect(appResponse.dispose).toHaveBeenCalledTimes(2)
      expect(input.oauthCommit).not.toHaveBeenCalled()
      expect(input.desktopCommit).toHaveBeenCalledOnce()
      expect(input.mobileCommit).toHaveBeenCalledOnce()
      expect(input.appMutation).not.toHaveBeenCalled()
      expect(input.write).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'app-dashboard-unavailable',
          httpStatus: status,
          stage: 'discover'
        })
      )
    }
  )

  it.each([
    [
      'network error',
      new Error('synthetic ECONNRESET Authorization=Bearer synthetic-private-value')
    ],
    ['invalid JSON', response(200, '<html>synthetic login page</html>')]
  ])('keeps web discovery and its starting balance after an App %s', async (_name, appResponse) => {
    const input = await fixture(appResponse)
    await expect(input.execute('authenticate')).resolves.toMatchObject({ status: 'partial' })
    await expect(input.execute('discover')).resolves.toMatchObject({
      status: 'partial',
      failureStage: 'app-dashboard'
    })
    const discovery = input.resources.discovery as DiscoveryOutput
    expect(discovery.dataSources['app-dashboard']).toBe(false)
    expect(
      discovery.tasks.find((task) => task.sourceTaskId === 'synthetic-daily')?.executable
    ).toBe(true)
    expect(input.resources.initialPoints).toBe(100)
    expect(JSON.stringify(input.write.mock.calls)).not.toContain('synthetic-private-value')
    expect(input.appMutation).not.toHaveBeenCalled()
  })

  it('continues discovery when the App warning cannot be written', async () => {
    const input = await fixture(response(503, '{}'))
    input.write.mockImplementation((event) =>
      event.event === 'app-dashboard-unavailable'
        ? Promise.reject(new Error('synthetic log unavailable'))
        : Promise.resolve()
    )
    await input.execute('authenticate')
    await expect(input.execute('discover')).resolves.toMatchObject({ status: 'partial' })
    expect(input.resources.initialPoints).toBe(100)
  })

  it('keeps healthy App discovery unchanged and avoids a duplicate App read', async () => {
    const input = await fixture(
      response(
        200,
        JSON.stringify({
          dashboard: {
            userStatus: { isRewardsUser: true, availablePoints: 100 },
            appActivities: []
          }
        })
      )
    )
    await expect(input.execute('authenticate')).resolves.toEqual({ status: 'completed' })
    await expect(input.execute('discover')).resolves.toEqual({ status: 'completed' })
    expect((input.resources.discovery as DiscoveryOutput).dataSources['app-dashboard']).toBe(true)
    expect(input.get).toHaveBeenCalledOnce()
    expect(input.oauthCommit).toHaveBeenCalledOnce()
    expect(input.write).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: 'app-dashboard-unavailable' })
    )
  })

  it('recovers an App read during discovery after the authentication read failed', async () => {
    const input = await fixture(response(503, '{}'))
    await input.execute('authenticate')
    input.get.mockResolvedValue(
      response(
        200,
        JSON.stringify({ dashboard: { userStatus: { isRewardsUser: true, availablePoints: 100 } } })
      )
    )
    await expect(input.execute('discover')).resolves.toEqual({ status: 'completed' })
    expect((input.resources.discovery as DiscoveryOutput).dataSources['app-dashboard']).toBe(true)
    expect(input.get).toHaveBeenCalledTimes(2)
  })

  it.each(['authenticate', 'discover'] as const)(
    'propagates cancellation during %s without persisting web discovery or committing App OAuth',
    async (stage) => {
      const input = await fixture(response(503, '{}'))
      if (stage === 'discover') await input.execute('authenticate')
      const cancelled = new Error('synthetic cancellation')
      input.get.mockImplementation(() => {
        input.controller.abort(cancelled)
        return Promise.reject(new Error('synthetic request interrupted'))
      })
      await expect(input.execute(stage)).rejects.toBe(cancelled)
      expect(input.bootstrap).not.toHaveBeenCalled()
      expect(input.store.listTaskState('2026-10-06')).toEqual([])
      expect(input.oauthCommit).not.toHaveBeenCalled()
    }
  )

  it.each(['authenticate', 'discover'] as const)(
    'propagates a business date change during %s instead of degrading it to an App outage',
    async (stage) => {
      const input = await fixture(response(503, '{}'))
      if (stage === 'discover') await input.execute('authenticate')
      const changed = new BusinessDateChanged()
      input.get.mockRejectedValue(changed)
      await expect(input.execute(stage)).rejects.toBe(changed)
      expect(input.bootstrap).not.toHaveBeenCalled()
      expect(input.oauthCommit).not.toHaveBeenCalled()
    }
  )
  it.each(['authenticate', 'discover'] as const)(
    'rejects a successful App response arriving after cancellation during %s',
    async (stage) => {
      const input = await fixture(response(503, '{}'))
      if (stage === 'discover') await input.execute('authenticate')
      const cancelled = new Error('synthetic late cancellation')
      const lateResponse = response(
        200,
        JSON.stringify({ dashboard: { userStatus: { isRewardsUser: true, availablePoints: 100 } } })
      )
      input.get.mockImplementation(() => {
        input.controller.abort(cancelled)
        return Promise.resolve(lateResponse)
      })
      await expect(input.execute(stage)).rejects.toBe(cancelled)
      expect(lateResponse.dispose).toHaveBeenCalledOnce()
      expect(input.bootstrap).not.toHaveBeenCalled()
      expect(input.oauthCommit).not.toHaveBeenCalled()
      expect(input.store.listTaskState('2026-10-06')).toEqual([])
    }
  )

  it.each(['authenticate', 'discover'] as const)(
    'checks the date guard when an App request fails across midnight during %s',
    async (stage) => {
      const input = await fixture(response(503, '{}'))
      if (stage === 'discover') await input.execute('authenticate')
      const changed = new BusinessDateChanged()
      let crossedMidnight = false
      input.resources.guardDate = () => {
        if (crossedMidnight) throw changed
      }
      input.get.mockImplementation(() => {
        crossedMidnight = true
        return Promise.resolve(response(503, '{}'))
      })
      await expect(input.execute(stage)).rejects.toBe(changed)
      expect(input.bootstrap).not.toHaveBeenCalled()
      expect(input.oauthCommit).not.toHaveBeenCalled()
      expect(input.store.listTaskState('2026-10-06')).toEqual([])
    }
  )

  it('retains read-only behavior after an App outage without completing or submitting web and search tasks', async () => {
    const input = await fixture(response(503, '{}'))
    await input.execute('authenticate', 'read-only')
    await input.execute('discover', 'read-only')
    await expect(input.execute('web-rewards', 'read-only')).resolves.toEqual({
      status: 'completed'
    })
    await expect(input.execute('search', 'read-only')).resolves.toEqual({ status: 'completed' })
    const tasks = input.store.listTaskState('2026-10-06')
    expect(tasks.find((task) => task.sourceTaskId === 'synthetic-daily')?.status).toBe('discovered')
    for (const type of ['pc-search', 'mobile-search']) {
      expect(tasks.find((task) => task.type === type)?.status).toBe('discovered')
    }
    expect(input.appMutation).not.toHaveBeenCalled()
    expect(input.get).toHaveBeenCalledTimes(2)
    expect(input.executed.mock.calls.every(([call]) => call.mode === 'read-only')).toBe(true)
  })
  it.each(['cancellation', 'business-date-change'] as const)(
    'does not continue discovery if %s happens while logging the App warning',
    async (reason) => {
      const input = await fixture(response(503, '{}'))
      await input.execute('authenticate')
      const interruption =
        reason === 'cancellation'
          ? new Error('synthetic cancellation during warning')
          : new BusinessDateChanged()
      let crossedMidnight = false
      input.resources.guardDate = () => {
        if (crossedMidnight) throw interruption
      }
      input.write.mockImplementation((event) => {
        if (event.event === 'app-dashboard-unavailable') {
          if (reason === 'cancellation') input.controller.abort(interruption)
          else crossedMidnight = true
        }
        return Promise.resolve()
      })
      await expect(input.execute('discover')).rejects.toBe(interruption)
      expect(input.bootstrap).not.toHaveBeenCalled()
      expect(input.store.listTaskState('2026-10-06')).toEqual([])
    }
  )
})
