import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserContext, Page } from 'patchright'

import { createSearchExecutor } from './helpers/searchExecutor.js'
import type { DashboardClient } from '../src/browser/DashboardClient.js'
import type { TaskRecord } from '../src/domain/Task.js'
import { DEFAULT_CONFIG } from '../src/infra/Config.js'
import type { LogEvent, StructuredLogger } from '../src/infra/StructuredLogger.js'
import { BusinessDateChanged } from '../src/orchestration/BusinessDate.js'

afterEach(() => vi.useRealTimers())

type ScrollFailure = 'navigation' | 'closed' | 'unknown' | 'timeout' | 'none'

function harness(failure: ScrollFailure = 'none', scroll = true, budget = 100_000) {
  vi.useFakeTimers()
  const controller = new AbortController()
  const press = vi.fn().mockResolvedValue(undefined)
  const box = {
    first: () => box,
    waitFor: vi.fn().mockResolvedValue(undefined),
    fill: vi.fn().mockResolvedValue(undefined),
    press
  }
  let finishScroll = (): void => undefined
  const scrollOperation = vi.fn(async () => {
    if (failure === 'navigation')
      throw new Error('Execution context was destroyed, most likely because of a navigation')
    if (failure === 'closed') throw new Error('Target page, context or browser has been closed')
    if (failure === 'unknown')
      throw new Error('https://synthetic.invalid/?token=SCROLL_SECRET_CANARY')
    if (failure === 'timeout')
      await new Promise<void>((resolve) => {
        finishScroll = resolve
      })
  })
  const evaluate = vi.fn(async (callback: () => unknown) => {
    if (String(callback).includes('window.scrollBy')) await scrollOperation()
  })
  const close = vi.fn().mockResolvedValue(undefined)
  const locator = vi.fn<(selector: string) => typeof box>().mockReturnValue(box)
  const page = {
    goto: vi.fn().mockResolvedValue(null),
    locator,
    evaluate,
    close,
    on: vi.fn(),
    off: vi.fn(),
    url: () => 'https://synthetic.invalid/'
  } as unknown as Page
  const newPage = vi.fn().mockResolvedValue(page)
  const fetchDashboard = vi.fn(() => {
    const counter = {
      availability: 'valid',
      confidence: 1,
      source: 'bing-flyout',
      observedAt: new Date().toISOString(),
      value: { completed: 60, total: 60, remaining: 0 }
    }
    return Promise.resolve({ pcSearch: counter, mobileSearch: counter })
  })
  const write = vi.fn<(event: LogEvent) => Promise<void>>().mockResolvedValue(undefined)
  const config = {
    ...DEFAULT_CONFIG.search,
    scroll,
    clickResult: false,
    delayMinSeconds: 0,
    delayMaxSeconds: 0
  }
  const executor = createSearchExecutor(
    { newPage, pages: () => [page], on: vi.fn(), off: vi.fn() } as unknown as BrowserContext,
    { fetchDashboard } as unknown as DashboardClient,
    { write } as unknown as StructuredLogger,
    config,
    'synthetic-run',
    'synthetic-account',
    budget
  )
  const task: TaskRecord = {
    taskId: 'synthetic-account:2026-10-07:pc-search',
    accountId: 'synthetic-account',
    localDate: '2026-10-07',
    sourceTaskId: 'pc-search',
    type: 'pc-search',
    source: 'bing-flyout',
    displayName: 'Synthetic PC search',
    executable: true,
    required: true,
    status: 'running',
    progress: { completed: 9, total: 60 },
    updatedAt: '2026-10-07T00:00:00Z'
  }
  const onProgress = vi.fn()
  const execute = (singleQuery: string | null = 'synthetic search', beforeSubmit?: () => void) =>
    executor.run({
      task,
      mobile: false,
      ...(singleQuery === null ? {} : { singleQuery }),
      ...(beforeSubmit === undefined ? {} : { beforeSubmit }),
      signal: controller.signal,
      onProgress
    })
  return {
    execute,
    press,
    scrollOperation,
    close,
    newPage,
    fetchDashboard,
    write,
    onProgress,
    controller,
    config,
    page,
    finishScroll: () => {
      finishScroll()
    },
    locator,
    box
  }
}

