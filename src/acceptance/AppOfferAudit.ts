import type { RewardOffer } from '../rewards/RewardsModel.js'

export type AppOfferAuditKind = 'app-activity' | 'app-check-in' | 'read-to-earn' | 'unknown'

export interface AppOfferAuditSummary {
  kind: AppOfferAuditKind
  sourceType: string
  count: number
  completed: number
  pending: number
  executable: number
  progressTotal: 'missing' | 'zero' | 'positive'
  giveEligible: 'true' | 'false' | 'other' | 'missing'
  hidden: 'true' | 'false' | 'other' | 'missing'
  attributeKeys: readonly string[]
}

function safeSourceType(value: string | undefined): string {
  if (value === undefined || !value.trim()) return 'missing'
  const normalized = value.trim().toLowerCase()
  return /^[a-z0-9_-]{1,48}$/.test(normalized) ? normalized : 'other'
}

function booleanAttribute(value: string | undefined): 'true' | 'false' | 'other' | 'missing' {
  if (value === undefined) return 'missing'
  const normalized = value.toLowerCase()
  if (normalized === 'true' || normalized === 'false') return normalized
  return 'other'
}

export function classifyAppOffer(offer: RewardOffer): AppOfferAuditKind {
  const sourceTaskId = offer.sourceTaskId.toLowerCase()
  const type = offer.attributes?.type?.toLowerCase() ?? ''
  if (type === 'msnreadearn' || /readarticle|read.to.earn/.test(sourceTaskId)) {
    return 'read-to-earn'
  }
  if (type === 'checkin' || /check.?in|daily.?check/.test(sourceTaskId)) {
    return 'app-check-in'
  }
  if (type === 'sapphire') return 'app-activity'
  return 'unknown'
}

export function summarizeAppOffers(
  offers: readonly RewardOffer[]
): readonly AppOfferAuditSummary[] {
  const summaries = new Map<string, AppOfferAuditSummary>()
  for (const offer of offers.filter((candidate) => candidate.source === 'app-dashboard')) {
    const kind = classifyAppOffer(offer)
    const sourceType = safeSourceType(offer.attributes?.type)
    const progressTotal = offer.total === null ? 'missing' : offer.total === 0 ? 'zero' : 'positive'
    const giveEligible = booleanAttribute(offer.attributes?.give_eligible)
    const hidden = booleanAttribute(offer.attributes?.hidden)
    const attributeKeys = Object.keys(offer.attributes ?? {}).sort()
    const key = JSON.stringify({
      kind,
      sourceType,
      progressTotal,
      giveEligible,
      hidden,
      attributeKeys
    })
    const current = summaries.get(key)
    if (current) {
      current.count += 1
      current.completed += offer.complete ? 1 : 0
      current.pending += offer.complete ? 0 : 1
      current.executable += offer.executable ? 1 : 0
      continue
    }
    summaries.set(key, {
      kind,
      sourceType,
      count: 1,
      completed: offer.complete ? 1 : 0,
      pending: offer.complete ? 0 : 1,
      executable: offer.executable ? 1 : 0,
      progressTotal,
      giveEligible,
      hidden,
      attributeKeys
    })
  }
  return [...summaries.values()].sort((left, right) => {
    const kind = left.kind.localeCompare(right.kind)
    return kind !== 0 ? kind : JSON.stringify(left).localeCompare(JSON.stringify(right))
  })
}
