import type { Frame, Page, Request } from 'patchright'

import { LoginStateError, type AuthenticationNavigationFailure } from '../auth/LoginState.js'
import { safePath } from '../security/Redactor.js'

const AUTH_NAVIGATION_TIMEOUT_MS = 30_000

function isAborted(signal: AbortSignal): boolean {
  return signal.aborted
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('login-cancelled')
}

/** Raw errors are used only for classification, never stored or logged. */
function navigationFailure(error: unknown): AuthenticationNavigationFailure {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  if (/ERR_NAME_NOT_RESOLVED|ENOTFOUND|EAI_AGAIN|ERR_DNS/i.test(message)) return 'dns'
  if (/ERR_CERT|ERR_SSL|CERTIFICATE|TLS/i.test(message)) return 'tls'
  if (/ERR_CONNECTION|ECONN|socket hang up/i.test(message)) return 'connection'
  if (/ERR_TOO_MANY_REDIRECTS/i.test(message)) return 'redirect'
  if (/ERR_INTERNET|ERR_NETWORK|network changed/i.test(message)) return 'network'
  if (/page, context or browser has been closed|Target closed|browser.*disconnect/i.test(message))
    return 'browser'
  if (
    (error instanceof Error && error.name === 'TimeoutError') ||
    /timed out|timeout/i.test(message)
  )
    return 'timeout'
  return 'unknown'
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
  let timer: ReturnType<typeof setTimeout> | undefined
  let documentFailure: AuthenticationNavigationFailure | undefined
  let committed = false
  const closeOwnedPage = () => {
    closing ??= Promise.resolve()
      .then(() => page.close({ runBeforeUnload: false }))
      .catch(() => undefined)
    return closing
  }
  const onRequestFailed = (request: Request) => {
    try {
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
        const classified = navigationFailure(request.failure()?.errorText)
        if (classified !== 'unknown') documentFailure = classified
      }
    } catch {
      /* A detached frame is not evidence of a specific network failure. */
    }
  }
  const onFrameNavigated = (frame: Frame) => {
    if (frame === page.mainFrame()) committed = true
  }
  // Minimal synthetic Page ports may not expose events. Real Page instances always do.
  const observeEvents = typeof page.on === 'function' && typeof page.off === 'function'
  if (observeEvents) {
    page.on('requestfailed', onRequestFailed)
    page.on('framenavigated', onFrameNavigated)
  }
  let rejectCancellation: (reason: Error) => void = () => undefined
  const cancelled = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject
  })
  const onAbort = () => {
    void closeOwnedPage().then(() => {
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
      const error = new Error('authentication navigation budget exhausted')
      error.name = 'TimeoutError'
      throw error
    }
    const budget = Math.min(AUTH_NAVIGATION_TIMEOUT_MS, timeout)
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const error = new Error('authentication navigation deadline exhausted')
        error.name = 'TimeoutError'
        reject(error)
      }, budget)
    })
    await Promise.race([
      page.goto(target, { waitUntil: 'commit', timeout: budget }),
      cancelled,
      deadline
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
    const failure = documentFailure ?? navigationFailure(error)
    // A failed navigation must not continue in the background or affect a later account.
    await closeOwnedPage()
    if (isAborted(signal)) throw abortReason(signal)
    throw new LoginStateError({
      loginState: 'unknown',
      loginStage: timedOut ? 'login-navigation-timeout' : 'login-navigation-error',
      message: `${timedOut ? '认证入口导航未在限定时间内结束' : '认证入口导航失败'}，登录状态未确认（原因分类：${failure}；已提交页面：${String(committed)}）`,
      navigationFailure: failure,
      navigationCommitted: committed,
      ...current
    })
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
    if (observeEvents) {
      page.off('requestfailed', onRequestFailed)
      page.off('framenavigated', onFrameNavigated)
    }
  }
}
