import type { ReactElement } from 'react'
import {
  formatTaskPoints,
  taskPointStateLabel,
  type TaskPointDetail
} from '../../domain/TaskPointDetail'
import { friendlyFailureReason, friendlyTaskDisplayName, taskTypeInfo } from './display'

export interface TaskPointCandidate {
  taskId: string
  displayName?: string | null | undefined
  status: string
  type?: string | null | undefined
  progress?: { completed: number; total: number | null } | null | undefined
  taskProgress?: { completed: number; total: number | null } | null | undefined
  confirmedPoints?: number | null | undefined
  taskEarnedPoints?: number | null | undefined
  reportedPoints?: number | null | undefined
  expectedPoints?: number | null | undefined
  taskPoints?: {
    confirmedPoints?: number | null | undefined
    reportedPoints?: number | null | undefined
    expectedPoints?: number | null | undefined
  } | null | undefined
}

export function resolveTaskEarnedPoints(task: TaskPointCandidate): number | null {
  const confirmed = task.confirmedPoints ?? task.taskPoints?.confirmedPoints ?? task.taskEarnedPoints
  if (confirmed !== null && confirmed !== undefined && confirmed >= 0) {
    return confirmed
  }
  const reported = task.reportedPoints ?? task.taskPoints?.reportedPoints
  if (reported !== null && reported !== undefined && reported >= 0) {
    return reported
  }
  const progress = task.progress ?? task.taskProgress
  const isSearch =
    task.type === 'search' ||
    task.type === 'pc-search' ||
    task.type === 'mobile-search' ||
    task.taskId.includes('search') ||
    (task.displayName != null && task.displayName.includes('搜索'))
  if (isSearch && progress?.completed != null && progress.completed >= 0) {
    return progress.completed
  }
  const isRead =
    task.type === 'read-to-earn' ||
    task.taskId.includes('read') ||
    (task.displayName != null && task.displayName.includes('阅读'))
  if (isRead && progress?.completed != null && progress.completed >= 0) {
    return progress.completed
  }
  const expected = task.expectedPoints ?? task.taskPoints?.expectedPoints
  if (expected !== null && expected !== undefined && expected >= 0) {
    if (task.status === 'completed' || (progress?.total != null && progress.completed === progress.total)) {
      return expected
    }
  }
  if (
    task.displayName &&
    (task.status === 'completed' || (progress?.total != null && progress.completed === progress.total))
  ) {
    const match = /(?:\+|赚取|获得)\s*(\d+)\s*(?:分|points)?/i.exec(task.displayName)
    if (match?.[1]) {
      const parsed = parseInt(match[1], 10)
      if (Number.isSafeInteger(parsed) && parsed > 0) return parsed
    }
  }
  if (task.status === 'completed') {
    return expected ?? 0
  }
  if (task.status === 'skipped') {
    return 0
  }
  return null
}

export function TaskPointTable({ tasks }: { tasks: readonly TaskPointDetail[] }): ReactElement {
  const visibleTasks =
    tasks.length > 1
      ? tasks.filter((t) => {
          if (t.taskId.startsWith('category-')) return false
          if (
            t.status === 'skipped' &&
            (!t.progress || t.progress.completed === 0 || t.progress.total === 0 || t.progress.total === null) &&
            t.confirmedPoints === null &&
            (!t.reason || t.reason.includes('未发现'))
          ) {
            return false
          }
          const earned = resolveTaskEarnedPoints(t)
          const isZeroPlaceholder =
            (earned === null || earned === 0) &&
            t.progress?.completed === 0 &&
            (t.status === 'skipped' || t.status === 'discovered' || t.status === 'unknown') &&
            !t.reason
          if (isZeroPlaceholder) return false
          return true
        })
      : tasks

  return (
    <div className="task-points-breakdown">
      {visibleTasks.length === 0 ? (
        <p className="observation">暂无任务明细记录</p>
      ) : (
        <table className="task-points-table task-pure-table">
          <colgroup>
            <col className="col-task-name" />
            <col className="col-task-progress" />
            <col className="col-task-points" />
          </colgroup>
          <thead>
            <tr>
              <th className="th-task-name">任务名称</th>
              <th className="th-task-progress">执行进度</th>
              <th className="th-task-points">获得积分</th>
            </tr>
          </thead>
          <tbody>
            {visibleTasks.map((task) => {
              const typeInfo = taskTypeInfo(task.type)
              const earned = resolveTaskEarnedPoints(task)
              const failureText = task.reason ? friendlyFailureReason(task.reason) : null
              const displayName = friendlyTaskDisplayName(task)

              return (
                <tr key={`${task.businessDate ?? ''}:${task.taskId}`}>
                  <td data-label="任务名称" className="td-task-name">
                    <div className="task-name-cell">
                      <span className="task-icon">{typeInfo.icon}</span>
                      <div className="task-name-content">
                        <div className="task-title-row">
                          <strong className="task-title-text">{displayName}</strong>
                          <span className={`task-state-badge state-${task.status}`}>
                            {taskPointStateLabel(task.status)}
                          </span>
                        </div>
                        {task.isQuestTask && <small className="quest-tag">任务包子任务</small>}
                        {failureText && (
                          <small className="task-reason-tip">⚠️ {failureText}</small>
                        )}
                      </div>
                    </div>
                  </td>
                  <td data-label="执行进度" className="td-task-progress">
                    {task.progress?.total != null ? (
                      <span className="task-progress-num">
                        {task.progress.completed}/{task.progress.total}
                      </span>
                    ) : task.status === 'completed' ? (
                      <span className="task-progress-num">已达标</span>
                    ) : (
                      <span className="task-progress-num">{taskPointStateLabel(task.status)}</span>
                    )}
                  </td>
                  <td data-label="获得积分" className="td-task-points">
                    {earned !== null && earned > 0 ? (
                      <strong className="point-gain-num">{formatTaskPoints(earned)}</strong>
                    ) : (
                      <span className="point-zero-num">0 分</span>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </div>
  )
}
