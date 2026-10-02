import type { Page } from 'patchright'
import { describe, expect, it, vi } from 'vitest'

import { LoginController } from '../src/browser/LoginController.js'
import type { LoginState } from '../src/auth/LoginState.js'
import { AccountPipeline } from '../src/orchestration/AccountPipeline.js'
import type { StructuredLogger } from '../src/infra/StructuredLogger.js'

function control(visible = false, enabled = true) {
  const item = {
    count: vi.fn().mockResolvedValue(1),
    first: () => item,
    nth: () => item,
    filter: () => item,
    isVisible: vi.fn().mockResolvedValue(visible),
    isEnabled: vi.fn().mockResolvedValue(enabled),
    click: vi.fn().mockResolvedValue(undefined)
  }
  return item
}
function fixture(url: string, image = false, enabled = true) {
  const absent = control()
  const back = control(true, enabled)
  const fidoImage = control(image)
  const goBack = vi.fn().mockResolvedValue(null)
  const candidate = {
    url: () => url,
    locator: vi.fn((selector: string) => {
      if (selector.includes('fidoImage')) return fidoImage
      if (selector.includes('back-button')) return back
      return absent
    }),
    getByRole: vi.fn().mockReturnValue(absent),
    getByText: vi.fn().mockReturnValue(absent),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    goBack
  } as unknown as Page
  const logger = { write: vi.fn().mockResolvedValue(undefined) } as unknown as StructuredLogger
  return { page: candidate, back, fidoImage, goBack, controller: new LoginController(logger) }
}
function state(state: LoginState) {
  return {
    state,
    loginStage: state === 'passkey-error' ? 'login-passkey-error' : 'login-candidate',
    url: 'https://login.microsoft.com/consumers/passkey/fido',
    host: 'login.microsoft.com',
    path: '/consumers/passkey/fido'
  }
}
const credentials = { email: 'synthetic@example.test', password: 'synthetic-passkey-canary' }

