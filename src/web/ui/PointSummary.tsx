import type { ReactElement } from 'react'
import { points } from './display'

export interface PointStatistics {
  reportedTaskPoints?: number | null
  confirmedTaskPoints?: number | null
  pendingTaskPoints?: number | null
  unattributedBalanceDelta?: number | null
  overreportedTaskPoints?: number | null
  creditVerificationStatus?: string
}

export function PointSummary({ value }: { value: PointStatistics }): ReactElement {
  return (
    <>
      <dl className="balance-fields">
        <div>
          <dt>任务到账证据状态</dt>
          <dd>
            {value.creditVerificationStatus === 'confirmed'
              ? '已确认'
              : value.creditVerificationStatus === 'partial'
                ? '部分确认'
                : value.creditVerificationStatus === 'conflict'
                  ? '证据冲突'
                  : '待确认'}
          </dd>
        </div>
        <div>
          <dt>任务上报积分</dt>
          <dd>{points(value.reportedTaskPoints)}</dd>
        </div>
        <div>
          <dt>已确认到账积分</dt>
          <dd>{points(value.confirmedTaskPoints)}</dd>
        </div>
        <div>
          <dt>待确认积分</dt>
          <dd>{points(value.pendingTaskPoints)}</dd>
        </div>
        <div>
          <dt>未归属余额变化</dt>
          <dd>{points(value.unattributedBalanceDelta)}</dd>
        </div>
        <div>
          <dt>超出余额证据的上报积分</dt>
          <dd>{points(value.overreportedTaskPoints)}</dd>
        </div>
      </dl>
      <small className="observation">
        未归属余额：账户余额已增加，但暂时无法关联到唯一任务来源。
      </small>
    </>
  )
}
