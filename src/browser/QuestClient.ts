import type { BrowserContext, Page } from 'patchright'
import type { QuestTaskContext } from '../domain/Task.js'
import type { StructuredLogger } from '../infra/StructuredLogger.js'
import { parseRewardsQuestHtml } from '../rewards/DashboardParser.js'
import type { QuestObservation, RewardOffer } from '../rewards/RewardsModel.js'
import {
  MutationNotStartedError,
  OfferActivationError,
  OfferUnavailableError
} from '../orchestration/MutationExecutor.js'
import { BusinessDateChanged } from '../orchestration/BusinessDate.js'
import { matchOfferAnchor, sameOfferUrl } from './OfferMatching.js'
import { readQuestAnchor, readQuestRows } from './QuestDom.js'
import { REWARDS_URLS } from './Urls.js'

const QUEST_BUDGET_MS = 90_000

type Check = () => number

/** Quest pages are owned separately so existing dashboard/card flows remain unchanged. */
export class QuestClient {
  constructor(
    private readonly context: BrowserContext,
    private readonly logger: StructuredLogger,
    private readonly runId: string,
    private readonly accountAlias: string
  ) {}

  async read(
    parentOfferId: string,
    signal?: AbortSignal,
    outerDeadline = Date.now() + QUEST_BUDGET_MS
  ) {
    return this.withPage(signal, outerDeadline, (page, check) =>
      this.load(page, parentOfferId, check)
    )
  }

  async activate(
    offer: RewardOffer,
    quest: QuestTaskContext,
    signal: AbortSignal,
    beforeActivate?: () => void
  ): Promise<void> {
    const activation = { started: false }
    try {
      await this.withPage(signal, Date.now() + QUEST_BUDGET_MS, async (page, check) => {
        const observation = await this.load(page, quest.parentOfferId, check)
        const matches = observation.offers.filter(
          (item) => item.sourceTaskId === offer.sourceTaskId
        )
        const current = matches[0]
        const rows = observation.rows.filter((row) => row.title === quest.title)
        if (
          matches.length !== 1 ||
          !current?.executable ||
          current.complete ||
          current.locked ||
          current.quest?.ariaLabel !== quest.ariaLabel ||
          current.quest.title !== quest.title ||
          !current.destinationUrl ||
          !offer.destinationUrl ||
          !sameOfferUrl(current.destinationUrl, offer.destinationUrl) ||
          rows.length !== 1 ||
          rows[0]?.state !== 'open'
        )
          throw new OfferUnavailableError(
            'Quest task is completed, locked, restricted or ambiguous'
          )
        check()
        const links = page.locator('a[href]')
        const anchors = await links.evaluateAll((nodes) =>
          nodes.map((node) => {
            const anchor = node as HTMLAnchorElement
            const row = anchor.closest('div.flex.flex-row')
            const headings = row?.querySelectorAll('h3')
            return {
              href: anchor.href,
              ariaLabel: anchor.getAttribute('aria-label') ?? '',
              rowTitle: headings?.length === 1 ? (headings[0]?.textContent.trim() ?? '') : '',
              offerId: anchor.getAttribute('data-offer-id') ?? '',
              visible:
                anchor.isConnected &&
                anchor.getClientRects().length > 0 &&
                window.getComputedStyle(anchor).visibility !== 'hidden',
              disabled:
                anchor.getAttribute('aria-disabled') === 'true' ||
                anchor.hasAttribute('disabled') ||
                anchor.hasAttribute('data-disabled')
            }
          })
        )
        check()
        const eligible = anchors.map((anchor) => ({
          ...anchor,
          visible:
            anchor.visible &&
            !anchor.disabled &&
            anchor.ariaLabel === quest.ariaLabel &&
            anchor.rowTitle === quest.title
        }))
        const identity = { sourceTaskId: offer.sourceTaskId, displayName: quest.ariaLabel }
        const match = matchOfferAnchor(eligible, current.destinationUrl, identity)
        if (match.index < 0) throw new OfferUnavailableError()
        const anchor = await links.nth(match.index).elementHandle()
        check()
        if (!anchor) throw new OfferUnavailableError()
        try {
          const candidate = await anchor.evaluate(readQuestAnchor)
          check()
          if (
            candidate.disabled ||
            candidate.rowTitle !== quest.title ||
            candidate.ariaLabel !== quest.ariaLabel ||
            matchOfferAnchor([candidate], current.destinationUrl, identity).index !== 0
          )
            throw new OfferUnavailableError()
          // Re-read the lock state after dynamic rendering and before the single click.
          const latest = parseRewardsQuestHtml(await page.content(), quest.parentOfferId).filter(
            (item) => item.sourceTaskId === offer.sourceTaskId
          )
          check()
          const refreshed = latest[0]
          if (
            latest.length !== 1 ||
            !refreshed?.executable ||
            refreshed.complete ||
            refreshed.locked ||
            refreshed.quest?.title !== quest.title ||
            refreshed.quest.ariaLabel !== quest.ariaLabel ||
            !refreshed.destinationUrl ||
            !sameOfferUrl(refreshed.destinationUrl, current.destinationUrl)
          )
            throw new OfferUnavailableError()
          const latestRows = (await page.evaluate(readQuestRows)).filter(
            (row) => row.title === quest.title
          )
          check()
          if (latestRows.length !== 1 || latestRows[0]?.state !== 'open')
            throw new OfferUnavailableError()
          await this.logger.write({
            level: 'info',
            event: 'offer-link-lookup',
            stage: 'quest',
            surface: 'quest',
            runId: this.runId,
            accountAlias: this.accountAlias,
            status: 'activating',
            result: 'matched',
            activationStarted: true
          })
          check()
          beforeActivate?.()
          check()
          activation.started = true
          await anchor.click({ timeout: Math.min(8_000, check()), noWaitAfter: true })
          check()
          await page.waitForTimeout(Math.min(3_000, check()))
          check()
        } finally {
          await anchor.dispose().catch(() => undefined)
        }
      })
    } catch (error) {
      if (activation.started) throw new OfferActivationError()
      if (signal.aborted) throw signal.reason
      if (error instanceof MutationNotStartedError || error instanceof BusinessDateChanged)
        throw error
      throw new MutationNotStartedError(
        'Quest activation preparation failed',
        'offer-browser-failed'
      )
    }
  }

