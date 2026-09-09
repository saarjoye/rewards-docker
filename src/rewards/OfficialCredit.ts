import type { CreditInput } from '../infra/PointCredits.js'

export type TaskCreditEvidence = Omit<
  CreditInput,
  'runId' | 'accountId' | 'taskId' | 'source' | 'observedAt'
>

// Deliberately narrow: request IDs, activity amounts and point progress are not credit receipts.
export function officialCredit(
  payload: unknown,
  offerId: string | undefined
): TaskCreditEvidence | undefined {
  if (!offerId || !payload || typeof payload !== 'object' || Array.isArray(payload))
    return undefined
  const root = payload as Record<string, unknown>
  const value = root.response ?? root
  if (typeof value !== 'object' || Array.isArray(value)) return undefined
  const row = value as Record<string, unknown>
  if (
    row.offerId !== offerId ||
    typeof row.officialCreditId !== 'string' ||
    !/^[a-zA-Z0-9_.:-]{1,256}$/.test(row.officialCreditId) ||
    !Number.isSafeInteger(row.earnedPoints) ||
    Number(row.earnedPoints) < 0
  )
    return undefined
  return {
    officialCreditId: row.officialCreditId,
    earnedPoints: row.earnedPoints as number,
    verificationStatus: 'confirmed',
    evidenceSource: 'official-credit',
    submitted: true
  }
}
