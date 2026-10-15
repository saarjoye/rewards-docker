import type { BalanceObservation } from './RunLedger.js'

export const MAGNITUDE_CONFLICT_THRESHOLD = 2000

export type CaliberFamily = 'total' | 'today'

export function caliberOf(source: string, provenance?: string | null): CaliberFamily {
  if (provenance === 'todays_points' || provenance === 'pointsCounters.totalPoints') {
    return 'today'
  }
  return 'total'
}

export function isDifferentCaliber(
  sourceA: string,
  provenanceA: string | null | undefined,
  sourceB: string,
  provenanceB: string | null | undefined
): boolean {
  return caliberOf(sourceA, provenanceA) !== caliberOf(sourceB, provenanceB)
}

export function balanceInterval(observations: readonly BalanceObservation[], requireStart = false) {
  const quarantined = observations.filter((row) => row.conflict === true)
  const active = observations.filter((row) => row.conflict !== true)
  const sorted = [...active].sort((a, b) => a.observedAt.localeCompare(b.observedAt))
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

  if (opening && closing) {
    const sameCaliber =
      caliberOf(opening.source, opening.provenance) === caliberOf(closing.source, closing.provenance)
    if (!sameCaliber) {
      conflicting = true
    }
  }

  // I14: a same-caliber adjacent jump larger than a reasonable single-day
  // gain is a conflict, regardless of whether the provenance label changed.
  // This catches cross-source contamination such as 12928 -> 1017 -> 12988
  // while still allowing a legitimate calibration -> availablePoints pair
  // when the values differ by a normal daily amount.
  for (let i = 0; i + 1 < sorted.length; i++) {
    const a = sorted[i]
    const b = sorted[i + 1]
    if (!a || !b) continue
    if (caliberOf(a.source, a.provenance) !== caliberOf(b.source, b.provenance)) continue
    if (Math.abs(a.balance - b.balance) > MAGNITUDE_CONFLICT_THRESHOLD) {
      conflicting = true
      break
    }
  }

  const valid = Boolean(opening && closing && opening.observedAt < closing.observedAt && !conflicting)
  const delta = valid && opening && closing ? closing.balance - opening.balance : null
  const finalized =
    valid && closing && sorted.some((row) => row.observedAt === closing.observedAt && row.phase === 'end')

  if (active.length === 0 && quarantined.length > 0) {
    return {
      conflicting: true,
      delta: null,
      openingBalance: null,
      closingBalance: null,
      observedFrom: null,
      observedAt: null,
      verificationStatus: 'conflict',
      evidenceSources: [...new Set(quarantined.map((row) => row.source))]
    }
  }

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