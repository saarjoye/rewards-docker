import type { FieldEvidence } from '../domain/Evidence.js'
import type { TaskRecord } from '../domain/Task.js'
import type { TaskCreditEvidence } from './OfficialCredit.js'

export interface TaskActionContext {
  accountId: string
  task: TaskRecord
  signal: AbortSignal
}

export interface MutationReceipt {
  accepted: boolean
  rejected?: boolean
  observedAt: string
  safeReference?: string
  credit?: TaskCreditEvidence
}

export interface VerificationResult {
  confirmed: boolean
  progress: { completed: number; total: number | null }
  points?: FieldEvidence<number>
  reason?: string
  credit?: TaskCreditEvidence
}

export interface TaskAdapter {
  execute(context: TaskActionContext): Promise<MutationReceipt>
  verify(context: TaskActionContext): Promise<VerificationResult>
}
