import type { BrowserContext } from 'patchright'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { DashboardClient, RscBootstrap } from '../src/browser/DashboardClient.js'
import { createEvidence } from '../src/domain/Evidence.js'
import { DEFAULT_CONFIG } from '../src/infra/Config.js'
import { SqliteStore } from '../src/infra/SqliteStore.js'
import type { StructuredLogger } from '../src/infra/StructuredLogger.js'
import { parseRewardsHtml } from '../src/rewards/DashboardParser.js'
import { webOfferExecutionPath } from '../src/rewards/OfferExecution.js'
import { RewardsDiscoveryService } from '../src/rewards/RewardsDiscoveryService.js'
import type { RewardsObservation } from '../src/rewards/RewardsModel.js'
import { RewardsTaskExecutor } from '../src/rewards/RewardsTaskExecutor.js'

const date = '2026-10-05'
const offerId = 'SYNTH_dailyset_urlreward_topic'
const destination = 'https://www.bing.com/search?q=synthetic+animal&form=TEST'

function linkProps(overrides: Record<string, unknown> = {}) {
  return {
    offerId,
    ariaLabel: '打开信息页面, 合成日常点击任务',
    linkText: '打开信息页面',
    href: destination,
    hash: 'synthetic-link-hash',
    edgeAction: null,
    isCompleted: false,
    isLocked: false,
    ...overrides
  }
}

function parse(items: Record<string, unknown>[] = [linkProps()]) {
  const flight = '1:' + JSON.stringify(items.map((props) => ({ props })))
  return parseRewardsHtml(
    '<script>self.__next_f.push([1,' + JSON.stringify(flight) + '])</script>',
    'earn',
    date
  )
}

function valid<T>(value: T) {
  return createEvidence({
    value,
    source: 'bing-flyout',
    availability: 'valid',
    confidence: 0.95,
    observedAt: date + 'T00:00:00.000Z'
  })
}

async function fixture(items: Record<string, unknown>[] = [linkProps()]) {
  const store = new SqliteStore(':memory:')
  const bootstrap = (complete?: boolean): RscBootstrap => ({
    html: [],
    ...parse(
      items.map((props) => ({
        ...props,
        ...(complete === undefined ? {} : { isCompleted: complete })
      }))
    ),
    domOffers: [],
    actionIds: { reportActivity: 'synthetic-report-action' }
  })
  const observation: RewardsObservation = {
    source: 'bing-flyout',
    offers: [],
    availablePoints: valid(100),
    rewardsUser: valid(true),
    market: valid('CN'),
    pcSearch: valid({ completed: 0, total: 60, remaining: 60 }),
    mobileSearch: valid({ completed: 0, total: 0, remaining: 0 }),
    topLevelFields: []
  }
  const bootstrapRsc = vi.fn().mockResolvedValue(bootstrap())
  const navigateOffer = vi.fn().mockResolvedValue(undefined)
  const reportServerAction = vi.fn()
  const client = {
    bootstrapRsc,
    fetchFlyout: vi.fn().mockResolvedValue(observation),
    fetchDashboard: vi.fn(),
    readClaimablePoints: vi.fn().mockResolvedValue(0),
    navigateOffer,
    reportServerAction
  } as unknown as DashboardClient
  const discovery = await new RewardsDiscoveryService().discover({
    accountId: 'synthetic-account',
    localDate: date,
    client,
    initialObservation: observation
  })
  const task = discovery.tasks.find((candidate) => candidate.sourceTaskId === offerId)
  if (!task) throw new Error('Synthetic daily task was not discovered')
  const executor = new RewardsTaskExecutor(
    {} as BrowserContext,
    client,
    store,
    { write: vi.fn().mockResolvedValue(undefined) } as unknown as StructuredLogger,
    DEFAULT_CONFIG,
    'synthetic-run',
    'account-1'
  )
  const execute = (
    mode: 'mutating' | 'read-only' = 'mutating',
    signal = new AbortController().signal
  ) => executor.executeTypes({ discovery, types: ['daily-set'], mode, signal })
  return {
    store,
    task,
    discovery,
    execute,
    bootstrap,
    bootstrapRsc,
    navigateOffer,
    reportServerAction
  }
}

afterEach(() => vi.useRealTimers())

