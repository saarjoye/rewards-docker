import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserContext, Page } from 'patchright'

import type { DashboardClient } from '../src/browser/DashboardClient.js'
import type { TaskRecord } from '../src/domain/Task.js'
import { DEFAULT_CONFIG } from '../src/infra/Config.js'
import { BusinessDateChanged } from '../src/orchestration/BusinessDate.js'
import type { StructuredLogger } from '../src/infra/StructuredLogger.js'
import {
  calculateSearchQueryBudgetMs,
  SearchExecutionError,
  SearchExecutor
} from '../src/orchestration/SearchExecutor.js'
import { SearchQueryPool } from '../src/orchestration/SearchQueryPool.js'

afterEach(() => {
  vi.useRealTimers()
})

function task(completed = 9): TaskRecord {
  return {
    taskId: 'account:date:pc-search',
    accountId: 'account',
    localDate: '2026-09-03',
    sourceTaskId: 'pc-search',
    type: 'pc-search',
    source: 'bing-flyout',
    displayName: 'PC 搜索',
    executable: true,
    required: true,
    status: 'running',
    progress: { completed, total: 60 },
    updatedAt: '2026-09-03T00:00:00Z'
  }
}

function hangingPage(): { page: Page; closed: ReturnType<typeof vi.fn> } {
  const closed = vi.fn().mockResolvedValue(undefined)
  const hanging = new Promise<void>(() => undefined)
  const box = {
    first: () => box,
    waitFor: vi.fn(() => hanging),
    fill: vi.fn(),
    press: vi.fn()
  }
  return {
    page: {
      goto: vi.fn().mockResolvedValue(null),
      locator: vi.fn().mockReturnValue(box),
      close: closed
    } as unknown as Page,
    closed
  }
}

function delayedSearchBoxPage(): {
  page: Page
  closed: ReturnType<typeof vi.fn>
  fill: ReturnType<typeof vi.fn>
  press: ReturnType<typeof vi.fn>
} {
  const closed = vi.fn().mockResolvedValue(undefined)
  const fill = vi.fn().mockResolvedValue(undefined)
  const press = vi.fn().mockResolvedValue(undefined)
  const box = {
    first: () => box,
    waitFor: vi.fn(() => new Promise<void>((resolve) => setTimeout(resolve, 50))),
    fill,
    press
  }
  return {
    page: {
      goto: vi.fn().mockResolvedValue(null),
      locator: vi.fn().mockReturnValue(box),
      close: closed
    } as unknown as Page,
    closed,
    fill,
    press
  }
}

function searchBoxPage(waitFor: ReturnType<typeof vi.fn>): {
  page: Page
  closed: ReturnType<typeof vi.fn>
  fill: ReturnType<typeof vi.fn>
  press: ReturnType<typeof vi.fn>
} {
  const closed = vi.fn().mockResolvedValue(undefined)
  const fill = vi.fn().mockResolvedValue(undefined)
  const press = vi.fn().mockResolvedValue(undefined)
  const box = { first: () => box, waitFor, fill, press }
  return {
    page: {
      goto: vi.fn().mockResolvedValue(null),
      locator: vi.fn().mockReturnValue(box),
      close: closed
    } as unknown as Page,
    closed,
    fill,
    press
  }
}