async function finish<T>(promise: Promise<T>): Promise<T> {
  const handled = promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error })
  )
  await vi.runAllTimersAsync()
  const result = await handled
  if ('error' in result) throw result.error
  return result.value
}

describe('optional search scrolling', () => {
  it.each([
    ['navigation', 'navigation-changed'],
    ['closed', 'page-closed'],
    ['unknown', 'page-operation-failed'],
    ['timeout', 'page-operation-timeout']
  ] as const)(
    'isolates %s and accepts only confirmed official completion',
    async (failure, reason) => {
      const h = harness(failure)
      const result = await finish(h.execute())
      expect(result).toMatchObject({
        status: 'completed',
        progress: { completed: 60, total: 60 },
        searchObservation: { submittedCount: 1, unknownSubmissionCount: 0, awaitingProgress: false }
      })
      expect(h.press).toHaveBeenCalledTimes(1)
      expect(h.newPage).toHaveBeenCalledTimes(1)
      expect(h.scrollOperation).toHaveBeenCalledTimes(1)
      expect(h.fetchDashboard).toHaveBeenCalledTimes(1)
      expect(h.close).toHaveBeenCalledTimes(1)
      expect(h.write).toHaveBeenCalledWith(
        expect.objectContaining({
          level: 'warn',
          event: 'search-scroll-skipped',
          stage: 'scroll',
          reason,
          submitted: true
        })
      )
      expect(JSON.stringify(h.write.mock.calls)).not.toMatch(
        /SCROLL_SECRET_CANARY|synthetic\.invalid/
      )
    }
  )

  it('keeps healthy scrolling and the configured delay', async () => {
    const h = harness()
    h.config.delayMinSeconds = 5
    h.config.delayMaxSeconds = 5
    const started = Date.now()
    expect((await finish(h.execute())).status).toBe('completed')
    expect(Date.now() - started).toBeGreaterThanOrEqual(9_000)
    expect(h.press).toHaveBeenCalledTimes(1)
    expect(h.scrollOperation).toHaveBeenCalledTimes(2)
    expect(h.write.mock.calls.some(([event]) => event.event === 'search-scroll-skipped')).toBe(
      false
    )
  })

  it('preserves the configured delay even when scrolling fails', async () => {
    const h = harness('closed')
    h.config.delayMinSeconds = 5
    h.config.delayMaxSeconds = 5
    const started = Date.now()
    await finish(h.execute())
    expect(Date.now() - started).toBeGreaterThanOrEqual(8_000)
  })

  it('does not scroll when the option is disabled', async () => {
    const h = harness('navigation', false)
    expect((await finish(h.execute())).status).toBe('completed')
    expect(h.scrollOperation).not.toHaveBeenCalled()
    expect(h.press).toHaveBeenCalledTimes(1)
  })

  it('does not repeat an unconfirmed submission after a scroll failure', async () => {
    const h = harness('navigation')
    h.fetchDashboard.mockImplementation(() => {
      const counter = {
        availability: 'valid',
        confidence: 1,
        source: 'bing-flyout',
        observedAt: new Date().toISOString(),
        value: { completed: 9, total: 60, remaining: 51 }
      }
      return Promise.resolve({ pcSearch: counter, mobileSearch: counter })
    })
    const result = await finish(h.execute(null))
    expect(result).toMatchObject({
      status: 'verification-pending',
      progress: { completed: 9, total: 60 },
      searchObservation: { submittedCount: 1, awaitingProgress: true, canContinue: false }
    })
    expect(h.press).toHaveBeenCalledTimes(1)
    expect(h.newPage).toHaveBeenCalledTimes(1)
  })

  it('keeps a submitted search pending when official reads fail after scrolling fails', async () => {
    const h = harness('closed')
    h.fetchDashboard.mockRejectedValue(new Error('SYNTHETIC_READ_SECRET'))
    const result = await finish(h.execute(null))
    expect(result.status).toBe('verification-pending')
    expect(result.searchObservation?.awaitingProgress).toBe(true)
    expect(h.press).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(h.write.mock.calls)).not.toContain('SYNTHETIC_READ_SECRET')
  })

  it('opens a fresh page only after official progress confirms the previous submission', async () => {
    const h = harness('navigation')
    h.fetchDashboard.mockImplementationOnce(() => {
      const counter = {
        availability: 'valid',
        confidence: 1,
        source: 'bing-flyout',
        observedAt: new Date().toISOString(),
        value: { completed: 12, total: 60, remaining: 48 }
      }
      return Promise.resolve({ pcSearch: counter, mobileSearch: counter })
    })
    expect((await finish(h.execute(null))).status).toBe('completed')
    expect(h.press).toHaveBeenCalledTimes(2)
    expect(h.newPage).toHaveBeenCalledTimes(2)
    expect(h.fetchDashboard.mock.invocationCallOrder[0]).toBeLessThan(
      h.newPage.mock.invocationCallOrder[1] ?? 0
    )
  })

  it('survives a failed warning write', async () => {
    const h = harness('unknown')
    h.write.mockImplementation((event) => {
      if (event.event === 'search-scroll-skipped')
        return Promise.reject(new Error('synthetic logger error'))
      return Promise.resolve()
    })
    expect((await finish(h.execute())).status).toBe('completed')
    expect(h.press).toHaveBeenCalledTimes(1)
  })

  it('skips result clicks on the affected page', async () => {
    const h = harness('closed')
    h.config.clickResult = true
    const beforeSubmit = vi.fn()
    expect((await finish(h.execute('synthetic search', beforeSubmit))).status).toBe('completed')
    expect(h.press).toHaveBeenCalledTimes(1)
    // A result visit would call the page locator a second time.
    expect(h.locator).toHaveBeenCalledTimes(1)
  })

  it('reconciles an overall timeout in scrolling without repeating the search', async () => {
    const h = harness('timeout', true, 4_000)
    expect((await finish(h.execute())).status).toBe('completed')
    expect(h.press).toHaveBeenCalledTimes(1)
    expect(h.close).toHaveBeenCalledTimes(1)
  })

  it('bounds a hung scroll and stops late scrolling or clicking', async () => {
    const h = harness('timeout')
    h.config.clickResult = true
    const started = Date.now()
    expect((await finish(h.execute())).status).toBe('completed')
    expect(Date.now() - started).toBeLessThan(20_000)
    h.finishScroll()
    await vi.runAllTimersAsync()
    expect(h.scrollOperation).toHaveBeenCalledTimes(1)
    expect(h.locator).toHaveBeenCalledTimes(1)
    expect(h.press).toHaveBeenCalledTimes(1)
  })

  it('propagates cancellation and prevents late operations', async () => {
    const h = harness('timeout')
    const cancelled = new Error('synthetic cancellation')
    const result = h.execute()
    const rejected = expect(result).rejects.toBe(cancelled)
    await vi.advanceTimersByTimeAsync(3_100)
    h.controller.abort(cancelled)
    await vi.runAllTimersAsync()
    await rejected
    h.finishScroll()
    await vi.runAllTimersAsync()
    expect(h.scrollOperation).toHaveBeenCalledTimes(1)
    expect(h.fetchDashboard).not.toHaveBeenCalled()
    expect(h.press).toHaveBeenCalledTimes(1)
    expect(h.close).toHaveBeenCalledTimes(1)
  })

  it('does not swallow a business-date change as an optional failure', async () => {
    const h = harness()
    h.scrollOperation.mockRejectedValue(new BusinessDateChanged())
    await expect(finish(h.execute())).rejects.toBeInstanceOf(BusinessDateChanged)
    expect(h.fetchDashboard).not.toHaveBeenCalled()
    expect(h.press).toHaveBeenCalledTimes(1)
  })

  it('preserves safe diagnosis for a fatal page failure without exposing browser text', async () => {
    const h = harness('none', false)
    h.config.clickResult = true
    h.locator.mockImplementation((selector: string) => {
      if (selector.startsWith('#sb_form_q')) {
        return h.box
      }
      throw new Error(
        'Target page has been closed https://synthetic.invalid/?token=FATAL_SECRET_CANARY'
      )
    })
    await expect(finish(h.execute())).rejects.toMatchObject({
      operationStage: 'click',
      message: '搜索页面操作失败（page-closed）'
    })
    expect(JSON.stringify(h.write.mock.calls)).not.toContain('FATAL_SECRET_CANARY')
    expect(h.press).toHaveBeenCalledTimes(1)
  })
})
