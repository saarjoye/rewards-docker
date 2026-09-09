import { randomInt } from 'node:crypto'

import type { APIResponse, BrowserContext, Locator, Page, Response } from 'patchright'

import type { StructuredLogger } from '../infra/StructuredLogger.js'
import { safePath } from '../security/Redactor.js'
import {
  extractActionIds,
  parseDashboardPayload,
  parseRewardsHtml
} from '../rewards/DashboardParser.js'
import type { RewardsObservation } from '../rewards/RewardsModel.js'
import type { RewardOffer } from '../rewards/RewardsModel.js'
import { inspectCreditStructure, type CreditStructure } from '../rewards/CreditStructure.js'
import { shouldRetry } from '../orchestration/RetryPolicy.js'
import {
  MutationNotStartedError,
  OfferUnavailableError
} from '../orchestration/MutationExecutor.js'
import { matchOfferAnchor, type OfferIdentity } from './OfferMatching.js'
import { officialCredit, type TaskCreditEvidence } from '../rewards/OfficialCredit.js'
import { BING_ORIGIN, REWARDS_ORIGIN, REWARDS_URLS } from './Urls.js'

const DASHBOARD_ATTEMPTS = 3
const DASHBOARD_REQUEST_TIMEOUT_MS = 8_000
const DASHBOARD_DEADLINE_MS = 55_000
const DISCOVERY_DEADLINE_MS = 90_000
const SCRIPT_SCAN_TIMEOUT_MS = 12_000
const SCRIPT_REQUEST_TIMEOUT_MS = 4_000
const SCRIPT_SCAN_CONCURRENCY = 6

export class DashboardFetchError extends Error {
  constructor(
    message: string,
    readonly status: number | undefined,
    readonly attempts: number,
    readonly durationMs: number
  ) {
    super(message)
    this.name = 'DashboardFetchError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function networkError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /timeout|timed out|ECONN|ENOTFOUND|EAI_AGAIN|socket|network|fetch failed/i.test(message)
}

function abortReason(signal: AbortSignal | undefined): Error {
  const reason = signal?.reason as unknown
  return reason instanceof Error ? reason : new Error('Operation was aborted')
}

async function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (milliseconds <= 0) return
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds)
    const abort = (): void => {
      clearTimeout(timer)
      reject(abortReason(signal))
    }
    signal?.addEventListener('abort', abort, { once: true })
  })
}

async function responseJson(response: APIResponse): Promise<unknown> {
  const text = await response.text()
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new DashboardResponseBodyError()
  }
}

class DashboardResponseBodyError extends TypeError {
  constructor() {
    super('Response body is not valid JSON')
    this.name = 'DashboardResponseBodyError'
  }
}

export interface RscBootstrap {
  html: readonly string[]
  offers: ReturnType<typeof parseRewardsHtml>['offers']
  domOffers?: readonly RewardOffer[]
  availablePoints: ReturnType<typeof parseRewardsHtml>['availablePoints']
  actionIds: Readonly<Record<string, string>>
  deploymentId?: string
  routerStateTree?: string
}

export interface OfferLinkInspection {
  found: boolean
  surface: 'earn' | 'dashboard' | 'none'
  opensNewPage: boolean
  sameOriginDestination: boolean
  hasInlineClick: boolean
  hasInteractiveAncestor: boolean
  attributeNames: readonly string[]
}

export interface ActivatedOfferPage {
  page: Page
  openedInNewPage: boolean
  close(): Promise<void>
}

export interface ClaimUiResult {
  clicked: boolean
  acknowledged: boolean
  status?: number
}

export interface ClaimControlInspection {
  text: string
  hasAllKeyword: boolean
  numbers: readonly number[]
  hasAriaLabel: boolean
  hasTitle: boolean
  disabled: boolean
  ariaDisabled: string
  ariaExpanded: string
  hasAriaControls: boolean
  role: string
  classes: readonly string[]
  attributeNames: readonly string[]
  pointerEvents: string
  hasReactClick: boolean
  hasReactPress: boolean
  interactiveAncestorTag: string
  interactiveAncestorClasses: readonly string[]
}

function serverActionAcknowledged(statusOk: boolean, responseText: string): boolean {
  return statusOk && /^\d+:true\s*$/m.test(responseText)
}

export class DashboardClient {
  private readonly confirmedObservations: RewardsObservation[] = []

  constructor(
    private readonly context: BrowserContext,
    private readonly page: Page,
    private readonly logger: StructuredLogger,
    private readonly runId: string,
    private readonly accountAlias: string,
    private readonly onObservation?: (observation: RewardsObservation) => void
  ) {}

  get latestObservation(): RewardsObservation | undefined {
    return this.confirmedObservations.at(-1)
  }

