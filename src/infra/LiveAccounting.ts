import { balanceInterval } from './BalanceInterval.js'
import type { RunLedger } from './RunLedger.js'

export function liveAccounting(
  ledger: RunLedger,
  accountId: string,
  businessDate: string,
  runId?: string
) {
  const interval = balanceInterval(
    ledger.balances(runId, accountId, businessDate),
    runId !== undefined
  )
  const liveBalanceDelta = interval.delta
  const confirmedBalanceDelta = interval.verificationStatus === 'confirmed' ? interval.delta : null
  const liveBalanceStatus =
    liveBalanceDelta === null ? 'unavailable' : confirmedBalanceDelta !== null ? 'final' : 'live'
  const credit = ledger.credits.reconcile(accountId, liveBalanceDelta, businessDate, runId)
  // Missing evidence is not a numeric zero. These comparisons are never added to earnings.
  const unmatchedBalancePoints =
    liveBalanceDelta === null ||
    credit.confirmedTaskPoints === null ||
    credit.creditVerificationStatus === 'conflict'
      ? null
      : Math.max(0, liveBalanceDelta - credit.confirmedTaskPoints)
  const hasEvidence =
    ledger.taskEvidenceForScope(runId, accountId, businessDate) ||
    ledger.credits.rows(accountId, businessDate, runId).length > 0
  const attributionStatus =
    interval.conflicting || credit.creditVerificationStatus === 'conflict'
      ? 'conflict'
      : liveBalanceDelta === null
        ? 'unavailable'
        : (credit.overreportedTaskPoints ?? 0) > 0
          ? 'overreported'
          : (unmatchedBalancePoints ?? 0) > 0 ||
              (hasEvidence && credit.confirmedTaskPoints === null)
            ? 'unmatched'
            : liveBalanceStatus === 'live'
              ? 'live'
              : credit.confirmedTaskPoints !== null
                ? 'confirmed'
                : 'unmatched'
  return {
    ...credit,
    businessDate,
    liveBalanceDelta,
    latestBalance: interval.conflicting ? null : interval.closingBalance,
    confirmedBalanceDelta,
    liveBalanceStatus,
    unmatchedBalancePoints,
    unattributedBalancePoints: unmatchedBalancePoints,
    attributionStatus,
    statisticScope: {
      kind: runId ? 'run-account-date' : 'account-date',
      runId: runId ?? null,
      accountId,
      businessDate,
      timezone: 'Asia/Shanghai'
    },
    observedFrom: interval.observedFrom,
    observedAt: interval.observedAt,
    verificationStatus: interval.verificationStatus,
    evidenceSources: interval.evidenceSources
  }
}
