import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EncryptedSessionStore, StoredSession } from '../src/auth/EncryptedSessionStore.js'
import {
  BrowserRuntime,
  type BrowserStorageState,
  sanitizeStorageState
} from '../src/browser/BrowserRuntime.js'

const mocks = vi.hoisted(() => ({ launch: vi.fn() }))
vi.mock('patchright', () => ({ default: { chromium: { launch: mocks.launch } } }))
beforeEach(() => mocks.launch.mockReset())

describe('isolated browser authentication contexts', () => {
  it('reuses Chromium but restores each account only into its own independent context', async () => {
    const storedState = { cookies: [], origins: [] } as unknown as BrowserStorageState
    const context = () => ({
      setDefaultTimeout: vi.fn(),
      setDefaultNavigationTimeout: vi.fn(),
      newPage: vi.fn().mockResolvedValue({}),
      close: vi.fn().mockResolvedValue(undefined)
    })
    const contexts = [context(), context(), context()]
    const newContext = vi
      .fn()
      .mockResolvedValueOnce(contexts[0])
      .mockResolvedValueOnce(contexts[1])
      .mockResolvedValueOnce(contexts[2])
    const browser = {
      newContext,
      isConnected: () => true,
      close: vi.fn().mockResolvedValue(undefined)
    }
    mocks.launch.mockResolvedValue(browser)
    const read = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ payload: storedState })
      .mockResolvedValueOnce(undefined)
    const runtime = new BrowserRuntime({
      headless: true,
      sessions: { read } as unknown as EncryptedSessionStore
    })
    const first = await runtime.openSlot('synthetic-1', 'web-desktop')
    const second = await runtime.openSlot('synthetic-2', 'web-desktop')
    const third = await runtime.openSlot('synthetic-3', 'web-desktop')
    expect(first.authenticationContext).toEqual({ reusedBrowser: false, restoredSession: false })
    expect(second.authenticationContext).toEqual({ reusedBrowser: true, restoredSession: true })
    expect(third.authenticationContext).toEqual({ reusedBrowser: true, restoredSession: false })
    expect(read.mock.calls).toEqual([
      ['synthetic-1', 'web-desktop'],
      ['synthetic-2', 'web-desktop'],
      ['synthetic-3', 'web-desktop']
    ])
    expect(newContext.mock.calls[0]?.[0]).not.toHaveProperty('storageState')
    expect(newContext.mock.calls[1]?.[0]).toMatchObject({ storageState: storedState })
    expect(newContext.mock.calls[2]?.[0]).not.toHaveProperty('storageState')
    await first.close()
    expect(contexts[0]?.close).toHaveBeenCalledTimes(1)
    expect(contexts[1]?.close).not.toHaveBeenCalled()
    expect(second.context).not.toBe(first.context)
    expect(mocks.launch).toHaveBeenCalledTimes(1)
    await runtime.close()
  })

  it('strips only the _U cookie while restoring other session state', async () => {
    const storedState = {
      cookies: [
        {
          name: '_U',
          value: 'synthetic-poison',
          domain: '.bing.com',
          path: '/',
          expires: -1,
          httpOnly: false,
          secure: true,
          sameSite: 'None'
        },
        {
          name: 'synthetic-session',
          value: 'synthetic-value',
          domain: '.bing.com',
          path: '/',
          expires: -1,
          httpOnly: true,
          secure: true,
          sameSite: 'None'
        }
      ],
      origins: [{ origin: 'https://rewards.bing.com', localStorage: [] }]
    } as unknown as BrowserStorageState
    const context = {
      setDefaultTimeout: vi.fn(),
      setDefaultNavigationTimeout: vi.fn(),
      newPage: vi.fn().mockResolvedValue({}),
      storageState: vi.fn().mockResolvedValue(storedState),
      close: vi.fn().mockResolvedValue(undefined)
    }
    const newContext = vi.fn().mockResolvedValue(context)
    mocks.launch.mockResolvedValue({
      newContext,
      isConnected: () => true,
      close: vi.fn().mockResolvedValue(undefined)
    })
    const read = vi.fn().mockResolvedValue({ payload: storedState })
    const commitVerified = vi.fn().mockResolvedValue(undefined)
    const runtime = new BrowserRuntime({
      headless: true,
      sessions: { read, commitVerified } as unknown as EncryptedSessionStore
    })

    const slot = await runtime.openSlot('synthetic-sanitize', 'web-desktop')
    const options = newContext.mock.calls[0]?.[0] as Record<string, unknown>
    expect(options.storageState).toMatchObject({
      cookies: [expect.objectContaining({ name: 'synthetic-session' })],
      origins: storedState.origins
    })
    expect((options.storageState as BrowserStorageState).cookies).toHaveLength(1)

    await slot.commitVerified()
    const session = commitVerified.mock.calls[0]?.[0] as StoredSession<BrowserStorageState>
    expect(session.payload.cookies).toHaveLength(1)
    expect(session.payload.cookies[0]?.name).toBe('synthetic-session')
    expect(session.payload.origins).toEqual(storedState.origins)
    await runtime.close()
  })

  it('leaves storage state without _U unchanged', () => {
    const state = {
      cookies: [
        {
          name: 'synthetic-session',
          value: 'synthetic-value',
          domain: '.bing.com',
          path: '/',
          expires: -1,
          httpOnly: true,
          secure: true,
          sameSite: 'None'
        }
      ],
      origins: []
    } as unknown as BrowserStorageState
    expect(sanitizeStorageState(state)).toEqual(state)
  })
})