  async fetchDashboard(
    signal?: AbortSignal,
    outerDeadline = Date.now() + DASHBOARD_DEADLINE_MS
  ): Promise<RewardsObservation> {
    const started = Date.now()
    const deadline = Math.min(outerDeadline, started + DASHBOARD_DEADLINE_MS)
    const captured: RewardsObservation[] = []
    const listener = (response: Response): void => {
      const path = safePath(response.url())
      if (!path.endsWith('/api/getuserinfo') && !path.includes('/rewards/panelflyout/getuserinfo'))
        return
      void response
        .json()
        .then((payload: unknown) => {
          const source = path.includes('/panelflyout/') ? 'bing-flyout' : 'legacy-getuserinfo'
          captured.push(parseDashboardPayload(payload, source))
        })
        .catch(() => undefined)
    }
    this.page.on('response', listener)

    let attempts = 0
    let lastStatus: number | undefined
    let lastReason = 'dashboard unavailable'
    let allowFlyoutFallback = false
    try {
      while (attempts < DASHBOARD_ATTEMPTS) {
        attempts += 1
        if (signal?.aborted) throw abortReason(signal)
        const remaining = deadline - Date.now()
        if (remaining <= 0) break
        const requestStarted = Date.now()
        try {
          const response = await this.context.request.get(REWARDS_URLS.userInfo, {
            timeout: Math.min(DASHBOARD_REQUEST_TIMEOUT_MS, remaining),
            headers: { Referer: REWARDS_URLS.dashboard, Origin: REWARDS_ORIGIN }
          })
          try {
            lastStatus = response.status()
            const contentType = response.headers()['content-type'] ?? 'unknown'
            await this.logger.write({
              level: response.ok() ? 'debug' : 'warn',
              event: 'dashboard-request',
              runId: this.runId,
              accountAlias: this.accountAlias,
              attempt: attempts,
              httpStatus: lastStatus,
              durationMs: Date.now() - requestStarted,
              path: safePath(response.url()),
              message: `content-type=${contentType.split(';')[0] ?? 'unknown'}`
            })
            if (response.ok()) {
              try {
                const observation = parseDashboardPayload(
                  await responseJson(response),
                  'legacy-getuserinfo'
                )
                this.accept(observation)
                return observation
              } catch (error) {
                lastReason = error instanceof Error ? error.message : 'dashboard parse error'
                allowFlyoutFallback = true
                const retryTransientBody =
                  error instanceof DashboardResponseBodyError &&
                  this.latestObservation !== undefined &&
                  attempts < DASHBOARD_ATTEMPTS
                if (!retryTransientBody) break
              }
            } else {
              lastReason = `dashboard HTTP ${String(lastStatus)}`
              allowFlyoutFallback = [502, 503, 504].includes(lastStatus)
              if (
                !shouldRetry({
                  kind: 'read-only',
                  attempt: attempts,
                  maxAttempts: DASHBOARD_ATTEMPTS,
                  status: lastStatus
                })
              )
                break
            }
          } finally {
            await response.dispose()
          }
        } catch (error) {
          lastReason = error instanceof Error ? error.message : 'dashboard network error'
          allowFlyoutFallback = networkError(error) || /timeout|timed out/i.test(lastReason)
          const retry = shouldRetry({
            kind: 'read-only',
            attempt: attempts,
            maxAttempts: DASHBOARD_ATTEMPTS,
            ...(lastStatus === undefined ? {} : { status: lastStatus }),
            timedOut: /timeout|timed out/i.test(lastReason),
            networkError: networkError(error)
          })
          if (!retry) break
        }
        if (attempts < DASHBOARD_ATTEMPTS) {
          await delay((attempts === 1 ? 500 : 1000) + randomInt(0, 251), signal)
        }
      }

      const capturedObservation = captured.find(
        (item) => item.availablePoints.availability === 'valid' && item.rewardsUser.value === true
      )
      if (capturedObservation) {
        this.accept(capturedObservation)
        return capturedObservation
      }

      const currentHtml = await this.page.content().catch(() => '')
      const currentParsed = currentHtml ? parseRewardsHtml(currentHtml) : undefined
      if (currentParsed?.availablePoints.availability === 'valid') {
        return this.fromHtml(currentParsed)
      }

      if (deadline - Date.now() > 3_000) {
        await this.page
          .goto(REWARDS_URLS.dashboard, {
            waitUntil: 'domcontentloaded',
            timeout: Math.min(15_000, deadline - Date.now())
          })
          .catch(() => undefined)
        const reloaded = captured.find(
          (item) => item.availablePoints.availability === 'valid' && item.rewardsUser.value === true
        )
        if (reloaded) {
          this.accept(reloaded)
          return reloaded
        }
        const html = await this.page.content().catch(() => '')
        const parsed = html ? parseRewardsHtml(html) : undefined
        if (parsed?.availablePoints.availability === 'valid') return this.fromHtml(parsed)
      }

      if (deadline - Date.now() > 3_000) {
        const html = await this.fetchHtml(REWARDS_URLS.dashboard, deadline)
        if (html) {
          const parsed = parseRewardsHtml(html)
          if (parsed.availablePoints.availability === 'valid') return this.fromHtml(parsed)
        }
      }

      if (
        deadline - Date.now() > 3_000 &&
        (allowFlyoutFallback || lastStatus === undefined || [502, 503, 504].includes(lastStatus))
      ) {
        const flyout = await this.fetchFlyout(deadline)
        if (flyout) return flyout
      }

      throw new DashboardFetchError(
        `dashboard 获取失败: ${lastReason}`,
        lastStatus,
        attempts,
        Date.now() - started
      )
    } finally {
      this.page.off('response', listener)
    }
  }

