import type { EvidenceSource } from './Evidence.js'

export type CanonicalTaskType =
  | 'claim-bonus-points'
  | 'app-activity'
  | 'daily-set'
  | 'special-promotion'
  | 'more-promotion'
  | 'app-check-in'
  | 'read-to-earn'
  | 'punch-card'
  | 'mobile-search'
  | 'pc-search'
  | 'unknown'

export type TaskStatus =
  | 'discovered'
  | 'selected'
  | 'running'
  | 'submitted'
  | 'verification-pending'
  | 'completed'
  | 'skipped'
  | 'failed'
  | 'action-required'
  | 'unknown'

export interface TaskProgress {
  completed: number
  total: number | null
}

export type SearchState =
  | 'search-submitted'
  | 'progress-confirmed'
  | 'progress-pending'
  | 'counter-unavailable'
  | 'failed'

export function searchStateLabel(state: SearchState): string {
  return {
    'search-submitted': '搜索已提交',
    'progress-confirmed': '进度已增长',
    'progress-pending': '搜索进度尚未更新',
    'counter-unavailable': '搜索额度暂无有效数据',
    failed: '搜索读取或执行失败'
  }[state]
}

export interface SearchEvent {
  eventId: string
  kind: 'submission' | 'observation'
  state: SearchState
  reason: string
  source: string
  availability: string
  completed: number | null
  total: number | null
  remaining: number | null
  observedAt: string
  durationMs: number
  usedFallback: boolean | null
  attempt: number
  submittedCount: number
  unknownSubmissionCount: number
  lastConfirmedCompleted: number
  lastConfirmedTotal: number | null
  canContinue: boolean
  retryReason?: string
}

export interface TaskRecord {
  searchObservation?: {
    runId: string
    submittedCount: number
    unknownSubmissionCount: number
    awaitingProgress: boolean
    completed: number
    total: number | null
    observedAt: string | null
    result: string
    recoveryAttemptedRunId?: string
    state?: SearchState
    canContinue?: boolean
    lastEvent?: SearchEvent
  }
  taskId: string
  accountId: string
  localDate: string
  sourceTaskId: string
  type: CanonicalTaskType
  source: EvidenceSource
  displayName: string
  executable: boolean
  required: boolean
  status: TaskStatus
  progress: TaskProgress
  reason?: string
  updatedAt: string
  reportedPoints?: number
  expectedPoints?: number
  identityStable?: boolean
}

export interface TaskCountSummary {
  discovered: number
  executable: number
  completed: number
  skipped: number
  failed: number
  verificationPending: number
  actionRequired: number
  unknown: number
}

export function createTaskId(accountId: string, localDate: string, sourceTaskId: string): string {
  if (!accountId || !localDate || !sourceTaskId) {
    throw new TypeError('Task identity fields must not be empty')
  }
  return `${accountId}:${localDate}:${sourceTaskId}`
}

export function summarizeTasks(tasks: readonly TaskRecord[]): TaskCountSummary {
  const summary: TaskCountSummary = {
    discovered: tasks.length,
    executable: 0,
    completed: 0,
    skipped: 0,
    failed: 0,
    verificationPending: 0,
    actionRequired: 0,
    unknown: 0
  }

  for (const task of tasks) {
    if (task.executable) summary.executable += 1
    if (task.status === 'completed') summary.completed += 1
    if (task.status === 'skipped') summary.skipped += 1
    if (task.status === 'failed') summary.failed += 1
    if (task.status === 'verification-pending') summary.verificationPending += 1
    if (task.status === 'action-required') summary.actionRequired += 1
    if (task.status === 'unknown' || task.type === 'unknown') summary.unknown += 1
  }

  return summary
}