describe('search budgets and cancellation', () => {
  it('retries a search-box failure once without duplicating submission', async () => {
    vi.useFakeTimers()
    const first = searchBoxPage(vi.fn().mockRejectedValue(new Error('not visible')))
    const second = searchBoxPage(vi.fn().mockResolvedValue(undefined))
    const newPage = vi.fn().mockResolvedValueOnce(first.page).mockResolvedValueOnce(second.page)
    const counter = {
      availability: 'valid',
      confidence: 1,
      source: 'bing-flyout',
      observedAt: new Date().toISOString(),
      value: { completed: 10, total: 60, remaining: 50 }
    }
    const write = vi.fn().mockResolvedValue(undefined)
    const logger = { write } as unknown as StructuredLogger
    const executor = new SearchExecutor(
      { newPage } as unknown as BrowserContext,
      { fetchDashboard: vi.fn().mockResolvedValue({ pcSearch: counter, mobileSearch: counter }) } as unknown as DashboardClient,
      logger,
      { ...DEFAULT_CONFIG.search, delayMinSeconds: 0, delayMaxSeconds: 0, scroll: false, clickResult: false },
      'run',
      'account-1'
    )

    const pending = executor.run({
      task: task(),
      mobile: false,
      singleQuery: 'synthetic-query',
      signal: new AbortController().signal,
      onProgress: vi.fn()
    })
    await vi.runAllTimersAsync()
    const result = await pending

    expect(result.progress.completed).toBe(10)
    expect(newPage).toHaveBeenCalledTimes(2)
    expect(first.press.mock.calls).toHaveLength(0)
    expect(second.press.mock.calls).toHaveLength(1)
    expect(write).toHaveBeenCalledWith(expect.objectContaining({ event: 'search-box-retry', retryAttempt: 1 }))
  })

  it('does not retry a submit-stage failure', async () => {
    const page = searchBoxPage(vi.fn().mockResolvedValue(undefined))
    page.press.mockRejectedValue(new Error('submit failed'))
    const newPage = vi.fn().mockResolvedValue(page.page)
    const counter = {
      availability: 'valid',
      confidence: 1,
      source: 'bing-flyout',
      observedAt: new Date().toISOString(),
      value: { completed: 10, total: 60, remaining: 50 }
    }
    const executor = new SearchExecutor(
      { newPage } as unknown as BrowserContext,
      { fetchDashboard: vi.fn().mockResolvedValue({ pcSearch: counter, mobileSearch: counter }) } as unknown as DashboardClient,
      { write: vi.fn().mockResolvedValue(undefined) } as unknown as StructuredLogger,
      { ...DEFAULT_CONFIG.search, delayMinSeconds: 0, delayMaxSeconds: 0, scroll: false, clickResult: false },
      'run',
      'account-1'
    )
    await expect(
      executor.run({ task: task(), mobile: false, signal: new AbortController().signal, onProgress: vi.fn() })
    ).rejects.toMatchObject({ operationStage: 'submit' })
    expect(newPage).toHaveBeenCalledTimes(1)
  })

  it('does not submit if the date changes while the search page is preparing', async () => {
    const { page, press } = delayedSearchBoxPage()
    let checks = 0
    const executor = new SearchExecutor(
      { newPage: vi.fn().mockResolvedValue(page) } as unknown as BrowserContext,
      {} as DashboardClient,
      {} as StructuredLogger,
      DEFAULT_CONFIG.search,
      'run',
      'synthetic',
      1000
    )
    await expect(
      executor.run({
        task: task(),
        mobile: false,
        signal: new AbortController().signal,
        onProgress: vi.fn(),
        beforeSubmit: () => {
          checks += 1
          if (checks > 1) throw new BusinessDateChanged()
        }
      })
    ).rejects.toBeInstanceOf(BusinessDateChanged)
    expect(press).not.toHaveBeenCalled()
  })
  it('includes the configured minute delay, scroll, click and dashboard budget', () => {
    const base = calculateSearchQueryBudgetMs(DEFAULT_CONFIG.search)
    expect(base).toBeGreaterThan(60_000)
    expect(
      calculateSearchQueryBudgetMs({
        ...DEFAULT_CONFIG.search,
        scroll: true,
        clickResult: true,
        resultVisitSeconds: 12
      })
    ).toBeGreaterThan(base + 20_000)
  })

  it('closes the active page on timeout and preserves confirmed progress', async () => {
    const { page, closed } = hangingPage()
    const executor = new SearchExecutor(
      { newPage: vi.fn().mockResolvedValue(page) } as unknown as BrowserContext,
      {} as DashboardClient,
      { write: vi.fn().mockResolvedValue(undefined) } as unknown as StructuredLogger,
      DEFAULT_CONFIG.search,
      'run',
      'account-1',
      20
    )
    const promise = executor.run({
      task: task(),
      mobile: false,
      signal: new AbortController().signal,
      onProgress: vi.fn()
    })
    await expect(promise).rejects.toMatchObject({
      name: 'SearchExecutionError',
      operationStage: 'search-box',
      completed: 9,
      total: 60
    } satisfies Partial<SearchExecutionError>)
    expect(closed).toHaveBeenCalled()
  })

  it('does not continue typing or submitting when a closed page operation resolves late', async () => {
    const { page, closed, fill, press } = delayedSearchBoxPage()
    const executor = new SearchExecutor(
      { newPage: vi.fn().mockResolvedValue(page) } as unknown as BrowserContext,
      {} as DashboardClient,
      { write: vi.fn().mockResolvedValue(undefined) } as unknown as StructuredLogger,
      DEFAULT_CONFIG.search,
      'run',
      'account-1',
      20
    )

    await expect(
      executor.run({
        task: task(),
        mobile: false,
        signal: new AbortController().signal,
        onProgress: vi.fn()
      })
    ).rejects.toMatchObject({ operationStage: 'search-box', completed: 9, total: 60 })
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(closed).toHaveBeenCalled()
    expect(fill).not.toHaveBeenCalled()
    expect(press).not.toHaveBeenCalled()
  })
})


