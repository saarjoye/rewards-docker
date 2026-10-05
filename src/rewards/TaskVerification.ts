import type { QuestTaskContext, TaskRecord } from '../domain/Task.js'
import type { QuestObservation, RewardOffer } from './RewardsModel.js'
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

/** Completed quest Links disappear; only the exact, unambiguous official task row can replace them. */
export function verifyOfficialQuestTask(
  task: TaskRecord,
  quest: QuestTaskContext,
  observation: QuestObservation
): VerificationResult {
  if (observation.parentOfferId !== quest.parentOfferId)
    return verificationFailure(task, 'task-verification-source-mismatch')
  const matches = observation.offers.filter((offer) => offer.sourceTaskId === task.sourceTaskId)
  if (matches.length) {
    if (
      matches.some(
        (offer) =>
          offer.parentOfferId !== quest.parentOfferId ||
          offer.quest?.title !== quest.title ||
          offer.quest.ariaLabel !== quest.ariaLabel ||
          offer.restrictionReason
      )
    )
      return verificationFailure(task, 'task-verification-source-mismatch')
    return verifyOfficialOffer(task, matches, 'rsc')
  }
  const rows = observation.rows.filter((row) => row.title === quest.title)
  if (!rows.length) return verificationFailure(task, 'task-not-found-during-verification')
  if (rows.length !== 1 || rows[0]?.state === 'unknown')
    return verificationFailure(task, 'task-verification-source-mismatch')
  const confirmed = rows[0]?.state === 'completed' && rows[0].actionCount === 0
  return {
    confirmed,
    progress: { completed: confirmed ? 1 : 0, total: 1 },
    credit: { evidenceSource: 'official-progress', verificationStatus: 'pending' },
    ...(confirmed
      ? {}
      : { failureCode: 'task-still-incomplete' as const, reason: 'task-still-incomplete' })
  }
}
