import type { FieldEvidence } from './Evidence.js'
import type { TaskRecord } from './Task.js'

export type AccountRunStatus =
  | 'queued'
  | 'running'
  | 'action-required'
  | 'failed'
  | 'partial'
  | 'success'

export interface AccountRunSnapshot {
  accountId: string
  runAccountIndex: number
  status: AccountRunStatus
  tasks: readonly TaskRecord[]
  finalBalance?: FieldEvidence<number>
}

export function aggregateAccountStatus(
  tasks: readonly TaskRecord[],
  finalBalance?: FieldEvidence<number>
): AccountRunStatus {
  if (tasks.some((task) => task.status === 'action-required')) return 'action-required'
  if (tasks.some((task) => task.status === 'failed')) return 'failed'

  const incomplete = tasks.some((task) =>
    ['discovered', 'selected', 'running', 'submitted', 'verification-pending', 'unknown'].includes(
      task.status
    )
  )
  const hasUnknownTask = tasks.some((task) => task.type === 'unknown')
  const balanceConfirmed =
    finalBalance?.availability === 'valid' &&
    Number.isSafeInteger(finalBalance.value) &&
    (finalBalance.value ?? -1) >= 0

  if (incomplete || hasUnknownTask || !balanceConfirmed) return 'partial'
  return 'success'
}
