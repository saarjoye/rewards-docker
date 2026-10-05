import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DashboardClient } from '../src/browser/DashboardClient.js'
import { parseRewardsHtml, parseRewardsQuestHtml } from '../src/rewards/DashboardParser.js'
import { webOfferExecutionPath } from '../src/rewards/OfferExecution.js'
import { RewardsDiscoveryService } from '../src/rewards/RewardsDiscoveryService.js'
import { verifyOfficialQuestTask } from '../src/rewards/TaskVerification.js'
import type { QuestObservation, RewardOffer } from '../src/rewards/RewardsModel.js'
import type { TaskRecord } from '../src/domain/Task.js'
import {
  accountId,
  bootstrap,
  childId,
  childOffer,
  childTask,
  date,
  destination,
  linkProps,
  observation,
  parentId,
  parentOffer,
  quest,
  questHtml,
  questObservation
} from './fixtures/quests.js'

afterEach(() => vi.useRealTimers())

async function discover(
  input: {
    offers?: readonly RewardOffer[]
    detail?: QuestObservation
    readQuest?: ReturnType<typeof vi.fn>
    enabled?: boolean
    known?: TaskRecord[]
    localDate?: string
    signal?: AbortSignal
  } = {}
) {
  const readQuest = input.readQuest ?? vi.fn().mockResolvedValue(input.detail ?? questObservation())
  const client = {
    bootstrapRsc: vi.fn().mockResolvedValue(bootstrap(input.offers)),
    fetchFlyout: vi.fn().mockResolvedValue(observation()),
    fetchDashboard: vi.fn(),
    readQuest,
    readClaimablePoints: vi.fn().mockResolvedValue(0)
  } as unknown as DashboardClient
  const result = await new RewardsDiscoveryService().discover({
    accountId,
    localDate: input.localDate ?? date,
    client,
    punchCards: input.enabled ?? true,
    knownQuestTasks: input.known ?? [],
    ...(input.signal ? { signal: input.signal } : {})
  })
  return { ...result, readQuest }
}

describe('quest parser and isolation', () => {
  it('extracts one nested child layer without changing ordinary cards', () => {
    const ordinary = {
      offerId: 'synthetic-normal',
      title: 'Normal',
      destinationUrl: destination,
      points: 5
    }
    const child = {
      offerId: childId,
      title: quest.title,
      hash: 'synthetic-hash',
      pointProgressMax: 5
    }
    const nested = { offerId: parentId, title: 'Package', childPromotions: [child] }
    const ordinaryOnly = parseRewardsHtml(JSON.stringify(ordinary)).offers
    const all = parseRewardsHtml(JSON.stringify([ordinary, nested])).offers
    expect(all.find((item) => item.sourceTaskId === 'synthetic-normal')).toEqual(ordinaryOnly[0])
    expect(all.find((item) => item.sourceTaskId === childId)).toMatchObject({
      type: 'punch-card',
      parentOfferId: parentId,
      executable: false
    })
  })

  it('extracts deeply nested Link props with exact parent association and no child reward estimate', () => {
    const html = questHtml([linkProps({ pointProgressMax: 200 })])
    const offers = parseRewardsQuestHtml(html, parentId)
    expect(offers).toHaveLength(1)
    expect(offers[0]).toMatchObject({
      sourceTaskId: childId,
      parentOfferId: parentId,
      quest,
      completed: 0,
      total: 1,
      executable: true
    })
    expect(offers[0]?.expectedPoints).toBeUndefined()
    expect(parseRewardsQuestHtml(html, 'OTHER_pcparent_Monthly_Test_punchcard')).toEqual([])
    expect(
      parseRewardsQuestHtml(
        questHtml([
          linkProps({ offerId: 'SYNTH_pcchild1_urlreward_Other_Monthly_Test_punchcard' })
        ]),
        parentId
      )
    ).toEqual([])
  })

  it('handles encoded Flight chunks and identical duplicate props once', () => {
    const raw = questHtml([linkProps(), linkProps()])
    const html = '<script>self.__next_f.push([1,' + JSON.stringify(raw) + '])</script>'
    expect(parseRewardsQuestHtml(html, parentId)).toHaveLength(1)
  })

  it.each([
    { isLocked: true },
    { isCompleted: true },
    { isDisabled: true },
    { href: 'http://www.bing.com/search?q=synthetic' },
    { href: 'https://example.test/search?q=synthetic' },
    { href: 'https://www.bing.com/search' },
    { href: 'https://www.bing.com:444/search?q=synthetic' },
    { href: 'https://synthetic:password@www.bing.com/search?q=synthetic' },
    { edgeAction: 'install-app' },
    { offerId: 'SYNTH_pcchild1_urlreward_RewardsApp_Exclusive_Test_punchcard' }
  ])('never executes locked, completed or unverified operation metadata (%j)', (overrides) => {
    const offers = parseRewardsQuestHtml(questHtml([linkProps(overrides)]), parentId)
    expect(offers.every((item) => !item.executable)).toBe(true)
  })

  it.each([
    { isLocked: undefined },
    { isCompleted: 'false' },
    { ariaLabel: 'Other title' },
    { linkText: '' }
  ])('ignores incomplete or conflicting identity (%j)', (overrides) => {
    expect(parseRewardsQuestHtml(questHtml([linkProps(overrides)]), parentId)).toEqual([])
  })

  it('disables conflicting duplicates regardless of ordering', () => {
    for (const props of [
      [linkProps(), linkProps({ isLocked: true })],
      [linkProps({ isLocked: true }), linkProps()]
    ]) {
      const result = parseRewardsQuestHtml(questHtml(props), parentId)
      expect(result).toHaveLength(1)
      expect(result[0]?.executable).toBe(false)
      expect(result[0]?.restrictionReason).toContain('歧义')
    }
  })

  it('uses the verified UI path even when a report hash is present', () => {
    expect(webOfferExecutionPath(childOffer(), true)).toBe('navigate-only')
    expect(webOfferExecutionPath(childOffer({ locked: true }), true)).toBe('unsupported')
    expect(webOfferExecutionPath(parentOffer({ isGroup: true }), true)).toBe('unsupported')
  })
})

