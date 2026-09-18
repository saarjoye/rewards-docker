import type { BrowserContext, Page } from 'patchright'
import { randomBytes, randomUUID } from 'node:crypto'

import { DashboardFetchError, type DashboardClient } from '../browser/DashboardClient.js'
import type { SearchEvent, SearchState, TaskRecord } from '../domain/Task.js'
import type { AccountMode } from '../domain/RunRequest.js'
import type { ApplicationConfig } from '../infra/Config.js'
import type { StructuredLogger } from '../infra/StructuredLogger.js'
import { BusinessDateChanged } from './BusinessDate.js'
import {
  defaultSearchQueryPool,
  SearchQueryPool
} from './SearchQueryPool.js'

export { FALLBACK_SEARCH_TERMS as SEARCH_TERMS } from './SearchQueryPool.js'

export type SearchOperationStage =
  | 'search-box'
  | 'submit'
  | 'post-submit-wait'
  | 'scroll'
  | 'click'
  | 'search-delay'
  | 'dashboard-refresh'

export class SearchExecutionError extends Error {
  constructor(
    message: string,
    readonly operationStage: SearchOperationStage,
    readonly completed: number,
    readonly total: number
  ) {
    super(message)
    this.name = 'SearchExecutionError'
  }
}

export interface SearchQueryMetadata {
  taskId: string
  queryIndex: number
  submittedCount: number
}

export function calculateSearchQueryBudgetMs(search: ApplicationConfig['search']): number {
  const navigation = 25_000
  const searchBox = 16_000
  const submit = 15_000
  const postSubmit = 5_000
  const scroll = search.scroll ? 10_000 : 0
  const click = search.clickResult ? search.resultVisitSeconds * 1000 + 17_000 : 0
  const configuredDelay = search.delayMaxSeconds * 1000 + 2_000
  const dashboard = 55_000
  const cleanup = 10_000
  return (
    navigation +
    searchBox +
    submit +
    postSubmit +
    scroll +
    click +
    configuredDelay +
    dashboard +
    cleanup
  )
}

function randomBetween(minimum: number, maximum: number): number {
  return Math.floor(minimum + Math.random() * (maximum - minimum + 1))
}

function signalError(signal: AbortSignal): Error {
  const reason = signal.reason as unknown
  return reason instanceof Error ? reason : new Error('Search operation was aborted')
}

async function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  await new Promise<void>((resolve, reject) => {
    const abort = (): void => {
      clearTimeout(timer)
      reject(signalError(signal))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort)
      resolve()
    }, milliseconds)
    signal.addEventListener('abort', abort, { once: true })
  })
}

export class SearchExecutor {
  private activePageCount = 0

  constructor(
    private readonly context: BrowserContext,
    private readonly client: DashboardClient,
    private readonly logger: StructuredLogger,
    private readonly config: ApplicationConfig['search'],
    private readonly runId: string,
    private readonly accountAlias: string,
    private readonly budgetOverrideMs?: number,
    private readonly queryPool: SearchQueryPool = defaultSearchQueryPool
  ) {}