describe('wangxun search model: persistent page, periodic refresh, realistic typing, and stagnant detection', () => {
  it('reuses a single persistent search page across multiple queries in a session', async () => {
    vi.useFakeTimers()
    const goto = vi.fn().mockResolvedValue(null)
    const closed = vi.fn().mockResolvedValue(undefined)
    const fill = vi.fn().mockResolvedValue(undefined)
    const press = vi.fn().mockResolvedValue(undefined)
    const box = {
      first: () => box,
      waitFor: vi.fn().mockResolvedValue(undefined),
      fill,
      press
    }
    const mockPage = {
      goto,
      locator: vi.fn().mockReturnValue(box),
      close: closed,
      isClosed: vi.fn().mockReturnValue(false)
    } as unknown as Page
    const newPage = vi.fn().mockResolvedValue(mockPage)

    let progressCount = 0
    const fetchDashboard = vi.fn().mockImplementation(() => {
      progressCount += 3
      return Promise.resolve({
        pcSearch: {
          availability: 'valid',
          confidence: 1,
          source: 'bing-flyout',
          observedAt: new Date().toISOString(),
          value: { completed: progressCount, total: 6, remaining: Math.max(0, 6 - progressCount) }
        },
        mobileSearch: {
          availability: 'valid',
          confidence: 1,
          source: 'bing-flyout',
          observedAt: new Date().toISOString(),
          value: { completed: 0, total: 0, remaining: 0 }
        }
      })
    })

    const executor = new SearchExecutor(
      { newPage } as unknown as BrowserContext,
      { fetchDashboard } as unknown as DashboardClient,
      { write: vi.fn().mockResolvedValue(undefined) } as unknown as StructuredLogger,
      { ...DEFAULT_CONFIG.search, delayMinSeconds: 0, delayMaxSeconds: 0, scroll: false, clickResult: false },
      'run-reuse',
      'account-reuse'
    )

    const runPromise = executor.run({
      task: { ...task(0), progress: { completed: 0, total: 6 } },
      mobile: false,
      signal: new AbortController().signal,
      onProgress: vi.fn()
    })

    await vi.runAllTimersAsync()
    const result = await runPromise

    expect(result.status).toBe('completed')
    expect(result.progress.completed).toBe(6)
    expect(newPage).toHaveBeenCalledTimes(1)
    expect(closed).toHaveBeenCalledTimes(1)
  })

  it('triggers periodic refresh navigation with PC=U531, FORM=ANNTA1 and cvid on the 10th search', async () => {
    vi.useFakeTimers()
    const gotoCalls: string[] = []
    const goto = vi.fn().mockImplementation((url: string) => {
      gotoCalls.push(url)
      return Promise.resolve(null)
    })
    const closed = vi.fn().mockResolvedValue(undefined)
    const fill = vi.fn().mockResolvedValue(undefined)
    const press = vi.fn().mockResolvedValue(undefined)
    const box = {
      first: () => box,
      waitFor: vi.fn().mockResolvedValue(undefined),
      fill,
      press
    }
    const mockPage = {
      goto,
      locator: vi.fn().mockReturnValue(box),
      close: closed,
      isClosed: vi.fn().mockReturnValue(false)
    } as unknown as Page
    const newPage = vi.fn().mockResolvedValue(mockPage)

    let progressCount = 0
    const fetchDashboard = vi.fn().mockImplementation(() => {
      progressCount += 3
      return Promise.resolve({
        pcSearch: {
          availability: 'valid',
          confidence: 1,
          source: 'bing-flyout',
          observedAt: new Date().toISOString(),
          value: { completed: progressCount, total: 30, remaining: Math.max(0, 30 - progressCount) }
        },
        mobileSearch: {
          availability: 'valid',
          confidence: 1,
          source: 'bing-flyout',
          observedAt: new Date().toISOString(),
          value: { completed: 0, total: 0, remaining: 0 }
        }
      })
    })

    const executor = new SearchExecutor(
      { newPage } as unknown as BrowserContext,
      { fetchDashboard } as unknown as DashboardClient,
      { write: vi.fn().mockResolvedValue(undefined) } as unknown as StructuredLogger,
      { ...DEFAULT_CONFIG.search, delayMinSeconds: 0, delayMaxSeconds: 0, scroll: false, clickResult: false },
      'run-periodic',
      'account-periodic'
    )

    const runPromise = executor.run({
      task: { ...task(0), progress: { completed: 0, total: 30 } },
      mobile: false,
      signal: new AbortController().signal,
      onProgress: vi.fn()
    })

    await vi.runAllTimersAsync()
    const result = await runPromise

    expect(result.status).toBe('completed')
    expect(result.progress.completed).toBe(30)
    expect(gotoCalls[0]).toBe('https://www.bing.com/')
    expect(gotoCalls).toHaveLength(2)
    const refreshUrl = gotoCalls[1]
    expect(refreshUrl).toBeDefined()
    expect(refreshUrl).toMatch(/^https:\/\/www\.bing\.com\/search\?q=.*&PC=U531&FORM=ANNTA1&cvid=[a-f0-9]{32}$/)
  })

  it('performs realistic typing flow with Home key, triple click, fill clearing, and keyboard typing delay', async () => {
    vi.useFakeTimers()
    const evaluated: Array<() => void> = []
    const evaluate = vi.fn().mockImplementation((fn: () => void) => {
      evaluated.push(fn)
      return Promise.resolve()
    })
    const keyboardPress = vi.fn().mockResolvedValue(undefined)
    const keyboardType = vi.fn().mockResolvedValue(undefined)
    const boxClick = vi.fn().mockResolvedValue(undefined)
    const boxFill = vi.fn().mockResolvedValue(undefined)
    const boxPress = vi.fn().mockResolvedValue(undefined)

    const box = {
      first: () => box,
      waitFor: vi.fn().mockResolvedValue(undefined),
      click: boxClick,
      fill: boxFill,
      press: boxPress
    }
    const mockPage = {
      goto: vi.fn().mockResolvedValue(null),
      locator: vi.fn().mockReturnValue(box),
      evaluate,
      keyboard: {
        press: keyboardPress,
        type: keyboardType
      },
      close: vi.fn().mockResolvedValue(undefined),
      isClosed: vi.fn().mockReturnValue(false)
    } as unknown as Page

    const fetchDashboard = vi.fn().mockResolvedValue({
      pcSearch: {
        availability: 'valid',
        confidence: 1,
        source: 'bing-flyout',
        observedAt: new Date().toISOString(),
        value: { completed: 3, total: 3, remaining: 0 }
      },
      mobileSearch: {
        availability: 'valid',
        confidence: 1,
        source: 'bing-flyout',
        observedAt: new Date().toISOString(),
        value: { completed: 0, total: 0, remaining: 0 }
      }
    })

    const executor = new SearchExecutor(
      { newPage: vi.fn().mockResolvedValue(mockPage) } as unknown as BrowserContext,
      { fetchDashboard } as unknown as DashboardClient,
      { write: vi.fn().mockResolvedValue(undefined) } as unknown as StructuredLogger,
      { ...DEFAULT_CONFIG.search, delayMinSeconds: 0, delayMaxSeconds: 0, scroll: false, clickResult: false },
      'run-typing',
      'account-typing'
    )

    const runPromise = executor.run({
      task: { ...task(0), progress: { completed: 0, total: 3 } },
      mobile: false,
      singleQuery: '拟人化打字测试',
      signal: new AbortController().signal,
      onProgress: vi.fn()
    })

    await vi.runAllTimersAsync()
    const result = await runPromise

    expect(result.status).toBe('completed')
    expect(keyboardPress).toHaveBeenCalledWith('Home')
    expect(boxClick).toHaveBeenCalledWith({ clickCount: 3 })
    expect(boxFill).toHaveBeenCalledWith('')
    expect(keyboardType).toHaveBeenCalledWith('拟人化打字测试', expect.anything())
    const delayArg = (keyboardType.mock.calls as unknown as Array<[string, { delay?: number }]>)[0]?.[1]?.delay ?? 0
    expect(delayArg).toBeGreaterThanOrEqual(45)
    expect(delayArg).toBeLessThanOrEqual(75)
    expect(boxPress).toHaveBeenCalledWith('Enter', { timeout: 15_000 })
  })

  it('safely closes newly opened popup tabs during search result visit', async () => {
    vi.useFakeTimers()
    const popupClosed = vi.fn().mockResolvedValue(undefined)
    const popupPage = {
      close: popupClosed
    } as unknown as Page

    const mainPageClosed = vi.fn().mockResolvedValue(undefined)
    const box = {
      first: () => box,
      waitFor: vi.fn().mockResolvedValue(undefined),
      fill: vi.fn().mockResolvedValue(undefined),
      press: vi.fn().mockResolvedValue(undefined)
    }
    const resultLink = {
      first: () => resultLink,
      isVisible: vi.fn().mockResolvedValue(true),
      click: vi.fn().mockImplementation(() => {
        openPages.push(popupPage)
        return Promise.resolve()
      })
    }

    const mainPage = {
      goto: vi.fn().mockResolvedValue(null),
      locator: vi.fn().mockImplementation((sel: string) => {
        if (sel.includes('b_algo') || sel.includes('b_results')) return resultLink
        return box
      }),
      url: vi.fn().mockReturnValue('https://www.bing.com/search?q=test'),
      close: mainPageClosed,
      isClosed: vi.fn().mockReturnValue(false)
    } as unknown as Page

    const openPages: Page[] = [mainPage]
    const context = {
      newPage: vi.fn().mockResolvedValue(mainPage),
      pages: () => openPages
    } as unknown as BrowserContext

    const fetchDashboard = vi.fn().mockResolvedValue({
      pcSearch: {
        availability: 'valid',
        confidence: 1,
        source: 'bing-flyout',
        observedAt: new Date().toISOString(),
        value: { completed: 3, total: 3, remaining: 0 }
      },
      mobileSearch: {
        availability: 'valid',
        confidence: 1,
        source: 'bing-flyout',
        observedAt: new Date().toISOString(),
        value: { completed: 0, total: 0, remaining: 0 }
      }
    })

    const executor = new SearchExecutor(
      context,
      { fetchDashboard } as unknown as DashboardClient,
      { write: vi.fn().mockResolvedValue(undefined) } as unknown as StructuredLogger,
      {
        ...DEFAULT_CONFIG.search,
        delayMinSeconds: 0,
        delayMaxSeconds: 0,
        scroll: false,
        clickResult: true,
        resultVisitSeconds: 1
      },
      'run-tab-cleanup',
      'account-tab'
    )

    const runPromise = executor.run({
      task: { ...task(0), progress: { completed: 0, total: 3 } },
      mobile: false,
      singleQuery: '标签页清理测试',
      signal: new AbortController().signal,
      onProgress: vi.fn()
    })

    await vi.runAllTimersAsync()
    const result = await runPromise

    expect(result.status).toBe('completed')
    expect(resultLink.click).toHaveBeenCalled()
    expect(popupClosed).toHaveBeenCalledTimes(1)
  })

  it('aborts with verification-pending when consecutive stagnant queries hit stagnantLimit (10)', async () => {
    vi.useFakeTimers()
    const box = {
      first: () => box,
      waitFor: vi.fn().mockResolvedValue(undefined),
      fill: vi.fn().mockResolvedValue(undefined),
      press: vi.fn().mockResolvedValue(undefined)
    }
    const mockPage = {
      goto: vi.fn().mockResolvedValue(null),
      locator: vi.fn().mockReturnValue(box),
      close: vi.fn().mockResolvedValue(undefined),
      isClosed: vi.fn().mockReturnValue(false)
    } as unknown as Page

    const fetchDashboard = vi.fn().mockResolvedValue({
      pcSearch: {
        availability: 'valid',
        confidence: 1,
        source: 'bing-flyout',
        observedAt: new Date().toISOString(),
        value: { completed: 9, total: 60, remaining: 51 }
      },
      mobileSearch: {
        availability: 'valid',
        confidence: 1,
        source: 'bing-flyout',
        observedAt: new Date().toISOString(),
        value: { completed: 0, total: 0, remaining: 0 }
      }
    })

    const write = vi.fn().mockResolvedValue(undefined)
    const logger = { write } as unknown as StructuredLogger

    const executor = new SearchExecutor(
      { newPage: vi.fn().mockResolvedValue(mockPage) } as unknown as BrowserContext,
      { fetchDashboard } as unknown as DashboardClient,
      logger,
      {
        ...DEFAULT_CONFIG.search,
        delayMinSeconds: 0,
        delayMaxSeconds: 0,
        scroll: false,
        clickResult: false,
        stagnantLimit: 10
      },
      'run-stagnant',
      'account-stagnant'
    )

    const runPromise = executor.run({
      task: task(9),
      mobile: false,
      signal: new AbortController().signal,
      onProgress: vi.fn()
    })

    await vi.runAllTimersAsync()
    const result = await runPromise

    expect(result.status).toBe('verification-pending')
    expect(result.reason).toContain('stagnant-progress: 连续 10 次搜索未获积分，停止本轮搜索')
    expect(box.press).toHaveBeenCalledTimes(10)
    expect(write).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'search-stagnant-aborted',
        retryReason: 'stagnant-progress',
        status: 'verification-pending'
      })
    )
  })
})

describe('SearchQueryPool', () => {
  it('loads Chinese query dictionary with high volume', () => {
    const pool = new SearchQueryPool()
    expect(pool.size).toBeGreaterThanOrEqual(52)
    const query = pool.getQuery('acc1', '2026-09-18', 0)
    expect(typeof query).toBe('string')
    expect(query.length).toBeGreaterThan(0)
  })

  it('provides deterministic queries based on account key, date, and offset', () => {
    const pool = new SearchQueryPool(['词A', '词B', '词C', '词D', '词E'])
    const q1 = pool.getQuery('user-1', '2026-09-18', 0)
    const q1Repeat = pool.getQuery('user-1', '2026-09-18', 0)
    expect(q1).toBe(q1Repeat)

    const q2 = pool.getQuery('user-1', '2026-09-18', 1)
    const queriesBatch = pool.getQueries('user-1', '2026-09-18', 3, 0)
    expect(queriesBatch).toHaveLength(3)
    expect(queriesBatch[0]).toBe(q1)
    expect(queriesBatch[1]).toBe(q2)
  })

  it('falls back to default fallback queries when no queries are loaded', () => {
    const pool = new SearchQueryPool([])
    expect(pool.size).toBeGreaterThanOrEqual(52)
  })
})
