import type { BrowserContext } from 'patchright'
import { describe, expect, it, vi } from 'vitest'

import type { DashboardClient, RscBootstrap } from '../src/browser/DashboardClient.js'
import { createEvidence } from '../src/domain/Evidence.js'
import { DEFAULT_CONFIG } from '../src/infra/Config.js'
import { SqliteStore } from '../src/infra/SqliteStore.js'
import type { StructuredLogger } from '../src/infra/StructuredLogger.js'
import { webOfferExecutionPath } from '../src/rewards/OfferExecution.js'
import {
  RewardsDiscoveryService,
  type DiscoveryOutput
} from '../src/rewards/RewardsDiscoveryService.js'
import type { RewardOffer, RewardsObservation } from '../src/rewards/RewardsModel.js'
import { RewardsTaskExecutor } from '../src/rewards/RewardsTaskExecutor.js'
import { verifyOfficialOffer } from '../src/rewards/TaskVerification.js'

function offer(overrides: Partial<RewardOffer> = {}): RewardOffer {
  return {
    sourceTaskId: 'synthetic-offer',
    source: 'rsc',
    type: 'special-promotion',
    displayName: 'Synthetic promotion',
    completed: 0,
    total: 5,
    complete: false,
    executable: true,
    ...overrides
  }
}

function evidence<T>(value: T, source: RewardOffer['source'] = 'rsc') {
  return createEvidence({
    value,
    source,
    availability: 'valid',
    confidence: 0.9,
    observedAt: '2026-10-02T00:00:00.000Z'
  })
}

function observation(
  source: RewardOffer['source'],
  offers: readonly RewardOffer[] = []
): RewardsObservation {
  return {
    source,
    offers,
    rewardsUser: evidence(true, source),
    market: evidence('CN', source),
    availablePoints: evidence(100, source),
    pcSearch: evidence({ completed: 0, total: 15, remaining: 15 }, source),
    mobileSearch: evidence({ completed: 0, total: 0, remaining: 0 }, source),
    topLevelFields: []
  }
}

async function discover(
  input: {
    rsc?: readonly RewardOffer[]
    dom?: readonly RewardOffer[]
    flyout?: readonly RewardOffer[]
    legacy?: readonly RewardOffer[]
    app?: readonly RewardOffer[]
    claimablePoints?: number | null
  } = {}
) {
  const bootstrap: RscBootstrap = {
    html: [],
    offers: input.rsc ?? [],
    domOffers: input.dom ?? [],
    availablePoints: evidence(100),
    actionIds: { reportActivity: 'synthetic-action' }
  }
  const flyout = observation('bing-flyout', input.flyout)
  const bootstrapRsc = vi.fn().mockResolvedValue(bootstrap)
  const fetchFlyout = vi.fn().mockResolvedValue(flyout)
  const reportServerAction = vi.fn()
  const navigateOffer = vi.fn()
  const client = {
    bootstrapRsc,
    fetchFlyout,
    fetchDashboard: vi.fn(),
    readClaimablePoints: vi
      .fn()
      .mockResolvedValue(input.claimablePoints === null ? undefined : (input.claimablePoints ?? 0)),
    reportServerAction,
    navigateOffer
  } as unknown as DashboardClient
  const discovery = await new RewardsDiscoveryService().discover({
    accountId: 'synthetic-account',
    localDate: '2026-10-02',
    client,
    initialObservation: input.legacy ? observation('legacy-getuserinfo', input.legacy) : flyout,
    ...(input.app ? { appObservation: observation('app-dashboard', input.app) } : {})
  })
  expect(reportServerAction).not.toHaveBeenCalled()
  expect(navigateOffer).not.toHaveBeenCalled()
  return { discovery, client, bootstrapRsc, fetchFlyout, reportServerAction, navigateOffer }
}

function target(discovery: DiscoveryOutput) {
  const descriptor = [...discovery.descriptors.values()].find(
    ({ task }) => task.sourceTaskId === 'synthetic-offer'
  )
  if (!descriptor?.offer) throw new Error('Synthetic offer was not discovered')
  return { task: descriptor.task, offer: descriptor.offer }
}

