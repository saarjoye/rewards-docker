import { afterEach, describe, expect, it, vi } from 'vitest'
import type { APIResponse, BrowserContext, Page } from 'patchright'

import { DashboardClient, DashboardFetchError } from '../src/browser/DashboardClient.js'
import type { StructuredLogger } from '../src/infra/StructuredLogger.js'

function response(status: number, payload: unknown, contentType = 'application/json'): APIResponse {
  return {
    status: () => status,
    ok: () => status >= 200 && status < 300,
    headers: () => ({ 'content-type': contentType }),
    url: () => 'https://rewards.bing.com/api/getuserinfo?type=1',
    text: () => Promise.resolve(JSON.stringify(payload)),
    dispose: () => Promise.resolve()
  } as unknown as APIResponse
}

function textResponse(status: number, text: string, contentType = 'text/plain'): APIResponse {
  return {
    status: () => status,
    ok: () => status >= 200 && status < 300,
    headers: () => ({ 'content-type': contentType }),
    url: () => 'https://rewards.bing.com/api/getuserinfo?type=1',
    text: () => Promise.resolve(text),
    dispose: () => Promise.resolve()
  } as unknown as APIResponse
}

function fixture(responses: APIResponse[]) {
  const get = vi
    .fn()
    .mockImplementation(() => Promise.resolve(responses.shift() ?? response(401, {})))
  const listeners = new Map<string, (...args: never[]) => void>()
  const on = vi.fn((name: string, callback: (...args: never[]) => void) =>
    listeners.set(name, callback)
  )
  const goto = vi.fn().mockResolvedValue(null)
  const page = {
    on,
    off: vi.fn((name: string) => listeners.delete(name)),
    content: vi.fn().mockResolvedValue('<html></html>'),
    goto,
    url: vi.fn().mockReturnValue('https://rewards.bing.com/dashboard')
  } as unknown as Page
  const logger = { write: vi.fn().mockResolvedValue(undefined) } as unknown as StructuredLogger
  const client = new DashboardClient(
    { request: { get } } as unknown as BrowserContext,
    page,
    logger,
    'run',
    'account-1'
  )
  return { client, get, page, on, goto }
}

const valid = {
  dashboard: {
    userStatus: {
      isRewardsUser: true,
      availablePoints: 42,
      counters: { pcSearch: [{ pointProgress: 0, pointProgressMax: 60 }] }
    }
  }
}

afterEach(() => vi.useRealTimers())