  async run(input: {
    task: TaskRecord
    mobile: boolean
    signal: AbortSignal
    onProgress: (task: TaskRecord) => void
    beforeSubmit?: () => void
    readOnly?: boolean
    singleQuery?: string
    accountMode?: AccountMode
    accountIndex?: number
    targetAccountIndex?: number
    retryPendingSearch?: boolean
    resumePendingSearch?: boolean
    executionMode?: 'read-only' | 'mutating'
  }): Promise<TaskRecord> {
    let current = input.task
    const existing = current.searchObservation
    let summary: NonNullable<TaskRecord['searchObservation']> = existing ?? {
      runId: this.runId,
      submittedCount: 0,
      unknownSubmissionCount: 0,
      awaitingProgress: false,
      completed: current.progress.completed,
      total: current.progress.total,
      observedAt: null,
      result: 'initial'
    }
    const save = (submission = false): void => {
      if (
        submission &&
        (summary.result === 'submitted' || summary.result === 'submission-started') &&
        summary.lastEvent?.reason !== summary.result
      ) {
        summary = {
          ...summary,
          state: 'search-submitted',
          canContinue: false,
          lastEvent: {
            eventId: randomUUID(),
            kind: 'submission',
            state: 'search-submitted',
            reason: summary.result,
            source: 'browser',
            availability: 'unknown',
            completed: null,
            total: null,
            remaining: null,
            observedAt: new Date().toISOString(),
            durationMs: 0,
            usedFallback: null,
            attempt: 0,
            submittedCount: summary.submittedCount,
            unknownSubmissionCount: summary.unknownSubmissionCount,
            lastConfirmedCompleted: summary.completed,
            lastConfirmedTotal: summary.total,
            canContinue: false,
            retryReason:
              input.retryPendingSearch || input.resumePendingSearch
                ? 'authorized-retry'
                : 'not-requested'
          }
        }
      }
      current = {
        ...current,
        searchObservation: { ...summary },
        updatedAt: new Date().toISOString()
      }
      input.onProgress(current)
    }
    let budgetExhausted = false
    const pending = async (): Promise<TaskRecord> => {
      summary = { ...summary, canContinue: false }
      current = {
        ...current,
        status: 'verification-pending',
        reason: 'progress-unconfirmed: 搜索进度尚未更新'
      }
      save()
      if (typeof this.logger.write === 'function')
        await this.logger.write({
          level: 'warn',
          event: 'search-verification-pending',
          runId: this.runId,
          taskId: current.taskId,
          taskType: current.type,
          phase: 'dashboard-refresh',
          status: 'verification-pending',
          submittedCount: summary.submittedCount,
          completed: summary.completed,
          total: summary.total,
          activePageCount: this.activePageCount,
          retryReason: summary.result
        }).catch(() => undefined)
      if (budgetExhausted && typeof this.logger.write === 'function')
        await this.logger.write({
          level: 'warn',
          event: 'search-budget-exhausted',
          runId: this.runId,
          taskId: current.taskId,
          taskType: current.type,
          phase: 'dashboard-refresh',
          status: 'verification-pending',
          submittedCount: summary.submittedCount,
          completed: summary.completed,
          total: summary.total,
          retryReason: 'query-or-round-deadline'
        }).catch(() => undefined)
      return current
    }
    const total = summary.total
    save()
    if (total === null) return pending()
    current = { ...current, progress: { completed: summary.completed, total } }
    const maxQueries = Math.min(50, Math.max(10, (total - current.progress.completed) * 2))
    const queryBudget = this.budgetOverrideMs ?? calculateSearchQueryBudgetMs(this.config)
    const roundDeadline =
      Date.now() + Math.min(60 * 60_000, Math.max(10 * 60_000, queryBudget * maxQueries))
    const retryScopeAllowed =
      (input.executionMode ?? (input.readOnly === true ? 'read-only' : 'mutating')) === 'mutating' &&
      ((input.retryPendingSearch === true &&
        input.accountMode === 'account' &&
        Number.isSafeInteger(input.accountIndex) &&
        input.targetAccountIndex === input.accountIndex) ||
        (input.resumePendingSearch === true && input.accountMode === 'continue'))
    let retryCounterEligible = false
    let retryAttempted = false
    const canRetryPendingSearch = (): boolean =>
      retryScopeAllowed &&
      retryCounterEligible &&
      summary.completed < total &&
      summary.recoveryAttemptedRunId !== this.runId

    let lastObservationResult = 'not-observed'
    const observe = async (): Promise<boolean> => {
      const deadline = Math.min(roundDeadline, Date.now() + 120_000)
      const waits = [0, 5_000, 10_000, 20_000]
      let received = false
      let requestFailures = 0
      for (let attempt = 0; attempt < waits.length; attempt += 1) {
        input.signal.throwIfAborted()
        input.beforeSubmit?.()
        const wait = waits[attempt] ?? 0
        if (Date.now() + wait >= deadline) break
        if (wait) await abortableDelay(wait, input.signal)
        let counter
        let result: string
        const requestStarted = Date.now()
        let usedFallback: boolean | null
        let durationMs: number | undefined
        try {
          const observation = await this.client.fetchDashboard(input.signal, deadline)
          received = true
          usedFallback = observation.readMetadata?.usedFallback ?? null
          durationMs = observation.readMetadata?.durationMs
          input.signal.throwIfAborted()
          input.beforeSubmit?.()
          counter = input.mobile ? observation.mobileSearch : observation.pcSearch
          const value = counter.value
          if (Date.now() >= deadline) result = 'observation-deadline'
          else if (counter.availability !== 'valid' || !value)
            result =
              counter.availability === 'missing' || counter.availability === 'empty'
                ? 'counter-missing'
                : 'counter-invalid'
          else if (
            counter.confidence < 0.75 ||
            !['legacy-getuserinfo', 'bing-flyout', 'app-dashboard', 'rsc'].includes(
              counter.source
            ) ||
            !Number.isSafeInteger(value.completed) ||
            !Number.isSafeInteger(value.total) ||
            !Number.isSafeInteger(value.remaining) ||
            value.total <= 0 ||
            value.completed < 0 ||
            value.remaining < 0 ||
            value.total < value.completed ||
            value.remaining !== value.total - value.completed ||
            !Number.isFinite(Date.parse(counter.observedAt))
          )
            result = 'counter-invalid'
          else if (value.total !== total) result = 'quota-conflict'
          else if (
            value.completed < summary.completed ||
            (summary.observedAt !== null &&
              Date.parse(counter.observedAt) < Date.parse(summary.observedAt))
          )
            result = 'snapshot-regressed'
          else {
            retryCounterEligible = true
            result =
              value.completed > summary.completed ||
              (value.completed === total && !summary.awaitingProgress)
                ? 'progress-increased'
                : 'progress-unchanged'
          }
        } catch (error) {
          if (input.signal.aborted) throw signalError(input.signal)
          if (error instanceof BusinessDateChanged) throw error
          usedFallback = error instanceof DashboardFetchError ? error.usedFallback : null
          result =
            error instanceof DashboardFetchError && [401, 403].includes(error.status ?? 0)
              ? 'authentication-failed'
              : error instanceof TypeError ||
                  (error instanceof DashboardFetchError && error.status === 200)
                ? 'counter-invalid'
                : 'request-failed'
          if (result === 'request-failed') requestFailures += 1
          else received = true
        }
        lastObservationResult = result
        const state: SearchState =
          result === 'progress-increased'
            ? 'progress-confirmed'
            : ['authentication-failed', 'request-failed'].includes(result)
              ? 'failed'
              : [
                    'counter-missing',
                    'counter-invalid',
                    'quota-conflict',
                    'snapshot-regressed'
                  ].includes(result)
                ? 'counter-unavailable'
                : 'progress-pending'
        const event: SearchEvent = {
          eventId: randomUUID(),
          kind: 'observation',
          state,
          reason: result,
          source: counter?.source ?? 'dashboard',
          availability: counter?.availability ?? 'unknown',
          completed: counter?.availability === 'valid' ? (counter.value?.completed ?? null) : null,
          total: counter?.availability === 'valid' ? (counter.value?.total ?? null) : null,
          remaining: counter?.availability === 'valid' ? (counter.value?.remaining ?? null) : null,
          observedAt: counter?.observedAt ?? new Date().toISOString(),
          durationMs: durationMs ?? Date.now() - requestStarted,
          usedFallback,
          attempt: attempt + 1,
          submittedCount: summary.submittedCount,
          unknownSubmissionCount: summary.unknownSubmissionCount,
          lastConfirmedCompleted:
            result === 'progress-increased'
              ? (counter?.value?.completed ?? summary.completed)
              : summary.completed,
          lastConfirmedTotal: summary.total,
          canContinue:
            !input.readOnly &&
            !retryAttempted &&
            result === 'progress-increased' &&
            counter?.value?.remaining !== 0,
          retryReason:
            input.retryPendingSearch !== true && input.resumePendingSearch !== true
              ? 'not-requested'
              : !retryScopeAllowed
                ? 'single-account-scope-required'
                : result === 'progress-increased'
                  ? 'progress-already-confirmed'
                  : result === 'progress-unchanged' && retryCounterEligible
                    ? 'authorized-valid-counter'
                    : result
        }
        summary = { ...summary, result, state, canContinue: event.canContinue, lastEvent: event }
        await this.logger.write({
          level: result === 'progress-increased' ? 'debug' : 'warn',
          event: 'search-dashboard-observation',
          runId: this.runId,
          taskId: current.taskId,
          taskType: input.task.type,
          stage: 'dashboard-refresh',
          status: result,
          source: counter?.source ?? 'dashboard',
          availability: counter?.availability ?? 'unknown',
          completed: counter?.availability === 'valid' ? (counter.value?.completed ?? null) : null,
          total: counter?.availability === 'valid' ? (counter.value?.total ?? null) : null,
          remaining: counter?.availability === 'valid' ? (counter.value?.remaining ?? null) : null,
          observedAt: counter?.observedAt ?? new Date().toISOString(),
          attempt: attempt + 1,
          queryIndex: summary.submittedCount + summary.unknownSubmissionCount,
          submittedCount: summary.submittedCount,
          unknownSubmissionCount: summary.unknownSubmissionCount,
          durationMs: event.durationMs,
          usedFallback,
          ...(input.accountIndex === undefined ? {} : { accountIndex: input.accountIndex }),
          ...(event.retryReason === undefined ? {} : { retryReason: event.retryReason })
        })
        if (result === 'authentication-failed') {
          save()
          throw new SearchExecutionError(
            'dashboard-authentication-failed',
            'dashboard-refresh',
            summary.completed,
            total
          )
        }
        if (result === 'progress-increased' && counter?.value) {
          summary = {
            ...summary,
            completed: counter.value.completed,
            total: counter.value.total,
            observedAt: counter.observedAt,
            awaitingProgress: false
          }
          current = {
            ...current,
            status: summary.completed === total ? 'completed' : 'running',
            progress: { completed: summary.completed, total }
          }
          save()
          return true
        }
        save()
      }
      if (!received && requestFailures > 0) {
        summary = { ...summary, state: 'failed', canContinue: false }
        save()
        throw new SearchExecutionError(
          'dashboard-request-failed',
          'dashboard-refresh',
          summary.completed,
          total
        )
      }
      summary = {
        ...summary,
        state:
          summary.state === 'failed' ? 'progress-pending' : (summary.state ?? 'progress-pending'),
        canContinue: false
      }
      return false
    }

    let searchPage: Page | null = null
    const ensureSearchPage = async (signal: AbortSignal): Promise<Page> => {
      signal.throwIfAborted()
      const isClosed = searchPage
        ? typeof searchPage.isClosed === 'function'
          ? searchPage.isClosed()
          : false
        : true
      if (searchPage && !isClosed) {
        return searchPage
      }
      searchPage = await this.context.newPage()
      this.activePageCount += 1
      if (typeof this.logger.write === 'function') {
        await this.logger.write({
          level: 'debug',
          event: 'search-page-opened',
          runId: this.runId,
          taskId: current.taskId,
          queryIndex: summary.submittedCount + summary.unknownSubmissionCount,
          submittedCount: summary.submittedCount,
          activePageCount: this.activePageCount,
          phase: 'search-page'
        }).catch(() => undefined)
      }
      signal.throwIfAborted()
      await searchPage.goto('https://www.bing.com/', {
        waitUntil: 'domcontentloaded',
        timeout: 25_000
      })
      return searchPage
    }

    const closeSearchPage = async (): Promise<void> => {
      if (searchPage) {
        const pageToClose = searchPage
        searchPage = null
        await pageToClose.close().catch(() => undefined)
        this.activePageCount = Math.max(0, this.activePageCount - 1)
        if (typeof this.logger.write === 'function') {
          await this.logger.write({
            level: 'debug',
            event: 'search-page-closed',
            runId: this.runId,
            taskId: current.taskId,
            queryIndex: summary.submittedCount + summary.unknownSubmissionCount,
            submittedCount: summary.submittedCount,
            activePageCount: this.activePageCount,
            phase: 'search-page'
          }).catch(() => undefined)
        }
      }
    }

    try {
      if (summary.awaitingProgress || current.status === 'verification-pending' || input.readOnly) {
        const grew = await observe()
        if (current.status === 'completed') return current
        if (grew) return current
        if (input.readOnly === true) return await pending()
        if (!canRetryPendingSearch()) return await pending()
        retryAttempted = true
        summary = { ...summary, recoveryAttemptedRunId: this.runId }
        save()
      }
      if (summary.runId !== this.runId) {
        summary = { ...summary, runId: this.runId }
        save()
      }
      const queryLimit = retryAttempted ? 1 : maxQueries
      const queryOffset = summary.submittedCount + summary.unknownSubmissionCount
      const stagnantLimit = this.config.stagnantLimit
      let consecutiveUnchangedCount = 0
      let searchCount = 0

      for (let index = 0; index < queryLimit && current.progress.completed < total; index += 1) {
        input.signal.throwIfAborted()
        input.beforeSubmit?.()
        if (Date.now() >= roundDeadline) {
          budgetExhausted = true
          return await pending()
        }
        const query =
          input.singleQuery ??
          this.queryPool.getQuery(this.accountAlias, input.task.localDate, queryOffset + index)

        searchCount += 1
        try {
          await this.performQueryWithSearchBoxRetry(
            ensureSearchPage,
            closeSearchPage,
            query,
            input.mobile,
            searchCount,
            queryBudget,
            input.signal,
            {
              taskId: current.taskId,
              queryIndex: queryOffset + index,
              submittedCount: summary.submittedCount
            },
            input.beforeSubmit,
            () => {
              summary = {
                ...summary,
                runId: this.runId,
                unknownSubmissionCount: summary.unknownSubmissionCount + 1,
                awaitingProgress: true,
                result: 'submission-started'
              }
              save(true)
            },
            () => {
              summary = {
                ...summary,
                submittedCount: summary.submittedCount + 1,
                unknownSubmissionCount: summary.unknownSubmissionCount - 1,
                result: 'submitted'
              }
              save(true)
            }
          )
        } catch (error) {
          if (input.signal.aborted) throw signalError(input.signal)
          if (error instanceof BusinessDateChanged) throw error
          if (summary.awaitingProgress) {
            const grew = await observe()
            if (error instanceof SearchExecutionError && error.operationStage === 'submit') {
              if (!grew) return await pending()
              if (current.status === 'completed') return current
            }
          }
          throw new SearchExecutionError(
            '搜索页面操作失败', error instanceof SearchExecutionError ? error.operationStage : 'submit',
            summary.completed,
            total
          )
        }

        const observation = await observe()
        if (!observation) {
          if (input.singleQuery !== undefined || lastObservationResult !== 'progress-unchanged')
            return await pending()
        }

        if (lastObservationResult === 'progress-increased') {
          consecutiveUnchangedCount = 0
        } else if (lastObservationResult === 'progress-unchanged') {
          consecutiveUnchangedCount += 1
          if (consecutiveUnchangedCount >= stagnantLimit) {
            summary = { ...summary, canContinue: false }
            current = {
              ...current,
              status: 'verification-pending',
              reason: `stagnant-progress: 连续 ${String(stagnantLimit)} 次搜索未获积分，停止本轮搜索`
            }
            save()
            if (typeof this.logger.write === 'function') {
              await this.logger.write({
                level: 'warn',
                event: 'search-stagnant-aborted',
                runId: this.runId,
                taskId: current.taskId,
                taskType: current.type,
                phase: 'dashboard-refresh',
                status: 'verification-pending',
                submittedCount: summary.submittedCount,
                completed: summary.completed,
                total: summary.total,
                activePageCount: this.activePageCount,
                retryReason: 'stagnant-progress'
              }).catch(() => undefined)
            }
            return current
          }
        }

        if (current.status === 'completed') return current
        if (retryAttempted) {
          summary = { ...summary, canContinue: false }
          save()
          return current
        }
        if (input.singleQuery !== undefined) {
          summary = { ...summary, canContinue: false }
          save()
          return current
        }
      }
      if (current.progress.completed < total) {
        budgetExhausted = true
        return await pending()
      }
      return { ...current, status: 'completed' }
    } finally {
      await closeSearchPage()
    }
  }

