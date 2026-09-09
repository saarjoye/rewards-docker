import { describe, expect, it, vi } from 'vitest'
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

describe('search budgets and cancellation', () => {
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