describe('dashboard acquisition', () => {
  it('does not treat HTTP 200 as evidence of a valid search counter', async () => {
    const { client } = fixture([
      response(200, { dashboard: { userStatus: { counters: {} } } }),
      response(200, {
        dashboard: {
          userStatus: { counters: { pcSearch: [{ pointProgress: null, pointProgressMax: 60 }] } }
        }
      }),
      response(200, valid)
    ])
    const missing = await client.fetchDashboard()
    expect(missing.pcSearch).toMatchObject({ availability: 'missing' })
    expect(missing.readMetadata).toMatchObject({
      usedFallback: false,
      attempts: 1
    })
    expect(Number.isSafeInteger(missing.readMetadata?.durationMs)).toBe(true)
    expect(missing.readMetadata?.durationMs).toBeGreaterThanOrEqual(0)
    expect((await client.fetchDashboard()).pcSearch).toMatchObject({ availability: 'invalid' })
    expect((await client.fetchDashboard()).pcSearch).toMatchObject({
      availability: 'valid',
      value: { completed: 0, total: 60 }
    })
  })
  it('retries 504 and 503 at most before accepting 200 text/plain JSON', async () => {
    vi.useFakeTimers()
    const { client, get } = fixture([
      response(504, {}),
      response(503, {}),
      response(200, valid, 'text/plain')
    ])
    const promise = client.fetchDashboard()
    await vi.runAllTimersAsync()
    await expect(promise).resolves.toMatchObject({ availablePoints: { value: 42 } })
    expect(get).toHaveBeenCalledTimes(3)
  })

  it('does not retry authentication failures or return a fake zero', async () => {
    const { client, get } = fixture([response(401, {})])
    await expect(client.fetchDashboard()).rejects.toBeInstanceOf(DashboardFetchError)
    const apiCalls = get.mock.calls.filter(([url]) => String(url).includes('/api/getuserinfo'))
    expect(apiCalls).toHaveLength(1)
    expect(client.latestObservation).toBeUndefined()
  })

  it('falls back to a valid flyout after one 200 non-JSON API response', async () => {
    const { client, get } = fixture([
      textResponse(200, '<html>transient gateway body</html>'),
      response(401, {}),
      response(200, valid)
    ])

    await expect(client.fetchDashboard()).resolves.toMatchObject({
      source: 'bing-flyout',
      readMetadata: { usedFallback: true },
      availablePoints: { availability: 'valid', value: 42 },
      pcSearch: { availability: 'valid', value: { completed: 0, total: 60, remaining: 60 } }
    })
    const apiCalls = get.mock.calls.filter(([url]) => String(url).includes('/api/getuserinfo'))
    expect(apiCalls).toHaveLength(1)
  })

  it('retries a transient 200 non-JSON body after this client already confirmed the account', async () => {
    vi.useFakeTimers()
    const { client, get } = fixture([
      response(200, valid),
      textResponse(200, '<html>transient gateway body</html>', 'text/html'),
      response(200, valid, 'text/plain')
    ])

    await expect(client.fetchDashboard()).resolves.toMatchObject({ availablePoints: { value: 42 } })
    const promise = client.fetchDashboard()
    await vi.runAllTimersAsync()
    await expect(promise).resolves.toMatchObject({ availablePoints: { value: 42 } })

    const apiCalls = get.mock.calls.filter(([url]) => String(url).includes('/api/getuserinfo'))
    expect(apiCalls).toHaveLength(3)
  })

  it('bounds repeated 200 non-JSON responses to three API attempts for a confirmed account', async () => {
    vi.useFakeTimers()
    const { client, get } = fixture([
      response(200, valid),
      textResponse(200, '<html>transient one</html>', 'text/html'),
      textResponse(200, '<html>transient two</html>', 'text/html'),
      textResponse(200, '<html>transient three</html>', 'text/html'),
      response(401, {}),
      response(401, {})
    ])

    await expect(client.fetchDashboard()).resolves.toMatchObject({ availablePoints: { value: 42 } })
    const promise = client.fetchDashboard()
    const assertion = expect(promise).rejects.toMatchObject({
      name: 'DashboardFetchError',
      status: 200,
      attempts: 3
    })
    await vi.runAllTimersAsync()
    await assertion

    const apiCalls = get.mock.calls.filter(([url]) => String(url).includes('/api/getuserinfo'))
    expect(apiCalls).toHaveLength(4)
  })

  it('stops after three transient failures and registers capture before fallback navigation', async () => {
    vi.useFakeTimers()
    const { client, get, on, goto } = fixture([
      response(504, {}),
      response(504, {}),
      response(504, {}),
      response(401, {}),
      response(401, {})
    ])
    const promise = client.fetchDashboard()
    const assertion = expect(promise).rejects.toMatchObject({
      name: 'DashboardFetchError',
      status: 504,
      attempts: 3
    })
    await vi.runAllTimersAsync()
    await assertion
    const apiCalls = get.mock.calls.filter(([url]) => String(url).includes('/api/getuserinfo'))
    expect(apiCalls).toHaveLength(3)
    expect(on).toHaveBeenCalledBefore(goto)
    expect(client.latestObservation).toBeUndefined()
  })
})