  private async performQueryWithSearchBoxRetry(
    ensureSearchPage: (signal: AbortSignal) => Promise<Page>,
    closeSearchPage: () => Promise<void>,
    query: string,
    mobile: boolean,
    searchCount: number,
    timeoutMs: number,
    parentSignal: AbortSignal,
    metadata: SearchQueryMetadata,
    beforeSubmit?: () => void,
    onSubmitting?: () => void,
    onSubmitted?: () => void
  ): Promise<void> {
    try {
      await this.performQuery(
        ensureSearchPage,
        closeSearchPage,
        query,
        mobile,
        searchCount,
        timeoutMs,
        parentSignal,
        metadata,
        beforeSubmit,
        onSubmitting,
        onSubmitted
      )
      return
    } catch (error) {
      if (
        !(error instanceof SearchExecutionError) ||
        error.operationStage !== 'search-box' ||
        parentSignal.aborted
      ) {
        throw error
      }

      await closeSearchPage()

      await this.logger.write({
        level: 'warn',
        event: 'search-box-retry',
        runId: this.runId,
        taskId: metadata.taskId,
        taskType: mobile ? 'mobile-search' : 'pc-search',
        stage: 'search-box',
        status: 'retrying',
        submitted: false,
        queryIndex: metadata.queryIndex,
        submittedCount: metadata.submittedCount,
        retryAttempt: 1,
        reason: 'search-box-not-visible'
      }).catch(() => undefined)

      await this.performQuery(
        ensureSearchPage,
        closeSearchPage,
        query,
        mobile,
        searchCount,
        timeoutMs,
        parentSignal,
        metadata,
        beforeSubmit,
        onSubmitting,
        onSubmitted
      )
      return
    }
  }

