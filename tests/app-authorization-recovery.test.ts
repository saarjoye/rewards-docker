import type { APIResponse, BrowserContext, Page } from 'patchright'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { EncryptedSessionStore } from '../src/auth/EncryptedSessionStore.js'
import { AppAuthorizationSession } from '../src/browser/AppAuthorizationSession.js'
import { AppOAuthClient, type AppToken } from '../src/browser/AppOAuthClient.js'
import type { LoginController } from '../src/browser/LoginController.js'
import type { StructuredLogger } from '../src/infra/StructuredLogger.js'
import { BusinessDateChanged } from '../src/orchestration/BusinessDate.js'

const credentials = { email: 'synthetic@example.invalid', password: 'synthetic-password' }
const token = (accessToken: string): AppToken => ({
  accessToken,
  refreshToken: 'synthetic-refresh',
  expiresAt: '2099-01-01T00:00:00.000Z'
})

function sessionFixture(guardDate?: () => void) {
  const oauth = {
    readStored: vi.fn<AppOAuthClient['readStored']>().mockResolvedValue(token('stored')),
    acquire: vi.fn<AppOAuthClient['acquire']>().mockResolvedValue(token('refreshed')),
    commitVerified: vi.fn<AppOAuthClient['commitVerified']>().mockResolvedValue(undefined)
  }
  const session = new AppAuthorizationSession(oauth, 'synthetic-account', credentials, guardDate)
  const signal = new AbortController().signal
  return { session, oauth, signal }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('App authorization session', () => {
  it('loads once, refreshes once, and commits only the current verified token', async () => {
    const { session, oauth, signal } = sessionFixture()
    await session.initialize(signal)
    await session.initialize(signal)
    expect(oauth.readStored).toHaveBeenCalledTimes(1)
    expect(oauth.acquire).not.toHaveBeenCalled()
    expect(oauth.commitVerified).not.toHaveBeenCalled()
    await session.confirm(signal)
    await session.confirm(signal)
    expect(oauth.commitVerified).toHaveBeenCalledTimes(1)
    expect(await session.refresh(signal)).toBe('refreshed')
    expect(session.accessToken).toBe('refreshed')
    expect(await session.refresh(signal)).toBeUndefined()
    expect(oauth.acquire).toHaveBeenCalledTimes(1)
    expect(oauth.commitVerified).toHaveBeenCalledTimes(1)
    await session.confirm(signal)
    expect(oauth.commitVerified).toHaveBeenLastCalledWith('synthetic-account', token('refreshed'))
  })

  it('does not acquire again when initial authorization was already necessary', async () => {
    const { session, oauth, signal } = sessionFixture()
    oauth.readStored.mockResolvedValue(undefined)
    await session.initialize(signal)
    expect(await session.refresh(signal)).toBeUndefined()
    expect(oauth.acquire).toHaveBeenCalledTimes(1)
  })

  it('consumes a failed refresh and never persists an unverified token', async () => {
    const { session, oauth, signal } = sessionFixture()
    await session.initialize(signal)
    const failed = new Error('synthetic-refresh-failed')
    oauth.acquire.mockRejectedValue(failed)
    await expect(session.refresh(signal)).rejects.toBe(failed)
    expect(await session.refresh(signal)).toBeUndefined()
    expect(session.accessToken).toBe('stored')
    expect(oauth.acquire).toHaveBeenCalledTimes(1)
    expect(oauth.commitVerified).not.toHaveBeenCalled()
  })

  it.each(['cancelled', 'date-changed'] as const)(
    'does not accept or persist a late refresh after %s',
    async (kind) => {
      const controller = new AbortController()
      let changed = false
      const reason = kind === 'cancelled' ? new Error('Cancelled') : new BusinessDateChanged()
      const { session, oauth } = sessionFixture(() => {
        if (changed) throw reason
      })
      await session.initialize(controller.signal)
      oauth.acquire.mockImplementation(() => {
        if (kind === 'cancelled') controller.abort(reason)
        else changed = true
        return Promise.resolve(token('late'))
      })
      await expect(session.refresh(controller.signal)).rejects.toBe(reason)
      expect(session.accessToken).toBe('stored')
      expect(oauth.commitVerified).not.toHaveBeenCalled()
    }
  )
})

describe('OAuth cancellation', () => {
  it('stops a pending token exchange and disposes its late response without starting login', async () => {
    let finish: ((response: APIResponse) => void) | undefined
    const pending = new Promise<APIResponse>((resolve) => {
      finish = resolve
    })
    const post = vi.fn().mockReturnValue(pending)
    const get = vi.fn()
    const newPage = vi.fn()
    const sessions = { read: vi.fn().mockResolvedValue({ payload: token('stored') }) }
    const logger = { write: vi.fn().mockResolvedValue(undefined) }
    const client = new AppOAuthClient(
      { request: { post, get }, newPage } as unknown as BrowserContext,
      {} as Page,
      sessions as unknown as EncryptedSessionStore,
      logger as unknown as StructuredLogger,
      {} as LoginController,
      'synthetic-run',
      'synthetic-account'
    )
    const controller = new AbortController()
    const reason = new Error('synthetic-cancellation')
    const acquisition = client.acquire('synthetic-account', credentials, controller.signal)
    const rejected = expect(acquisition).rejects.toBe(reason)
    await vi.waitFor(() => {
      expect(post).toHaveBeenCalledTimes(1)
    })
    controller.abort(reason)
    await rejected
    const response = { dispose: vi.fn().mockResolvedValue(undefined) }
    finish?.(response as unknown as APIResponse)
    await vi.waitFor(() => {
      expect(response.dispose).toHaveBeenCalledTimes(1)
    })
    expect(get).not.toHaveBeenCalled()
    expect(newPage).not.toHaveBeenCalled()
    expect(logger.write).not.toHaveBeenCalled()
  })
})
