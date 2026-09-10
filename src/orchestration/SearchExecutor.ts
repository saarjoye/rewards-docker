import type { BrowserContext } from 'patchright'
import { randomUUID } from 'node:crypto'

import { DashboardFetchError, type DashboardClient } from '../browser/DashboardClient.js'
import type { SearchEvent, SearchState, TaskRecord } from '../domain/Task.js'
import type { AccountMode } from '../domain/RunRequest.js'
import type { ApplicationConfig } from '../infra/Config.js'
import type { StructuredLogger } from '../infra/StructuredLogger.js'
import { BusinessDateChanged } from './BusinessDate.js'

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

const SEARCH_TERMS = [
  '中国传统节日',
  '今日科技新闻',
  '人工智能发展',
  '北京天气',
  '上海旅游',
  '中国历史文化',
  '健康生活方式',
  '世界地理知识',
  '国产电影推荐',
  '音乐基础知识',
  '计算机科学',
  '绿色能源',
  '航天科技',
  '海洋生物',
  '古典文学',
  '摄影技巧',
  '家庭烹饪',
  '运动健康',
  '城市交通',
  '自然保护',
  '数学趣题',
  '物理实验',
  '化学元素',
  '天文观测',
  '建筑设计',
  '园艺知识',
  '博物馆展览',
  '语言学习',
  '网络安全',
  '开源软件',
  '数据库基础',
  '云计算',
  '机器学习',
  '机器人技术',
  '新能源汽车',
  '高速铁路',
  '农业科技',
  '气象科学',
  '地质公园',
  '非物质文化遗产',
  '诗词鉴赏',
  '书法艺术',
  '国画基础',
  '戏曲文化',
  '围棋入门',
  '羽毛球规则',
  '篮球比赛',
  '足球历史',
  '游泳技巧',
  '营养搭配',
  '睡眠健康',
  '心理健康'
] as const

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
  constructor(
    private readonly context: BrowserContext,
    private readonly client: DashboardClient,
    private readonly logger: StructuredLogger,
    private readonly config: ApplicationConfig['search'],
    private readonly runId: string,
    private readonly accountAlias: string,
    private readonly budgetOverrideMs?: number
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
            retryReason: input.retryPendingSearch ? 'authorized-retry' : 'not-requested'
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
    const pending = (): TaskRecord => {
      summary = { ...summary, canContinue: false }
      current = {
        ...current,
        status: 'verification-pending',
        reason: 'progress-unconfirmed: 搜索进度尚未更新'
      }
      save()
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
      input.retryPendingSearch === true &&
      (input.executionMode ?? (input.readOnly === true ? 'read-only' : 'mutating')) === 'mutating' &&
      input.accountMode === 'account' &&
      Number.isSafeInteger(input.accountIndex) &&
      input.targetAccountIndex === input.accountIndex
    let retryCounterEligible = false
    let retryAttempted = false
    const canRetryPendingSearch = (): boolean =>
      retryScopeAllowed && retryCounterEligible && summary.completed < total

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
        retryCounterEligible = false
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
          else if (usedFallback === true) result = 'counter-fallback'
          else if (
            counter.confidence < 0.75 ||
            !['legacy-getuserinfo', 'bing-flyout', 'app-dashboard', 'rsc'].includes(
              counter.source
            ) ||
            !Number.isSafeInteger(value.completed) ||
            !Number.isSafeInteger(value.total) ||
            value.completed < 0 ||
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
        const state: SearchState =
          result === 'progress-increased'
            ? 'progress-confirmed'
            : ['authentication-failed', 'request-failed'].includes(result)
              ? 'failed'
              : [
                    'counter-missing',
                    'counter-invalid',
                    'counter-fallback',
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
            input.retryPendingSearch !== true
              ? 'not-requested'
              : !retryScopeAllowed
                ? 'single-account-scope-required'
                : result === 'progress-increased'
                  ? 'progress-already-confirmed'
                  : retryCounterEligible
                    ? 'authorized-valid-counter'
                    : result
        }
        summary = { ...summary, result, state, canContinue: event.canContinue, lastEvent: event }
        await this.logger.write({
          level: result === 'progress-increased' ? 'debug' : 'warn',
          event: 'search-dashboard-observation',
          runId: this.runId,
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

    // A persisted in-flight submission is only reconciled by reads, never replayed.
    if (summary.awaitingProgress || current.status === 'verification-pending' || input.readOnly) {
      const grew = await observe()
      if (current.status === 'completed') return current
      if (grew) return current
      if (input.readOnly === true) return pending()
      if (!canRetryPendingSearch()) return pending()
      retryAttempted = true
    }
    if (summary.runId !== this.runId) {
      summary = { ...summary, runId: this.runId, submittedCount: 0, unknownSubmissionCount: 0 }
      save()
    }
    const queryLimit = retryAttempted ? 1 : maxQueries
    const queryOffset = summary.submittedCount + summary.unknownSubmissionCount
    for (let index = 0; index < queryLimit && current.progress.completed < total; index += 1) {
      input.signal.throwIfAborted()
      input.beforeSubmit?.()
      if (Date.now() >= roundDeadline) return pending()
      const query =
        input.singleQuery ??
        SEARCH_TERMS[(queryOffset + index) % SEARCH_TERMS.length] ??
        SEARCH_TERMS[0]
      try {
        await this.performQuery(
          query,
          input.mobile,
          queryBudget,
          input.signal,
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
            if (!grew) return pending()
            if (current.status === 'completed') return current
          }
          // Do not submit more after a browser action failed, even if progress arrived.
        }
        throw new SearchExecutionError(
          '搜索页面操作失败',
          error instanceof SearchExecutionError ? error.operationStage : 'submit',
          summary.completed,
          total
        )
      }
      if (!(await observe())) return pending()
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
    return current.progress.completed < total ? pending() : { ...current, status: 'completed' }
  }
  private async performQuery(
    query: string,
    mobile: boolean,
    timeoutMs: number,
    parentSignal: AbortSignal,
    beforeSubmit?: () => void,
    onSubmitting?: () => void,
    onSubmitted?: () => void
  ): Promise<void> {
    const page = await this.context.newPage()
    const controller = new AbortController()
    let stage: SearchOperationStage = 'search-box'
    let operationError: unknown
    const operation = (async () => {
      try {
        controller.signal.throwIfAborted()
        await page.goto('https://www.bing.com/', { waitUntil: 'domcontentloaded', timeout: 25_000 })
        controller.signal.throwIfAborted()
        stage = 'search-box'
        const box = page.locator('textarea[name="q"], input[name="q"], #sb_form_q').first()
        await box.waitFor({ state: 'visible', timeout: 16_000 })
        controller.signal.throwIfAborted()
        await box.fill(query)
        controller.signal.throwIfAborted()
        stage = 'submit'
        beforeSubmit?.()
        onSubmitting?.()
        await box.press('Enter', { timeout: 15_000 })
        controller.signal.throwIfAborted()
        onSubmitted?.()
        controller.signal.throwIfAborted()
        stage = 'post-submit-wait'
        await abortableDelay(5_000, controller.signal)
        if (this.config.scroll) {
          stage = 'scroll'
          await page.evaluate(() => {
            window.scrollTo({ top: Math.max(1, document.body.scrollHeight / 2), behavior: 'auto' })
          })
          await abortableDelay(2_000, controller.signal)
        }
        if (this.config.clickResult) {
          stage = 'click'
          const result = page.locator('li.b_algo h2 a, #b_results h2 a').first()
          if (await result.isVisible({ timeout: 5_000 }).catch(() => false)) {
            controller.signal.throwIfAborted()
            await result.click({ timeout: 10_000 })
            await abortableDelay(this.config.resultVisitSeconds * 1000, controller.signal)
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
        const error = new SearchExecutionError(`单次搜索超时: ${String(timeoutMs)}ms`, stage, 0, 0)
        controller.abort(error)
        void page.close().catch(() => undefined)
        reject(error)
      }, timeoutMs)
    })
    const abort = (): void => {
      controller.abort(signalError(parentSignal))
      void page.close().catch(() => undefined)
    }
    parentSignal.addEventListener('abort', abort, { once: true })
    try {
      await Promise.race([operation, timeout])
      await this.logger.write({
        level: 'debug',
        event: 'search-query',
        runId: this.runId,
        stage,
        status: 'submitted',
        message: mobile ? 'mobile' : 'desktop'
      })
    } catch (error) {
      await page.close().catch(() => undefined)
      await Promise.race([
        operation.catch(() => undefined),
        new Promise<void>((resolve) => setTimeout(resolve, 1000))
      ])
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
      await page.close().catch(() => undefined)
    }
  }
}
