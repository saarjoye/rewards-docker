import type { CanonicalTaskType, TaskProgress } from './Task.js'
import { pointAmount, taskPointStateLabel, type TaskPointDetail } from './TaskPointDetail.js'
import { publicText } from './Presentation.js'

const moduleNames: Record<CanonicalTaskType, string> = {
  'claim-bonus-points': '领取奖励积分',
  'app-activity': 'App 活动',
  'daily-set': '每日任务',
  'special-promotion': '特殊活动',
  'more-promotion': '更多推广',
  'app-check-in': '每日签到',
  'read-to-earn': '阅读赚取',
  'punch-card': '打卡活动',
  'mobile-search': '移动搜索',
  'pc-search': 'PC 搜索',
  unknown: '其他任务'
}

export interface TaskPointSummary {
  key: string
  displayName: string
  tasks: readonly TaskPointDetail[]
  confirmedPoints: number | null
  amountLabel: string
  statusLabel: string
  progress: TaskProgress | null
  reason: string | null
}

const signedPoints = (amount: number) => `+${String(amount)} 分`
const safeSum = (values: readonly number[]): number | null => {
  if (!values.length) return null
  const total = values.reduce((sum, value) => sum + value, 0)
  return pointAmount(total)
}

function amountLabel(tasks: readonly TaskPointDetail[]): string {
  if (tasks.some((task) => task.pointsStatus === 'conflict')) return '积分证据冲突'
  const confirmed = tasks.map((task) => pointAmount(task.confirmedPoints)).filter((n) => n !== null)
  if (confirmed.length) {
    const amount = safeSum(confirmed)
    if (amount === null) return '得分未确认'
    const missing = tasks.length - confirmed.length
    return signedPoints(amount) + (missing ? `（另${String(missing)}项未确认）` : '')
  }
  const amounts = tasks.map(
    (task) => pointAmount(task.reportedPoints) ?? pointAmount(task.expectedPoints)
  )
  const known = amounts.filter((amount) => amount !== null)
  const amount = safeSum(known)
  if (amount === null) return '得分未确认'
  const reports = tasks.filter((task) => pointAmount(task.reportedPoints) !== null).length
  const source = reports === known.length ? '上报' : reports ? '上报/预计' : '预计'
  return known.length === tasks.length
    ? `${source} ${signedPoints(amount)}（未确认）`
    : `得分未确认（其中${source} ${signedPoints(amount)}）`
}

function statusLabel(tasks: readonly TaskPointDetail[]): string {
  const counts = new Map<string, number>()
  for (const task of tasks) counts.set(task.status, (counts.get(task.status) ?? 0) + 1)
  if (counts.size === 1) {
    const label = taskPointStateLabel(tasks[0]?.status ?? 'unknown')
    return label + (tasks.length > 1 ? `（${String(tasks.length)}项）` : '')
  }
  const completed = counts.get('completed') ?? 0
  const parts = completed ? [`已完成 ${String(completed)}/${String(tasks.length)} 项`] : []
  const states = [
    'failed',
    'action-required',
    'verification-pending',
    'submitted',
    'running',
    'selected',
    'discovered',
    'skipped'
  ]
  for (const state of states) {
    const count = counts.get(state)
    if (count) parts.push(`${taskPointStateLabel(state)} ${String(count)} 项`)
  }
  const unknown = tasks.filter(
    (task) => task.status !== 'completed' && !states.includes(task.status)
  ).length
  if (unknown) parts.push(`状态未记录 ${String(unknown)} 项`)
  return parts.join('，')
}

function searchProgress(tasks: readonly TaskPointDetail[]): TaskProgress | null {
  if (!tasks.every((task) => ['pc-search', 'mobile-search'].includes(task.type))) return null
  const completed: number[] = []
  const totals: number[] = []
  for (const task of tasks) {
    const progress = pointAmount(task.progress?.completed)
    const total = pointAmount(task.progress?.total)
    if (progress === null || total === null || total === 0) return null
    completed.push(progress)
    totals.push(total)
  }
  const done = safeSum(completed)
  const total = safeSum(totals)
  return done === null || total === null ? null : { completed: done, total }
}

/** A presentation-only grouping; never establishes credits or changes task state. */
export function taskPointSummaries(tasks: readonly TaskPointDetail[]): TaskPointSummary[] {
  const groups = new Map<string, TaskPointDetail[]>()
  const seen = new Set<string>()
  for (const task of tasks) {
    const identity = JSON.stringify([task.businessDate, task.taskId])
    if (seen.has(identity)) continue
    seen.add(identity)
    const key = task.type === 'unknown' ? identity : task.type
    const group = groups.get(key) ?? []
    group.push(task)
    groups.set(key, group)
  }
  const order = new Map(Object.keys(moduleNames).map((type, index) => [type, index]))
  return [...groups.entries()]
    .sort(
      ([, a], [, b]) => (order.get(a[0]?.type ?? '') ?? 11) - (order.get(b[0]?.type ?? '') ?? 11)
    )
    .map(([key, group]) => {
      const first = group[0]
      if (!first) throw new Error('Empty task summary group')
      const reasons = [
        ...new Set(
          group
            .filter((task) => task.status !== 'completed')
            .map((task) => task.reason)
            .filter((reason) => reason)
        )
      ]
      return {
        key,
        displayName: first.type === 'unknown' ? first.displayName : moduleNames[first.type],
        tasks: group,
        confirmedPoints: group.some((task) => task.pointsStatus === 'conflict')
          ? null
          : safeSum(
              group.map((task) => pointAmount(task.confirmedPoints)).filter((n) => n !== null)
            ),
        amountLabel: amountLabel(group),
        statusLabel: statusLabel(group),
        progress: searchProgress(group),
        reason:
          reasons.length === 1
            ? (reasons[0] ?? null)
            : reasons.length
              ? '多个任务原因不同，请展开查看'
              : null
      }
    })
}

const notificationSegments = new Intl.Segmenter('zh-CN', { granularity: 'grapheme' })

export function taskPointSummaryLine(
  summary: TaskPointSummary,
  earnedPoints: number | null = summary.confirmedPoints
): string | null {
  const amount = pointAmount(earnedPoints)
  if (amount === null || summary.tasks.some((task) => task.pointsStatus === 'conflict')) return null
  const compact = (text: string) => {
    const characters = Array.from(
      notificationSegments.segment(publicText(text).replace(/\s+/g, ' ').trim()),
      ({ segment }) => segment
    )
    return characters.length > 60 ? characters.slice(0, 59).join('') + '…' : characters.join('')
  }
  return `- ${compact(summary.displayName)}：${String(amount)} 分`
}
