import type { BalanceObservation } from './RunLedger.js'

export const MAGNITUDE_CONFLICT_THRESHOLD = 2000

export type CaliberFamily = 'total' | 'flyout'

export function caliberOf(source: string, provenance?: string | null): CaliberFamily {
  if (source === 'bing-flyout' || source === 'legacy-getuserinfo') {
    if (provenance === 'appResponse.balance' || provenance === 'userInfo.balance') {
      return 'total'
    }
    return 'flyout'
  }
  return 'total'
}

export function isDifferentCaliber(
  sourceA: string,
  provenanceA: string | null | undefined,
  sourceB: string,
  provenanceB: string | null | undefined
): boolean {
  if (caliberOf(sourceA, provenanceA) !== caliberOf(sourceB, provenanceB)) return true
  if (provenanceA && provenanceB && provenanceA !== provenanceB) {
    if (
      (provenanceA === 'userStatus.availablePoints' && provenanceB !== 'userStatus.availablePoints') ||
      (provenanceB === 'userStatus.availablePoints' && provenanceA !== 'userStatus.availablePoints')
    ) {
      return true
    }
  }
  return false
}

export function balanceInterval(observations: readonly BalanceObservation[], requireStart = false) {
  const sorted = [...observations].sort((a, b) => a.observedAt.localeCompare(b.observedAt))
  const opening = requireStart ? sorted.find((row) => row.phase === 'start') : sorted[0]
  const closing = sorted.at(-1)
  const seen = new Map<string, number>()
  let conflicting =
    new Set(sorted.map((row) => row.accountId)).size > 1 ||
    (requireStart
      ? new Set(sorted.map((row) => row.runId)).size > 1
      : new Set(sorted.map((row) => row.businessDate)).size > 1)

  for (const row of sorted) {
    if (seen.has(row.observedAt) && seen.get(row.observedAt) !== row.balance) conflicting = true
    seen.set(row.observedAt, row.balance)
  }

  if (sorted.some((row) => row.conflict === true)) {
    conflicting = true
  }

  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const a = sorted[i]
      const b = sorted[j]
      if (!a || !b) continue
      if (
        isDifferentCaliber(a.source, a.provenance, b.source, b.provenance) &&
        Math.abs(a.balance - b.balance) > MAGNITUDE_CONFLICT_THRESHOLD
      ) {
        conflicting = true
        break
      }
    }
    if (conflicting) break
  }

  if (
    opening &&
    closing &&
    opening.observedAt < closing.observedAt &&
    isDifferentCaliber(opening.source, opening.provenance, closing.source, closing.provenance)
  ) {
    conflicting = true
  }

  const valid = Boolean(opening && closing && opening.observedAt < closing.observedAt && !conflicting)
  const delta = valid && opening && closing ? closing.balance - opening.balance : null
  const finalized =
    valid && closing && sorted.some((row) => row.observedAt === closing.observedAt && row.phase === 'end')

  return {
    conflicting,
    delta: conflicting ? null : delta,
    openingBalance: conflicting ? null : (opening?.balance ?? null),
    closingBalance: conflicting ? null : (closing?.balance ?? null),
    observedFrom: opening?.observedAt ?? null,
    observedAt: closing?.observedAt ?? null,
    verificationStatus: conflicting
      ? 'conflict'
      : delta === null
        ? 'pending'
        : finalized
          ? 'confirmed'
          : 'provisional',
    evidenceSources: [...new Set(sorted.map((row) => row.source))]
  }
}