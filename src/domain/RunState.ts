import type { AccountRunStatus } from './AccountRun.js'
import type { ExecutionMode } from './RunRequest.js'

export type RunStatus =
  | 'queued'
  | 'running'
  | 'cancelling'
  | 'completed'
  | 'partial'
  | 'failed'
  | 'cancelled'
  | 'interrupted'

export interface RunSummary {
  runId: string
  localDate: string
  executionMode: ExecutionMode
  status: RunStatus
  selectedAccountIndexes: readonly number[]
  startedAt: string
  finishedAt?: string
}

export interface AccountRunSummary {
  runId: string
  accountId: string
  runAccountIndex: number
  localDate: string
  status: AccountRunStatus
  stage?: string
  message?: string
  updatedAt: string
}
