import type { Page } from 'patchright'

import { LoginStateError } from '../auth/LoginState.js'
import { safePath } from '../security/Redactor.js'

const AUTH_NAVIGATION_TIMEOUT_MS = 30_000

function isAborted(signal: AbortSignal): boolean {
  return signal.aborted
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('login-cancelled')
}

/** Navigation is not authentication: callers must still detect the form and verify the session. */
export async function navigateForAuthentication(
  page: Page,
  target: string,
  signal: AbortSignal,
  timeout = AUTH_NAVIGATION_TIMEOUT_MS
): Promise<void> {
  if (isAborted(signal)) throw abortReason(signal)
  let closing: Promise<void> | undefined
  let rejectCancellation: (reason: Error) => void = () => undefined
  const cancelled = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject
  })
  const onAbort = () => {
    // Close the owned page rather than leave a navigation running after cancellation.
    closing ??= Promise.resolve()
      .then(() => page.close({ runBeforeUnload: false }))
      .catch(() => undefined)
    void closing.then(() => {
      rejectCancellation(abortReason(signal))
    })
  }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    if (isAborted(signal)) {
      onAbort()
      await cancelled
    }
    if (!Number.isFinite(timeout) || timeout <= 0) {
      const exhausted = new Error('authentication navigation budget exhausted')
      exhausted.name = 'TimeoutError'
      throw exhausted
    }
    await Promise.race([
      page.goto(target, {
        waitUntil: 'commit',
        timeout: Math.min(AUTH_NAVIGATION_TIMEOUT_MS, timeout)
      }),
      cancelled
    ])
    if (isAborted(signal)) {
      await closing
      throw abortReason(signal)
    }
  } catch (error) {
    if (isAborted(signal)) {
      await closing
      throw abortReason(signal)
    }
    let current: { url: string; host: string; path: string }
    try {
      const parsed = new URL(page.url())
      current = {
        url: safePath(parsed.href),
        host: parsed.hostname.toLowerCase(),
        path: parsed.pathname
      }
    } catch {
      current = { url: '[invalid-url]', host: '', path: '' }
    }
    const timedOut = error instanceof Error && error.name === 'TimeoutError'
    throw new LoginStateError({
      loginState: 'unknown',
      loginStage: timedOut ? 'login-navigation-timeout' : 'login-navigation-error',
      message: timedOut
        ? '认证入口导航未在限定时间内提交，登录状态未确认'
        : '认证入口导航失败，登录状态未确认',
      ...current
    })
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}
