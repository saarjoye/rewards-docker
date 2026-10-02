export interface OfferIdentity {
  sourceTaskId?: string
  taskId?: string
  offerId?: string
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
  text?: string
  cardLabel?: string
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
  const normalize = (value?: string) => value?.replace(/\s+/g, ' ').trim()
  const expectedIds = [identity.sourceTaskId, identity.taskId, identity.offerId].filter(Boolean)
  const label = normalize(identity.displayName)
  const evidence = (anchor: OfferAnchor) => {
    const ids = [anchor.offerId, anchor.taskId].filter(Boolean)
    const id = ids.some((value) => expectedIds.includes(value))
    const conflicting = expectedIds.length > 0 && ids.length > 0 && !id
    const named = Boolean(
      label &&
      [anchor.ariaLabel, anchor.title, anchor.text, anchor.cardLabel].map(normalize).includes(label)
    )
    const destinationMatches =
      !anchor.destinationUrl || sameOfferUrl(anchor.destinationUrl, destination)
    return { id, named, eligible: anchor.visible !== false && !conflicting && destinationMatches }
  }
  const exact = anchors.flatMap((anchor, index) => {
    const proof = evidence(anchor)
    return proof.eligible && sameOfferUrl(anchor.href, destination) ? [{ index, ...proof }] : []
  })
  if (exact.length === 1) {
    const repeated =
      anchors.filter((anchor) => anchor.visible !== false && sameOfferUrl(anchor.href, destination))
        .length > 1
    const candidate = exact[0]
    if (repeated && !candidate?.id && !candidate?.named) return { index: -1, method: 'ambiguous' }
    return {
      index: candidate?.index ?? -1,
      method: repeated ? (candidate?.id ? 'url-identity' : 'url-name') : 'url'
    }
  }
  if (exact.length > 1) {
    const identified = exact.filter((candidate) => candidate.id)
    if (identified.length === 1)
      return { index: identified[0]?.index ?? -1, method: 'url-identity' }
    if (identified.length > 1) return { index: -1, method: 'ambiguous' }
    const named = exact.filter((candidate) => candidate.named)
    return {
      index: named.length === 1 ? (named[0]?.index ?? -1) : -1,
      method: named.length === 1 ? 'url-name' : 'ambiguous'
    }
  }
  const fallback = anchors.flatMap((anchor, index) => {
    const proof = evidence(anchor)
    if (!proof.eligible) return []
    const actual = safeUrl(anchor.href)
    if (
      !actual ||
      actual.port ||
      !['rewards.bing.com', 'rewards.microsoft.com'].includes(actual.hostname)
    )
      return []
    // Official wrappers still require an explicit matching destination. Identity cannot replace it.
    if (!anchor.destinationUrl || !sameOfferUrl(anchor.destinationUrl, destination)) return []
    return proof.id || proof.named ? [{ index, ...proof }] : []
  })
  const identified = fallback.filter((candidate) => candidate.id)
  const preferred = identified.length ? identified : fallback
  return {
    index: preferred.length === 1 ? (preferred[0]?.index ?? -1) : -1,
    method:
      preferred.length === 1 ? 'identity-destination' : preferred.length ? 'ambiguous' : 'missing'
  }
}
