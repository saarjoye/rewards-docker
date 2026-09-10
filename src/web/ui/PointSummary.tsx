import type { ReactElement } from 'react'
import { points, stateLabel } from './display'

export interface PointStatistics {
  reportedTaskPoints?: number | null
  confirmedTaskPoints?: number | null
  pendingTaskPoints?: number | null
  unattributedBalanceDelta?: number | null
  overreportedTaskPoints?: number | null
  creditVerificationStatus?: string
  liveBalanceDelta?: number | null
  liveBalanceStatus?: string
  confirmedBalanceDelta?: number | null
  unmatchedBalancePoints?: number | null
  unattributedBalancePoints?: number | null
  attributionStatus?: string
  statisticScope?: {
    kind: string
    runId?: string | null
    accountId?: string
    businessDate: string
    timezone: string
  }
}

export function PointSummary({ value }: { value: PointStatistics }): ReactElement {
  return (
    <>
      <dl className="balance-fields">
        <div>
          <dt>数据状态</dt>
          <dd>{stateLabel(value.attributionStatus ?? 'pending')}</dd>
        </div>
        <div>
          <dt>
            {value.statisticScope?.kind === 'account-date'
              ? '日累计已观测余额变化'
              : '本轮实时余额变化'}
          </dt>
          <dd>
            {points(value.liveBalanceDelta)} · {stateLabel(value.liveBalanceStatus ?? 'pending')}
          </dd>
        </div>
        <div>
          <dt>最终余额变化</dt>
          <dd>{points(value.confirmedBalanceDelta)}</dd>
        </div>
        <div>
          <dt>任务上报积分</dt>
          <dd>{points(value.reportedTaskPoints)}</dd>
        </div>
        <div>
          <dt>已匹配到账积分</dt>
          <dd>{points(value.confirmedTaskPoints)}</dd>
        </div>
        <div>
          <dt>任务预计积分</dt>
          <dd>{points(value.pendingTaskPoints)}</dd>
        </div>
        <div>
          <dt>未归属余额变化</dt>
          <dd>{points(value.unmatchedBalancePoints)}</dd>
        </div>
        <div>
          <dt>上报超额</dt>
          <dd>{points(value.overreportedTaskPoints)}</dd>
        </div>
      </dl>
      <small className="observation">
        {value.statisticScope
          ? `${value.statisticScope.businessDate} · ${value.statisticScope.timezone} · ${value.statisticScope.kind === 'account-date' ? '账号日累计' : '本轮账号'}`
          : '统计范围：—'}
        。未归属余额变化与上报超额是不同的比较项，不相加；— 表示没有数值证据。
      </small>
    </>
  )
}
