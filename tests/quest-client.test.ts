import { EventEmitter } from 'node:events'
import type { BrowserContext } from 'patchright'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QuestClient } from '../src/browser/QuestClient.js'
import type { StructuredLogger } from '../src/infra/StructuredLogger.js'
import { BusinessDateChanged } from '../src/orchestration/BusinessDate.js'
import {
  childId,
  childOffer,
  destination,
  linkProps,
  parentId,
  quest,
  questHtml,
  questObservation
} from './fixtures/quests.js'

afterEach(() => vi.useRealTimers())

function ownedPage() {
  return Object.assign(new EventEmitter(), { close: vi.fn().mockResolvedValue(undefined) })
}

function fixture() {
  let currentUrl = 'about:blank'
  const candidate = {
    href: destination,
    ariaLabel: quest.ariaLabel,
    rowTitle: quest.title,
    offerId: childId,
    visible: true,
    disabled: false
  }
  const click = vi.fn().mockResolvedValue(undefined)
  const anchor = {
    evaluate: vi.fn().mockResolvedValue(candidate),
    click,
    dispose: vi.fn().mockResolvedValue(undefined)
  }
  const links = {
    evaluateAll: vi.fn().mockResolvedValue([candidate]),
    nth: vi.fn().mockReturnValue({ elementHandle: vi.fn().mockResolvedValue(anchor) })
  }
  const heading = {
    first: vi.fn().mockReturnThis(),
    waitFor: vi.fn().mockResolvedValue(undefined)
  }
  const page = Object.assign(ownedPage(), {
    goto: vi.fn((url: string): Promise<{ status(): number } | null> => {
      currentUrl = url
      return Promise.resolve(null)
    }),
    url: vi.fn(() => currentUrl),
    content: vi.fn().mockResolvedValue(questHtml()),
    evaluate: vi.fn().mockResolvedValue(questObservation().rows),
    locator: vi.fn((selector: string) => (selector === 'a[href]' ? links : heading)),
    waitForTimeout: vi.fn().mockResolvedValue(undefined)
  })
  const existing = ownedPage()
  const unrelated = ownedPage()
  const newPage = vi.fn().mockResolvedValue(page)
  const pages = vi.fn().mockReturnValue([existing, unrelated, page])
  const context = { newPage, pages } as unknown as BrowserContext
  const write = vi.fn().mockResolvedValue(undefined)
  const client = new QuestClient(
    context,
    { write } as unknown as StructuredLogger,
    'synthetic-run',
    'account-2'
  )
  return {
    client,
    context,
    page,
    existing,
    unrelated,
    candidate,
    anchor,
    click,
    links,
    newPage,
    write
  }
}