  private async load(page: Page, parentOfferId: string, check: Check): Promise<QuestObservation> {
    if (!/^[A-Za-z0-9_-]+_pcparent_[A-Za-z0-9_-]+$/i.test(parentOfferId))
      throw new MutationNotStartedError('Invalid quest identity', 'offer-invalid-destination')
    const target = REWARDS_URLS.quest(parentOfferId)
    const response = await page.goto(target, {
      waitUntil: 'domcontentloaded',
      timeout: Math.min(30_000, check())
    })
    check()
    const actual = new URL(page.url())
    const expected = new URL(target)
    if (actual.origin !== expected.origin || actual.pathname !== expected.pathname)
      throw new MutationNotStartedError(
        'Quest authentication redirect',
        'offer-authentication-failed'
      )
    if (response && response.status() >= 400)
      throw new MutationNotStartedError('Quest page unavailable', 'offer-network-failed')
    await page
      .locator('h3')
      .first()
      .waitFor({ state: 'attached', timeout: Math.min(5_000, check()) })
    check()
    const html = await page.content()
    check()
    const rows = await page.evaluate(readQuestRows)
    check()
    return { parentOfferId, offers: parseRewardsQuestHtml(html, parentOfferId), rows }
  }

  private async withPage<T>(
    signal: AbortSignal | undefined,
    outerDeadline: number,
    work: (page: Page, check: Check) => Promise<T>
  ): Promise<T> {
    const deadline = Math.min(outerDeadline, Date.now() + QUEST_BUDGET_MS)
    let active = true
    const owned = new Set<Page>()
    const listeners = new Map<Page, (popup: Page) => void>()
    const check: Check = () => {
      if (signal?.aborted) throw signal.reason
      if (!active || Date.now() >= deadline) throw new Error('Quest deadline exhausted')
      return Math.max(1, deadline - Date.now())
    }
    check()
    const closing = new Map<Page, Promise<void>>()
    const close = (page: Page) => {
      const existing = closing.get(page)
      if (existing) return existing
      const pending = page.close().catch(() => undefined)
      closing.set(page, pending)
      return pending
    }
    const track = (page: Page) => {
      if (owned.has(page)) return
      owned.add(page)
      if (!active) {
        void close(page)
        return
      }
      const popup = (opened: Page) => {
        track(opened)
      }
      listeners.set(page, popup)
      page.on('popup', popup)
    }
    let rejectBoundary: (reason: unknown) => void = () => undefined
    const boundary = new Promise<never>((_, reject) => {
      rejectBoundary = reject
    })
    const stop = (reason: unknown) => {
      active = false
      for (const page of owned) void close(page)
      rejectBoundary(reason)
    }
    const abort = () => {
      stop(signal?.reason ?? new Error('Quest operation cancelled'))
    }
    const timer = setTimeout(() => {
      stop(new Error('Quest deadline exhausted'))
    }, check())
    signal?.addEventListener('abort', abort, { once: true })
    const running = (async () => {
      check()
      const page = await this.context.newPage()
      track(page)
      check()
      return work(page, check)
    })()
    try {
      return await Promise.race([running, boundary])
    } finally {
      active = false
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      // Page-scoped popup ownership protects unrelated tabs in this account context.
      let cleanupTimer: ReturnType<typeof setTimeout> | undefined
      const cleanupBoundary = new Promise<void>((resolve) => {
        cleanupTimer = setTimeout(resolve, 5_000)
      })
      try {
        await Promise.race([Promise.all([...owned].map(close)), cleanupBoundary])
      } finally {
        clearTimeout(cleanupTimer)
        for (const [page, popup] of listeners) page.off('popup', popup)
      }
    }
  }
}
