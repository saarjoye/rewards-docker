import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserContext, Page } from 'patchright'
import type { DashboardClient } from '../src/browser/DashboardClient.js'
import type { TaskRecord } from '../src/domain/Task.js'
import { DEFAULT_CONFIG } from '../src/infra/Config.js'
import type { StructuredLogger } from '../src/infra/StructuredLogger.js'
import { SearchQueryPool } from '../src/orchestration/SearchQueryPool.js'
import { SearchExecutor } from '../src/orchestration/SearchExecutor.js'
import { createSearchExecutor } from './helpers/searchExecutor.js'

afterEach(() => vi.useRealTimers())

function harness(
  options: {
    click?: boolean
    total?: number
    budget?: number
    delay?: number
    pool?: string[]
    stagnantLimit?: number
  } = {}
) {
  vi.useFakeTimers()
  const controller = new AbortController()
  const contextEvents = new EventEmitter()
  const pageEvents = new EventEmitter()
  let url = 'https://www.bing.com/'
  const box = {
    first: () => box,
    waitFor: vi.fn().mockResolvedValue(undefined),
    click: vi.fn().mockResolvedValue(undefined),
    fill: vi.fn().mockResolvedValue(undefined),
    press: vi.fn(() => {
      url = 'https://www.bing.com/search?q=synthetic'
      return Promise.resolve()
    })
  }
  const link = {
    first: () => link,
    isVisible: vi.fn().mockResolvedValue(true),
    click: vi.fn().mockResolvedValue(undefined)
  }
  const page = Object.assign(pageEvents, {
    goto: vi.fn((next: string) => {
      url = next
      return Promise.resolve()
    }),
    locator: vi.fn((selector: string) => (selector.includes('b_algo') ? link : box)),
    url: () => url,
    isClosed: () => false,
    opener: () => Promise.resolve(null),
    keyboard: {
      type: vi.fn().mockResolvedValue(undefined),
      press: vi.fn().mockResolvedValue(undefined)
    },
    close: vi.fn().mockResolvedValue(undefined)
  })
  const pages: Page[] = [page as unknown as Page]
  const context = Object.assign(contextEvents, {
    newPage: vi.fn().mockResolvedValue(page),
    pages: () => [...pages]
  })
  const total = options.total ?? 1
  const task: TaskRecord = {
    taskId: 'synthetic:2026-09-21:pc',
    accountId: 'stable-synthetic-id',
    localDate: '2026-09-21',
    sourceTaskId: 'pc-search',
    type: 'pc-search',
    source: 'bing-flyout',
    displayName: 'PC 搜索',
    executable: true,
    required: true,
    status: 'running',
    progress: { completed: 0, total },
    updatedAt: new Date().toISOString()
  }
  let completed = 0
  const fetchDashboard = vi.fn(() =>
    Promise.resolve({
      pcSearch: {
        availability: 'valid',
        confidence: 1,
        source: 'bing-flyout',
        observedAt: new Date().toISOString(),
        value: { completed: ++completed, total, remaining: total - completed }
      }
    })
  )
  const args: ConstructorParameters<typeof SearchExecutor> = [
    context as unknown as BrowserContext,
    { fetchDashboard } as unknown as DashboardClient,
    { write: vi.fn().mockResolvedValue(undefined) } as unknown as StructuredLogger,
    {
      ...DEFAULT_CONFIG.search,
      scroll: false,
      clickResult: options.click ?? false,
      delayMinSeconds: options.delay ?? 0,
      delayMaxSeconds: options.delay ?? 0,
      stagnantLimit: options.stagnantLimit ?? 10
    },
    'synthetic-run',
    'order-dependent-alias',
    options.budget,
    new SearchQueryPool(options.pool)
  ]
  const executor = createSearchExecutor(...args)
  const input = { task, mobile: false, signal: controller.signal, onProgress: vi.fn() }
  const popup = (parent: Page | null = page as unknown as Page) => {
    const emitter = new EventEmitter()
    const child = Object.assign(emitter, {
      opener: () => Promise.resolve(parent),
      close: vi.fn().mockResolvedValue(undefined)
    })
    pages.push(child as unknown as Page)
    context.emit('page', child)
    if (parent) (parent as unknown as EventEmitter).emit('popup', child)
    return child
  }
  return { executor, input, page, context, box, link, popup, controller, fetchDashboard, args }
}