describe('server action transport', () => {
  it('uses same-origin page fetch with route context and no explicit credentials', async () => {
    const evaluate = vi.fn().mockResolvedValue({ status: 200, ok: true, text: '1:true\n' })
    let pageUrl = 'https://rewards.bing.com/earn'
    const goto = vi.fn().mockImplementation(() => {
      pageUrl = 'https://rewards.bing.com/dashboard'
      return Promise.resolve(null)
    })
    const page = {
      url: vi.fn(() => pageUrl),
      goto,
      evaluate
    } as unknown as Page
    const client = new DashboardClient(
      {} as BrowserContext,
      page,
      { write: vi.fn().mockResolvedValue(undefined) } as unknown as StructuredLogger,
      'run',
      'account-1'
    )

    await expect(
      client.reportServerAction({
        actionId: 'synthetic-action',
        body: ['synthetic-body'],
        url: 'https://rewards.bing.com/dashboard',
        referer: 'https://rewards.bing.com/dashboard',
        routerStateTree: 'synthetic-router-state',
        deploymentId: 'synthetic-deployment'
      })
    ).resolves.toMatchObject({ status: 200, acknowledged: true })

    expect(goto).toHaveBeenCalledWith('https://rewards.bing.com/dashboard', {
      waitUntil: 'domcontentloaded',
      timeout: 30_000
    })
    expect(evaluate).toHaveBeenCalledTimes(1)
    const request = evaluate.mock.calls[0]?.[1] as {
      requestUrl: string
      headers: Record<string, string>
      body: string
      timeoutMs: number
    }
    expect(request).toMatchObject({
      requestUrl: 'https://rewards.bing.com/dashboard',
      timeoutMs: 20_000,
      body: '["synthetic-body"]',
      headers: {
        'Next-Router-State-Tree': 'synthetic-router-state',
        'X-Deployment-Id': 'synthetic-deployment'
      }
    })
    expect(request.headers).not.toHaveProperty('Cookie')
    expect(request.headers).not.toHaveProperty('cookie')
    expect(request.headers).not.toHaveProperty('Authorization')
    expect(request.headers).not.toHaveProperty('Referer')
    expect(request.headers).not.toHaveProperty('Origin')
  })
})

describe('App activity transport', () => {
  it('uses the check-in-specific App identity only for type 103', async () => {
    const post = vi.fn().mockResolvedValue(response(200, { response: { balance: 100 } }))
    const client = new DashboardClient(
      { request: { post } } as unknown as BrowserContext,
      {} as Page,
      { write: vi.fn().mockResolvedValue(undefined) } as unknown as StructuredLogger,
      'run',
      'account-1'
    )

    await client.submitAppActivity('synthetic-token', {
      type: 103,
      amount: 1,
      country: 'CN'
    })
    await client.submitAppActivity('synthetic-token', {
      type: 101,
      amount: 1,
      country: 'CN'
    })

    const postCalls = post.mock.calls as unknown as Array<
      [string, { headers: Record<string, string> }]
    >
    const checkInHeaders = postCalls[0]?.[1].headers ?? {}
    const activityHeaders = postCalls[1]?.[1].headers ?? {}
    expect(checkInHeaders['User-Agent']).toContain('iPad')
    expect(checkInHeaders['User-Agent']).toContain('BingSapphire/33.4.440603001')
    expect(checkInHeaders['X-Rewards-Flights']).toBe('rwgobig')
    expect(activityHeaders['User-Agent']).toContain('Android')
    expect(activityHeaders).not.toHaveProperty('X-Rewards-Flights')
    expect(checkInHeaders).not.toHaveProperty('Cookie')
    expect(activityHeaders).not.toHaveProperty('Cookie')
  })
})