describe('modern Microsoft passkey compatibility', () => {
  it.each([
    '/consumers/passkey/fido',
    '/consumers/passkey/fido/',
    '/consumers/fido/get',
    '/consumers/passkey/FIDO'
  ])('recognizes the complete FIDO route segment %s', async (path) => {
    const f = fixture(`https://login.microsoft.com${path}`)
    await expect(f.controller.detectCurrentState(f.page)).resolves.toMatchObject({
      state: 'passkey-error',
      loginStage: 'login-passkey-error'
    })
  })

  it('recognizes the observed FIDO image on an official login host', async () => {
    const f = fixture('https://login.microsoft.com/consumers/new-view', true)
    await expect(f.controller.detectCurrentState(f.page)).resolves.toMatchObject({
      state: 'passkey-error'
    })
  })

  it.each([
    ['https://login.microsoft.com/consumers/not-fido', false],
    ['https://login.microsoft.com/consumers/fidology', false],
    ['https://login.microsoft.com/consumers/home?return=/fido', false],
    ['https://untrusted.example.test/consumers/fido', true],
    ['http://login.microsoft.com/consumers/new-view', true]
  ])('does not classify a lookalike route or untrusted image: %s', async (url, image) => {
    const f = fixture(url, image)
    await expect(f.controller.detectCurrentState(f.page)).resolves.toMatchObject({
      state: 'unknown'
    })
  })

  it('uses the offered in-page back control once without replaying the username POST', async () => {
    const f = fixture(state('passkey-error').url, true)
    vi.spyOn(f.controller, 'detectCurrentState')
      .mockResolvedValueOnce(state('passkey-error'))
      .mockResolvedValueOnce(state('logged-in'))
    await f.controller.login(f.page, credentials, new AbortController().signal)
    expect(f.back.click).toHaveBeenCalledExactlyOnceWith({ timeout: 5_000 })
    expect(f.goBack).not.toHaveBeenCalled()
  })

  it('stops for manual passkey verification when the new back control is disabled', async () => {
    const f = fixture(state('passkey-error').url, true, false)
    vi.spyOn(f.controller, 'detectCurrentState').mockResolvedValue(state('passkey-error'))
    await expect(
      f.controller.login(f.page, credentials, new AbortController().signal)
    ).rejects.toMatchObject({
      name: 'LoginStateError',
      loginState: 'passkey-error',
      loginStage: 'login-passkey-error'
    })
    expect(f.back.click).not.toHaveBeenCalled()
    expect(f.goBack).not.toHaveBeenCalled()
  })

  it('requires manual verification when the offered back control is missing', async () => {
    const f = fixture(state('passkey-error').url, true)
    f.back.isVisible.mockResolvedValue(false)
    vi.spyOn(f.controller, 'detectCurrentState').mockResolvedValue(state('passkey-error'))
    await expect(
      f.controller.login(f.page, credentials, new AbortController().signal)
    ).rejects.toMatchObject({
      name: 'LoginStateError',
      loginState: 'passkey-error',
      loginStage: 'login-passkey-error'
    })
    expect(f.back.click).not.toHaveBeenCalled()
    expect(f.goBack).not.toHaveBeenCalled()
  })

  it('does not use a modern back control on an untrusted page', async () => {
    const f = fixture('https://untrusted.example.test/consumers/fido', true)
    vi.spyOn(f.controller, 'detectCurrentState').mockResolvedValue(state('passkey-error'))
    await expect(
      f.controller.login(f.page, credentials, new AbortController().signal)
    ).rejects.toMatchObject({ name: 'LoginStateError', loginState: 'passkey-error' })
    expect(f.back.click).not.toHaveBeenCalled()
  })

  it('does not interact when cancelled before login starts', async () => {
    const f = fixture(state('passkey-error').url, true)
    const abort = new AbortController()
    const reason = new Error('synthetic passkey cancellation')
    abort.abort(reason)
    await expect(f.controller.login(f.page, credentials, abort.signal)).rejects.toBe(reason)
    expect(f.back.click).not.toHaveBeenCalled()
    expect(f.goBack).not.toHaveBeenCalled()
  })

  it('keeps an unconfirmed passkey switch action-required and never starts Rewards tasks', async () => {
    const f = fixture(state('passkey-error').url, true)
    f.back.click.mockRejectedValue(new Error('synthetic unconfirmed choice'))
    vi.spyOn(f.controller, 'detectCurrentState').mockResolvedValue(state('passkey-error'))
    const signal = new AbortController().signal
    const execute = vi.fn(async () => {
      await f.controller.login(f.page, credentials, signal)
      return { status: 'completed' as const }
    })
    const checkpoint = vi.fn().mockResolvedValue(undefined)
    const pipeline = new AccountPipeline({ execute, checkpoint })
    const result = await pipeline.run({
      runId: 'synthetic-run',
      accountId: 'synthetic-account',
      runAccountIndex: 1,
      localDate: '2026-10-02',
      signal
    })
    expect(result.status).toBe('action-required')
    expect(execute).toHaveBeenCalledTimes(1)
    expect(result.stages).toMatchObject([
      {
        stage: 'authenticate',
        result: {
          status: 'action-required',
          failureStage: 'login-passkey-choice-unconfirmed'
        }
      }
    ])
    expect(result.stages[0]?.result.message).toContain('需要人工')
    expect(f.back.click).toHaveBeenCalledTimes(1)
  })

  it('does not retry a back click or navigate history after an unconfirmed click', async () => {
    const f = fixture(state('passkey-error').url, true)
    f.back.click.mockRejectedValue(new Error('synthetic click timeout ?code=passkey-error-canary'))
    vi.spyOn(f.controller, 'detectCurrentState').mockResolvedValue(state('passkey-error'))
    const error = await f.controller
      .login(f.page, credentials, new AbortController().signal)
      .catch((e: unknown) => e)
    expect(error).toMatchObject({
      name: 'LoginStateError',
      loginState: 'passkey-error',
      loginStage: 'login-passkey-choice-unconfirmed'
    })
    expect(String(error)).not.toContain('passkey-error-canary')
    expect(f.back.click).toHaveBeenCalledTimes(1)
    expect(f.goBack).not.toHaveBeenCalled()
  })

  it('accepts a confirmed state change after a back click times out without clicking again', async () => {
    const f = fixture(state('passkey-error').url, true)
    f.back.click.mockRejectedValue(new Error('synthetic delayed click'))
    vi.spyOn(f.controller, 'detectCurrentState')
      .mockResolvedValueOnce(state('passkey-error'))
      .mockResolvedValueOnce(state('logged-in'))
      .mockResolvedValueOnce(state('logged-in'))
    await f.controller.login(f.page, credentials, new AbortController().signal)
    expect(f.back.click).toHaveBeenCalledTimes(1)
    expect(f.goBack).not.toHaveBeenCalled()
  })
})