describe('search resource ownership and cancellation', () => {
  it('closes delayed popups that open after the result visit during the search delay', async () => {
    const h = harness({ click: true, delay: 20 })
    let late: ReturnType<typeof h.popup> | undefined
    h.link.click.mockImplementation(() => {
      setTimeout(() => {
        late = h.popup()
      }, 9_000)
      return Promise.resolve()
    })
    const pending = h.executor.run(h.input)
    await vi.advanceTimersByTimeAsync(12_001)
    expect(late?.close).toHaveBeenCalledTimes(1)
    await vi.runAllTimersAsync()
    expect((await pending).status).toBe('completed')
    expect(h.page.listenerCount('popup')).toBe(0)
    expect(late?.listenerCount('popup')).toBe(0)
  })

  it.each(['normal', 'click-error', 'cancel', 'timeout'])(
    'cleans popup descendants on %s without closing unrelated tabs',
    async (mode) => {
      const h = harness({ click: true, ...(mode === 'timeout' ? { budget: 4_000 } : {}) })
      const existing = h.popup(null)
      let child: ReturnType<typeof h.popup> | undefined
      let grandchild: ReturnType<typeof h.popup> | undefined
      let unrelated: ReturnType<typeof h.popup> | undefined
      h.link.click.mockImplementation(() => {
        child = h.popup()
        grandchild = h.popup(child as unknown as Page)
        unrelated = h.popup(null)
        if (mode === 'click-error') return Promise.reject(new Error('synthetic click failure'))
        if (mode === 'cancel') h.controller.abort(new Error('synthetic cancel'))
        return Promise.resolve()
      })
      const result = h.executor.run(h.input).catch((error: unknown) => error)
      await vi.runAllTimersAsync()
      const settled = await result
      if (mode === 'normal') expect(settled).toMatchObject({ status: 'completed' })
      else expect(settled).toBeInstanceOf(Error)
      expect(child?.close).toHaveBeenCalledTimes(1)
      expect(grandchild?.close).toHaveBeenCalledTimes(1)
      expect(existing.close).not.toHaveBeenCalled()
      expect(unrelated?.close).not.toHaveBeenCalled()
      expect(h.page.close).toHaveBeenCalledTimes(1)
      expect(h.page.listenerCount('popup')).toBe(0)
      expect(h.context.listenerCount('page')).toBe(0)
      expect(child?.listenerCount('popup')).toBe(0)
    }
  )

  it('returns to the result page after same-tab navigation even with a popup', async () => {
    const h = harness({ click: true })
    h.link.click.mockImplementation(async () => {
      h.popup()
      await h.page.goto('https://example.test/result')
    })
    const pending = h.executor.run(h.input)
    await vi.runAllTimersAsync()
    expect((await pending).status).toBe('completed')
    expect(h.page.goto).toHaveBeenLastCalledWith(
      'https://www.bing.com/search?q=synthetic',
      expect.anything()
    )
  })

  it.each(['new-page', 'navigation', 'typing'])(
    'prevents late submission when cancelled during %s',
    async (stage) => {
      const h = harness()
      let release: () => void = () => undefined
      const blocked = new Promise<void>((resolve) => {
        release = resolve
      })
      if (stage === 'new-page')
        h.context.newPage.mockImplementation(async () => {
          await blocked
          return h.page
        })
      if (stage === 'navigation')
        h.page.goto.mockImplementation(async () => {
          await blocked
        })
      if (stage === 'typing') h.page.keyboard.type.mockImplementation(() => blocked)
      const pending = h.executor.run(h.input).catch((error: unknown) => error)
      await vi.advanceTimersByTimeAsync(1)
      h.controller.abort(new Error('cancel'))
      await vi.advanceTimersByTimeAsync(1_001)
      expect(await pending).toBeInstanceOf(Error)
      release()
      await vi.runAllTimersAsync()
      expect(h.box.press).not.toHaveBeenCalled()
      expect(h.page.close).toHaveBeenCalledTimes(1)
    }
  )

  it('does not submit after failed focus or failed typing', async () => {
    for (const stage of ['focus', 'typing']) {
      const h = harness()
      const fail = vi.fn().mockRejectedValue(new Error('synthetic input failure'))
      if (stage === 'focus') h.box.click.mockImplementation(fail)
      else h.page.keyboard.type.mockImplementation(fail)
      const pending = h.executor.run(h.input).catch((error: unknown) => error)
      await vi.runAllTimersAsync()
      expect(await pending).toBeInstanceOf(Error)
      expect(h.box.press).not.toHaveBeenCalled()
    }
  })
})

