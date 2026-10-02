import type { TaskRecord } from '../domain/Task.js'
import type { RewardOffer } from './RewardsModel.js'
import type { TaskVerificationFailureCode, VerificationResult } from './TaskAdapter.js'

export function verificationFailure(
  task: TaskRecord,
  failureCode: TaskVerificationFailureCode
): VerificationResult {
  return { confirmed: false, progress: task.progress, failureCode, reason: failureCode }
}

export function verificationReadFailure(error: unknown): TaskVerificationFailureCode {
  const text = error instanceof Error ? error.message : ''
  return (error instanceof Error && error.name === 'TimeoutError') ||
    /timeout|timed out|deadline exhausted|deadline expired/i.test(text)
    ? 'task-verification-timeout'
    : 'task-verification-unavailable'
}

/** Bind a completion observation to exactly one task in the source being read. */
export function verifyOfficialOffer(
  task: TaskRecord,
  offers: readonly RewardOffer[],
  expectedSource: RewardOffer['source']
): VerificationResult {
  const matches = offers.filter((offer) => offer.sourceTaskId === task.sourceTaskId)
  if (!matches.length) return verificationFailure(task, 'task-not-found-during-verification')
  const offer = matches[0]
  if (matches.length !== 1 || !offer || offer.source !== expectedSource || offer.type !== task.type)
    return verificationFailure(task, 'task-verification-source-mismatch')
  return {
    confirmed: offer.complete,
    progress: { completed: offer.completed, total: offer.total },
    credit: {
      evidenceSource: 'official-progress',
      verificationStatus: 'pending',
      ...(offer.expectedPoints === undefined ? {} : { expectedPoints: offer.expectedPoints })
    },
    ...(offer.complete
      ? {}
      : { failureCode: 'task-still-incomplete' as const, reason: 'task-still-incomplete' })
  }
}