describe('quest detail discovery', () => {
  it('reads each parent once, preserves ordinary cards and skips the group entry', async () => {
    const ordinary = {
      ...parentOffer(),
      sourceTaskId: 'synthetic-normal',
      type: 'more-promotion' as const
    }
    const result = await discover({ offers: [parentOffer(), parentOffer(), ordinary] })
    expect(result.readQuest).toHaveBeenCalledTimes(1)
    expect(result.tasks.find((task) => task.sourceTaskId === parentId)).toMatchObject({
      executable: false,
      status: 'skipped'
    })
    expect(result.tasks.find((task) => task.sourceTaskId === childId)).toMatchObject({
      quest,
      executable: true
    })
    expect(result.descriptors.get(childTask().taskId)?.quest).toEqual(quest)
    expect(
      result.snapshot.offers.find((offer) => offer.sourceTaskId === 'synthetic-normal')
    ).toEqual(ordinary)
  })

  it('does not read detail when punch cards are disabled', async () => {
    const result = await discover({ enabled: false })
    expect(result.readQuest).not.toHaveBeenCalled()
    expect(result.tasks.some((task) => task.sourceTaskId === childId)).toBe(false)
  })

  it('does not enable newly parsed child stubs when detail loading fails', async () => {
    const stub = parseRewardsHtml(
      JSON.stringify({
        offerId: parentId,
        childPromotions: [{ offerId: childId, hash: 'synthetic-hash', pointProgressMax: 5 }]
      })
    ).offers
    const ordinary = {
      ...parentOffer(),
      sourceTaskId: 'synthetic-normal',
      type: 'more-promotion' as const
    }
    const result = await discover({
      offers: [...stub, ordinary],
      readQuest: vi.fn().mockRejectedValue(new Error('synthetic timeout'))
    })
    expect(result.tasks.find((task) => task.sourceTaskId === childId)?.executable).toBe(false)
    expect(
      result.snapshot.offers.find((offer) => offer.sourceTaskId === 'synthetic-normal')
    ).toEqual(ordinary)
  })

  it('keeps locks after 24 hours and across days until the official state changes', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(date + 'T01:00:00Z'))
    const locked = questObservation({
      offers: [childOffer({ locked: true, executable: false })],
      rows: [{ title: quest.title, state: 'locked', actionCount: 0 }]
    })
    for (const localDate of [date, '2026-10-06', '2026-10-07']) {
      const result = await discover({ localDate, detail: locked })
      expect(result.tasks.find((task) => task.sourceTaskId === childId)).toMatchObject({
        executable: false,
        status: 'skipped'
      })
      expect(result.tasks.find((task) => task.sourceTaskId === childId)?.reason).toContain(
        '24 小时'
      )
      vi.setSystemTime(Date.now() + 24 * 60 * 60_000)
    }
    const open = await discover({ localDate: '2026-10-08' })
    expect(open.tasks.find((task) => task.sourceTaskId === childId)?.executable).toBe(true)
  })

  it('restores only same-account, same-day pending identities when completed Links disappear', async () => {
    const pending = childTask({ status: 'verification-pending' })
    const result = await discover({
      known: [
        pending,
        childTask({ accountId: 'other-account' }),
        childTask({ localDate: '2026-10-04' })
      ],
      detail: questObservation({
        offers: [],
        rows: [{ title: quest.title, state: 'completed', actionCount: 0 }]
      })
    })
    expect(result.readQuest).toHaveBeenCalledTimes(1)
    expect(result.descriptors.get(pending.taskId)).toMatchObject({
      task: { status: 'verification-pending', executable: false },
      quest
    })
    expect(result.tasks.filter((task) => task.quest)).toHaveLength(1)
  })

  it('retains pending identity when the current task is locked or has changed labels', async () => {
    const pending = childTask({ status: 'verification-pending' })
    for (const changed of [
      childOffer({ locked: true, executable: false }),
      childOffer({ complete: true, completed: 1, quest: { ...quest, title: 'Other task' } })
    ]) {
      const result = await discover({
        known: [pending],
        detail: questObservation({ offers: [changed] })
      })
      expect(result.descriptors.get(pending.taskId)).toMatchObject({
        quest,
        task: { quest, status: 'verification-pending', executable: false }
      })
    }
  })

  it('keeps a failed group unavailable while discovering the next package', async () => {
    const otherParent = 'SYNTH_pcparent_Other_Test_punchcard'
    const readQuest = vi
      .fn()
      .mockRejectedValueOnce(new Error('synthetic detail failure'))
      .mockResolvedValueOnce(questObservation())
    const result = await discover({
      offers: [parentOffer({ sourceTaskId: otherParent }), parentOffer()],
      readQuest
    })
    expect(readQuest).toHaveBeenCalledTimes(2)
    expect(result.tasks.find((task) => task.sourceTaskId === childId)?.executable).toBe(true)
    expect(result.tasks.find((task) => task.sourceTaskId === otherParent)).toMatchObject({
      executable: false,
      status: 'skipped'
    })
  })

  it('propagates cancellation and does not read the next package', async () => {
    const controller = new AbortController()
    const readQuest = vi.fn().mockImplementation(() => {
      const cancelled = new Error('synthetic cancelled')
      controller.abort(cancelled)
      return Promise.reject(cancelled)
    })
    await expect(
      discover({
        signal: controller.signal,
        readQuest,
        offers: [
          parentOffer(),
          parentOffer({ sourceTaskId: 'SYNTH_pcparent_Other_Test_punchcard' })
        ]
      })
    ).rejects.toThrow('synthetic cancelled')
    expect(readQuest).toHaveBeenCalledTimes(1)
  })
})

