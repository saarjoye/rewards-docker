import { useState } from 'react'
import type { ReactElement } from 'react'
import { clockTime, stateLabel, publicText } from './display'

export interface EvidenceRow {
  taskId: string
  kind: string
  source: string
  observedAt: string
  businessDate?: string
  balance?: number | null
  accepted?: boolean | null
  completed?: number | null
  total?: number | null
  executionState?: string | null
  confirmedPoints?: number | null
  creditKey?: string | null
}
export interface TaskSummary {
  taskId: string
  displayName: string
  status: string
  reason?: string
  accountRealtimeBalance?: number | null
  accountRealtimeBalanceSource?: string | null
  accountRealtimeBalanceAt?: string | null
  taskEarnedPoints?: number | null
  taskEarnedPointsSource?: string | null
  taskEarnedPointsStatus?: string
  taskCreditKey?: string | null
  taskProgress?: { completed: number; total: number | null }
  taskEvidence?: readonly EvidenceRow[]
  latestTaskEvidence?: EvidenceRow | null
}

export interface CreditRow {
  taskId: string
  businessDate: string
  creditKey: string
  evidenceSource: string
  confirmedPoints: number | null
  reportedPoints: number | null
  expectedPoints: number | null
}

const sourceName = (source: string): string =>
  ({
    'app-dashboard': 'App 响应',
    rsc: 'Rewards 页面响应',
    'bing-flyout': 'Bing 面板响应',
    'legacy-getuserinfo': '账户信息响应',
    'browser-response': '浏览器响应'
  })[source] ?? '来源未识别'
const kindName = (kind: string): string =>
  ({
    response: '提交回执',
    verification: '任务复核',
    execution: '执行记录'
  })[kind] ?? '观测记录'
const numeric = (value: number | null | undefined): string =>
  value === null || value === undefined || !Number.isFinite(value) ? '—' : String(value)
const detailText = (value: string) =>
  publicText(value).replace(/已观测|未取得|未匹配|待确认(?:积分)?/g, '—')

export function TaskEvidencePanel({
  tasks,
  evidence = []
}: {
  tasks: readonly TaskSummary[]
  evidence?: readonly EvidenceRow[]
  creditEvidence?: readonly CreditRow[]
}): ReactElement {
  const [kind, setKind] = useState('all')
  const groups = new Map(tasks.map((task) => [task.taskId, { task, rows: [] as EvidenceRow[] }]))
  for (const row of evidence) {
    if (!groups.has(row.taskId))
      groups.set(row.taskId, {
        task: { taskId: row.taskId, displayName: '任务名称：—', status: 'unknown' },
        rows: []
      })
    groups.get(row.taskId)?.rows.push(row)
  }
  for (const { task, rows } of groups.values()) {
    if (task.taskEvidence) rows.splice(0, rows.length, ...task.taskEvidence)
    const rank = (kind: string) => ({ verification: 3, response: 2, execution: 1 })[kind] ?? 0
    rows.sort((a, b) => rank(b.kind) - rank(a.kind) || b.observedAt.localeCompare(a.observedAt))
  }
  return (
    <div className="task-evidence-panel">
      <div className="evidence-heading">
        <h3>
          任务与证据{' '}
          <span>
            （{groups.size} 项任务 ·{' '}
            {[...groups.values()].reduce((sum, group) => sum + group.rows.length, 0)} 条记录）
          </span>
        </h3>
        <label>
          记录类型
          <select
            value={kind}
            onChange={(event) => {
              setKind(event.target.value)
            }}
          >
            <option value="all">全部记录</option>
            <option value="response">提交回执</option>
            <option value="verification">任务复核</option>
            <option value="execution">执行记录</option>
          </select>
        </label>
      </div>
      {groups.size === 0 && <p className="observation">暂无任务明细</p>}
      {[...groups.values()].map(({ task, rows }) => {
        const visible = rows.filter((row) => kind === 'all' || row.kind === kind)
        return (
          <details className="task-evidence" key={task.taskId}>
            <summary>
              <span className="evidence-task-name">{detailText(task.displayName)}</span>
              <span className="evidence-task-status">
                {detailText(stateLabel(task.status))} · {rows.length} 条证据
              </span>
            </summary>
            <div className="balance-fields">
              <p>账号实时余额：{numeric(task.accountRealtimeBalance)} 分</p>
              <p>任务到账：{numeric(task.taskEarnedPoints)} 分</p>
            </div>
            {task.taskProgress && (
              <p>
                任务进度：{numeric(task.taskProgress.completed)} /{' '}
                {numeric(task.taskProgress.total)}
              </p>
            )}
            {task.accountRealtimeBalanceAt && (
              <small>
                余额时间：{clockTime(task.accountRealtimeBalanceAt)} ·{' '}
                {sourceName(task.accountRealtimeBalanceSource ?? '')}
              </small>
            )}
            {task.reason && <p className="observation">{detailText(task.reason)}</p>}
            <div className="observation">
              <small className="evidence-identity">到账标识：{task.taskCreditKey ?? '—'}</small>
            </div>
            <p className="evidence-identity">
              任务标识：<code>{task.taskId}</code>
            </p>
            {visible.length === 0 ? (
              <p className="observation">
                {rows.length ? '当前类型没有记录' : '尚无保存的任务证据'}
              </p>
            ) : (
              <table className="evidence-table">
                <caption>任务观测账本 · Asia/Shanghai</caption>
                <thead>
                  <tr>
                    <th>观测时间</th>
                    <th>类型与来源</th>
                    <th>记录内容</th>
                    <th>到账证据</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((row, index) => (
                    <tr key={`${row.observedAt}:${row.kind}:${String(index)}`}>
                      <td data-label="观测时间">
                        <time dateTime={row.observedAt}>{clockTime(row.observedAt)}</time>
                        <small>业务日期：{row.businessDate ?? '未记录'}</small>
                      </td>
                      <td data-label="类型与来源">
                        {kindName(row.kind)}
                        <small>{sourceName(row.source)}</small>
                      </td>
                      <td data-label="记录内容">
                        <dl className="evidence-values">
                          {row.kind === 'response' && (
                            <div>
                              <dt>回执</dt>
                              <dd>
                                {row.accepted === true
                                  ? '已记录接收回执'
                                  : row.accepted === false
                                    ? '未确认接收'
                                    : '未记录回执'}
                              </dd>
                            </div>
                          )}
                          {row.executionState && (
                            <div>
                              <dt>执行状态</dt>
                              <dd>{detailText(stateLabel(row.executionState))}</dd>
                            </div>
                          )}
                          {(row.completed != null || row.total != null) && (
                            <div>
                              <dt>任务进度</dt>
                              <dd>
                                {numeric(row.completed)} / {numeric(row.total)}
                              </dd>
                            </div>
                          )}
                          <div>
                            <dt>观测余额</dt>
                            <dd>{row.balance == null ? '— 分' : `${numeric(row.balance)} 分`}</dd>
                          </div>
                        </dl>
                      </td>
                      <td data-label="到账证据">
                        {row.confirmedPoints == null
                          ? '— 分'
                          : `已确认到账 ${numeric(row.confirmedPoints)} 分`}
                        <small>到账标识：{row.creditKey ?? '—'}</small>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </details>
        )
      })}
    </div>
  )
}
