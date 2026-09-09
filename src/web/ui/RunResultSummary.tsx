import { executionModeLabel, runStatusLabel } from '../../domain/RunOutcome'

export interface RunResultFields {
  executionMode: string
  status: string
  accountsTotal: number
  accountsEnded?: number
  accountsCompleted?: number
  accountsPartial?: number
  accountsFailed?: number
  accountsNotCompleted?: number
}

export function RunResultSummary({ run }: { run: RunResultFields }) {
  const number = (value?: number) => (value === undefined ? '—' : String(value))
  return (
    <dl className="balance-fields run-result-summary">
      <div>
        <dt>模式</dt>
        <dd>{executionModeLabel(run.executionMode)}</dd>
      </div>
      <div>
        <dt>运行状态</dt>
        <dd>{runStatusLabel(run.status)}</dd>
      </div>
      <div>
        <dt>已结束账号</dt>
        <dd>
          {number(run.accountsEnded)}/{run.accountsTotal}
        </dd>
      </div>
      <div>
        <dt>完全完成账号</dt>
        <dd>
          {number(run.accountsCompleted)}/{run.accountsTotal}
        </dd>
      </div>
      <div>
        <dt>部分完成账号</dt>
        <dd>{number(run.accountsPartial)}</dd>
      </div>
      <div>
        <dt>失败账号</dt>
        <dd>{number(run.accountsFailed)}</dd>
      </div>
      <div>
        <dt>未完全完成账号</dt>
        <dd>{number(run.accountsNotCompleted)}</dd>
      </div>
    </dl>
  )
}
