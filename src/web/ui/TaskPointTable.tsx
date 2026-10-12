import type { ReactElement } from 'react'
import {
  formatTaskPoints,
  taskPointStateLabel,
  type TaskPointDetail
} from '../../domain/TaskPointDetail'
import { StatusTag } from './UiKit'
import { publicText, friendlyFailureReason, taskTypeInfo } from './display'

export function TaskPointTable({ tasks }: { tasks: readonly TaskPointDetail[] }): ReactElement {
  return (
    <div className="task-points-breakdown">
      {tasks.length === 0 ? (
        <p className="observation">暂无任务明细记录</p>
      ) : (
        <table className="evidence-table task-points-table task-pure-table">
          <thead>
            <tr>
              <th>任务名称</th>
              <th>执行进度</th>
              <th>获得积分</th>
              <th>完成状态</th>
            </tr>
          </thead>
          <tbody>
            {tasks.map((task) => {
              const typeInfo = taskTypeInfo(task.type)
              const earned =
                task.confirmedPoints !== null
                  ? task.confirmedPoints
                  : task.status === 'completed'
                    ? (task.reportedPoints ?? task.expectedPoints ?? null)
                    : null
              const failureText = task.reason ? friendlyFailureReason(task.reason) : null

              return (
                <tr key={`${task.businessDate ?? ''}:${task.taskId}`}>
                  <td data-label="任务名称">
                    <div className="task-name-cell">
                      <span className="task-icon">{typeInfo.icon}</span>
                      <div>
                        <strong>{publicText(task.displayName || typeInfo.label)}</strong>
                        {task.isQuestTask && <small className="quest-tag">任务包子任务</small>}
                      </div>
                    </div>
                  </td>
                  <td data-label="执行进度">
                    {task.progress?.total != null ? (
                      <span className="task-progress-num">
                        {task.progress.completed}/{task.progress.total}
                      </span>
                    ) : task.status === 'completed' ? (
                      <span className="task-progress-num">已达标</span>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td data-label="获得积分">
                    {earned !== null && earned > 0 ? (
                      <strong className="point-gain-num">{formatTaskPoints(earned)}</strong>
                    ) : earned === 0 ? (
                      <span className="point-zero-num">0 分</span>
                    ) : (
                      <span className="point-pending-num">—</span>
                    )}
                  </td>
                  <td data-label="完成状态">
                    <div className="task-status-cell">
                      <StatusTag
                        value={task.status}
                        label={taskPointStateLabel(task.status)}
                      />
                      {failureText && (
                        <small className="task-reason-tip">⚠️ {failureText}</small>
                      )}
                    </div>
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