describe('daily official URL-reward Links', () => {
  it('discovers a state-bearing Link with href and its actual title instead of an unusable hash fragment', () => {
    const result = parse()
    expect(result.offers).toHaveLength(1)
    expect(result.offers[0]).toMatchObject({
      sourceTaskId: offerId,
      type: 'daily-set',
      source: 'rsc',
      displayName: '合成日常点击任务',
      destinationUrl: destination,
      executable: true,
      completed: 0,
      total: 1,
      identityStable: true
    })
    expect(result.offers[0]?.expectedPoints).toBeUndefined()
  })

  it('uses the official click even when a reportActivity action and reward metadata exist', () => {
    const offer = parse([linkProps({ pointProgressMax: 15 })]).offers[0]
    if (!offer) throw new Error('Missing synthetic offer')
    expect(webOfferExecutionPath(offer, true)).toBe('navigate-only')
    expect(offer.expectedPoints).toBe(15)
  })

  it('keeps ordinary daily report-activity tasks on their existing path', () => {
    const ordinary = {
      offerId: 'synthetic-daily-normal',
      title: '合成现有任务',
      hash: 'synthetic-action-hash',
      pointProgressMax: 15,
      activityType: 11
    }
    const baseline = parse([ordinary]).offers[0]
    const together = parse([ordinary, linkProps()]).offers.find(
      (offer) => offer.sourceTaskId === ordinary.offerId
    )
    expect(together).toEqual(baseline)
    if (!together) throw new Error('Missing synthetic existing daily task')
    expect(webOfferExecutionPath(together, true)).toBe('report-activity')
  })

  it('clicks once and only marks complete after a matching official state refresh', async () => {
    const f = await fixture()
    try {
      f.bootstrapRsc.mockResolvedValue(f.bootstrap(true))
      const result = await f.execute()
      expect(result.status).toBe('completed')
      expect(f.navigateOffer).toHaveBeenCalledTimes(1)
      expect(f.navigateOffer).toHaveBeenCalledWith(
        destination,
        {
          sourceTaskId: offerId,
          taskId: f.task.taskId,
          offerId,
          displayName: '合成日常点击任务'
        },
        expect.any(AbortSignal)
      )
      expect(f.reportServerAction).not.toHaveBeenCalled()
      expect(f.store.getTask(f.task.taskId)?.status).toBe('completed')
      expect(f.store.getMutationState(f.task.taskId)).toBe('verified')
      await f.execute()
      expect(f.navigateOffer).toHaveBeenCalledTimes(1)
    } finally {
      f.store.close()
    }
  })
  it('reads a daily Link nested under a different offer without expanding unrelated nested tasks', () => {
    const nested = { offerId: 'synthetic-container', children: [{ props: linkProps() }] }
    const result = parse([nested])
    expect(result.offers.find((offer) => offer.sourceTaskId === offerId)).toMatchObject({
      executable: true,
      destinationUrl: destination,
      displayName: '合成日常点击任务'
    })
  })

  it('accepts explicit URL-reward metadata without requiring urlreward in the offer ID', () => {
    const offer = parse([
      linkProps({ offerId: 'synthetic-daily-topic', promotionType: 'urlreward' })
    ]).offers[0]
    expect(offer).toMatchObject({ executable: true, requiresOfficialClick: true })
  })

  it.each([
    { isLocked: true },
    { isCompleted: true },
    { isDisabled: true },
    { isLocked: undefined },
    { isCompleted: undefined },
    { edgeAction: 'install-app' },
    { href: 'http://www.bing.com/search?q=synthetic' },
    { href: 'https://example.test/search?q=synthetic' },
    { href: 'https://synthetic:placeholder@www.bing.com/search?q=synthetic' },
    { href: 'https://www.bing.com/search' },
    { href: 'https://www.bing.com:444/search?q=synthetic' },
    { ariaLabel: 'Unrelated label' },
    { linkText: '' },
    { promotionType: 'quiz' },
    { attributes: { type: 'poll' } },
    { offerId: 'SYNTH_dailyset_urlreward_puzzle' },
    { offerId: 'SYNTH_dailyset_urlreward_referral' }
  ])('does not activate incomplete, locked or restricted Link metadata: %j', (overrides) => {
    const offer = parse([linkProps(overrides)]).offers[0]
    expect(offer?.executable).toBe(false)
    if (!offer) throw new Error('Synthetic restricted task must remain visible')
    expect(webOfferExecutionPath(offer, true)).not.toBe('navigate-only')
    expect(webOfferExecutionPath(offer, true)).not.toBe('report-activity')
  })

  it('keeps a future daily Link out of today’s execution', () => {
    expect(parse([linkProps({ attributes: { daily_set_date: '10/06/2026' } })]).offers).toEqual([])
  })

  it('prefers the official Link over a hash-only representation regardless of ordering', () => {
    const metadata = { offerId, hash: 'synthetic-hash', pointProgressMax: 15, activityType: 11 }
    for (const items of [
      [metadata, linkProps()],
      [linkProps(), metadata]
    ]) {
      const offers = parse(items).offers
      expect(offers).toHaveLength(1)
      expect(offers[0]).toMatchObject({ executable: true, requiresOfficialClick: true })
    }
  })

  it('deduplicates identical Link representations but refuses conflicting states or targets', () => {
    expect(parse([linkProps(), linkProps()]).offers).toHaveLength(1)
    for (const overrides of [
      { isCompleted: true },
      { href: 'https://www.bing.com/search?q=another' }
    ]) {
      const offers = parse([linkProps(), linkProps(overrides)]).offers
      expect(offers).toHaveLength(1)
      expect(offers[0]).toMatchObject({ executable: false, complete: false, identityStable: false })
    }
  })

  it('waits for delayed official confirmation without clicking again', async () => {
    vi.useFakeTimers()
    const f = await fixture()
    try {
      f.bootstrapRsc.mockResolvedValueOnce(f.bootstrap(false)).mockResolvedValue(f.bootstrap(true))
      const pending = f.execute()
      await vi.runAllTimersAsync()
      expect((await pending).status).toBe('completed')
      expect(f.navigateOffer).toHaveBeenCalledTimes(1)
      expect(f.reportServerAction).not.toHaveBeenCalled()
    } finally {
      f.store.close()
    }
  })

  it('keeps an unconfirmed click pending and rechecks it on resume without a second click', async () => {
    vi.useFakeTimers()
    const f = await fixture()
    try {
      const execution = f.execute()
      await vi.runAllTimersAsync()
      expect((await execution).status).toBe('partial')
      expect(f.store.getTask(f.task.taskId)?.status).toBe('verification-pending')
      expect(f.navigateOffer).toHaveBeenCalledTimes(1)
      f.bootstrapRsc.mockResolvedValue(f.bootstrap(true))
      expect((await f.execute()).status).toBe('completed')
      expect(f.navigateOffer).toHaveBeenCalledTimes(1)
      expect(f.reportServerAction).not.toHaveBeenCalled()
    } finally {
      f.store.close()
    }
  })

  it('does not resend when a click throws after activation was attempted', async () => {
    const f = await fixture()
    try {
      f.navigateOffer.mockRejectedValueOnce(new Error('synthetic activation timeout'))
      expect((await f.execute()).status).toBe('partial')
      expect(f.store.getMutationState(f.task.taskId)).toBe('verification-pending')
      f.bootstrapRsc.mockResolvedValue(f.bootstrap(true))
      expect((await f.execute()).status).toBe('completed')
      expect(f.navigateOffer).toHaveBeenCalledTimes(1)
    } finally {
      f.store.close()
    }
  })

  it('keeps read-only and cancellation paths free of clicks and mutation reservations', async () => {
    const f = await fixture()
    try {
      await f.execute('read-only')
      const controller = new AbortController()
      controller.abort(new Error('synthetic cancelled'))
      await expect(f.execute('mutating', controller.signal)).rejects.toThrow('synthetic cancelled')
      expect(f.navigateOffer).not.toHaveBeenCalled()
      expect(f.reportServerAction).not.toHaveBeenCalled()
      expect(f.store.getMutationState(f.task.taskId)).toBeUndefined()
    } finally {
      f.store.close()
    }
  })
  it.each([{ isLocked: true }, { isCompleted: true }, { isDisabled: true }])(
    'does not reserve or submit already complete or unavailable tasks: %j',
    async (overrides) => {
      const f = await fixture([linkProps(overrides)])
      try {
        await f.execute()
        expect(f.navigateOffer).not.toHaveBeenCalled()
        expect(f.reportServerAction).not.toHaveBeenCalled()
        expect(f.store.getMutationState(f.task.taskId)).toBeUndefined()
      } finally {
        f.store.close()
      }
    }
  )
})