describe('official quest verification', () => {
  it('confirms a disappearing Link only by its unique completed row', () => {
    const result = verifyOfficialQuestTask(
      childTask(),
      quest,
      questObservation({
        offers: [],
        rows: [{ title: quest.title, state: 'completed', actionCount: 0 }]
      })
    )
    expect(result).toMatchObject({
      confirmed: true,
      progress: { completed: 1, total: 1 },
      credit: { verificationStatus: 'pending' }
    })
    expect(result.credit?.earnedPoints).toBeUndefined()
  })

  it.each(
    [
      [],
      [{ title: 'Other task', state: 'completed' as const, actionCount: 0 }],
      [{ title: quest.title, state: 'locked' as const, actionCount: 0 }],
      [{ title: quest.title, state: 'completed' as const, actionCount: 1 }],
      [{ title: quest.title, state: 'unknown' as const, actionCount: 0 }],
      [
        { title: quest.title, state: 'completed' as const, actionCount: 0 },
        { title: quest.title, state: 'completed' as const, actionCount: 0 }
      ]
    ].map((rows) => ({ rows }))
  )('never infers completion from a missing, conflicting or locked row (%j)', ({ rows }) => {
    expect(
      verifyOfficialQuestTask(childTask(), quest, questObservation({ offers: [], rows })).confirmed
    ).toBe(false)
  })

  it('rejects an observation from another package and wrong task metadata', () => {
    expect(
      verifyOfficialQuestTask(
        childTask(),
        quest,
        questObservation({ parentOfferId: 'another-parent' })
      ).confirmed
    ).toBe(false)
    expect(
      verifyOfficialQuestTask(
        childTask(),
        quest,
        questObservation({
          offers: [childOffer({ complete: true, quest: { ...quest, title: 'Other' } })]
        })
      ).confirmed
    ).toBe(false)
    expect(
      verifyOfficialQuestTask(
        childTask(),
        quest,
        questObservation({
          offers: [childOffer({ complete: true, completed: 1, source: 'bing-flyout' })]
        })
      ).confirmed
    ).toBe(false)
  })

  it('does not count one completed child as a completed package', async () => {
    const result = await discover({
      detail: questObservation({
        offers: [childOffer({ complete: true, completed: 1, executable: false })],
        rows: [{ title: quest.title, state: 'completed', actionCount: 0 }]
      })
    })
    expect(result.tasks.find((task) => task.sourceTaskId === childId)?.status).toBe('completed')
    expect(result.tasks.find((task) => task.sourceTaskId === parentId)?.status).toBe('skipped')
    expect(result.tasks.find((task) => task.sourceTaskId === parentId)?.progress.completed).toBe(0)
  })
})
