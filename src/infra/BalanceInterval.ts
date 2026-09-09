import type { BalanceObservation } from './RunLedger.js'

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
  const valid = opening && closing && opening.observedAt < closing.observedAt && !conflicting
  const delta = valid ? closing.balance - opening.balance : null
  const finalized =
    valid && sorted.some((row) => row.observedAt === closing.observedAt && row.phase === 'end')
  return {
    delta,
    openingBalance: opening?.balance ?? null,
    closingBalance: closing?.balance ?? null,
    observedFrom: opening?.observedAt ?? null,
    observedAt: closing?.observedAt ?? null,
    verificationStatus: delta === null ? 'pending' : finalized ? 'confirmed' : 'provisional',
    evidenceSources: [...new Set(sorted.map((row) => row.source))]
  }
}