describe('coherent official offer discovery', () => {
  it('keeps RSC source, type and progress together when flyout classifies the same ID differently', async () => {
    const primary = offer({ hash: 'synthetic-rsc-hash' })
    const secondary = offer({
      source: 'bing-flyout',
      type: 'more-promotion',
      complete: true,
      completed: 10,
      total: 10
    })
    const { discovery } = await discover({ rsc: [primary], flyout: [secondary] })
    const selected = target(discovery)
    expect(selected.offer).toEqual(primary)
    expect(selected.task).toMatchObject({
      source: 'rsc',
      type: 'special-promotion',
      status: 'discovered',
      progress: { completed: 0, total: 5 }
    })
    expect(verifyOfficialOffer(selected.task, [primary], 'rsc')).toMatchObject({
      confirmed: false,
      failureCode: 'task-still-incomplete'
    })
  })

  it('does not let a DOM section overwrite Flight classification or progress', async () => {
    const primary = offer({ type: 'punch-card', hash: 'synthetic-rsc-hash' })
    const dom = offer({ type: 'more-promotion', completed: 1, total: 1, complete: true })
    const { discovery } = await discover({ rsc: [primary], dom: [dom] })
    expect(target(discovery).offer).toEqual(primary)
    expect(target(discovery).task).toMatchObject({
      type: 'punch-card',
      progress: { completed: 0, total: 5 },
      status: 'discovered'
    })
  })

  it.each([false, true])(
    'does not replace RSC completion=%s with the opposite flyout state',
    async (complete) => {
      const primary = offer({ complete, completed: complete ? 5 : 0 })
      const secondary = offer({
        source: 'bing-flyout',
        complete: !complete,
        completed: complete ? 0 : 5
      })
      const { discovery } = await discover({ rsc: [primary], flyout: [secondary] })
      expect(target(discovery).offer).toEqual(primary)
      expect(target(discovery).task.status).toBe(complete ? 'completed' : 'discovered')
    }
  )

  it.each(['rsc', 'bing-flyout'] as const)(
    'does not re-enable a disabled RSC offer from a %s helper',
    async (source) => {
      const primary = offer({ executable: false, hash: 'synthetic-rsc-hash' })
      const secondary = offer({
        source,
        executable: true,
        identityStable: true,
        destinationUrl: 'https://example.test/reward'
      })
      const { discovery } = await discover({
        rsc: [primary],
        ...(source === 'rsc' ? { dom: [secondary] } : { flyout: [secondary] })
      })
      expect(target(discovery).offer).toEqual(primary)
      expect(target(discovery).task).toMatchObject({ executable: false, status: 'unknown' })
    }
  )

  it('does not re-enable a disabled flyout offer through a same-ID DOM fallback', async () => {
    const primary = offer({ source: 'bing-flyout', executable: false })
    const { discovery } = await discover({
      flyout: [primary],
      dom: [offer({ identityStable: true, destinationUrl: 'https://example.test/reward' })]
    })
    expect(target(discovery).offer).toEqual(primary)
    expect(target(discovery).task).toMatchObject({
      source: 'bing-flyout',
      executable: false,
      status: 'unknown'
    })
  })

  it('does not promote an unstable primary identity from auxiliary DOM metadata', async () => {
    const primary = offer({ identityStable: false, hash: 'synthetic-rsc-hash' })
    const { discovery } = await discover({
      rsc: [primary],
      dom: [offer({ identityStable: true, destinationUrl: 'https://example.test/reward' })]
    })
    expect(target(discovery).offer).toEqual(primary)
    expect(target(discovery).task.identityStable).toBe(false)
  })

  it('preserves the explicit zero-point promotional restriction', async () => {
    const primary = offer({ total: 0, isPromotional: true })
    const { discovery } = await discover({
      rsc: [primary],
      flyout: [offer({ source: 'bing-flyout', total: 10, isPromotional: false })]
    })
    expect(target(discovery).task).toMatchObject({
      executable: false,
      status: 'skipped',
      progress: { completed: 0, total: 0 }
    })
  })

  it('does not transplant flyout action metadata into an RSC Server Action', async () => {
    const primary = offer({ destinationUrl: 'https://www.bing.com/search?q=synthetic' })
    const { discovery } = await discover({
      rsc: [primary],
      flyout: [
        offer({
          source: 'bing-flyout',
          hash: 'synthetic-flyout-hash',
          activityType: 99,
          parentOfferId: 'synthetic-parent',
          attributes: { type: 'synthetic-action' },
          expectedPoints: 100
        })
      ]
    })
    const selected = target(discovery)
    expect(selected.offer).toEqual(primary)
    expect(webOfferExecutionPath(selected.offer, true)).toBe('navigate-only')
  })

  it('uses a re-observable flyout offer before a same-ID DOM fallback when Flight has no offer', async () => {
    const primary = offer({ source: 'bing-flyout', type: 'more-promotion' })
    const { discovery } = await discover({
      dom: [offer({ identityStable: true })],
      flyout: [primary]
    })
    const selected = target(discovery)
    expect(selected.offer).toEqual(primary)
    expect(selected.task).toMatchObject({ source: 'bing-flyout', type: 'more-promotion' })
    expect(
      verifyOfficialOffer(
        selected.task,
        [{ ...primary, complete: true, completed: 5 }],
        'bing-flyout'
      )
    ).toMatchObject({
      confirmed: true,
      progress: { completed: 5, total: 5 }
    })
  })

  it('keeps flyout verification binding when legacy evidence arrived first', async () => {
    const primary = offer({ source: 'bing-flyout', type: 'more-promotion' })
    const { discovery } = await discover({
      legacy: [offer({ source: 'legacy-getuserinfo', type: 'punch-card' })],
      flyout: [primary]
    })
    expect(target(discovery).offer).toEqual(primary)
    expect(target(discovery).task).toMatchObject({ source: 'bing-flyout', type: 'more-promotion' })
  })

  it('does not mix an App-owned offer into an existing same-ID RSC offer', async () => {
    const primary = offer({ hash: 'synthetic-rsc-hash' })
    const { discovery } = await discover({
      rsc: [primary],
      app: [offer({ source: 'app-dashboard', type: 'app-activity', attributes: { type: 'app' } })]
    })
    expect(target(discovery).offer).toEqual(primary)
  })

  it('keeps a DOM-only stable offer compatible without fabricating an official observation', async () => {
    const dom = offer({
      identityStable: true,
      destinationUrl: 'https://www.bing.com/search?q=synthetic'
    })
    const { discovery } = await discover({ dom: [dom] })
    const selected = target(discovery)
    expect(selected.offer).toEqual(dom)
    expect(selected.task).toMatchObject({
      executable: true,
      identityStable: true,
      status: 'discovered'
    })
    expect(verifyOfficialOffer(selected.task, [], 'rsc')).toMatchObject({
      confirmed: false,
      failureCode: 'task-not-found-during-verification'
    })
  })

  it('allows a unique stable same-type DOM destination to supplement an already executable RSC offer', async () => {
    const primary = offer({ hash: 'synthetic-rsc-hash', attributes: { type: 'quiz' } })
    const dom = offer({
      identityStable: true,
      destinationUrl: 'https://example.test/quiz',
      total: 1,
      completed: 1,
      complete: true
    })
    const { discovery } = await discover({ rsc: [primary], dom: [dom] })
    const selected = target(discovery)
    expect(selected.offer).toEqual({ ...primary, destinationUrl: dom.destinationUrl })
    expect(selected.task).toMatchObject({
      progress: { completed: 0, total: 5 },
      status: 'discovered'
    })
    expect(webOfferExecutionPath(selected.offer, true)).toBe('interactive-quiz')
  })

  it.each([
    { identityStable: false, destinationUrl: 'https://example.test/reward' },
    {
      identityStable: true,
      type: 'daily-set' as const,
      destinationUrl: 'https://example.test/reward'
    },
    { identityStable: true, destinationUrl: 'http://example.test/reward' },
    {
      identityStable: true,
      destinationUrl: 'https://synthetic-user:synthetic-password@example.test/reward'
    }
  ])(
    'does not supplement a destination from unstable, incompatible or unsafe DOM evidence: %j',
    async (overrides) => {
      const primary = offer({ hash: 'synthetic-rsc-hash' })
      const { discovery } = await discover({ rsc: [primary], dom: [offer(overrides)] })
      expect(target(discovery).offer).toEqual(primary)
    }
  )

  it('does not choose a destination from duplicate same-ID DOM anchors', async () => {
    const primary = offer({ hash: 'synthetic-rsc-hash' })
    const { discovery } = await discover({
      rsc: [primary],
      dom: [
        offer({ identityStable: true, destinationUrl: 'https://example.test/reward?offer=one' }),
        offer({ identityStable: true, destinationUrl: 'https://example.test/reward?offer=two' })
      ]
    })
    expect(target(discovery).offer).toEqual(primary)
  })

  it('preserves an existing RSC destination even when DOM disagrees on business parameters', async () => {
    const primary = offer({ destinationUrl: 'https://www.bing.com/search?q=synthetic&filters=one' })
    const { discovery } = await discover({
      rsc: [primary],
      dom: [
        offer({
          identityStable: true,
          destinationUrl: 'https://www.bing.com/search?q=synthetic&filters=two'
        })
      ]
    })
    expect(target(discovery).offer).toEqual(primary)
  })

  it('still rejects duplicate official IDs rather than using a conveniently completed match', async () => {
    const primary = offer({ hash: 'synthetic-rsc-hash' })
    const { discovery } = await discover({ rsc: [primary] })
    expect(
      verifyOfficialOffer(
        target(discovery).task,
        [primary, { ...primary, complete: true, completed: 5 }],
        'rsc'
      )
    ).toMatchObject({ confirmed: false, failureCode: 'task-verification-source-mismatch' })
  })

  it('repairs classification on rediscovery and verifies an existing pending mutation without replaying it', async () => {
    const primary = offer({ hash: 'synthetic-rsc-hash' })
    const f = await discover({
      rsc: [primary],
      flyout: [offer({ source: 'bing-flyout', type: 'more-promotion' })]
    })
    const selected = target(f.discovery)
    const store = new SqliteStore(':memory:')
    try {
      store.upsertTask({ ...selected.task, type: 'more-promotion', status: 'verification-pending' })
      store.beginMutation(selected.task.taskId)
      store.updateMutation(selected.task.taskId, 'verification-pending')
      f.bootstrapRsc.mockResolvedValue({
        offers: [{ ...primary, complete: true, completed: 5 }],
        availablePoints: evidence(100)
      })
      const executor = new RewardsTaskExecutor(
        {} as BrowserContext,
        f.client,
        store,
        { write: vi.fn() } as unknown as StructuredLogger,
        DEFAULT_CONFIG,
        'synthetic-run',
        'account-1'
      )
      const result = await executor.executeTypes({
        discovery: f.discovery,
        types: ['special-promotion', 'more-promotion'],
        mode: 'mutating',
        signal: new AbortController().signal
      })
      expect(result.status).toBe('completed')
      expect(store.getTask(selected.task.taskId)).toMatchObject({
        type: 'special-promotion',
        status: 'completed',
        progress: { completed: 5, total: 5 }
      })
      expect(store.getMutationState(selected.task.taskId)).toBe('verified')
      expect(f.bootstrapRsc).toHaveBeenCalledTimes(2)
      expect(f.reportServerAction).not.toHaveBeenCalled()
      expect(f.navigateOffer).not.toHaveBeenCalled()
    } finally {
      store.close()
    }
  })

  it.each([
    { points: null, status: 'unknown', executable: false },
    { points: 0, status: 'skipped', executable: false },
    { points: 5, status: 'discovered', executable: true }
  ])(
    'does not change the independent claim task for claimable points=$points',
    async ({ points, status, executable }) => {
      const { discovery } = await discover({
        rsc: [offer()],
        flyout: [offer({ source: 'bing-flyout', type: 'more-promotion' })],
        claimablePoints: points
      })
      expect(discovery.tasks.find((task) => task.type === 'claim-bonus-points')).toMatchObject({
        status,
        executable
      })
    }
  )
})

