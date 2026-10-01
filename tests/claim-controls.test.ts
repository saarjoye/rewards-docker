import type { BrowserContext, Locator, Page } from 'patchright'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  claimablePointsFromControls,
  claimControlPoints,
  selectClaimAction,
  type ClaimControlSnapshot
} from '../src/browser/ClaimControls.js'
import { DashboardClient } from '../src/browser/DashboardClient.js'
import type { StructuredLogger } from '../src/infra/StructuredLogger.js'

interface ControlFixture {
  texts: string[]
  contextTexts?: string[]
  expanded?: string | null
  controls?: string | null
  disabled?: boolean
  visible?: boolean
}

function fixture(initial: ControlFixture[], expanded = initial) {
  const clicks = initial.map(() => vi.fn().mockResolvedValue(undefined))
  const actionClicks =
    expanded === initial ? clicks : expanded.map(() => vi.fn().mockResolvedValue(undefined))
  const collection = (controls: ControlFixture[], handlers: typeof clicks) => ({
    count: vi.fn().mockResolvedValue(controls.length),
    nth: vi.fn((index: number) => ({
      getAttribute: vi.fn((name: string) =>
        Promise.resolve(
          name === 'aria-label'
            ? controls[index]?.texts[0] || null
            : name === 'aria-expanded'
              ? (controls[index]?.expanded ?? null)
              : null
        )
      ),
      textContent: vi.fn().mockResolvedValue(controls[index]?.texts[1] ?? ''),
      click: handlers[index]
    })),
    evaluateAll: vi.fn<() => Promise<ClaimControlSnapshot[]>>().mockResolvedValue(
      controls.map((control, index) => ({
        index,
        texts: control.texts,
        contextTexts: control.contextTexts ?? [],
        expanded: control.expanded ?? null,
        controls: control.controls ?? null,
        disabled: control.disabled ?? false,
        visible: control.visible ?? true
      }))
    )
  })
  const initialButtons = collection(initial, clicks)
  const expandedButtons = collection(expanded, actionClicks)
  const panelLocator = { locator: vi.fn().mockReturnValue(expandedButtons) }
  const response = {
    status: () => 200,
    ok: () => true,
    text: vi.fn().mockResolvedValue('1:true\n'),
    url: () => 'https://rewards.bing.com/dashboard',
    headers: () => ({ 'content-type': 'text/x-component' }),
    request: () => ({ method: () => 'POST' })
  }
  const page = {
    url: vi.fn().mockReturnValue('https://rewards.bing.com/dashboard'),
    goto: vi.fn().mockRejectedValue(new Error('synthetic navigation failure')),
    locator: vi.fn(
      (selector: string): Locator =>
        (selector.startsWith('[id=')
          ? panelLocator
          : selector.includes(':not([aria-expanded])')
            ? expandedButtons
            : initialButtons) as unknown as Locator
    ),
    evaluate: vi.fn((callback: () => unknown) => {
      vi.stubGlobal('document', {
        querySelectorAll: () =>
          initial.map((control) => ({
            getAttribute: (name: string) =>
              name === 'aria-label' ? control.texts[0] || null : null,
            textContent: control.texts[1] ?? ''
          }))
      })
      try {
        return Promise.resolve(callback())
      } finally {
        vi.unstubAllGlobals()
      }
    }),
    waitForResponse: vi.fn().mockResolvedValue(response),
    waitForTimeout: vi.fn().mockResolvedValue(undefined)
  }
  const client = new DashboardClient(
    {} as BrowserContext,
    page as unknown as Page,
    { write: vi.fn().mockResolvedValue(undefined) } as unknown as StructuredLogger,
    'synthetic-run',
    'synthetic-account'
  )
  return {
    client,
    page,
    clicks,
    actionClicks,
    panelLocator,
    response,
    initialButtons,
    expandedButtons
  }
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('claim controls with separated amount and action labels', () => {
  it('combines a generic aria label with numeric visible button text', async () => {
    const f = fixture([{ texts: ['领取积分', '30 积分'] }])
    await expect(f.client.claimBonusByUiWithResult()).resolves.toMatchObject({
      clicked: true,
      acknowledged: true
    })
    expect(f.clicks[0]).toHaveBeenCalledTimes(1)
  })

  it('reads a scoped claimable amount next to a numberless claim button', async () => {
    const f = fixture([{ texts: ['', '领取积分'], contextTexts: ['可领取积分：30 领取积分'] }])
    await expect(f.client.readClaimablePoints()).resolves.toBe(30)
    await expect(f.client.claimBonusByUiWithResult()).resolves.toMatchObject({
      clicked: true,
      acknowledged: true
    })
    expect(f.clicks[0]).toHaveBeenCalledTimes(1)
  })

  it('uses the unique claim-all action after disclosure even without a numeric label', async () => {
    const f = fixture(
      [{ texts: ['', '可领取 30 积分'], expanded: 'false' }],
      [
        { texts: ['', '领取 10 积分'] },
        { texts: ['', '领取 20 积分'] },
        { texts: ['', '领取全部积分'] }
      ]
    )
    await expect(f.client.claimBonusByUiWithResult()).resolves.toMatchObject({
      clicked: true,
      acknowledged: true
    })
    expect(f.clicks[0]).toHaveBeenCalledTimes(1)
    expect(f.actionClicks[0]).not.toHaveBeenCalled()
    expect(f.actionClicks[1]).not.toHaveBeenCalled()
    expect(f.actionClicks[2]).toHaveBeenCalledTimes(1)
  })

  it('does not collapse an already-expanded disclosure', async () => {
    const f = fixture(
      [{ texts: ['', '可领取 30 积分'], expanded: 'true' }],
      [{ texts: ['', 'Claim all points'] }]
    )
    await expect(f.client.claimBonusByUiWithResult()).resolves.toMatchObject({
      clicked: true,
      acknowledged: true
    })
    expect(f.clicks[0]).not.toHaveBeenCalled()
    expect(f.actionClicks[0]).toHaveBeenCalledTimes(1)
  })

  it('restricts the expanded action to the panel referenced by aria-controls', async () => {
    const f = fixture(
      [
        { texts: ['可领取30积分'], expanded: 'false', controls: 'claim-panel' },
        { texts: ['领取30积分'] }
      ],
      [{ texts: ['领取全部积分'] }]
    )
    await expect(f.client.claimBonusByUiWithResult()).resolves.toMatchObject({
      clicked: true,
      acknowledged: true
    })
    expect(f.page.locator).toHaveBeenCalledWith('[id="claim-panel"]')
    expect(f.panelLocator.locator).toHaveBeenCalledWith(
      'button:not([aria-expanded]), [role="button"]:not([aria-expanded])'
    )
    expect(f.clicks[1]).not.toHaveBeenCalled()
    expect(f.actionClicks[0]).toHaveBeenCalledTimes(1)
  })

  it('does not mark a missing mutation receipt as acknowledged or retry the click', async () => {
    const f = fixture([{ texts: ['领取30积分'] }])
    vi.mocked(f.page.waitForResponse).mockRejectedValue(new Error('synthetic missing receipt'))
    await expect(f.client.claimBonusByUiWithResult()).resolves.toEqual({
      clicked: true,
      acknowledged: false
    })
    expect(f.clicks[0]).toHaveBeenCalledTimes(1)
  })

  it('does not mark a rejected mutation receipt as acknowledged', async () => {
    const f = fixture([{ texts: ['领取30积分'] }])
    f.response.text.mockResolvedValue('1:false\n')
    await expect(f.client.claimBonusByUiWithResult()).resolves.toEqual({
      clicked: true,
      status: 200,
      acknowledged: false
    })
    expect(f.clicks[0]).toHaveBeenCalledTimes(1)
  })

  it.each(['https://untrusted.example/dashboard', 'https://login.live.com/'])(
    'rejects an unexpected final navigation destination %s',
    async (destination) => {
      const f = fixture([{ texts: ['领取30积分'] }])
      vi.mocked(f.page.url).mockReturnValue('about:blank')
      vi.mocked(f.page.goto).mockImplementation(() => {
        vi.mocked(f.page.url).mockReturnValue(destination)
        return Promise.resolve(null)
      })
      await expect(f.client.readClaimablePoints()).resolves.toBeUndefined()
      await expect(f.client.claimBonusByUiWithResult()).rejects.toThrow(
        'Dashboard page unavailable'
      )
      expect(f.page.locator).not.toHaveBeenCalled()
      expect(f.clicks[0]).not.toHaveBeenCalled()
    }
  )

  it('does not guess an action when multiple individual claim controls are present', async () => {
    const f = fixture([{ texts: ['', '领取 10 积分'] }, { texts: ['', '领取 20 积分'] }])
    await expect(f.client.claimBonusByUiWithResult()).resolves.toEqual({
      clicked: false,
      acknowledged: false
    })
    expect(f.clicks.every((click) => click.mock.calls.length === 0)).toBe(true)
  })

  it('does not treat the account balance as a claimable amount', async () => {
    const f = fixture([{ texts: ['', '领取积分'], contextTexts: ['可用积分 1,000 领取积分'] }])
    await expect(f.client.readClaimablePoints()).resolves.toBeUndefined()
    await expect(f.client.claimBonusByUiWithResult()).resolves.toEqual({
      clicked: false,
      acknowledged: false
    })
    expect(f.clicks[0]).not.toHaveBeenCalled()
  })

  it('ignores hidden and disabled claim actions', async () => {
    const f = fixture([
      { texts: ['', '领取 30 积分'], visible: false },
      { texts: ['', '领取 30 积分'], disabled: true }
    ])
    await expect(f.client.claimBonusByUiWithResult()).resolves.toEqual({
      clicked: false,
      acknowledged: false
    })
    expect(f.clicks.every((click) => click.mock.calls.length === 0)).toBe(true)
  })

  it('preserves explicit zero while missing claim evidence stays unknown', async () => {
    const zero = fixture([{ texts: ['', '可领取 0 积分'], disabled: true }])
    await expect(zero.client.readClaimablePoints()).resolves.toBe(0)
    await expect(fixture([]).client.readClaimablePoints()).resolves.toBeUndefined()
  })

  it('never clicks controls on an unrelated origin with a dashboard path', async () => {
    const f = fixture([{ texts: ['', '领取 30 积分'] }])
    vi.mocked(f.page.url).mockReturnValue('https://untrusted.example/dashboard')
    await expect(f.client.claimBonusByUiWithResult()).rejects.toThrow('Dashboard page unavailable')
    expect(f.clicks[0]).not.toHaveBeenCalled()
  })
})

function control(text: string, patch: Partial<ClaimControlSnapshot> = {}): ClaimControlSnapshot {
  return {
    index: 0,
    texts: [text],
    contextTexts: [],
    expanded: null,
    controls: null,
    disabled: false,
    visible: true,
    ...patch
  }
}

describe('claim amount evidence and conservative action selection', () => {
  it.each([
    ['Claim 1,234 points', 1234],
    ['可领取1，234积分', 1234],
    ['待領取 30 點數', 30],
    ['Claim 0 points', 0],
    ['Claim 1,23 points', undefined],
    ['Claim -30 points', undefined],
    ['Claim 1.5 points', undefined],
    ['Claim 10 or 20 points', undefined],
    ['Redeem 30 points', undefined],
    ['Available points 100', undefined],
    ['Claim 9007199254740992 points', undefined]
  ])('reads %s without guessing missing or malformed amounts', (text, expected) => {
    expect(claimControlPoints(control(text))).toBe(expected)
  })

  it.each([
    ['可领取积分1.5', undefined],
    ['1.5 points to claim', undefined],
    ['可领取积分-30', undefined],
    ['- 30 points to claim', undefined],
    ['可领取积分1,23', undefined],
    ['1,23 points to claim', undefined],
    ['可领取积分1, 23', undefined],
    ['1, 23 points to claim', undefined],
    ['Available to claim: 1,234 points', 1234],
    ['1\u202f234 points to claim', 1234],
    ['可领取积分1\u00a0234', 1234],
    ['可领取积分1，234', 1234],
    ['可领取积分9007199254740992', undefined]
  ])('reads the complete nearby amount in %s or leaves it unknown', (context, expected) => {
    expect(claimControlPoints(control('Claim points', { contextTexts: [context] }))).toBe(expected)
  })

  it('preserves nonbreaking thousands separators in the control label', () => {
    expect(claimControlPoints(control('Claim 1\u00a0234 points'))).toBe(1234)
    expect(claimControlPoints(control('Claim 1\u202f234 points'))).toBe(1234)
  })

  it('does not let unrelated all-offers or disclosure controls mask a claim amount', () => {
    expect(
      claimablePointsFromControls([control('View all offers'), control('领取30积分', { index: 1 })])
    ).toBe(30)
    expect(
      claimablePointsFromControls([
        control('Show balance 1000', { expanded: 'false' }),
        control('领取30积分', { index: 1 })
      ])
    ).toBe(30)
  })

  it('rejects an invalid nearby amount even when the control label contains a valid number', () => {
    expect(
      claimControlPoints(control('领取30积分', { contextTexts: ['可领取积分1.5'] }))
    ).toBeUndefined()
  })

  it('rejects conflicting accessible labels even if surrounding text has a valid amount', () => {
    expect(
      claimControlPoints(
        control('领取30积分', {
          texts: ['领取30积分', '领取20积分'],
          contextTexts: ['可领取积分30']
        })
      )
    ).toBeUndefined()
  })

  it('prefers a consistent summary over individual claim amounts', () => {
    expect(
      claimablePointsFromControls([
        control('可领取30积分', { expanded: 'true' }),
        control('领取全部30积分', { index: 1 }),
        control('领取10积分', { index: 2 }),
        control('领取20积分', { index: 3 })
      ])
    ).toBe(30)
  })

  it('does not invent a total by summing multiple claim buttons', () => {
    expect(
      claimablePointsFromControls([control('领取10积分'), control('领取20积分', { index: 1 })])
    ).toBeUndefined()
    expect(
      claimablePointsFromControls([control('领取10积分'), control('领取10积分', { index: 1 })])
    ).toBeUndefined()
  })

  it('does not choose between multiple claim-all actions or contradict explicit amounts', () => {
    expect(
      selectClaimAction([control('领取全部积分'), control('领取全部积分', { index: 1 })], 30)
    ).toBeUndefined()
    expect(selectClaimAction([control('领取全部20积分')], 30)).toBeUndefined()
    expect(
      selectClaimAction(
        [control('领取全部积分', { contextTexts: ['可领取积分20', '可领取积分30'] })],
        30
      )
    ).toBeUndefined()
  })

  it('reads scoped pending points without using unrelated balance numbers', () => {
    expect(
      claimControlPoints(
        control('Claim points', {
          contextTexts: ['Balance 1000. Available to claim: 30 points. Claim points']
        })
      )
    ).toBe(30)
    expect(
      claimControlPoints(
        control('Claim points', { contextTexts: ['Available points: 1000. Claim points'] })
      )
    ).toBeUndefined()
  })
})

/** Minimal synthetic DOM tree: evaluateAll runs the production callback, not a prebuilt snapshot. */
class SyntheticElement {
  parentElement: SyntheticElement | null = null
  children: SyntheticElement[] = []
  style = { display: 'block', visibility: 'visible' }
  rects: object[] = [{ width: 100, height: 20 }]

  constructor(
    readonly tagName: string,
    private readonly text = '',
    private readonly attributes: Record<string, string> = {}
  ) {}

  append(...children: SyntheticElement[]): this {
    for (const child of children) {
      child.parentElement = this
      this.children.push(child)
    }
    return this
  }

  get textContent(): string {
    return this.text + this.children.map((child) => child.textContent).join(' ')
  }

  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null
  }

  getClientRects(): object[] {
    return this.rects
  }

  matches(selector: string): boolean {
    return selector.split(',').some((part) => {
      const value = part.trim()
      if (value === ':disabled')
        return this.tagName === 'button' && this.getAttribute('disabled') !== null
      const attribute = value.match(/^\[([a-z-]+)(?:="([^"]+)")?\]$/)
      if (attribute) {
        const actual = this.getAttribute(attribute[1] ?? '')
        return attribute[2] === undefined ? actual !== null : actual === attribute[2]
      }
      return this.tagName === value
    })
  }

  closest(selector: string): SyntheticElement | null {
    return this.matches(selector) ? this : (this.parentElement?.closest(selector) ?? null)
  }

  querySelectorAll(selector: string): SyntheticElement[] {
    return this.children.flatMap((child) => [
      ...(child.matches(selector) ? [child] : []),
      ...child.querySelectorAll(selector)
    ])
  }
}

function domFixture(root: SyntheticElement) {
  const elements = root.querySelectorAll('button, [role="button"]')
  const clicks = elements.map(() => vi.fn().mockResolvedValue(undefined))
  const f = fixture([])
  const buttons = {
    evaluateAll: vi.fn((callback: (nodes: HTMLElement[]) => unknown) =>
      Promise.resolve(callback(elements as unknown as HTMLElement[]))
    ),
    nth: vi.fn((index: number) => ({ click: clicks[index] }))
  } as unknown as Locator
  vi.mocked(f.page.locator).mockReturnValue(buttons)
  vi.stubGlobal('window', { getComputedStyle: (element: SyntheticElement) => element.style })
  return { ...f, clicks }
}

function element(
  tagName: string,
  text = '',
  attributes: Record<string, string> = {}
): SyntheticElement {
  return new SyntheticElement(tagName, text, attributes)
}

// These are deterministic DOM-like fixtures, not a live browser or an authenticated page.
describe('claim snapshot extraction from synthetic DOM trees', () => {
  it('extracts a neighboring labeled amount for a role-button without normalizing its separator away', async () => {
    const root = element('main').append(
      element('section').append(
        element('span', '可领取积分：1\u202f234'),
        element('div', '领取积分', { role: 'button', 'aria-label': 'Claim points' })
      )
    )
    const f = domFixture(root)
    await expect(f.client.readClaimablePoints()).resolves.toBe(1234)
    await expect(f.client.claimBonusByUiWithResult()).resolves.toMatchObject({
      clicked: true,
      acknowledged: true
    })
    expect(f.clicks[0]).toHaveBeenCalledTimes(1)
  })

  it('does not read a shared parent amount when that parent contains several controls', async () => {
    const root = element('section', '可领取积分：30').append(
      element('button', '领取积分'),
      element('div', '查看全部', { role: 'button' })
    )
    const f = domFixture(root)
    await expect(f.client.readClaimablePoints()).resolves.toBeUndefined()
    await expect(f.client.claimBonusByUiWithResult()).resolves.toEqual({
      clicked: false,
      acknowledged: false
    })
    expect(f.clicks.every((click) => click.mock.calls.length === 0)).toBe(true)
  })

  it('stops before page-level text even if only one control exists', async () => {
    const root = element('main', '可领取积分：1000').append(
      element('section').append(element('button', '领取积分'))
    )
    const f = domFixture(root)
    await expect(f.client.readClaimablePoints()).resolves.toBeUndefined()
    expect(f.clicks[0]).not.toHaveBeenCalled()
  })

  it('checks hidden and aria-disabled ancestors instead of trusting button labels', async () => {
    const root = element('main').append(
      element('section', '', { hidden: '' }).append(element('button', '领取30积分')),
      element('section', '', { 'aria-disabled': 'true' }).append(
        element('div', '领取30积分', { role: 'button' })
      ),
      element('button', '领取30积分', { disabled: '' })
    )
    const f = domFixture(root)
    await expect(f.client.claimBonusByUiWithResult()).resolves.toEqual({
      clicked: false,
      acknowledged: false
    })
    expect(f.clicks.every((click) => click.mock.calls.length === 0)).toBe(true)
  })

  it.each(['display-none', 'visibility-hidden', 'no-rects'])(
    'ignores a nonvisible control: %s',
    async (kind) => {
      const button = element('button', '领取30积分')
      if (kind === 'display-none') button.style.display = 'none'
      if (kind === 'visibility-hidden') button.style.visibility = 'hidden'
      if (kind === 'no-rects') button.rects = []
      const f = domFixture(element('section').append(button))
      await expect(f.client.readClaimablePoints()).resolves.toBeUndefined()
      await expect(f.client.claimBonusByUiWithResult()).resolves.toEqual({
        clicked: false,
        acknowledged: false
      })
      expect(f.clicks[0]).not.toHaveBeenCalled()
    }
  )
})

describe('claim controls readiness on slow pages', () => {
  it('waits for the claim amount to hydrate before reporting it unavailable', async () => {
    const f = fixture([{ texts: ['领取积分', '30 积分'] }])
    const read = vi.mocked(f.initialButtons.evaluateAll)
    read
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValue([control('领取 30 积分')])
    await expect(f.client.readClaimablePoints()).resolves.toBe(30)
    expect(read).toHaveBeenCalledTimes(3)
    expect(f.page.waitForTimeout).toHaveBeenCalledTimes(2)
    expect(f.clicks[0]).not.toHaveBeenCalled()
  })

  it('waits for delayed claim controls and submits the reward only once', async () => {
    const f = fixture([{ texts: ['领取积分', '30 积分'] }])
    const read = vi.mocked(f.initialButtons.evaluateAll)
    read.mockResolvedValueOnce([]).mockResolvedValue([control('领取 30 积分')])
    await expect(f.client.claimBonusByUiWithResult()).resolves.toMatchObject({
      clicked: true,
      acknowledged: true
    })
    expect(f.clicks[0]).toHaveBeenCalledTimes(1)
  })

  it('waits for an expanded action instead of treating a slow panel as empty', async () => {
    const f = fixture([{ texts: ['领取 30 积分'], expanded: 'false' }], [{ texts: ['领取全部'] }])
    const read = vi.mocked(f.expandedButtons.evaluateAll)
    read.mockResolvedValueOnce([]).mockResolvedValue([control('领取全部')])
    await expect(f.client.claimBonusByUiWithResult()).resolves.toMatchObject({
      clicked: true,
      acknowledged: true
    })
    expect(f.clicks[0]).toHaveBeenCalledTimes(1)
    expect(f.actionClicks[0]).toHaveBeenCalledTimes(1)
  })

  it('uses commit navigation then waits for controls when dashboard DOMContentLoaded is delayed', async () => {
    const f = fixture([{ texts: ['领取 30 积分'] }])
    let current = 'https://www.bing.com/search'
    f.page.url.mockImplementation(() => current)
    f.page.goto.mockImplementation((_target: string, options: { waitUntil: string }) => {
      if (options.waitUntil === 'domcontentloaded')
        return Promise.reject(new Error('synthetic navigation timeout'))
      current = 'https://rewards.bing.com/dashboard'
      return Promise.resolve(null)
    })
    await expect(f.client.readClaimablePoints()).resolves.toBe(30)
    expect(f.page.goto).toHaveBeenCalledWith(
      'https://rewards.bing.com/dashboard',
      expect.objectContaining({ waitUntil: 'commit' })
    )
    expect(f.clicks[0]).not.toHaveBeenCalled()
  })
})

describe('claim readiness safety boundaries', () => {
  it('bounds empty snapshots and does not turn missing evidence into zero', async () => {
    const f = fixture([])
    await expect(f.client.readClaimablePoints()).resolves.toBeUndefined()
    expect(f.initialButtons.evaluateAll).toHaveBeenCalledTimes(11)
    expect(f.page.waitForTimeout).toHaveBeenCalledTimes(10)
    expect(f.page.waitForResponse).not.toHaveBeenCalled()
  })

  it('does not wait for or submit an explicitly zero claim', async () => {
    const f = fixture([{ texts: ['可领取 0 积分'], disabled: true }])
    await expect(f.client.readClaimablePoints()).resolves.toBe(0)
    await expect(f.client.claimBonusByUiWithResult()).resolves.toEqual({
      clicked: false,
      acknowledged: false
    })
    expect(f.page.waitForTimeout).not.toHaveBeenCalled()
    expect(f.clicks[0]).not.toHaveBeenCalled()
  })

  it('retries a read-only snapshot after an execution context transition', async () => {
    const f = fixture([{ texts: ['领取 30 积分'] }])
    vi.mocked(f.initialButtons.evaluateAll).mockRejectedValueOnce(
      new Error('Execution context was destroyed, most likely because of a navigation')
    )
    await expect(f.client.readClaimablePoints()).resolves.toBe(30)
    expect(f.initialButtons.evaluateAll).toHaveBeenCalledTimes(2)
    expect(f.clicks[0]).not.toHaveBeenCalled()
  })

  it('does not hide a non-transient snapshot error', async () => {
    const f = fixture([{ texts: ['领取 30 积分'] }])
    const reason = new Error('synthetic snapshot programming error')
    vi.mocked(f.initialButtons.evaluateAll).mockRejectedValue(reason)
    await expect(f.client.readClaimablePoints()).rejects.toBe(reason)
    expect(f.initialButtons.evaluateAll).toHaveBeenCalledTimes(1)
    expect(f.clicks[0]).not.toHaveBeenCalled()
  })

  it('stops waiting when the page leaves the official Rewards origin', async () => {
    const f = fixture([{ texts: ['领取 30 积分'] }])
    vi.mocked(f.initialButtons.evaluateAll).mockResolvedValueOnce([])
    f.page.waitForTimeout.mockImplementation(() => {
      f.page.url.mockReturnValue('https://untrusted.example/dashboard')
      return Promise.resolve()
    })
    await expect(f.client.claimBonusByUiWithResult()).resolves.toEqual({
      clicked: false,
      acknowledged: false
    })
    expect(f.clicks[0]).not.toHaveBeenCalled()
    expect(f.page.waitForResponse).not.toHaveBeenCalled()
  })

  it('rejects an origin change that occurs while reading a usable snapshot', async () => {
    const f = fixture([{ texts: ['领取 30 积分'] }])
    vi.mocked(f.initialButtons.evaluateAll).mockImplementation(() => {
      f.page.url.mockReturnValue('https://untrusted.example/dashboard')
      return Promise.resolve([control('领取 30 积分')])
    })
    await expect(f.client.claimBonusByUiWithResult()).resolves.toEqual({
      clicked: false,
      acknowledged: false
    })
    expect(f.clicks[0]).not.toHaveBeenCalled()
  })

  it('cancels a pending readiness wait without sending a claim', async () => {
    vi.useFakeTimers()
    const f = fixture([{ texts: ['领取 30 积分'] }])
    vi.mocked(f.initialButtons.evaluateAll).mockResolvedValue([])
    const abort = new AbortController()
    const reason = new Error('synthetic claim cancelled')
    const running = f.client.claimBonusByUiWithResult(abort.signal)
    const rejected = expect(running).rejects.toBe(reason)
    await vi.advanceTimersByTimeAsync(0)
    abort.abort(reason)
    await rejected
    expect(f.initialButtons.evaluateAll).toHaveBeenCalledTimes(1)
    expect(f.clicks[0]).not.toHaveBeenCalled()
    expect(f.page.waitForResponse).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not navigate or inspect an already cancelled claim', async () => {
    const f = fixture([{ texts: ['领取 30 积分'] }])
    const abort = new AbortController()
    const reason = new Error('synthetic claim pre-cancelled')
    abort.abort(reason)
    await expect(f.client.claimBonusByUiWithResult(abort.signal)).rejects.toBe(reason)
    expect(f.page.goto).not.toHaveBeenCalled()
    expect(f.page.locator).not.toHaveBeenCalled()
    expect(f.clicks[0]).not.toHaveBeenCalled()
  })
})

describe('claim action hydration', () => {
  it('waits for a temporarily disabled action to become usable before submitting once', async () => {
    const f = fixture([{ texts: ['领取 30 积分'], disabled: true }])
    f.initialButtons.evaluateAll
      .mockResolvedValueOnce([control('领取 30 积分', { disabled: true })])
      .mockResolvedValueOnce([control('领取 30 积分', { disabled: true })])
      .mockResolvedValue([control('领取 30 积分')])
    await expect(f.client.claimBonusByUiWithResult()).resolves.toMatchObject({
      clicked: true,
      acknowledged: true
    })
    expect(f.initialButtons.evaluateAll).toHaveBeenCalledTimes(3)
    expect(f.clicks[0]).toHaveBeenCalledTimes(1)
  })
})