describe('offer link inspection', () => {
  it('reports only structural link metadata without destination details', async () => {
    const evaluate = vi.fn().mockResolvedValue({
      opensNewPage: true,
      sameOriginDestination: false,
      hasInlineClick: false,
      hasInteractiveAncestor: true,
      attributeNames: ['class', 'data-bi-id', 'target']
    })
    const page = {
      url: vi.fn().mockReturnValue('https://rewards.bing.com/earn'),
      goto: vi.fn().mockResolvedValue(null),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
      locator: vi.fn().mockReturnValue({
        nth: vi.fn().mockReturnValue({
          elementHandle: vi.fn().mockResolvedValue({
            evaluate: vi
              .fn()
              .mockResolvedValueOnce({
                href: 'https://destination.example.test/private?token=canary'
              })
              .mockImplementation(evaluate),
            dispose: vi.fn().mockResolvedValue(undefined)
          })
        }),
        evaluateAll: vi
          .fn()
          .mockResolvedValue([{ href: 'https://destination.example.test/private?token=canary' }])
      }),
      evaluate
    } as unknown as Page
    const client = new DashboardClient(
      {} as BrowserContext,
      page,
      { write: vi.fn().mockResolvedValue(undefined) } as unknown as StructuredLogger,
      'run',
      'account-1'
    )

    const result = await client.inspectOfferLink(
      'https://destination.example.test/private?token=canary'
    )

    expect(result).toEqual({
      found: true,
      surface: 'earn',
      opensNewPage: true,
      sameOriginDestination: false,
      hasInlineClick: false,
      hasInteractiveAncestor: true,
      attributeNames: ['class', 'data-bi-id', 'target']
    })
    expect(JSON.stringify(result)).not.toContain('destination.example.test')
    expect(JSON.stringify(result)).not.toContain('canary')
  })

  it('uses the official pressable link and closes its new page after activation', async () => {
    const click = vi.fn().mockResolvedValue(undefined)
    const opened = {
      waitForLoadState: vi.fn().mockResolvedValue(undefined),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined)
    }
    const links = {
      evaluateAll: vi
        .fn()
        .mockResolvedValue([{ href: 'https://rewards.bing.com/earn/task?opaque=canary' }]),
      nth: vi.fn().mockReturnValue({
        elementHandle: vi.fn().mockResolvedValue({
          evaluate: vi
            .fn()
            .mockResolvedValue({ href: 'https://rewards.bing.com/earn/task?opaque=canary' }),
          getAttribute: vi.fn().mockResolvedValue('_blank'),
          click,
          dispose: vi.fn().mockResolvedValue(undefined)
        }),
        getAttribute: vi.fn().mockResolvedValue('_blank'),
        click
      })
    }
    const page = {
      url: vi.fn().mockReturnValue('https://rewards.bing.com/earn'),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
      locator: vi.fn().mockReturnValue(links)
    } as unknown as Page
    const waitForEvent = vi.fn().mockResolvedValue(opened)
    const context = { waitForEvent } as unknown as BrowserContext
    const client = new DashboardClient(
      context,
      page,
      { write: vi.fn().mockResolvedValue(undefined) } as unknown as StructuredLogger,
      'run',
      'account-1'
    )

    await client.navigateOffer('https://rewards.bing.com/earn/task?opaque=canary')

    expect(click).toHaveBeenCalledTimes(1)
    expect(waitForEvent).toHaveBeenCalledWith('page', { timeout: 10_000 })
    expect(opened.close).toHaveBeenCalledTimes(1)
  })

  it('keeps an officially activated interaction page open for the caller', async () => {
    const opened = {
      waitForLoadState: vi.fn().mockResolvedValue(undefined),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined)
    }
    const links = {
      evaluateAll: vi
        .fn()
        .mockResolvedValue([{ href: 'https://www.bing.com/search?q=synthetic&filters=quiz' }]),
      nth: vi.fn().mockReturnValue({
        elementHandle: vi.fn().mockResolvedValue({
          evaluate: vi
            .fn()
            .mockResolvedValue({ href: 'https://www.bing.com/search?q=synthetic&filters=quiz' }),
          getAttribute: vi.fn().mockResolvedValue('_blank'),
          click: vi.fn().mockResolvedValue(undefined),
          dispose: vi.fn().mockResolvedValue(undefined)
        }),
        getAttribute: vi.fn().mockResolvedValue('_blank'),
        click: vi.fn().mockResolvedValue(undefined)
      })
    }
    const page = {
      url: vi.fn().mockReturnValue('https://rewards.bing.com/earn'),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
      locator: vi.fn().mockReturnValue(links)
    } as unknown as Page
    const context = {
      waitForEvent: vi.fn().mockResolvedValue(opened)
    } as unknown as BrowserContext
    const client = new DashboardClient(
      context,
      page,
      { write: vi.fn().mockResolvedValue(undefined) } as unknown as StructuredLogger,
      'run',
      'account-1'
    )

    const activated = await client.openOfferForInteraction(
      'https://www.bing.com/search?q=synthetic&filters=quiz'
    )

    expect(activated.page).toBe(opened)
    expect(activated.openedInNewPage).toBe(true)
    expect(opened.close).not.toHaveBeenCalled()
    await activated.close()
    expect(opened.close).toHaveBeenCalledTimes(1)
  })

  it('opens the Bing Rewards flyout and activates its matching official link', async () => {
    let currentUrl = 'https://rewards.bing.com/earn'
    const goto = vi.fn((url: string) => {
      currentUrl = url
      return Promise.resolve(null)
    })
    const pageLinks = {
      evaluateAll: vi.fn().mockResolvedValue([])
    }
    const triggerClick = vi.fn().mockResolvedValue(undefined)
    const trigger = {
      first: vi.fn().mockReturnThis(),
      count: vi.fn().mockResolvedValue(1),
      isVisible: vi.fn().mockResolvedValue(true),
      click: triggerClick
    }
    const anchorClick = vi.fn().mockResolvedValue(undefined)
    const frameLinks = {
      evaluateAll: vi
        .fn()
        .mockResolvedValue([{ href: 'https://www.bing.com/search?q=synthetic&form=new' }]),
      nth: vi.fn().mockReturnValue({
        elementHandle: vi.fn().mockResolvedValue({
          evaluate: vi
            .fn()
            .mockResolvedValue({ href: 'https://www.bing.com/search?q=synthetic&form=new' }),
          getAttribute: vi.fn().mockResolvedValue('_blank'),
          click: anchorClick,
          dispose: vi.fn().mockResolvedValue(undefined)
        }),
        getAttribute: vi.fn().mockResolvedValue('_blank'),
        click: anchorClick
      })
    }
    const frame = {
      url: vi.fn().mockReturnValue('https://cn.bing.com/rewards/panelflyout'),
      locator: vi.fn().mockReturnValue(frameLinks)
    }
    const opened = {
      waitForLoadState: vi.fn().mockResolvedValue(undefined),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined)
    }
    const page = {
      url: vi.fn(() => currentUrl),
      goto,
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
      locator: vi.fn((selector: string) => (selector === 'a[href]' ? pageLinks : trigger)),
      frames: vi.fn().mockReturnValue([frame])
    } as unknown as Page
    const context = {
      waitForEvent: vi.fn().mockResolvedValue(opened)
    } as unknown as BrowserContext
    const client = new DashboardClient(
      context,
      page,
      { write: vi.fn().mockResolvedValue(undefined) } as unknown as StructuredLogger,
      'run',
      'account-1'
    )

    await client.navigateOffer('https://www.bing.com/search?q=synthetic&form=old')

    expect(triggerClick).toHaveBeenCalledTimes(1)
    expect(frameLinks.evaluateAll).toHaveBeenCalledTimes(1)
    expect(anchorClick).toHaveBeenCalledTimes(1)
    expect(goto).not.toHaveBeenCalledWith(
      'https://www.bing.com/search?q=synthetic&form=old',
      expect.anything()
    )
  })

  it('captures the claim UI server-action acknowledgement instead of trusting the click', async () => {
    const click = vi.fn().mockResolvedValue(undefined)
    const button = {
      getAttribute: vi.fn().mockResolvedValue(null),
      textContent: vi.fn().mockResolvedValue('可领取3领取'),
      click
    }
    const buttons = {
      count: vi.fn().mockResolvedValue(1),
      nth: vi.fn().mockReturnValue(button)
    }
    const response = {
      status: vi.fn().mockReturnValue(200),
      ok: vi.fn().mockReturnValue(true),
      text: vi.fn().mockResolvedValue('1:true\n'),
      url: vi.fn().mockReturnValue('https://rewards.bing.com/dashboard'),
      headers: vi.fn().mockReturnValue({ 'content-type': 'text/x-component' }),
      request: vi.fn().mockReturnValue({ method: () => 'POST' })
    }
    const waitForResponse = vi.fn((predicate: (candidate: typeof response) => boolean) =>
      Promise.resolve(predicate(response) ? response : undefined)
    )
    const page = {
      url: vi.fn().mockReturnValue('https://rewards.bing.com/dashboard'),
      locator: vi.fn().mockReturnValue(buttons),
      waitForResponse,
      waitForTimeout: vi.fn().mockResolvedValue(undefined)
    } as unknown as Page
    const client = new DashboardClient(
      {} as BrowserContext,
      page,
      { write: vi.fn().mockResolvedValue(undefined) } as unknown as StructuredLogger,
      'run',
      'account-1'
    )

    await expect(client.claimBonusByUiWithResult()).resolves.toEqual({
      clicked: true,
      acknowledged: true,
      status: 200
    })
    expect(click).toHaveBeenCalledTimes(1)
    expect(waitForResponse).toHaveBeenCalledTimes(1)
  })

  it('expands the claim disclosure before clicking the actual claim action', async () => {
    const disclosureClick = vi.fn().mockResolvedValue(undefined)
    const claimClick = vi.fn().mockResolvedValue(undefined)
    const disclosure = {
      getAttribute: vi.fn((name: string) =>
        Promise.resolve(name === 'aria-expanded' ? 'false' : null)
      ),
      textContent: vi.fn().mockResolvedValue('可领取3领取'),
      click: disclosureClick
    }
    const claim = {
      getAttribute: vi.fn().mockResolvedValue(null),
      textContent: vi.fn().mockResolvedValue('3待领取领取积分'),
      click: claimClick
    }
    const initialButtons = {
      count: vi.fn().mockResolvedValue(1),
      nth: vi.fn().mockReturnValue(disclosure)
    }
    const expandedButtons = {
      count: vi.fn().mockResolvedValue(1),
      nth: vi.fn().mockReturnValue(claim)
    }
    const response = {
      status: vi.fn().mockReturnValue(200),
      ok: vi.fn().mockReturnValue(true),
      text: vi.fn().mockResolvedValue('1:true\n')
    }
    const page = {
      url: vi.fn().mockReturnValue('https://rewards.bing.com/dashboard'),
      locator: vi.fn((selector: string) =>
        selector === 'button:not([aria-expanded])' ? expandedButtons : initialButtons
      ),
      waitForResponse: vi.fn().mockResolvedValue(response),
      waitForTimeout: vi.fn().mockResolvedValue(undefined)
    } as unknown as Page
    const client = new DashboardClient(
      {} as BrowserContext,
      page,
      { write: vi.fn().mockResolvedValue(undefined) } as unknown as StructuredLogger,
      'run',
      'account-1'
    )

    await expect(client.claimBonusByUiWithResult()).resolves.toMatchObject({
      clicked: true,
      acknowledged: true,
      status: 200
    })
    expect(disclosureClick).toHaveBeenCalledTimes(1)
    expect(claimClick).toHaveBeenCalledTimes(1)
  })

  it('fails without direct-navigation fallback when the official link is absent', async () => {
    let currentUrl = 'https://rewards.bing.com/earn'
    const goto = vi.fn((url: string) => {
      currentUrl = url
      return Promise.resolve(null)
    })
    const pageLinks = { evaluateAll: vi.fn().mockResolvedValue([]) }
    const missingTrigger = {
      first: vi.fn().mockReturnThis(),
      count: vi.fn().mockResolvedValue(0),
      isVisible: vi.fn().mockResolvedValue(false),
      click: vi.fn()
    }
    const page = {
      url: vi.fn(() => currentUrl),
      goto,
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
      locator: vi.fn((selector: string) => (selector === 'a[href]' ? pageLinks : missingTrigger)),
      frames: vi.fn().mockReturnValue([])
    } as unknown as Page
    const client = new DashboardClient(
      {} as BrowserContext,
      page,
      { write: vi.fn().mockResolvedValue(undefined) } as unknown as StructuredLogger,
      'run',
      'account-1'
    )

    await expect(
      client.navigateOffer('https://destination.example.test/private?token=canary')
    ).rejects.toMatchObject({ errorCode: 'offer-not-found-before-activation' })
    expect(goto).toHaveBeenCalledTimes(5)
    expect(missingTrigger.click).not.toHaveBeenCalled()
    expect(goto).not.toHaveBeenCalledWith(
      'https://destination.example.test/private?token=canary',
      expect.anything()
    )
  })
})
