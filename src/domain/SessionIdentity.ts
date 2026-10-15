export interface RewardsIdentityAnchor {
  ruid?: string
  msaAuth?: string
}

const MSA_AUTH_COOKIE_NAME = '.MSA.Auth'
const RUID_REGION_PREFIX = /^[a-z]{2,8}-/i

const IDENTITY_CLAIM_NAMES = new Map<string, string>([
  ['accountid', 'accountid'],
  ['account_id', 'accountid'],
  ['cid', 'cid'],
  ['oid', 'oid'],
  ['puid', 'puid'],
  ['sub', 'sub'],
  ['uid', 'uid'],
  ['userid', 'userid'],
  ['user_id', 'userid']
])

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function decodeBase64Json(value: string): unknown {
  try {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8')) as unknown
  } catch {
    return undefined
  }
}

function collectIdentityClaims(value: unknown, output: string[], depth = 0): void {
  if (depth > 3) return
  if (Array.isArray(value)) {
    for (const item of value) collectIdentityClaims(item, output, depth + 1)
    return
  }
  if (typeof value !== 'object' || value === null) return
  for (const [key, raw] of Object.entries(value)) {
    const canonical = IDENTITY_CLAIM_NAMES.get(key.toLowerCase())
    const scalar = nonEmptyString(raw)
    if (canonical && scalar) output.push(`${canonical}=${scalar}`)
    collectIdentityClaims(raw, output, depth + 1)
  }
}

function msaAuthIdentitySegment(value: string): string | undefined {
  const input = nonEmptyString(value)
  if (!input) return undefined

  let decoded: string
  try {
    decoded = decodeURIComponent(input)
  } catch {
    decoded = input
  }

  const claims: string[] = []
  for (const token of decoded.split(/[&;|,]/)) {
    const pair = /^([^:=]+)[:=](.+)$/.exec(token)
    const key = pair?.[1]?.trim().toLowerCase()
    const claim = key ? IDENTITY_CLAIM_NAMES.get(key) : undefined
    const claimValue = nonEmptyString(pair?.[2])
    if (claim && claimValue) claims.push(`${claim}=${claimValue}`)

    for (const part of token.split('.')) {
      const parsed = decodeBase64Json(part)
      if (parsed !== undefined) collectIdentityClaims(parsed, claims)
    }
  }

  if (claims.length > 0) return [...new Set(claims)].sort().join('&')
  return undefined
}

export function normalizeRewardsRuid(value: string): string | undefined {
  const trimmed = nonEmptyString(value)
  if (!trimmed) return undefined
  const stable = trimmed.replace(RUID_REGION_PREFIX, '')
  return stable.trim().toUpperCase() || undefined
}

export function extractMsaAuthIdentity(
  cookies: readonly { name: string; value: string }[]
): string | undefined {
  const identities = cookies
    .filter((cookie) => cookie.name === MSA_AUTH_COOKIE_NAME)
    .map((cookie) => msaAuthIdentitySegment(cookie.value))
    .filter((identity): identity is string => identity !== undefined)
  if (identities.length === 0) return undefined
  return [...new Set(identities)].sort().join('|')
}

export function mergeSessionIdentityAnchors(
  ...anchors: readonly (RewardsIdentityAnchor | undefined)[]
): RewardsIdentityAnchor | undefined {
  let ruid: string | undefined
  let msaAuth: string | undefined
  for (const anchor of anchors) {
    if (!ruid && anchor?.ruid) ruid = normalizeRewardsRuid(anchor.ruid)
    if (!msaAuth && anchor?.msaAuth) msaAuth = nonEmptyString(anchor.msaAuth)
  }
  return ruid || msaAuth ? { ...(ruid ? { ruid } : {}), ...(msaAuth ? { msaAuth } : {}) } : undefined
}

export function createSessionIdentityAnchor(
  observationAnchor: RewardsIdentityAnchor | undefined,
  cookies: readonly { name: string; value: string }[]
): RewardsIdentityAnchor | undefined {
  const msaAuth = extractMsaAuthIdentity(cookies)
  return mergeSessionIdentityAnchors(observationAnchor, {
    ...(msaAuth ? { msaAuth } : {})
  })
}

export function validateSessionIdentityAnchor(
  expected: RewardsIdentityAnchor | undefined,
  actual: RewardsIdentityAnchor | undefined
): { valid: boolean; reason?: string; updated?: RewardsIdentityAnchor } {
  if (!expected || (!expected.ruid && !expected.msaAuth)) return { valid: true }
  if (!actual || (!actual.ruid && !actual.msaAuth)) {
    return { valid: false, reason: '会话身份与预期不一致' }
  }

  let matched = false
  if (expected.ruid && actual.ruid) {
    matched = true
    if (normalizeRewardsRuid(expected.ruid) !== normalizeRewardsRuid(actual.ruid)) {
      return { valid: false, reason: '会话身份与预期不一致' }
    }
  }
  if (expected.msaAuth && actual.msaAuth) {
    matched = true
    if (expected.msaAuth !== actual.msaAuth) {
      return { valid: false, reason: '会话身份与预期不一致' }
    }
  }
  if (!matched) return { valid: false, reason: '会话身份与预期不一致' }
  const updated = mergeSessionIdentityAnchors(expected, actual)
  return { valid: true, ...(updated ? { updated } : {}) }
}
