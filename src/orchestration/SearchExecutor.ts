import type { BrowserContext } from 'patchright'

import type { DashboardClient } from '../browser/DashboardClient.js'
import type { TaskRecord } from '../domain/Task.js'
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
  }): Promise<TaskRecord> {
    const total = input.task.progress.total
    if (total === null) {
      throw new SearchExecutionError(
        '搜索额度未确认',
        'dashboard-refresh',
        input.task.progress.completed,
        0
      )
    }
    let current = input.task
    let stagnant = 0
    const maxQueries = Math.min(50, Math.max(10, (total - current.progress.completed) * 2))
    const queryBudget = this.budgetOverrideMs ?? calculateSearchQueryBudgetMs(this.config)
    const roundBudget = Math.min(60 * 60_000, Math.max(10 * 60_000, queryBudget * maxQueries))
    const roundDeadline = Date.now() + roundBudget

    for (let index = 0; index < maxQueries && current.progress.completed < total; index += 1) {
      input.beforeSubmit?.()
      if (input.signal.aborted) throw input.signal.reason
      if (Date.now() >= roundDeadline) {
        throw new SearchExecutionError(
          '整轮搜索达到最大耗时',
          'search-delay',
          current.progress.completed,
          total
        )
      }
      const query = SEARCH_TERMS[index % SEARCH_TERMS.length] as string
      try {
        await this.performQuery(query, input.mobile, queryBudget, input.signal, input.beforeSubmit)
      } catch (error) {
        if (error instanceof SearchExecutionError) {
          throw new SearchExecutionError(
            error.message,
            error.operationStage,
            current.progress.completed,
            total
          )
        }
        throw error
      }

      let observation
      try {
        observation = await this.client.fetchDashboard(input.signal)
      } catch (error) {
        throw new SearchExecutionError(
          error instanceof Error ? error.message : 'Dashboard 刷新失败',
          'dashboard-refresh',
          current.progress.completed,
          total
        )
      }
      const counter = input.mobile ? observation.mobileSearch : observation.pcSearch
      input.beforeSubmit?.()
      if (counter.availability !== 'valid' || !counter.value) {
        throw new SearchExecutionError(
          counter.reason ?? '搜索 counter 未确认',
          'dashboard-refresh',
          current.progress.completed,
          total
        )
      }
      const nextCompleted = Math.max(current.progress.completed, counter.value.completed)
      stagnant = nextCompleted === current.progress.completed ? stagnant + 1 : 0
      current = {
        ...current,
        status: counter.value.remaining === 0 ? 'completed' : 'running',
        progress: { completed: nextCompleted, total: counter.value.total },
        updatedAt: new Date().toISOString()
      }
      input.onProgress(current)
      if (counter.value.remaining === 0) return current
      if (stagnant >= 5) {
        throw new SearchExecutionError(
          '连续 5 次搜索未观察到进度变化',
          'dashboard-refresh',
          current.progress.completed,
          current.progress.total ?? total
        )
      }
    }

    if (current.progress.completed < total) {
      throw new SearchExecutionError(
        '搜索查询达到安全上限但额度尚未完成',
        'dashboard-refresh',
        current.progress.completed,
        total
      )
    }
    return current
  }

  private async performQuery(
    query: string,
    mobile: boolean,
    timeoutMs: number,
    parentSignal: AbortSignal,
    beforeSubmit?: () => void
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
        await box.press('Enter', { timeout: 15_000 })
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
        accountAlias: this.accountAlias,
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