describe('rediscovered task classification persistence', () => {
  it('refreshes derived type/source without changing mutation identity or historical snapshots', async () => {
    const { discovery } = await discover({ rsc: [offer()] })
    const { task } = target(discovery)
    const store = new SqliteStore(':memory:')
    try {
      const previous = {
        ...task,
        type: 'more-promotion' as const,
        source: 'legacy-getuserinfo' as const,
        status: 'verification-pending' as const
      }
      store.upsertTask(previous, 'synthetic-previous-run')
      store.beginMutation(task.taskId)
      store.updateMutation(task.taskId, 'verification-pending')
      const originalMutation = store.database
        .prepare('SELECT * FROM mutation_ledger WHERE task_id = ?')
        .get(task.taskId)
      store.upsertTask({ ...task, status: 'verification-pending' }, 'synthetic-current-run')
      expect(store.getTask(task.taskId)).toMatchObject({
        type: 'special-promotion',
        source: 'rsc',
        status: 'verification-pending'
      })
      expect(store.ledger.tasks('synthetic-previous-run')).toEqual([previous])
      expect(store.ledger.tasks('synthetic-current-run')[0]).toMatchObject({
        type: 'special-promotion',
        source: 'rsc'
      })
      expect(
        store.database.prepare('SELECT * FROM mutation_ledger WHERE task_id = ?').get(task.taskId)
      ).toEqual(originalMutation)
      expect(store.beginMutation(task.taskId)).toBe(false)
    } finally {
      store.close()
    }
  })

  it.each([
    { accountId: 'synthetic-other-account' },
    { localDate: '2026-10-03' },
    { sourceTaskId: 'synthetic-other-offer' }
  ])('refuses to rebind a task key to a different immutable identity: %j', async (overrides) => {
    const { discovery } = await discover({ rsc: [offer()] })
    const { task } = target(discovery)
    const store = new SqliteStore(':memory:')
    try {
      store.upsertTask(task, 'synthetic-previous-run')
      store.beginMutation(task.taskId)
      store.updateMutation(task.taskId, 'verification-pending')
      expect(() => {
        store.upsertTask(
          {
            ...task,
            ...overrides,
            type: 'more-promotion',
            source: 'bing-flyout'
          },
          'synthetic-conflicting-run'
        )
      }).toThrow('Task identity mismatch')
      expect(store.getTask(task.taskId)).toMatchObject(task)
      expect(store.ledger.tasks('synthetic-conflicting-run')).toEqual([])
      expect(store.getMutationState(task.taskId)).toBe('verification-pending')
      expect(store.beginMutation(task.taskId)).toBe(false)
    } finally {
      store.close()
    }
  })
})
