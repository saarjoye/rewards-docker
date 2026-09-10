export const executionModeLabel = (mode: string): string =>
  ({ mutating: '执行任务', 'read-only': '只读检查' })[mode] ?? '—'

export const runStatusLabel = (status: string): string =>
  ({
    completed: '全部完成',
    partial: '部分完成',
    failed: '执行失败',
    running: '执行中',
    cancelled: '已取消',
    interrupted: '已中断',
    queued: '等待执行',
    cancelling: '正在停止'
  })[status] ?? '—'

export const accountStatusLabel = (status: string): string =>
  ({
    completed: '完成',
    partial: '部分完成',
    failed: '失败',
    running: '执行中',
    'action-required': '需要处理',
    cancelled: '已取消',
    interrupted: '已中断',
    queued: '等待执行'
  })[status] ?? '—'

export function taskBoundAccountState(
  state: string,
  tasks: readonly { required: boolean; status: string }[]
): string {
  if (state !== 'completed') return state
  return tasks.length > 0 &&
    tasks.filter((task) => task.required).every((task) => task.status === 'completed')
    ? 'completed'
    : 'partial'
}

export function batchStatus(
  results: readonly string[],
  expectedCount: number
): 'completed' | 'partial' | 'failed' {
  if (!results.length || results.every((status) => status === 'failed')) return 'failed'
  return results.length === expectedCount && results.every((status) => status === 'success')
    ? 'completed'
    : 'partial'
}

export function runOutcome(
  recordedStatus: string,
  accountsTotal: number,
  accounts: readonly { executionState: string; endedAt: string | null }[]
) {
  const accountsEnded = accounts.filter((account) => account.endedAt !== null).length
  const count = (status: string) =>
    accounts.filter((account) => account.executionState === status).length
  const accountsCompleted = count('completed')
  const accountsFailed = count('failed')
  const allAccountsCompleted =
    accountsTotal > 0 && accounts.length === accountsTotal && accountsCompleted === accountsTotal
  // A historical end timestamp does not supply missing account completion evidence.
  const status =
    recordedStatus === 'completed' && !allAccountsCompleted
      ? accountsTotal > 0 && accountsFailed === accountsTotal
        ? 'failed'
        : 'partial'
      : recordedStatus
  return {
    status,
    recordedStatus,
    runStatusLabel: runStatusLabel(status),
    accountsTotal,
    accountsEnded,
    accountsProcessed: accountsEnded,
    accountsCompleted,
    accountsPartial: count('partial'),
    accountsFailed,
    accountsNotCompleted: Math.max(accountsTotal, accounts.length) - accountsCompleted,
    allAccountsCompleted: recordedStatus === 'completed' && allAccountsCompleted
  }
}
