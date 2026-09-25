import type { BrowserContext, Page } from 'patchright'
import { randomUUID } from 'node:crypto'

import type { SearchQueryAllocator } from '../domain/SearchQueryAllocation.js'
import { DashboardFetchError, type DashboardClient } from '../browser/DashboardClient.js'
import type { SearchEvent, SearchState, TaskRecord } from '../domain/Task.js'
import type { AccountMode } from '../domain/RunRequest.js'
import type { ApplicationConfig } from '../infra/Config.js'
import type { StructuredLogger } from '../infra/StructuredLogger.js'
import { BusinessDateChanged } from './BusinessDate.js'
import { defaultSearchQueryPool, SearchQueryPool } from './SearchQueryPool.js'

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

export type SearchExecutionConfig = Omit<ApplicationConfig['search'], 'stagnantLimit'> & {
  stagnantLimit?: number
}

export function calculateSearchQueryBudgetMs(search: SearchExecutionConfig): number {
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

async function boundedCleanup(operation: Promise<unknown>): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  try {
    await Promise.race([
      operation.catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 1_000)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export class SearchExecutor {
  private activePageCount = 0
  private readonly visitingResultPages = new WeakSet<Page>()
  private readonly popupClosures = new WeakMap<Page, Promise<void>>()

  constructor(
    private readonly context: BrowserContext,
    private readonly client: DashboardClient,
    private readonly logger: StructuredLogger,
    private readonly config: SearchExecutionConfig,
    private readonly runId: string,
    private readonly accountAlias: string,
    private readonly budgetOverrideMs?: number,
    private readonly queryPool: SearchQueryPool = defaultSearchQueryPool,
    private readonly queryAllocator?: SearchQueryAllocator
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
        await this.logger
          .write({
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
          })
          .catch(() => undefined)
      if (budgetExhausted && typeof this.logger.write === 'function')
        await this.logger
          .write({
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
          })
          .catch(() => undefined)
      return current
    }
    const total = summary.total
    save()
    if (total === null) return pending()
    current = { ...current, progress: { completed: summary.completed, total } }
    const maxQueries = Math.min(50, Math.max(10, (total - current.progress.completed) * 2))
    const queryBudget = this.budgetOverrideMs ?? calculateSearchQueryBudgetMs(this.config)
    const roundDeadline =
      Date.now() + Math.min(24 * 60 * 60_000, Math.max(10 * 60_000, queryBudget * maxQueries))
    const retryScopeAllowed =
      (input.executionMode ?? (input.readOnly === true ? 'read-only' : 'mutating')) ===
        'mutating' &&
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
    let pageClosing: Promise<void> = Promise.resolve()
    let stopWatchingPopups = (): Promise<void> => Promise.resolve()
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
      if (searchPage) {
        searchPage = null
        this.activePageCount = Math.max(0, this.activePageCount - 1)
        await stopWatchingPopups()
      }
      const created = await this.context.newPage()
      if (signal.aborted) {
        await boundedCleanup(created.close())
        signal.throwIfAborted()
      }
      searchPage = created
      stopWatchingPopups = this.watchSearchPagePopups(created)
      this.activePageCount += 1
      if (typeof this.logger.write === 'function') {
        await this.logger
          .write({
            level: 'debug',
            event: 'search-page-opened',
            runId: this.runId,
            taskId: current.taskId,
            queryIndex: summary.submittedCount + summary.unknownSubmissionCount,
            submittedCount: summary.submittedCount,
            activePageCount: this.activePageCount,
            phase: 'search-page'
          })
          .catch(() => undefined)
      }
      signal.throwIfAborted()
      await searchPage.goto('https://www.bing.com/', {
        waitUntil: 'domcontentloaded',
        timeout: 25_000
      })
      signal.throwIfAborted()
      return searchPage
    }

    const closeSearchPage = async (): Promise<void> => {
      if (searchPage) {
        const pageToClose = searchPage
        const cleanupPopups = stopWatchingPopups
        searchPage = null
        stopWatchingPopups = () => Promise.resolve()
        pageClosing = (async () => {
          await boundedCleanup(pageToClose.close())
          await cleanupPopups()
        })()
        await pageClosing
        this.activePageCount = Math.max(0, this.activePageCount - 1)
        if (typeof this.logger.write === 'function') {
          await this.logger
            .write({
              level: 'debug',
              event: 'search-page-closed',
              runId: this.runId,
              taskId: current.taskId,
              queryIndex: summary.submittedCount + summary.unknownSubmissionCount,
              submittedCount: summary.submittedCount,
              activePageCount: this.activePageCount,
              phase: 'search-page'
            })
            .catch(() => undefined)
        }
      }
      await pageClosing
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
      const stagnantLimit = this.config.stagnantLimit ?? 10
      let consecutiveUnchangedCount = 0

      for (let index = 0; index < queryLimit && current.progress.completed < total; index += 1) {
        input.signal.throwIfAborted()
        input.beforeSubmit?.()
        if (Date.now() >= roundDeadline) {
          budgetExhausted = true
          return await pending()
        }
        if (!this.queryAllocator) throw new Error('Search query allocator is required')
        const candidates =
          input.singleQuery === undefined
            ? this.queryPool.getQueries(
                input.task.accountId,
                input.task.localDate,
                this.queryPool.size,
                queryOffset + index
              )
            : [input.singleQuery]
        const query = this.queryAllocator.reserve({
          localDate: input.task.localDate,
          accountId: input.task.accountId,
          taskId: input.task.taskId,
          candidates
        })
        if (query === null) {
          summary = { ...summary, canContinue: false }
          current = {
            ...current,
            status: 'action-required',
            reason:
              input.singleQuery === undefined
                ? 'search-query-pool-exhausted'
                : 'search-query-already-reserved'
          }
          save()
          return current
        }

        try {
          await this.performQueryWithSearchBoxRetry(
            ensureSearchPage,
            closeSearchPage,
            query,
            input.mobile,
            Math.min(queryBudget, roundDeadline - Date.now()),
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
            '搜索页面操作失败',
            error instanceof SearchExecutionError ? error.operationStage : 'submit',
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
              await this.logger
                .write({
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
                })
                .catch(() => undefined)
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

  private closePopup(popup: Page): Promise<void> {
    let closing = this.popupClosures.get(popup)
    if (!closing) {
      closing = boundedCleanup(popup.close())
      this.popupClosures.set(popup, closing)
    }
    return closing
  }

  private watchSearchPagePopups(page: Page): () => Promise<void> {
    // Older synthetic Page implementations do not expose event APIs.
    if (typeof page.on !== 'function') return () => Promise.resolve()
    const popups = new Set<Page>()
    let stopping = false
    const register = (popup: Page): void => {
      if (popup === page || popups.has(popup)) return
      popups.add(popup)
      if (!stopping) popup.on('popup', register)
      if (stopping || !this.visitingResultPages.has(page)) void this.closePopup(popup)
    }
    page.on('popup', register)
    return async () => {
      stopping = true
      await Promise.all([...popups].map((popup) => this.closePopup(popup)))
      page.off('popup', register)
      for (const popup of popups) popup.off('popup', register)
    }
  }

  private async visitResult(page: Page, signal: AbortSignal): Promise<void> {
    const existing = new Set(this.context.pages())
    const owned = new Set<Page>()
    const inspections = new Set<Promise<void>>()
    let finishing = false
    const close = (popup: Page): Promise<void> => this.closePopup(popup)
    const register = (popup: Page): void => {
      if (popup === page || existing.has(popup) || owned.has(popup)) return
      owned.add(popup)
      if (finishing || signal.aborted) void close(popup)
      else popup.on('popup', register)
    }
    const inspect = async (candidate: Page): Promise<void> => {
      const visited = new Set<Page>()
      let parent: Page | null = candidate
      while (parent && !visited.has(parent)) {
        if (parent === page || owned.has(parent)) {
          register(candidate)
          return
        }
        visited.add(parent)
        parent = await parent.opener()
      }
    }
    const onPage = (candidate: Page): void => {
      if (existing.has(candidate)) return
      const pending = inspect(candidate).catch(() => undefined)
      inspections.add(pending)
      void pending.finally(() => inspections.delete(pending))
    }
    const abort = (): void => {
      finishing = true
      for (const popup of owned) void close(popup)
    }
    this.visitingResultPages.add(page)
    page.on('popup', register)
    this.context.on('page', onPage)
    signal.addEventListener('abort', abort, { once: true })
    const searchUrl = page.url()
    try {
      signal.throwIfAborted()
      const result = page
        .locator('#b_results .b_algo h2 a, li.b_algo h2 a, #b_results h2 a')
        .first()
      if (await result.isVisible({ timeout: 5_000 }).catch(() => false)) {
        signal.throwIfAborted()
        await result.click({ timeout: 10_000 })
        await abortableDelay(this.config.resultVisitSeconds * 1000, signal)
        signal.throwIfAborted()
        if (page.url() !== searchUrl) {
          await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 15_000 })
        }
      }
    } finally {
      finishing = true
      for (const candidate of this.context.pages()) onPage(candidate)
      await boundedCleanup(Promise.all([...inspections]))
      await Promise.all([...owned].map(close))
      page.off('popup', register)
      this.context.off('page', onPage)
      for (const popup of owned) popup.off('popup', register)
      signal.removeEventListener('abort', abort)
      this.visitingResultPages.delete(page)
    }
  }

  private async performQueryWithSearchBoxRetry(
    ensureSearchPage: (signal: AbortSignal) => Promise<Page>,
    closeSearchPage: () => Promise<void>,
    query: string,
    mobile: boolean,
    timeoutMs: number,
    parentSignal: AbortSignal,
    metadata: SearchQueryMetadata,
    beforeSubmit?: () => void,
    onSubmitting?: () => void,
    onSubmitted?: () => void
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs
    try {
      await this.performQuery(
        ensureSearchPage,
        closeSearchPage,
        query,
        mobile,
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
        parentSignal.aborted ||
        Date.now() >= deadline
      ) {
        throw error
      }

      await closeSearchPage()

      await this.logger
        .write({
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
        })
        .catch(() => undefined)

      await this.performQuery(
        ensureSearchPage,
        closeSearchPage,
        query,
        mobile,
        Math.max(0, deadline - Date.now()),
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
    timeoutMs: number,
    parentSignal: AbortSignal,
    metadata: SearchQueryMetadata,
    beforeSubmit?: () => void,
    onSubmitting?: () => void,
    onSubmitted?: () => void
  ): Promise<void> {
    if (timeoutMs <= 0) throw new SearchExecutionError('搜索预算已耗尽', 'search-box', 0, 0)
    const controller = new AbortController()
    if (parentSignal.aborted) controller.abort(signalError(parentSignal))
    let stage: SearchOperationStage = 'search-box'
    let operationError: unknown

    const operation = (async () => {
      try {
        controller.signal.throwIfAborted()
        const page = await ensureSearchPage(controller.signal)
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
            await boxOps.click({ clickCount: 3 })
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
        controller.signal.throwIfAborted()
        onSubmitting?.()
        controller.signal.throwIfAborted()
        if (typeof boxOps.press === 'function') {
          await boxOps.press('Enter', { timeout: 15_000 })
        } else if (typeof keyboard?.press === 'function') {
          await keyboard.press('Enter')
        } else {
          throw new Error('Search page does not support Enter submission')
        }
        controller.signal.throwIfAborted()
        onSubmitted?.()
        controller.signal.throwIfAborted()

        stage = 'post-submit-wait'
        await abortableDelay(3_000, controller.signal)

        if (this.config.scroll && typeof page.evaluate === 'function') {
          stage = 'scroll'
          for (let step = 0; step < 2; step += 1) {
            controller.signal.throwIfAborted()
            await page.evaluate(() => {
              window.scrollBy({
                left: 0,
                top: Math.floor(window.innerHeight * (0.4 + Math.random() * 0.4)),
                behavior: 'smooth'
              })
            })
            await abortableDelay(randomBetween(500, 1000), controller.signal)
          }
        }

        if (this.config.clickResult) {
          stage = 'click'
          await this.visitResult(page, controller.signal)
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
    let rejectAborted: (reason: Error) => void = () => undefined
    const cancelled = new Promise<never>((_resolve, reject) => {
      rejectAborted = reject
    })
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const error = new SearchExecutionError(`单次搜索超时: ${String(timeoutMs)}ms`, stage, 0, 0)
        controller.abort(error)
        void closeSearchPage()
        reject(error)
      }, timeoutMs)
    })
    const abort = (): void => {
      controller.abort(signalError(parentSignal))
      void closeSearchPage()
      rejectAborted(signalError(parentSignal))
    }
    parentSignal.addEventListener('abort', abort, { once: true })
    if (parentSignal.aborted) abort()

    try {
      await Promise.race([operation, timeout, cancelled])
      if (typeof this.logger.write === 'function') {
        await this.logger
          .write({
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
          })
          .catch(() => undefined)
      }
    } catch (error) {
      controller.abort(error)
      await closeSearchPage()
      await boundedCleanup(operation)
      if (error instanceof SearchExecutionError || error instanceof BusinessDateChanged) throw error
      throw new SearchExecutionError(
        operationError instanceof Error ? operationError.message : '搜索页面操作失败',
        stage,
        0,
        0
      )
    } finally {
      if (timer) clearTimeout(timer)
      parentSignal.removeEventListener('abort', abort)
    }
  }
}