describe('quest page activation and cleanup', () => {
  it('clicks exactly one verified anchor on its detail page and protects unrelated tabs', async () => {
    const f = fixture()
    const guard = vi.fn()
    await f.client.activate(childOffer(), quest, new AbortController().signal, guard)
    expect(f.page.goto).toHaveBeenCalledTimes(1)
    expect(f.page.goto.mock.calls[0]?.[0]).toBe('https://rewards.bing.com/earn/quest/' + parentId)
    expect(f.click).toHaveBeenCalledTimes(1)
    expect(guard).toHaveBeenCalledTimes(1)
    expect(guard.mock.invocationCallOrder[0]).toBeLessThan(f.click.mock.invocationCallOrder[0] ?? 0)
    expect(f.page.close).toHaveBeenCalled()
    expect(f.existing.close).not.toHaveBeenCalled()
    expect(f.unrelated.close).not.toHaveBeenCalled()
    expect(f.page.listenerCount('popup')).toBe(0)
  })

  it.each(['success', 'click-error', 'visit-error'] as const)(
    'cleans popup descendants after %s',
    async (mode) => {
      const f = fixture()
      const popup = ownedPage()
      const descendant = ownedPage()
      f.click.mockImplementation(() => {
        f.page.emit('popup', popup)
        popup.emit('popup', descendant)
        return mode === 'click-error'
          ? Promise.reject(new Error('synthetic click error'))
          : Promise.resolve()
      })
      if (mode === 'visit-error')
        f.page.waitForTimeout.mockRejectedValue(new Error('synthetic visit error'))
      const result = f.client.activate(childOffer(), quest, new AbortController().signal)
      if (mode === 'success') await result
      else await expect(result).rejects.toMatchObject({ errorCode: 'offer-activation-failed' })
      for (const page of [f.page, popup, descendant]) {
        expect(page.close).toHaveBeenCalled()
        expect(page.listenerCount('popup')).toBe(0)
      }
      expect(f.unrelated.close).not.toHaveBeenCalled()
      expect(f.click).toHaveBeenCalledTimes(1)
    }
  )

  it('supports same-page destination navigation without reopening the dashboard page', async () => {
    const f = fixture()
    f.click.mockImplementation(() => f.page.goto(destination))
    await f.client.activate(childOffer(), quest, new AbortController().signal)
    expect(f.click).toHaveBeenCalledTimes(1)
    expect(f.page.goto).toHaveBeenCalledTimes(2)
    expect(f.page.close).toHaveBeenCalled()
    expect(f.existing.close).not.toHaveBeenCalled()
  })

  it.each([
    { isLocked: true },
    { isCompleted: true },
    { edgeAction: 'install-app' },
    { href: 'https://www.bing.com/search?q=other+task' }
  ])('rechecks official task metadata before activation (%j)', async (changed) => {
    const f = fixture()
    f.page.content
      .mockResolvedValueOnce(questHtml())
      .mockResolvedValue(questHtml([linkProps(changed)]))
    await expect(
      f.client.activate(childOffer(), quest, new AbortController().signal)
    ).rejects.toMatchObject({ errorCode: 'offer-not-found-before-activation' })
    expect(f.click).not.toHaveBeenCalled()
    expect(f.page.close).toHaveBeenCalled()
  })

  it('rechecks the visible lock state immediately before clicking', async () => {
    const f = fixture()
    f.page.evaluate
      .mockResolvedValueOnce(questObservation().rows)
      .mockResolvedValue([{ title: quest.title, state: 'locked', actionCount: 1 }])
    await expect(
      f.client.activate(childOffer(), quest, new AbortController().signal)
    ).rejects.toMatchObject({ errorCode: 'offer-not-found-before-activation' })
    expect(f.click).not.toHaveBeenCalled()
  })

  it.each([
    'duplicate-anchor',
    'different-title',
    'changed-target',
    'disabled-anchor',
    'duplicate-row'
  ] as const)('rejects ambiguous or changed DOM identity (%s)', async (mode) => {
    const f = fixture()
    if (mode === 'duplicate-anchor')
      f.links.evaluateAll.mockResolvedValue([f.candidate, f.candidate])
    if (mode === 'different-title')
      f.links.evaluateAll.mockResolvedValue([{ ...f.candidate, rowTitle: 'Other' }])
    if (mode === 'changed-target')
      f.anchor.evaluate.mockResolvedValue({
        ...f.candidate,
        href: 'https://www.bing.com/search?q=other'
      })
    if (mode === 'disabled-anchor')
      f.anchor.evaluate.mockResolvedValue({ ...f.candidate, disabled: true })
    if (mode === 'duplicate-row')
      f.page.evaluate.mockResolvedValue([...questObservation().rows, ...questObservation().rows])
    await expect(
      f.client.activate(childOffer(), quest, new AbortController().signal)
    ).rejects.toMatchObject({ errorCode: 'offer-not-found-before-activation' })
    expect(f.click).not.toHaveBeenCalled()
  })

  it('does not navigate or click after an already cancelled signal', async () => {
    const f = fixture()
    const controller = new AbortController()
    controller.abort(new Error('synthetic cancelled'))
    await expect(f.client.activate(childOffer(), quest, controller.signal)).rejects.toThrow(
      'synthetic cancelled'
    )
    expect(f.newPage).not.toHaveBeenCalled()
    expect(f.click).not.toHaveBeenCalled()
  })

  it('closes a page created after initialization cancellation without continuing', async () => {
    const f = fixture()
    let resolvePage: (page: unknown) => void = () => undefined
    f.newPage.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePage = resolve
        })
    )
    const controller = new AbortController()
    const pending = f.client.activate(childOffer(), quest, controller.signal)
    const rejection = expect(pending).rejects.toThrow('synthetic cancelled')
    controller.abort(new Error('synthetic cancelled'))
    await rejection
    resolvePage(f.page)
    await Promise.resolve()
    await Promise.resolve()
    expect(f.page.close).toHaveBeenCalled()
    expect(f.page.goto).not.toHaveBeenCalled()
    expect(f.click).not.toHaveBeenCalled()
  })

  it('bounds page initialization by the shared read deadline', async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.newPage.mockImplementation(() => new Promise(() => undefined))
    const rejection = expect(
      f.client.read(parentId, undefined, Date.now() + 2_000)
    ).rejects.toThrow('deadline')
    await vi.advanceTimersByTimeAsync(2_000)
    await rejection
    expect(f.click).not.toHaveBeenCalled()
  })

  it('cancels delayed navigation and cannot click after it resolves', async () => {
    const f = fixture()
    let resolveGoto: (value: null) => void = () => undefined
    f.page.goto.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveGoto = resolve
        })
    )
    const controller = new AbortController()
    const pending = f.client.activate(childOffer(), quest, controller.signal)
    const rejection = expect(pending).rejects.toThrow('synthetic cancelled')
    await Promise.resolve()
    await Promise.resolve()
    controller.abort(new Error('synthetic cancelled'))
    await rejection
    resolveGoto(null)
    await Promise.resolve()
    await Promise.resolve()
    expect(f.click).not.toHaveBeenCalled()
    expect(f.page.close).toHaveBeenCalled()
    expect(f.page.listenerCount('popup')).toBe(0)
  })

  it('cleans owned popups when cancelled after a single click', async () => {
    const f = fixture()
    const popup = ownedPage()
    const controller = new AbortController()
    f.click.mockImplementation(() => {
      f.page.emit('popup', popup)
      controller.abort(new Error('synthetic cancelled'))
      return Promise.resolve()
    })
    await expect(f.client.activate(childOffer(), quest, controller.signal)).rejects.toMatchObject({
      errorCode: 'offer-activation-failed'
    })
    expect(f.click).toHaveBeenCalledTimes(1)
    expect(popup.close).toHaveBeenCalled()
  })

  it('cannot submit when the business date changes at the activation guard', async () => {
    const f = fixture()
    const changed = new BusinessDateChanged()
    await expect(
      f.client.activate(childOffer(), quest, new AbortController().signal, () => {
        throw changed
      })
    ).rejects.toBe(changed)
    expect(f.click).not.toHaveBeenCalled()
    expect(f.page.close).toHaveBeenCalled()
  })

  it('rejects authentication redirects and non-success detail pages without clicking', async () => {
    for (const redirect of [true, false]) {
      const f = fixture()
      if (redirect) f.page.url.mockReturnValue('https://login.live.com/synthetic')
      else
        f.page.goto.mockImplementation((url: string) => {
          f.page.url.mockReturnValue(url)
          return Promise.resolve({ status: () => 503 })
        })
      await expect(
        f.client.activate(childOffer(), quest, new AbortController().signal)
      ).rejects.toMatchObject({
        errorCode: redirect ? 'offer-authentication-failed' : 'offer-network-failed'
      })
      expect(f.click).not.toHaveBeenCalled()
    }
  })

  it('bounds cleanup even when closing a timed-out page never resolves', async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.page.goto.mockImplementation(() => new Promise(() => undefined))
    f.page.close.mockImplementation(() => new Promise(() => undefined))
    let settled = false
    void f.client.read(parentId, undefined, Date.now() + 2_000).catch(() => {
      settled = true
    })
    await vi.advanceTimersByTimeAsync(7_001)
    expect(settled).toBe(true)
    expect(f.page.close).toHaveBeenCalled()
    expect(f.click).not.toHaveBeenCalled()
    expect(f.page.listenerCount('popup')).toBe(0)
  })
})
