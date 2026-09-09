export interface OfferIdentity {
  sourceTaskId?: string
  displayName?: string
}

export interface OfferAnchor {
  href: string
  visible?: boolean
  offerId?: string
  taskId?: string
  destinationUrl?: string
  ariaLabel?: string
  title?: string
}

const bingHosts = new Set(['bing.com', 'www.bing.com', 'cn.bing.com'])
const tracking = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term',
  'msclkid'
])
const bingTracking = new Set(['form', 'cvid', 'qs', 'sp', 'pq', 'sc', 'sk'])

function safeUrl(value: string): URL | undefined {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password ? url : undefined
  } catch {
    return undefined
  }
}

function path(url: URL): string {
  return url.pathname.replace(/\/+$/, '') || '/'
}

export function sameOfferUrl(left: string, right: string): boolean {
  const a = safeUrl(left)
  const b = safeUrl(right)
  if (!a || !b) return false
  const bing = bingHosts.has(a.hostname) && bingHosts.has(b.hostname)
  if ((!bing && a.hostname !== b.hostname) || a.port !== b.port || path(a) !== path(b)) return false
  if (bing && path(a) === '/search' && (!a.searchParams.has('q') || !b.searchParams.has('q')))
    return false
  const query = (url: URL) =>
    JSON.stringify(
      [...url.searchParams.entries()]
        .filter(
          ([key]) =>
            !tracking.has(key.toLowerCase()) && !(bing && bingTracking.has(key.toLowerCase()))
        )
        .sort(([ak, av], [bk, bv]) => ak.localeCompare(bk) || av.localeCompare(bv))
    )
  return query(a) === query(b) && a.hash === b.hash
}

export function matchOfferAnchor(
  anchors: readonly OfferAnchor[],
  destination: string,
  identity: OfferIdentity = {}
) {
  const expected = safeUrl(destination)
  if (!expected) return { index: -1, method: 'unsafe' }
  const exact = anchors.flatMap((anchor, index) =>
    anchor.visible !== false && sameOfferUrl(anchor.href, destination) ? [index] : []
  )
  if (exact.length)
    return {
      index: exact.length === 1 ? (exact[0] ?? -1) : -1,
      method: exact.length === 1 ? 'url' : 'ambiguous'
    }
  const normalize = (value?: string) => value?.replace(/\s+/g, ' ').trim()
  const fallback = anchors.flatMap((anchor, index) => {
    if (anchor.visible === false) return []
    const actual = safeUrl(anchor.href)
    if (
      !actual ||
      actual.port ||
      !['rewards.bing.com', 'rewards.microsoft.com'].includes(actual.hostname)
    )
      return []
    // A wrapper needs an explicit matching destination. IDs/titles cannot override search semantics.
    if (!anchor.destinationUrl || !sameOfferUrl(anchor.destinationUrl, destination)) return []
    const id =
      identity.sourceTaskId && [anchor.offerId, anchor.taskId].includes(identity.sourceTaskId)
    const label = normalize(identity.displayName)
    const named = label && [normalize(anchor.ariaLabel), normalize(anchor.title)].includes(label)
    return id || named ? [index] : []
  })
  return {
    index: fallback.length === 1 ? (fallback[0] ?? -1) : -1,
    method:
      fallback.length === 1 ? 'identity-destination' : fallback.length ? 'ambiguous' : 'missing'
  }
}