  private async performQuery(
    ensureSearchPage: (signal: AbortSignal) => Promise<Page>,
    closeSearchPage: () => Promise<void>,
    query: string,
    mobile: boolean,
    searchCount: number,
    timeoutMs: number,
    parentSignal: AbortSignal,
    metadata: SearchQueryMetadata,
    beforeSubmit?: () => void,
    onSubmitting?: () => void,
    onSubmitted?: () => void
  ): Promise<void> {
    const page = await ensureSearchPage(parentSignal)
    const controller = new AbortController()
    let stage: SearchOperationStage = 'search-box'
    let operationError: unknown

    const operation = (async () => {
      try {
        controller.signal.throwIfAborted()

        if (searchCount > 0 && searchCount % 10 === 0) {
          const cvid = randomBytes(16).toString('hex')
          const refreshUrl = `https://www.bing.com/search?q=${encodeURIComponent(query)}&PC=U531&FORM=ANNTA1&cvid=${cvid}`
          await page.goto(refreshUrl, {
            waitUntil: 'domcontentloaded',
            timeout: 25_000
          })
        }

        controller.signal.throwIfAborted()
        stage = 'search-box'

        if (typeof page.evaluate === 'function') {
          await page
            .evaluate(() => {
              window.scrollTo({ left: 0, top: 0, behavior: 'auto' })
            })
            .catch(() => undefined)
        }
        const keyboard = (
          page as unknown as {
            keyboard?: {
              press?: (key: string, options?: { delay?: number }) => Promise<void>
              type?: (text: string, options?: { delay?: number }) => Promise<void>
            }
          }
        ).keyboard

        if (typeof keyboard?.press === 'function') {
          await keyboard.press('Home').catch(() => undefined)
        }

        const box = page.locator('#sb_form_q, textarea[name="q"], input[name="q"]').first()
        await box.waitFor({ state: 'visible', timeout: 16_000 })
        controller.signal.throwIfAborted()

        const boxOps = box as unknown as {
          click?: (options?: { clickCount?: number }) => Promise<void>
          press?: (key: string, options?: { timeout?: number }) => Promise<void>
        }

        if (typeof keyboard?.type === 'function') {
          if (typeof boxOps.click === 'function') {
            await boxOps.click({ clickCount: 3 }).catch(() => undefined)
          }
          await box.fill('')
          controller.signal.throwIfAborted()
          await keyboard.type(query, { delay: randomBetween(45, 75) })
        } else {
          await box.fill(query)
        }
        controller.signal.throwIfAborted()

        stage = 'submit'
        beforeSubmit?.()
        onSubmitting?.()
        if (typeof boxOps.press === 'function') {
          await boxOps.press('Enter', { timeout: 15_000 })
        } else if (typeof keyboard?.press === 'function') {
          await keyboard.press('Enter')
        }
        controller.signal.throwIfAborted()
        onSubmitted?.()
        controller.signal.throwIfAborted()

        stage = 'post-submit-wait'
        await abortableDelay(3_000, controller.signal)

        if (this.config.scroll && typeof page.evaluate === 'function') {
          stage = 'scroll'
          await page
            .evaluate(() => {
              const maxScroll = Math.max(1, document.body.scrollHeight - window.innerHeight)
              window.scrollTo({
                left: 0,
                top: Math.floor(Math.random() * maxScroll),
                behavior: 'auto'
              })
            })
            .catch(() => undefined)
          await abortableDelay(2_000, controller.signal)
        }

        if (this.config.clickResult) {
          stage = 'click'
          const existingPages = new Set(
            typeof this.context.pages === 'function' ? this.context.pages() : [page]
          )
          const searchPageUrl =
            typeof page.url === 'function' ? page.url() : 'https://www.bing.com/'

          const result = page.locator('#b_results .b_algo h2 a, li.b_algo h2 a, #b_results h2 a').first()
          if (await result.isVisible({ timeout: 5_000 }).catch(() => false)) {
            controller.signal.throwIfAborted()
            await result.click({ timeout: 10_000 })
            await abortableDelay(this.config.resultVisitSeconds * 1000, controller.signal)

            const currentPages =
              typeof this.context.pages === 'function' ? this.context.pages() : [page]
            let newTabClosed = false
            for (const p of currentPages) {
              if (!existingPages.has(p)) {
                newTabClosed = true
                await p.close().catch(() => undefined)
              }
            }
            if (!newTabClosed && typeof page.url === 'function' && page.url() !== searchPageUrl) {
              await page
                .goto(searchPageUrl, { waitUntil: 'domcontentloaded', timeout: 15_000 })
                .catch(() => undefined)
            }
          }
        }

        stage = 'search-delay'
        await abortableDelay(
          randomBetween(this.config.delayMinSeconds, this.config.delayMaxSeconds) * 1000,
          controller.signal
        )
      } catch (error) {
        operationError = error
        throw error
      }
    })()

    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const error = new SearchExecutionError(
          `单次搜索超时: ${String(timeoutMs)}ms`,
          stage,
          0,
          0
        )
        controller.abort(error)
        void closeSearchPage()
        reject(error)
      }, timeoutMs)
    })
    const abort = (): void => {
      controller.abort(signalError(parentSignal))
      void closeSearchPage()
    }
    parentSignal.addEventListener('abort', abort, { once: true })

    try {
      await Promise.race([operation, timeout])
      if (typeof this.logger.write === 'function') {
        await this.logger.write({
          level: 'debug',
          event: 'search-query',
          runId: this.runId,
          taskId: metadata.taskId,
          queryIndex: metadata.queryIndex,
          submittedCount: metadata.submittedCount,
          activePageCount: this.activePageCount,
          phase: 'submit',
          stage,
          status: 'submitted',
          message: mobile ? 'mobile' : 'desktop'
        }).catch(() => undefined)
      }
    } catch (error) {
      await closeSearchPage()
      await Promise.race([
        operation.catch(() => undefined),
        new Promise<void>((resolve) => setTimeout(resolve, 1_000))
      ])
      if (error instanceof SearchExecutionError || error instanceof BusinessDateChanged) throw error
      throw new SearchExecutionError(
        operationError instanceof Error ? operationError.message : '搜索页面操作失败', stage, 0, 0
      )
    } finally {
      if (timer) clearTimeout(timer)
      parentSignal.removeEventListener('abort', abort)
    }
  }
}
