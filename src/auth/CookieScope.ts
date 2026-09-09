export interface ScopedCookie {
  name: string
  value: string
  domain: string
  path: string
  hostOnly: boolean
  secure: boolean
  expires: number
}

function domainMatches(cookie: ScopedCookie, hostname: string): boolean {
  const domain = cookie.domain.replace(/^\./, '').toLowerCase()
  const host = hostname.toLowerCase()
  if (cookie.hostOnly) return host === domain
  return host === domain || host.endsWith(`.${domain}`)
}

function pathMatches(cookiePath: string, requestPath: string): boolean {
  if (cookiePath === requestPath) return true
  if (!requestPath.startsWith(cookiePath)) return false
  if (cookiePath.endsWith('/')) return true
  return requestPath.charAt(cookiePath.length) === '/'
}

export function selectCookiesForUrl(
  cookies: readonly ScopedCookie[],
  targetUrl: string,
  nowSeconds = Date.now() / 1000
): ScopedCookie[] {
  const url = new URL(targetUrl)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError('Cookie target URL must use HTTP or HTTPS')
  }

  return cookies
    .map((cookie, index) => ({ cookie, index }))
    .filter(({ cookie }) => domainMatches(cookie, url.hostname))
    .filter(({ cookie }) => pathMatches(cookie.path || '/', url.pathname || '/'))
    .filter(({ cookie }) => !cookie.secure || url.protocol === 'https:')
    .filter(({ cookie }) => cookie.expires === -1 || cookie.expires > nowSeconds)
    .sort(
      (left, right) =>
        right.cookie.path.length - left.cookie.path.length || left.index - right.index
    )
    .map(({ cookie }) => cookie)
}

export function buildCookieHeaderForUrl(
  cookies: readonly ScopedCookie[],
  targetUrl: string,
  nowSeconds = Date.now() / 1000
): string {
  return selectCookiesForUrl(cookies, targetUrl, nowSeconds)
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join('; ')
}