describe('allocation and search budgets', () => {
  it('resets the configured stagnation counter after confirmed progress', async () => {
    const h = harness({ total: 5, stagnantLimit: 2 })
    h.fetchDashboard.mockImplementation(() => {
      const completed = h.box.press.mock.calls.length >= 2 ? 1 : 0
      return Promise.resolve({
        pcSearch: {
          availability: 'valid',
          confidence: 1,
          source: 'bing-flyout',
          observedAt: new Date().toISOString(),
          value: { completed, total: 5, remaining: 5 - completed }
        }
      })
    })
    const pending = h.executor.run(h.input)
    await vi.runAllTimersAsync()
    expect(await pending).toMatchObject({
      status: 'verification-pending',
      progress: { completed: 1 }
    })
    expect(h.box.press).toHaveBeenCalledTimes(4)
  })

  it('uses a ten-query limit when older runtime config omits stagnantLimit', async () => {
    const h = harness({ total: 20 })
    Reflect.deleteProperty(h.args[3], 'stagnantLimit')
    h.fetchDashboard.mockImplementation(() =>
      Promise.resolve({
        pcSearch: {
          availability: 'valid',
          confidence: 1,
          source: 'bing-flyout',
          observedAt: new Date().toISOString(),
          value: { completed: 0, total: 20, remaining: 20 }
        }
      })
    )
    const pending = h.executor.run(h.input)
    await vi.runAllTimersAsync()
    const result = await pending
    expect(result.status).toBe('verification-pending')
    expect(result.reason).toContain('10')
    expect(h.box.press).toHaveBeenCalledTimes(10)
  })

  it('uses persistent account identity and stops at exhaustion without marking completion', async () => {
    const h = harness({ total: 3, pool: ['甲', '乙'] })
    const pending = h.executor.run(h.input)
    await vi.runAllTimersAsync()
    expect(await pending).toMatchObject({
      status: 'action-required',
      reason: 'search-query-pool-exhausted',
      progress: { completed: 2 }
    })
    const first = new SearchQueryPool(['甲', '乙']).getQuery(
      h.input.task.accountId,
      h.input.task.localDate,
      0
    )
    expect(h.page.keyboard.type.mock.calls[0]?.[0]).toBe(first)
    expect(h.box.press).toHaveBeenCalledTimes(2)
  })

  it('does not reuse an explicit query across runs', async () => {
    const h = harness()
    const input = { ...h.input, singleQuery: 'Explicit synthetic query' }
    const first = h.executor.run(input)
    await vi.runAllTimersAsync()
    await first
    const second = h.executor.run(input)
    await vi.runAllTimersAsync()
    expect(await second).toMatchObject({
      status: 'action-required',
      reason: 'search-query-already-reserved'
    })
    expect(h.box.press).toHaveBeenCalledTimes(1)
  })

  it('does not allocate or open a page in read-only mode', async () => {
    const h = harness()
    const reserve = vi.fn(() => 'synthetic')
    h.args[8] = { reserve }
    const pending = new SearchExecutor(...h.args).run({ ...h.input, readOnly: true })
    await vi.runAllTimersAsync()
    await pending
    expect(reserve).not.toHaveBeenCalled()
    expect(h.context.newPage).not.toHaveBeenCalled()
  })

  it.each([360, 720])(
    'finishes searches with %i second delays beyond the old one-hour cap',
    async (delay) => {
      const h = harness({ total: 11, delay })
      const start = Date.now()
      const pending = h.executor.run(h.input)
      await vi.runAllTimersAsync()
      expect((await pending).status).toBe('completed')
      expect(Date.now() - start).toBeGreaterThan(60 * 60_000)
      expect(h.context.newPage).toHaveBeenCalledTimes(1)
      expect(h.box.press).toHaveBeenCalledTimes(11)
    }
  )

  it('caps execution at 24 hours including page initialization and input', async () => {
    const h = harness({ total: 10, budget: 4 * 60 * 60_000 })
    h.page.keyboard.type.mockImplementation(
      () => new Promise<void>((resolve) => setTimeout(resolve, 3 * 60 * 60_000))
    )
    const start = Date.now()
    const pending = h.executor.run(h.input).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000 + 2_000)
    expect(await pending).toBeInstanceOf(Error)
    expect(h.box.press).toHaveBeenCalledTimes(7)
    expect(Date.now() - start).toBe(24 * 60 * 60_000 + 2_000)
    await vi.runAllTimersAsync()
    expect(h.box.press).toHaveBeenCalledTimes(7)
  })
})
