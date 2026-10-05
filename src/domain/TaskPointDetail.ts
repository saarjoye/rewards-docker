import type { CanonicalTaskType, TaskProgress, TaskRecord } from './Task.js'
import { publicText } from './Presentation.js'

export interface TaskPointInput {
  taskId: string
  displayName: string
  status: string
  type?: CanonicalTaskType
  localDate?: string
  reason?: string
  quest?: TaskRecord['quest']
  progress?: TaskProgress
  taskProgress?: TaskProgress
  reportedPoints?: number
  expectedPoints?: number
  taskEarnedPoints?: number | null
  taskEarnedPointsSource?: string | null
  taskPointsConflict?: boolean
}

export interface TaskPointCredit {
  taskId: string
  businessDate: string
  creditKey: string
  evidenceSource: string
  confirmedPoints: number | null
  reportedPoints: number | null
  expectedPoints: number | null
  conflict?: boolean
}

export interface TaskPointDetail {
  taskId: string
  businessDate: string | null
  displayName: string
  type: CanonicalTaskType
  status: string
  reason: string | null
  progress: TaskProgress | null
  isQuestTask: boolean
  confirmedPoints: number | null
  confirmedSource: string | null
  reportedPoints: number | null
  expectedPoints: number | null
  pointsStatus: 'confirmed' | 'unconfirmed' | 'conflict'
}

export function pointAmount(value: number | null | undefined): number | null {
  return value !== null && value !== undefined && Number.isSafeInteger(value) && value >= 0
    ? value
    : null
}

const singleAmount = (values: readonly (number | null | undefined)[]): number | null => {
  const known = new Set(values.map(pointAmount).filter((value) => value !== null))
  return known.size === 1 ? ([...known][0] ?? null) : null
}

/** Display existing evidence only. Completion and expected values never establish a credit. */
export function taskPointDetail(
  task: TaskPointInput,
  evidence: readonly TaskPointCredit[] = []
): TaskPointDetail {
  const rows = evidence.filter(
    (row) => row.taskId === task.taskId && (!task.localDate || row.businessDate === task.localDate)
  )
  const byKey = new Map<string, TaskPointCredit[]>()
  for (const row of rows) {
    const group = byKey.get(row.creditKey) ?? []
    group.push(row)
    byKey.set(row.creditKey, group)
  }
  const conflict =
    task.taskPointsConflict === true ||
    rows.some((row) => row.conflict) ||
    [...byKey.values()].some(
      (group) =>
        new Set(
          group.map((row) => pointAmount(row.confirmedPoints)).filter((value) => value !== null)
        ).size > 1
    )
  let confirmedPoints = pointAmount(task.taskEarnedPoints)
  let confirmedSource = confirmedPoints === null ? null : (task.taskEarnedPointsSource ?? null)
  // Explicit null from the server is authoritative; raw receipts cannot revive rejected attribution.
  if (task.taskEarnedPoints === undefined && !conflict) {
    for (const source of ['official-credit', 'official-progress', 'isolated-balance']) {
      const amounts = [...byKey.values()]
        .map((group) =>
          singleAmount(
            group.filter((row) => row.evidenceSource === source).map((row) => row.confirmedPoints)
          )
        )
        .filter((value) => value !== null)
      if (amounts.length) {
        confirmedPoints = pointAmount(amounts.reduce((sum, value) => sum + value, 0))
        confirmedSource = confirmedPoints === null ? null : source
        break
      }
    }
  }
  if (conflict) {
    confirmedPoints = null
    confirmedSource = null
  }
  return {
    taskId: task.taskId,
    businessDate: task.localDate ?? null,
    displayName: task.displayName,
    type: task.type ?? 'unknown',
    status: task.status,
    reason: task.reason ?? null,
    progress: task.taskProgress ?? task.progress ?? null,
    isQuestTask: Boolean(task.quest),
    confirmedPoints,
    confirmedSource,
    reportedPoints:
      pointAmount(task.reportedPoints) ?? singleAmount(rows.map((row) => row.reportedPoints)),
    expectedPoints:
      pointAmount(task.expectedPoints) ?? singleAmount(rows.map((row) => row.expectedPoints)),
    pointsStatus: conflict ? 'conflict' : confirmedPoints === null ? 'unconfirmed' : 'confirmed'
  }
}

export function taskPointStateLabel(state: string): string {
  return (
    {
      discovered: '待执行',
      selected: '已选择',
      running: '执行中',
      submitted: '已提交',
      'verification-pending': '待复核',
      completed: '已完成',
      skipped: '已跳过',
      failed: '失败',
      'action-required': '需要人工处理',
      unknown: '状态未记录'
    }[state] ?? '状态未记录'
  )
}

export function taskPointAmountLabel(detail: TaskPointDetail): string {
  if (detail.pointsStatus === 'conflict') return '积分证据冲突'
  if (detail.confirmedPoints !== null) return `已确认 ${formatTaskPoints(detail.confirmedPoints)}`
  if (detail.reportedPoints !== null)
    return `上报 ${formatTaskPoints(detail.reportedPoints)}，到账未确认`
  if (detail.expectedPoints !== null)
    return `预计 ${formatTaskPoints(detail.expectedPoints)}，到账未确认`
  return '得分未确认'
}

export function formatTaskPoints(value: number): string {
  return `${value > 0 ? '+' : ''}${String(value)} 分`
}

export function taskPointNotificationLine(detail: TaskPointDetail): string {
  const progress =
    detail.progress?.total != null
      ? ` | 进度 ${String(detail.progress.completed)}/${String(detail.progress.total)}`
      : ''
  const reason = detail.reason ? `：${publicText(detail.reason).replace(/\s+/g, ' ')}` : ''
  return `- ${publicText(detail.displayName).replace(/\s+/g, ' ')}：${taskPointAmountLabel(detail)} | ${taskPointStateLabel(detail.status)}${progress}${reason}`
}
