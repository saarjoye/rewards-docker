import type { FieldEvidence } from '../domain/Evidence.js'
import type { TaskRecord } from '../domain/Task.js'

export interface TaskActionContext {
  accountId: string
  task: TaskRecord
  signal: AbortSignal
}

export interface MutationReceipt {
  accepted: boolean
  observedAt: string
  safeReference?: string
}

export interface VerificationResult {
  confirmed: boolean
  progress: { completed: number; total: number | null }
  points?: FieldEvidence<number>
  reason?: string
}

export interface TaskAdapter {
  execute(context: TaskActionContext): Promise<MutationReceipt>
  verify(context: TaskActionContext): Promise<VerificationResult>
}
