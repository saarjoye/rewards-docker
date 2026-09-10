import type { TaskRecord } from '../domain/Task.js'
import type { TaskActionContext, TaskAdapter, VerificationResult } from '../rewards/TaskAdapter.js'
import { redactText } from '../security/Redactor.js'

export type MutationLedgerState =
  | 'submission-started'
  | 'submitted'
  | 'verification-pending'
  | 'verified'
  | 'failed'

export interface MutationLedger {
  beginMutation(taskId: string, startedAt?: string): boolean
  cancelMutation(taskId: string): void
  updateMutation(
    taskId: string,
    state: Exclude<MutationLedgerState, 'submission-started'>,
    updatedAt?: string
  ): void
}

export interface ReadableMutationLedger extends MutationLedger {
  getMutationState(taskId: string): MutationLedgerState | undefined
}

export interface MutationOutcome {
  status: 'verified' | 'verification-pending' | 'failed'
  verification?: VerificationResult
  message?: string
  errorCode?: OfferFailureCode
  activationStarted?: boolean
}

export type OfferFailureCode =
  | 'offer-not-found-before-activation'
  | 'offer-activation-failed'
  | 'offer-submission-rejected'
  | 'task-verification-failed'
  | 'offer-authentication-failed'
  | 'offer-network-failed'
  | 'offer-browser-failed'
  | 'offer-invalid-destination'

export class MutationNotStartedError extends Error {
  constructor(
    message: string,
    readonly errorCode?: OfferFailureCode
  ) {
    super(message)
    this.name = 'MutationNotStartedError'
  }
}

// A missing current offer is not an execution failure; no submission has happened.
export class OfferUnavailableError extends MutationNotStartedError {
  constructor(message = 'Offer is unavailable before activation') {
    super(message, 'offer-not-found-before-activation')
  }
}

export class OfferActivationError extends Error {
  readonly errorCode = 'offer-activation-failed' as const
  constructor() {
    super('Offer activation failed; result is unknown')
  }
}

export class MutationExecutor {
  constructor(private readonly ledger: MutationLedger) {}

  async execute(
    task: TaskRecord,
    adapter: TaskAdapter,
    signal: AbortSignal
  ): Promise<MutationOutcome> {
    const context: TaskActionContext = { accountId: task.accountId, task, signal }

    if (!this.ledger.beginMutation(task.taskId)) {
      return this.verifyOnly(context, adapter)
    }

    try {
      const receipt = await adapter.execute(context)
      if (receipt.rejected === true) {
        this.ledger.updateMutation(task.taskId, 'failed')
        return {
          status: 'failed',
          errorCode: 'offer-submission-rejected',
          message: 'offer-submission-rejected',
          activationStarted: true
        }
      }
      this.ledger.updateMutation(task.taskId, receipt.accepted ? 'submitted' : 'failed')
      if (!receipt.accepted) {
        const verification = await this.verifyOnly(context, adapter)
        if (verification.status === 'verified') return verification
        return {
          ...verification,
          status: 'verification-pending',
          message: 'Mutation response was not acknowledged; read-only verification is pending'
        }
      }
      return await this.verifyOnly(context, adapter)
    } catch (error) {
      if (error instanceof MutationNotStartedError) {
        this.ledger.cancelMutation(task.taskId)
        return {
          status: error instanceof OfferUnavailableError ? 'verification-pending' : 'failed',
          message: error.errorCode ?? redactText(error.message),
          ...(error.errorCode ? { errorCode: error.errorCode } : {}),
          activationStarted: false
        }
      }
      this.ledger.updateMutation(task.taskId, 'verification-pending')
      return {
        status: 'verification-pending',
        ...(error instanceof OfferActivationError
          ? { errorCode: error.errorCode, activationStarted: true }
          : {}),
        message:
          error instanceof OfferActivationError
            ? error.errorCode
            : redactText(error instanceof Error ? error.message : 'Mutation result is unknown')
      }
    }
  }

  private async verifyOnly(
    context: TaskActionContext,
    adapter: TaskAdapter
  ): Promise<MutationOutcome> {
    try {
      const verification = await adapter.verify(context)
      const status = verification.confirmed ? 'verified' : 'verification-pending'
      this.ledger.updateMutation(context.task.taskId, status)
      return {
        status,
        verification,
        ...(verification.confirmed ? {} : { errorCode: 'task-verification-failed' as const })
      }
    } catch (error) {
      this.ledger.updateMutation(context.task.taskId, 'verification-pending')
      return {
        status: 'verification-pending',
        errorCode: 'task-verification-failed',
        message: redactText(
          error instanceof Error ? error.message : 'Read-only verification failed'
        )
      }
    }
  }
}
