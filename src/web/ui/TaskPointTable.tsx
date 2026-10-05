import type { ReactElement } from 'react'
import {
  formatTaskPoints,
  taskPointAmountLabel,
  taskPointStateLabel,
  type TaskPointDetail
} from '../../domain/TaskPointDetail'
import { publicText } from './display'

export function TaskPointTable({ tasks }: { tasks: readonly TaskPointDetail[] }): ReactElement {
  return (
    <div className="task-points-breakdown">
      {tasks.length === 0 ? (
        <p className="observation">暂无保存的任务积分明细</p>
      ) : (
        <table className="evidence-table task-points-table">
          <caption>任务积分明细（{tasks.length} 项）</caption>
          <thead>
            <tr>
              <th>任务</th>
              <th>得分明细</th>
              <th>完成状态</th>
            </tr>
          </thead>
          <tbody>
            {tasks.map((task) => (
              <tr key={`${task.businessDate ?? ''}:${task.taskId}`}>
                <td data-label="任务">
                  <strong>{publicText(task.displayName)}</strong>
                  {task.isQuestTask && <small>任务包子任务</small>}
                  {task.businessDate && <small>{task.businessDate}</small>}
                </td>
                <td data-label="得分明细">
                  <strong>{taskPointAmountLabel(task)}</strong>
                  {task.confirmedPoints !== null && task.reportedPoints !== null && (
                    <small>上报 {formatTaskPoints(task.reportedPoints)}</small>
                  )}
                  {task.expectedPoints !== null && (
                    <small>预计 {formatTaskPoints(task.expectedPoints)}</small>
                  )}
                </td>
                <td data-label="完成状态">
                  {taskPointStateLabel(task.status)}
                  {task.progress?.total != null && (
                    <small>
                      进度 {task.progress.completed}/{task.progress.total}
                    </small>
                  )}
                  {task.reason && <small>{publicText(task.reason)}</small>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <small className="observation">
        已完成表示任务状态。上报和预计积分尚未确认到账，不计入本次总增加；总增加以余额变化为准。
      </small>
    </div>
  )
}