  async fetchFlyout(
    deadline = Date.now() + 15_000,
    signal?: AbortSignal
  ): Promise<RewardsObservation | undefined> {
    if (signal?.aborted) throw abortReason(signal)
    const remaining = deadline - Date.now()
    if (remaining <= 0) return undefined
    const response = await this.context.request
      .get(REWARDS_URLS.flyout, {
        timeout: Math.min(10_000, remaining),
        headers: { Referer: BING_ORIGIN, Origin: BING_ORIGIN }
      })
      .catch(() => undefined)
    if (signal?.aborted) throw abortReason(signal)
    if (!response) return undefined
    try {
      if (signal?.aborted) throw abortReason(signal)
      await this.logger.write({
        level: response.ok() ? 'debug' : 'warn',
        event: 'bing-flyout-request',
        runId: this.runId,
        accountAlias: this.accountAlias,
        httpStatus: response.status(),
        path: safePath(response.url())
      })
      if (!response.ok()) return undefined
      const observation = parseDashboardPayload(await responseJson(response), 'bing-flyout')
      if (observation.rewardsUser.value !== true) return undefined
      this.accept(observation)
      return observation
    } catch {
      return undefined
    } finally {
      await response.dispose()
    }
  }

  async bootstrapRsc(
    signal?: AbortSignal,
    outerDeadline = Date.now() + DISCOVERY_DEADLINE_MS
  ): Promise<RscBootstrap> {
    const deadline = Math.min(outerDeadline, Date.now() + DISCOVERY_DEADLINE_MS)
    const targets = [
      { url: REWARDS_URLS.earn, segment: 'earn' as const },
      { url: REWARDS_URLS.dashboard, segment: 'dashboard' as const }
    ]
    const pages: string[] = []
    const domOffers: RewardOffer[] = []
    for (const { url } of targets) {
      if (signal?.aborted) throw abortReason(signal)
      const navigationRemaining = deadline - Date.now()
      if (navigationRemaining <= 0) throw new Error('RSC discovery deadline exhausted')
      await this.page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: Math.min(30_000, navigationRemaining)
      })
      if (new URL(this.page.url()).hostname !== 'rewards.bing.com') {
        throw new Error(`Rewards 页面重定向: ${safePath(this.page.url())}`)
      }
      const contentRemaining = deadline - Date.now()
      if (contentRemaining <= 0) throw new Error('RSC discovery deadline exhausted')
      await this.page
        .locator('main section, [role="main"] section')
        .first()
        .waitFor({
          state: 'attached',
          timeout: Math.min(15_000, contentRemaining)
        })
        .catch(() => undefined)
      await this.page.waitForTimeout(Math.min(1_000, Math.max(1, deadline - Date.now())))
      if (url === REWARDS_URLS.earn) domOffers.push(...(await this.readDomOffersFromCurrentPage()))
      pages.push(await this.page.content())
    }

    const parsed = pages.map((html, index) => parseRewardsHtml(html, targets[index]?.segment))
    const scripts = await this.readReferencedScripts(pages, signal, deadline)
    const actionIds = extractActionIds(scripts)
    const offers = new Map<string, RscBootstrap['offers'][number]>()
    for (const result of parsed) {
      for (const offer of result.offers) offers.set(offer.sourceTaskId, offer)
    }
    const firstParsed = parsed[0]
    if (!firstParsed) throw new DashboardFetchError('Rewards 页面未返回可解析内容', undefined, 0, 0)
    const availablePoints =
      parsed.find((result) => result.availablePoints.availability === 'valid')?.availablePoints ??
      firstParsed.availablePoints
    const deploymentId = parsed.find((result) => result.deploymentId)?.deploymentId
    const routerStateTree = parsed[1]?.routerStateTree
    return {
      html: pages,
      offers: [...offers.values()],
      domOffers,
      availablePoints,
      actionIds,
      ...(deploymentId === undefined ? {} : { deploymentId }),
      ...(routerStateTree === undefined ? {} : { routerStateTree })
    }
  }

  async fetchAppDashboard(
    accessToken: string,
    onStructure?: (structure: CreditStructure) => void
  ): Promise<RewardsObservation> {
    const response = await this.context.request.get(REWARDS_URLS.appDashboard, {
      timeout: 15_000,
      headers: this.appHeaders(accessToken)
    })
    try {
      if (!response.ok()) {
        throw new DashboardFetchError('App Dashboard 请求失败', response.status(), 1, 0)
      }
      const payload = await responseJson(response)
      if (onStructure) onStructure(inspectCreditStructure(payload))
      const observation = parseDashboardPayload(payload, 'app-dashboard')
      this.accept(observation)
      return observation
    } finally {
      await response.dispose()
    }
  }

  async reportServerAction(input: {
    actionId: string
    body: readonly unknown[]
    url?: string
    referer?: string
    deploymentId?: string
    routerStateTree: string
    offerId?: string
  }): Promise<{ status: number; acknowledged: boolean; credit?: TaskCreditEvidence }> {
    const url = input.url ?? REWARDS_URLS.earn
    const referer = input.referer ?? url
    const refererUrl = new URL(referer)
    const currentUrl = new URL(this.page.url())
    if (currentUrl.origin !== refererUrl.origin || currentUrl.pathname !== refererUrl.pathname) {
      await this.page.goto(referer, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      const finalUrl = new URL(this.page.url())
      if (finalUrl.origin !== refererUrl.origin || finalUrl.pathname !== refererUrl.pathname) {
        throw new Error(`Server Action 页面重定向: ${safePath(this.page.url())}`)
      }
    }

    const response = await this.page.evaluate(
      async ({ requestUrl, headers, body, timeoutMs }) => {
        const controller = new AbortController()
        const timeout = window.setTimeout(() => {
          controller.abort()
        }, timeoutMs)
        try {
          const result = await fetch(requestUrl, {
            method: 'POST',
            credentials: 'include',
            headers,
            body,
            signal: controller.signal
          })
          return { status: result.status, ok: result.ok, text: await result.text() }
        } finally {
          window.clearTimeout(timeout)
        }
      },
      {
        requestUrl: url,
        headers: {
          Accept: 'text/x-component',
          'Content-Type': 'text/plain;charset=UTF-8',
          'Next-Action': input.actionId,
          'Next-Router-State-Tree': input.routerStateTree,
          ...(input.deploymentId ? { 'X-Deployment-Id': input.deploymentId } : {})
        },
        body: JSON.stringify(input.body),
        timeoutMs: 20_000
      }
    )
    let credit: TaskCreditEvidence | undefined
    if (response.ok && input.offerId) {
      for (const line of response.text.split('\n')) {
        try {
          const parsed: unknown = JSON.parse(line.replace(/^[0-9a-f]+:/i, ''))
          const candidate = officialCredit(parsed, input.offerId)
          if (candidate) {
            if (
              credit &&
              (credit.officialCreditId !== candidate.officialCreditId ||
                credit.earnedPoints !== candidate.earnedPoints)
            ) {
              credit = undefined
              break
            }
            credit = candidate
          }
        } catch {
          /* Non-JSON RSC chunks are not credit evidence. */
        }
      }
    }
    return {
      status: response.status,
      acknowledged: serverActionAcknowledged(response.ok, response.text),
      ...(credit ? { credit } : {})
    }
  }

  async submitAppActivity(
    accessToken: string,
    payload: Readonly<Record<string, unknown>>,
    onStructure?: (structure: CreditStructure) => void,
    onCredit?: (credit: TaskCreditEvidence) => void
  ): Promise<number | undefined> {
    const response = await this.context.request.post(REWARDS_URLS.appActivities, {
      timeout: 20_000,
      headers: {
        ...this.appActivityHeaders(accessToken, payload),
        'Content-Type': 'application/json'
      },
      data: payload
    })
    try {
      if (!response.ok()) throw new Error(`App activity HTTP ${String(response.status())}`)
      const body = await responseJson(response)
      const offerId =
        isRecord(payload.attributes) && typeof payload.attributes.offerid === 'string'
          ? payload.attributes.offerid
          : undefined
      const credit = officialCredit(body, offerId)
      if (credit) onCredit?.(credit)
      if (onStructure)
        onStructure(inspectCreditStructure(body, 'allowlisted-app-activity-structure'))
      const balance = isRecord(body) && isRecord(body.response) ? body.response.balance : undefined
      return typeof balance === 'number' && Number.isSafeInteger(balance) && balance >= 0
        ? balance
        : undefined
    } finally {
      await response.dispose()
    }
  }

  async navigateOffer(url: string, identity: OfferIdentity = {}): Promise<void> {
    const activated = await this.openOfferForInteraction(url, identity)
    try {
      await activated.page.waitForTimeout(3_000)
    } finally {
      await activated.close()
    }
  }

  async openOfferForInteraction(
    url: string,
    identity: OfferIdentity = {}
  ): Promise<ActivatedOfferPage> {
    let activationStarted = false
    try {
      const destination = new URL(url, REWARDS_ORIGIN)
      if (destination.protocol !== 'https:' || destination.username || destination.password)
        throw new TypeError('Offer destination must use credential-free HTTPS')
      // Retry discovery only before activation. A click with an unknown result is never repeated.
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        const surfaces = [REWARDS_URLS.earn, REWARDS_URLS.dashboard]
        for (const surface of surfaces) {
          const current = new URL(this.page.url())
          const expected = new URL(surface)
          if (current.origin !== expected.origin || current.pathname !== expected.pathname) {
            await this.page.goto(surface, { waitUntil: 'domcontentloaded', timeout: 30_000 })
          }
          await this.page.waitForTimeout(1_000)
          if (new URL(this.page.url()).origin !== expected.origin)
            throw new MutationNotStartedError('Offer surface redirected before activation')
          const anchorIndex = await this.offerAnchorIndex(
            destination.href,
            undefined,
            identity,
            expected.pathname,
            attempt
          )
          if (anchorIndex < 0) continue
          const anchor = this.page.locator('a[href]').nth(anchorIndex)
          activationStarted = true
          return await this.activateOfferAnchor(anchor)
        }

        await this.page.goto(BING_ORIGIN, { waitUntil: 'domcontentloaded', timeout: 30_000 })
        await this.page.waitForTimeout(1_000)
        const triggerSelectors = [
          '#id_rh',
          '[aria-label*="Microsoft Rewards" i]',
          '[title*="Microsoft Rewards" i]',
          'a[href*="rewards" i]'
        ]
        let flyoutOpened = false
        let flyoutInspected = false
        for (const selector of triggerSelectors) {
          const trigger = this.page.locator(selector).first()
          if ((await trigger.count()) === 0 || !(await trigger.isVisible().catch(() => false)))
            continue
          await trigger.click({ timeout: 10_000 })
          flyoutOpened = true
          break
        }
        if (flyoutOpened) {
          await this.page.waitForTimeout(2_000)
          for (const frame of this.page.frames()) {
            const frameUrl = new URL(frame.url())
            if (
              frameUrl.protocol !== 'https:' ||
              !['bing.com', 'www.bing.com', 'cn.bing.com'].includes(frameUrl.hostname) ||
              !frameUrl.pathname.includes('/rewards/panelflyout')
            )
              continue
            const links = frame.locator('a[href]')
            flyoutInspected = true
            const anchorIndex = await this.offerAnchorIndex(
              destination.href,
              links,
              identity,
              'bing-flyout',
              attempt
            )
            if (anchorIndex < 0) continue
            activationStarted = true
            return await this.activateOfferAnchor(links.nth(anchorIndex))
          }
        }
        if (!flyoutInspected)
          await this.logger.write({
            level: 'info',
            event: 'offer-link-lookup',
            stage: 'bing-flyout',
            attempt,
            status: 'unavailable',
            message: 'candidates=0; matched=false'
          })
      }
      throw new OfferUnavailableError(
        'Offer currently unavailable after two surface discoveries; no task was submitted'
      )
    } catch (error) {
      if (activationStarted || error instanceof MutationNotStartedError) throw error
      await this.logger.write({
        level: 'warn',
        event: 'offer-link-lookup',
        stage: 'pre-activation',
        status: networkError(error) ? 'network-error' : 'browser-or-authentication-error'
      })
      throw new MutationNotStartedError('Offer lookup failed before activation')
    }
  }

  async inspectOfferLink(url: string): Promise<OfferLinkInspection> {
    const destination = new URL(url, REWARDS_ORIGIN)
    if (destination.protocol !== 'https:') throw new TypeError('Offer destination must use HTTPS')
    const surfaces = [
      { name: 'earn' as const, url: REWARDS_URLS.earn },
      { name: 'dashboard' as const, url: REWARDS_URLS.dashboard }
    ]
    for (const surface of surfaces) {
      const current = new URL(this.page.url())
      const expected = new URL(surface.url)
      if (current.origin !== expected.origin || current.pathname !== expected.pathname) {
        await this.page.goto(surface.url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      }
      await this.page.waitForTimeout(1_000)
      const anchorIndex = await this.offerAnchorIndex(destination.href)
      const inspection = await this.page.evaluate((index) => {
        const anchor = [...document.querySelectorAll<HTMLAnchorElement>('a[href]')][index]
        if (!anchor) return undefined
        const interactive = anchor.parentElement?.closest('button, [role="button"]')
        return {
          opensNewPage: anchor.target.toLowerCase() === '_blank',
          sameOriginDestination: new URL(anchor.href).origin === window.location.origin,
          hasInlineClick: anchor.hasAttribute('onclick'),
          hasInteractiveAncestor: interactive != null,
          attributeNames: anchor
            .getAttributeNames()
            .filter((name) => !['href', 'aria-label', 'title'].includes(name.toLowerCase()))
            .sort()
        }
      }, anchorIndex)
      if (inspection) return { found: true, surface: surface.name, ...inspection }
    }
    return {
      found: false,
      surface: 'none',
      opensNewPage: false,
      sameOriginDestination: destination.origin === REWARDS_ORIGIN,
      hasInlineClick: false,
      hasInteractiveAncestor: false,
      attributeNames: []
    }
  }

  async discoverDomOffers(
    signal?: AbortSignal,
    deadline = Date.now() + DISCOVERY_DEADLINE_MS
  ): Promise<readonly RewardOffer[]> {
    if (signal?.aborted) throw abortReason(signal)
    if (new URL(this.page.url()).pathname !== '/earn') {
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new Error('DOM discovery deadline exhausted')
      await this.page.goto(REWARDS_URLS.earn, {
        waitUntil: 'domcontentloaded',
        timeout: Math.min(30_000, remaining)
      })
    }
    const contentRemaining = deadline - Date.now()
    if (contentRemaining <= 0) throw new Error('DOM discovery deadline exhausted')
    await this.page
      .locator('main section, [role="main"] section')
      .first()
      .waitFor({
        state: 'attached',
        timeout: Math.min(15_000, contentRemaining)
      })
      .catch(() => undefined)
    await this.page.waitForTimeout(Math.min(1_000, Math.max(1, deadline - Date.now())))
    return this.readDomOffersFromCurrentPage()
  }

  private async readDomOffersFromCurrentPage(): Promise<readonly RewardOffer[]> {
    return this.page.evaluate(() => {
      const sections = [...document.querySelectorAll('main section, [role="main"] section')]
      return sections.flatMap((section) => {
        const sectionId = section.id.toLowerCase()
        let type: RewardOffer['type'] = 'unknown'
        if (sectionId.includes('daily')) type = 'daily-set'
        else if (sectionId.includes('quest')) type = 'punch-card'
        else if (sectionId.includes('more')) type = 'more-promotion'
        else if (sectionId.includes('level') || sectionId.includes('special'))
          type = 'special-promotion'

        return [...section.querySelectorAll<HTMLAnchorElement>('a[href]')].flatMap(
          (anchor, index) => {
            const text = (anchor.getAttribute('aria-label') || anchor.innerText || '')
              .replace(/\s+/g, ' ')
              .trim()
            if (!text || /redeem|兑换|refer|推荐/i.test(text)) return []
            const sourceTaskId =
              anchor.href.match(/\/quest\/([^/?#]+)/i)?.[1] ??
              anchor.getAttribute('data-offer-id') ??
              `${sectionId || 'section'}-${String(index + 1)}`
            const progress = text.match(/(\d+)\s*\/\s*(\d+)/)
            const completed = progress
              ? Number(progress[1])
              : /completed|已完成/i.test(text)
                ? 1
                : 0
            const total = progress ? Number(progress[2]) : /completed|已完成/i.test(text) ? 1 : null
            return [
              {
                sourceTaskId,
                identityStable: Boolean(
                  anchor.href.match(/\/quest\/([^/?#]+)/i)?.[1] ||
                  anchor.getAttribute('data-offer-id')
                ),
                type,
                source: 'rsc' as const,
                displayName: text.slice(0, 160),
                completed,
                total,
                complete: total !== null && completed >= total,
                executable: type !== 'unknown',
                destinationUrl: anchor.href
              }
            ]
          }
        )
      })
    })
  }

  private async offerAnchorIndex(
    destinationUrl: string,
    links?: Locator,
    identity: OfferIdentity = {},
    surface = 'inspection',
    attempt = 1
  ): Promise<number> {
    const candidates = await (links ?? this.page.locator('a[href]')).evaluateAll((anchors) =>
      anchors.map((candidate) => {
        const anchor = candidate as HTMLAnchorElement
        const owner = anchor.closest('[data-offer-id], [data-task-id]')
        return {
          href: anchor.href,
          visible:
            anchor.getClientRects().length > 0 &&
            window.getComputedStyle(anchor).visibility !== 'hidden',
          offerId:
            anchor.getAttribute('data-offer-id') ?? owner?.getAttribute('data-offer-id') ?? '',
          taskId: anchor.getAttribute('data-task-id') ?? owner?.getAttribute('data-task-id') ?? '',
          destinationUrl:
            anchor.getAttribute('data-destination-url') ??
            owner?.getAttribute('data-destination-url') ??
            '',
          ariaLabel: anchor.getAttribute('aria-label') ?? '',
          title: anchor.getAttribute('title') ?? ''
        }
      })
    )
    const match = matchOfferAnchor(candidates, destinationUrl, identity)
    await this.logger.write({
      level: 'info',
      event: 'offer-link-lookup',
      stage: surface,
      attempt,
      status: match.method,
      message: `candidates=${String(candidates.length)}; matched=${String(match.index >= 0)}`
    })
    return match.index
  }

  private async activateOfferAnchor(anchor: Locator): Promise<ActivatedOfferPage> {
    const opensNewPage = (await anchor.getAttribute('target'))?.toLowerCase() === '_blank'
    if (opensNewPage) {
      const openedPage = this.context
        .waitForEvent('page', { timeout: 10_000 })
        .catch(() => undefined)
      await anchor.click({ timeout: 10_000 })
      const opened = await openedPage
      if (opened) {
        await opened
          .waitForLoadState('domcontentloaded', { timeout: 15_000 })
          .catch(() => undefined)
        return {
          page: opened,
          openedInNewPage: true,
          close: () => opened.close().catch(() => undefined)
        }
      } else {
        await this.page.waitForTimeout(3_000)
      }
      return {
        page: this.page,
        openedInNewPage: false,
        close: () => Promise.resolve()
      }
    }
    await anchor.click({ timeout: 10_000 })
    await this.page.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => undefined)
    return {
      page: this.page,
      openedInNewPage: false,
      close: () => Promise.resolve()
    }
  }

  async readClaimablePoints(): Promise<number | undefined> {
    if (new URL(this.page.url()).pathname !== '/dashboard') {
      await this.page.goto(REWARDS_URLS.dashboard, {
        waitUntil: 'domcontentloaded',
        timeout: 30_000
      })
    }
    return this.page.evaluate(() => {
      const candidates = [...document.querySelectorAll('button')]
      for (const button of candidates) {
        const text = (button.getAttribute('aria-label') || button.textContent || '')
          .replace(/\s+/g, ' ')
          .trim()
        if (!/claim|领取/i.test(text)) continue
        const match = text.match(/([\d,]+)/)
        if (!match?.[1]) continue
        const points = Number(match[1].replaceAll(',', ''))
        if (Number.isSafeInteger(points) && points >= 0) return points
      }
      return undefined
    })
  }

  async inspectClaimControls(): Promise<readonly ClaimControlInspection[]> {
    if (new URL(this.page.url()).pathname !== '/dashboard') {
      await this.page.goto(REWARDS_URLS.dashboard, {
        waitUntil: 'domcontentloaded',
        timeout: 30_000
      })
    }
    return this.page.evaluate(() =>
      [...document.querySelectorAll('button')]
        .map((button) => {
          const text = (button.getAttribute('aria-label') || button.textContent || '')
            .replace(/\s+/g, ' ')
            .trim()
          const reactPropsKey = Object.keys(button).find((key) => key.startsWith('__reactProps'))
          const reactProps = reactPropsKey
            ? (button as unknown as Record<string, Record<string, unknown>>)[reactPropsKey]
            : undefined
          const interactiveAncestor = button.parentElement?.closest<HTMLElement>(
            'a, [role="button"], [data-react-aria-pressable]'
          )
          return {
            text: text.slice(0, 120),
            hasAllKeyword: /\ball\b|全部|所有/i.test(text),
            numbers: [...text.matchAll(/[\d,]+/g)]
              .map(([value]) => Number(value.replaceAll(',', '')))
              .filter((value) => Number.isSafeInteger(value) && value >= 0),
            hasAriaLabel: button.hasAttribute('aria-label'),
            hasTitle: button.hasAttribute('title'),
            disabled: button.disabled,
            ariaDisabled: button.getAttribute('aria-disabled') ?? '',
            ariaExpanded: button.getAttribute('aria-expanded') ?? '',
            hasAriaControls: button.hasAttribute('aria-controls'),
            role: button.getAttribute('role') ?? '',
            classes: [...button.classList].slice(0, 8),
            attributeNames: button
              .getAttributeNames()
              .filter((name) => !['aria-label', 'title', 'value'].includes(name.toLowerCase()))
              .sort(),
            pointerEvents: window.getComputedStyle(button).pointerEvents,
            hasReactClick: typeof reactProps?.onClick === 'function',
            hasReactPress: typeof reactProps?.onPress === 'function',
            interactiveAncestorTag: interactiveAncestor?.tagName.toLowerCase() ?? '',
            interactiveAncestorClasses: [...(interactiveAncestor?.classList ?? [])].slice(0, 8)
          }
        })
        .filter(({ text }) => /claim|领取/i.test(text))
        .slice(0, 12)
    )
  }

  async inspectExpandedClaimControls(): Promise<readonly ClaimControlInspection[]> {
    if (new URL(this.page.url()).pathname !== '/dashboard') {
      await this.page.goto(REWARDS_URLS.dashboard, {
        waitUntil: 'domcontentloaded',
        timeout: 30_000
      })
    }
    const buttons = this.page.locator('button[aria-expanded]')
    const count = await buttons.count()
    const candidates: number[] = []
    for (let index = 0; index < count; index += 1) {
      const button = buttons.nth(index)
      const text = ((await button.getAttribute('aria-label')) ?? (await button.textContent()) ?? '')
        .replace(/\s+/g, ' ')
        .trim()
      const points = Number(text.match(/([\d,]+)/)?.[1]?.replaceAll(',', '') ?? '0')
      if (/claim|领取/i.test(text) && Number.isSafeInteger(points) && points > 0) {
        candidates.push(index)
      }
    }
    if (candidates.length !== 1) throw new Error('Claim disclosure control is ambiguous')
    await buttons.nth(candidates[0] ?? -1).click({ timeout: 10_000 })
    await this.page.waitForTimeout(750)
    return this.inspectClaimControls()
  }

  async claimBonusByUi(): Promise<boolean> {
    return (await this.claimBonusByUiWithResult()).clicked
  }

  async claimBonusByUiWithResult(): Promise<ClaimUiResult> {
    if (new URL(this.page.url()).pathname !== '/dashboard') {
      await this.page.goto(REWARDS_URLS.dashboard, {
        waitUntil: 'domcontentloaded',
        timeout: 30_000
      })
    }
    let buttons = this.page.locator('button')
    let candidates = await this.positiveClaimButtonIndices(buttons)
    if (candidates.length !== 1) return { clicked: false, acknowledged: false }
    const initialButton = buttons.nth(candidates[0] ?? -1)
    if ((await initialButton.getAttribute('aria-expanded')) !== null) {
      await initialButton.click({ timeout: 10_000 })
      await this.page.waitForTimeout(750)
      buttons = this.page.locator('button:not([aria-expanded])')
      candidates = await this.positiveClaimButtonIndices(buttons)
      if (candidates.length !== 1) return { clicked: false, acknowledged: false }
    }
    const responsePromise = this.page
      .waitForResponse(
        (response) => {
          const request = response.request()
          if (request.method() !== 'POST') return false
          const responseUrl = new URL(response.url())
          if (responseUrl.origin !== REWARDS_ORIGIN) return false
          const contentType = response.headers()['content-type']?.toLowerCase() ?? ''
          return contentType.includes('text/x-component')
        },
        { timeout: 10_000 }
      )
      .catch(() => undefined)
    await buttons.nth(candidates[0] ?? -1).click({ timeout: 10_000 })
    const response = await responsePromise
    await this.page.waitForTimeout(2_000)
    if (!response) return { clicked: true, acknowledged: false }
    const responseText = await response.text().catch(() => '')
    return {
      clicked: true,
      status: response.status(),
      acknowledged: serverActionAcknowledged(response.ok(), responseText)
    }
  }

  private async positiveClaimButtonIndices(buttons: Locator): Promise<number[]> {
    const count = await buttons.count()
    const candidates: number[] = []
    for (let index = 0; index < count; index += 1) {
      const button = buttons.nth(index)
      const text = ((await button.getAttribute('aria-label')) ?? (await button.textContent()) ?? '')
        .replace(/\s+/g, ' ')
        .trim()
      if (!/claim|领取/i.test(text)) continue
      const points = Number(text.match(/([\d,]+)/)?.[1]?.replaceAll(',', '') ?? '0')
      if (Number.isSafeInteger(points) && points > 0) candidates.push(index)
    }
    return candidates
  }

  private async fetchHtml(url: string, deadline: number): Promise<string | undefined> {
    const response = await this.context.request
      .get(url, {
        timeout: Math.min(10_000, Math.max(1, deadline - Date.now())),
        maxRedirects: 10,
        headers: { Referer: REWARDS_ORIGIN }
      })
      .catch(() => undefined)
    if (!response) return undefined
    try {
      const final = new URL(response.url())
      if (!response.ok() || final.hostname !== 'rewards.bing.com') return undefined
      return await response.text()
    } finally {
      await response.dispose()
    }
  }

  private fromHtml(parsed: ReturnType<typeof parseRewardsHtml>): RewardsObservation {
    const observation: RewardsObservation = {
      source: 'rsc',
      rewardsUser: {
        availability: 'valid',
        source: 'rsc',
        confidence: 0.75,
        observedAt: new Date().toISOString(),
        value: true
      },
      market: {
        availability: 'missing',
        source: 'rsc',
        confidence: 0,
        observedAt: new Date().toISOString(),
        reason: 'market is not accepted from page HTML'
      },
      availablePoints: parsed.availablePoints,
      pcSearch: {
        availability: 'missing',
        source: 'rsc',
        confidence: 0,
        observedAt: new Date().toISOString(),
        reason: 'pcSearch missing from Flight data'
      },
      mobileSearch: {
        availability: 'missing',
        source: 'rsc',
        confidence: 0,
        observedAt: new Date().toISOString(),
        reason: 'mobileSearch missing from Flight data'
      },
      offers: parsed.offers,
      topLevelFields: ['flight']
    }
    this.accept(observation)
    return observation
  }

  private accept(observation: RewardsObservation): void {
    if (observation.availablePoints.availability === 'valid') {
      this.confirmedObservations.push(observation)
      this.onObservation?.(observation)
    }
  }

  private async readReferencedScripts(
    htmlPages: readonly string[],
    signal?: AbortSignal,
    outerDeadline = Date.now() + SCRIPT_SCAN_TIMEOUT_MS
  ): Promise<string[]> {
    const sources = new Set<string>()
    for (const html of htmlPages) {
      for (const match of html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)) {
        if (match[1]) sources.add(new URL(match[1], REWARDS_ORIGIN).href)
      }
    }
    const urls = [...sources].slice(0, 30)
    const scriptResults: Array<string | undefined> = Array.from({ length: urls.length })
    const deadline = Math.min(outerDeadline, Date.now() + SCRIPT_SCAN_TIMEOUT_MS)
    let nextIndex = 0
    const worker = async (): Promise<void> => {
      while (nextIndex < urls.length) {
        if (signal?.aborted) throw abortReason(signal)
        const remaining = deadline - Date.now()
        if (remaining <= 0) return
        const currentIndex = nextIndex
        const url = urls[currentIndex]
        nextIndex += 1
        if (!url) continue
        const response = await this.context.request
          .get(url, { timeout: Math.min(SCRIPT_REQUEST_TIMEOUT_MS, remaining) })
          .catch(() => undefined)
        if (!response) continue
        try {
          if (response.ok()) scriptResults[currentIndex] = await response.text()
        } finally {
          await response.dispose()
        }
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(SCRIPT_SCAN_CONCURRENCY, urls.length) }, () => worker())
    )
    return scriptResults.filter((script): script is string => script !== undefined)
  }

  private appHeaders(accessToken: string): Record<string, string> {
    return {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      'User-Agent':
        'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/140.0.0.0 Mobile Safari/537.36 BingSapphire/33.4.440603001',
      'X-Rewards-AppId': 'SAIOS/33.4.440603001',
      'X-Rewards-PartnerId': 'startapp',
      'X-Rewards-Country': 'CN',
      'X-Rewards-Language': 'zh-CN',
      'X-Rewards-IsMobile': 'true'
    }
  }

  private appActivityHeaders(
    accessToken: string,
    payload: Readonly<Record<string, unknown>>
  ): Record<string, string> {
    const headers = this.appHeaders(accessToken)
    if (payload.type !== 103) return headers
    return {
      ...headers,
      'User-Agent':
        'Mozilla/5.0 (iPad; CPU iPad OS 26_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5 Mobile/15E148 Safari/605.1.15 BingSapphire/33.4.440603001',
      'X-Rewards-Flights': 'rwgobig'
    }
  }
}
