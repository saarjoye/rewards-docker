import type { ReactElement } from 'react'
import {
  formatTaskPoints,
  taskPointAmountLabel,
  taskPointStateLabel,
  type TaskPointDetail
} from '../../domain/TaskPointDetail'
import { taskPointSummaries } from '../../domain/TaskPointSummary'
import { publicText } from './display'

export function TaskPointTable({ tasks }: { tasks: readonly TaskPointDetail[] }): ReactElement {
  const summaries = taskPointSummaries(tasks)
  const details = summaries.flatMap((summary) => summary.tasks)
  return (
    <div className="task-points-breakdown">
      {tasks.length === 0 ? (
        <p className="observation">暂无保存的任务积分明细</p>
      ) : (
        <>
          <table className="evidence-table task-points-table task-points-summary">
            <caption>
              任务积分明细（{summaries.length} 类 · {details.length} 项）
            </caption>
            <thead>
              <tr>
                <th>任务</th>
                <th>积分</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              {summaries.map((summary) => (
                <tr key={summary.key}>
                  <td data-label="任务">
                    <strong>{publicText(summary.displayName)}</strong>
                    {summary.tasks.some((task) => task.isQuestTask) && (
                      <small>含任务包子任务</small>
                    )}
                  </td>
                  <td data-label="积分">
                    <strong>{summary.amountLabel}</strong>
                  </td>
                  <td data-label="状态">
                    {summary.statusLabel}
                    {summary.progress && (
                      <small>
                        进度 {summary.progress.completed}/{summary.progress.total}
                      </small>
                    )}
                    {summary.reason && <small>{publicText(summary.reason)}</small>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <details className="task-points-details">
            <summary>查看具体任务与积分依据</summary>
            <table className="evidence-table task-points-table">
              <caption>具体任务（{details.length} 项）</caption>
              <thead>
                <tr>
                  <th>任务</th>
                  <th>得分明细</th>
                  <th>完成状态</th>
                </tr>
              </thead>
              <tbody>
                {details.map((task) => (
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
          </details>
        </>
      )}
      <small className="observation">总增加以余额变化为准；未确认金额不作为到账。</small>
    </div>
  )
}
