import { useState, useEffect, type ReactElement } from 'react'
import { Card } from 'tdesign-react/es/card/index.js'
import { DatePicker } from 'tdesign-react/es/date-picker/index.js'
import { Empty } from 'tdesign-react/es/empty/index.js'
import { Pagination } from 'tdesign-react/es/pagination/index.js'
import { Switch } from 'tdesign-react/es/switch/index.js'
import { AddIcon, DeleteIcon } from 'tdesign-icons-react'
import type { AccountSummary, StatePayload } from './App'
import { Button, DataTable, Field, PageHeader, SelectField, StatusTag } from './UiKit'
import { taskFailure } from '../../domain/Presentation'
import { TaskPointTable } from './TaskPointTable'
import { RunResultSummary } from './RunResultSummary'
import { runStatusLabel, executionModeLabel } from '../../domain/RunOutcome'
import { clockTime, duration, points, publicText, stateLabel } from './display'


function MidnightCountdown(): ReactElement {
  const [timeLeft, setTimeLeft] = useState({ hours: 0, minutes: 0, seconds: 0 })

  useEffect(() => {
    const update = () => {
      const now = new Date()
      const utc = now.getTime() + now.getTimezoneOffset() * 60000
      const shanghaiTime = new Date(utc + 3600000 * 8)
      const midnight = new Date(shanghaiTime)
      midnight.setHours(24, 0, 0, 0)
      const diff = Math.max(0, midnight.getTime() - shanghaiTime.getTime())
      const hours = Math.floor(diff / 3600000)
      const minutes = Math.floor((diff % 3600000) / 60000)
      const seconds = Math.floor((diff % 60000) / 1000)
      setTimeLeft({ hours, minutes, seconds })
    }
    update()
    const interval = setInterval(update, 1000)
    return () => { clearInterval(interval); }
  }, [])

  const pad = (n: number) => String(n).padStart(2, '0')

  return (
    <div className="midnight-countdown" title="距离次日0点 (Asia/Shanghai) 微软积分与任务额度刷新">
      <span className="countdown-label">距次日刷新:</span>
      <span className="countdown-digits">
        {pad(timeLeft.hours)}:{pad(timeLeft.minutes)}:{pad(timeLeft.seconds)}
      </span>
    </div>
  )
}

export interface TrendDay {
  date: string
  totalGained: number
  totalPoints: number
  accounts: Array<{
    accountId: string
    initialPoints: number | null
    finalPoints: number | null
    gainedPoints: number | null
    status: string
    balanceConfirmed: boolean
  }>
}

function PointsTrendCard(): ReactElement {
  const [days, setDays] = useState<7 | 30>(7)
  const [trend, setTrend] = useState<TrendDay[]>([])

  useEffect(() => {
    let active = true
    fetch(`/api/points/history?days=${String(days)}`)
      .then(async (res) => (res.ok ? ((await res.json()) as { trend: TrendDay[] }) : Promise.reject(new Error("fetch failed"))))
      .then((data) => {
        if (active && Array.isArray(data.trend)) {
          setTrend(data.trend)
        }
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [days])

  const totalGainedSum = trend.reduce((sum, d) => sum + d.totalGained, 0)
  const maxGained = Math.max(1, ...trend.map((d) => d.totalGained))

  return (
    <Card
      bordered={false}
      title="积分增长趋势"
      subtitle={`全账号最近 ${String(days)} 天收益波动统计 · 柱条指示当日净增`}
      actions={
        <div className="trend-toggle-group">
          <button
            type="button"
            className={`trend-toggle-btn ${days === 7 ? 'active' : ''}`}
            onClick={() => { setDays(7); }}
          >
            7 天
          </button>
          <button
            type="button"
            className={`trend-toggle-btn ${days === 30 ? 'active' : ''}`}
            onClick={() => { setDays(30); }}
          >
            30 天
          </button>
        </div>
      }
    >
      <div className="trend-summary-row">
        <span className="muted">区间总净增:</span>
        <strong className="trend-summary-gained">+{String(totalGainedSum)} 分</strong>
        <span className="muted">日均增长:</span>
        <strong>+{String(trend.length > 0 ? Math.round(totalGainedSum / trend.length) : 0)} 分/天</strong>
      </div>

      {trend.length === 0 ? (
        <Empty description="暂无历史趋势数据，执行日常任务或体检后将自动绘制" />
      ) : (
        <div className="trend-bar-chart">
          {trend.map((day) => {
            const heightPercent = Math.max(8, Math.round((day.totalGained / maxGained) * 100))
            const shortDate = day.date.slice(5)
            return (
              <div key={day.date} className="trend-bar-col" title={`${day.date}: +${String(day.totalGained)} 分`}>
                <div className="trend-bar-container">
                  <span className="trend-bar-tooltip">
                    {day.date}
                    <br />
                    +{String(day.totalGained)} 分
                  </span>
                  <div
                    className="trend-bar-fill"
                    style={{ height: `${String(heightPercent)}%` }}
                  />
                </div>
                <span className="trend-bar-label">{shortDate}</span>
              </div>
            )
          })}
        </div>
      )}
    </Card>
  )
}

export function Overview({
  state,
  openRun,
  onCalibrateAccount
}: {
  state: StatePayload | undefined
  openRun: (id: string) => void
  onCalibrateAccount?: (accountId: string) => void
}): ReactElement {
  const active = state?.runs.find((row) => row.runId === state.activeRunId)

  const todayDeltas =
    state?.today
      .map((d) => d.dailyBalanceDelta)
      .filter((v): v is number => typeof v === 'number' && Number.isFinite(v)) ?? []
  const totalDailyGain =
    todayDeltas.length > 0 ? todayDeltas.reduce((acc, v) => acc + v, 0) : null

  const totalPointsArr =
    state?.today
      .map((d) => d.accountTotalPoints)
      .filter((v): v is number => typeof v === 'number' && Number.isFinite(v)) ?? []
  const aggregateTotalPoints =
    totalPointsArr.length > 0 ? totalPointsArr.reduce((acc, v) => acc + v, 0) : null

  const discovered = state?.taskSummary.discovered ?? 0
  const completed = state?.taskSummary.completed ?? 0
  const completionRate =
    discovered > 0 ? Math.round((completed / discovered) * 100) : state ? 0 : null

  const attentionAccounts =
    state?.today.filter((d) =>
      ['action-required', 'failed', 'verification-pending', 'partial'].includes(
        d.verificationStatus
      )
    ).length ?? 0

  return (
    <>
      <PageHeader title="概览" description="运行进度、账号余额与需要处理的事项" actions={<MidnightCountdown />} />
      <section className="overview-hero-grid" aria-label="多账号聚合总览">
        <div className="hero-stat-card hero-card-gain">
          <div className="hero-stat-header">
            <span className="hero-stat-label">今日积分总增量</span>
            <span className="hero-stat-badge gain-badge">全账号净增</span>
          </div>
          <strong className="hero-stat-value gain-value">
            {totalDailyGain !== null ? points(totalDailyGain) : '—'}
          </strong>
          <span className="hero-stat-subtext muted">
            已统计 {todayDeltas.length}/{state?.today.length ?? 0} 个有效观测账号
          </span>
        </div>

        <div className="hero-stat-card hero-card-total">
          <div className="hero-stat-header">
            <span className="hero-stat-label">全账号积分总资产</span>
            <span className="hero-stat-badge asset-badge">当前结余</span>
          </div>
          <strong className="hero-stat-value total-value">
            {aggregateTotalPoints !== null ? `${String(aggregateTotalPoints)} 分` : '—'}
          </strong>
          <span className="hero-stat-subtext muted">
            覆盖 {totalPointsArr.length}/{state?.today.length ?? 0} 个账号最新余额
          </span>
        </div>

        <div className="hero-stat-card hero-card-progress">
          <div className="hero-stat-header">
            <span className="hero-stat-label">今日任务达成率</span>
            <span className="hero-stat-badge progress-badge">
              {completionRate !== null ? `${String(completionRate)}%` : '—'}
            </span>
          </div>
          <strong className="hero-stat-value progress-value">
            {completionRate !== null ? `${String(completionRate)}%` : '读取中'}
          </strong>
          <span className="hero-stat-subtext muted">
            {completed}/{discovered} 项任务执行达标
          </span>
        </div>

        <div className="hero-stat-card hero-card-health">
          <div className="hero-stat-header">
            <span className="hero-stat-label">账号运行健康度</span>
            <span
              className={`hero-stat-badge ${attentionAccounts === 0 ? 'health-good' : 'health-warn'}`}
            >
              {attentionAccounts === 0 ? '全状态健康' : `${String(attentionAccounts)} 个需关注`}
            </span>
          </div>
          <strong
            className={`hero-stat-value ${attentionAccounts === 0 ? 'health-value-good' : 'health-value-warn'}`}
          >
            {attentionAccounts === 0 ? '全部正常' : `${String(attentionAccounts)} 待处理`}
          </strong>
          <span className="hero-stat-subtext muted">
            {attentionAccounts === 0
              ? '无异常、无阻塞、无未决'
              : '含失败、受阻或待复核账号'}
          </span>
        </div>
      </section>
      <section className="metrics" aria-label="任务统计">
        {[
          ['已发现任务', state?.taskSummary.discovered],
          ['执行已结束', state?.taskSummary.completed],
          ['待复核', state?.taskSummary.verificationPending],
          [
            '失败 / 需处理',
            state ? state.taskSummary.failed + state.taskSummary.actionRequired : undefined
          ]
        ].map(([label, value]) => (
          <Card key={String(label)} bordered={false}>
            <span className="muted">{label}</span>
            <strong className="metric-value">{value ?? '读取中'}</strong>
          </Card>
        ))}
      </section>
      <PointsTrendCard />
      <Card bordered={false} title="当前运行" className="active-run-card">
        {active ? (
          <div className="active-run">
            <div>
              <StatusTag value={active.status} label={runStatusLabel(active.status)} />
              <RunResultSummary run={active} />
              <p>
                已结束 {active.accountsProcessed}/{active.accountsTotal} 个账号
              </p>
              <small className="muted">
                {clockTime(active.startedAt)} —{' '}
                {active.finishedAt ? clockTime(active.finishedAt) : '执行中'} ={' '}
                {duration(active.startedAt, active.finishedAt ?? new Date().toISOString())}
              </small>
            </div>
            <div>
              <span className="muted">本次余额变化</span>
              <strong className="balance-number">{points(active.liveBalanceDelta)}</strong>
              <StatusTag value={active.liveBalanceStatus} />
              <Button
                variant="outline"
                onClick={() => {
                  openRun(active.runId)
                }}
              >
                查看当前运行
              </Button>
            </div>
          </div>
        ) : (
          <p className="muted">当前没有运行中的任务。通过“新建运行”选择账号和执行方式。</p>
        )}
      </Card>
      <Card
        bordered={false}
        title="账号积分"
        subtitle="今日得分按上海日期统计 · 账号总分随余额读取更新"
      >
        {!state ? (
          <Empty description="读取中" />
        ) : !state.today.length ? (
          <Empty description="暂无余额观测" />
        ) : (
          <div className="balance-cards">
            {state.today.map((day) => (
              <article className="balance-card" key={day.accountId}>
                <div className="section-heading">
                  <strong>{day.accountLabel}</strong>
                  <StatusTag value={day.verificationStatus} />
                </div>
                <AccountPointTotals
                  today={day.dailyBalanceDelta}
                  total={day.accountTotalPoints ?? null}
                  expected={day.expectedDailyPoints ?? null}
                  conflict={day.verificationStatus === 'conflict'}
                  todaySource={day.dailyBalanceDeltaSource ?? null}
                  totalSource={day.accountTotalPointsSource ?? null}
                />
                <p className="muted">余额更新：{clockTime(day.accountTotalPointsAt)}</p>
                {day.verificationStatus === 'conflict' && onCalibrateAccount && (
                  <div style={{ marginTop: '8px', marginBottom: '8px' }}>
                    <Button
                      variant="outline"
                      theme="primary"
                      size="small"
                      onClick={() => {
                        onCalibrateAccount(day.accountId)
                      }}
                    >
                      校准真实积分并回填
                    </Button>
                  </div>
                )}
                <details className="account-task-details">
                  <summary>查看任务明细</summary>
                  <TaskPointTable tasks={day.taskPointDetails ?? []} />
                </details>
              </article>
            ))}
          </div>
        )}
      </Card>
      <Card bordered={false} title="最近运行">
        <DataTable
          rows={state?.runs.slice(0, 5) ?? []}
          rowKey={(row) => row.runId}
          empty="暂无运行记录"
          columns={[
            {
              key: 'time',
              title: '执行时间',
              cell: (row) => (
                <>
                  <span>{clockTime(row.startedAt)}</span>
                  <small className="muted">
                    {clockTime(row.finishedAt)} ={' '}
                    {duration(
                      row.startedAt,
                      row.finishedAt ??
                        (row.runId === state?.activeRunId ? new Date().toISOString() : null)
                    )}
                  </small>
                </>
              )
            },
            {
              key: 'progress',
              title: '账号进度',
              cell: (row) => (
                <>
                  <span>
                    已结束 {row.accountsProcessed}/{row.accountsTotal}
                  </span>
                  <small>
                    完全完成 {row.accountsCompleted ?? '—'}/{row.accountsTotal} · 部分完成{' '}
                    {row.accountsPartial ?? '—'} · 失败 {row.accountsFailed ?? '—'}
                  </small>
                </>
              )
            },
            {
              key: 'status',
              title: '运行状态',
              cell: (row) => (
                <>
                  <StatusTag value={row.status} label={runStatusLabel(row.status)} />
                  <small>模式：{executionModeLabel(row.executionMode)}</small>
                </>
              )
            },
            {
              key: 'points',
              title: '本轮实时余额变化',
              cell: (row) => points(row.liveBalanceDelta)
            },
            {
              key: 'actions',
              title: '操作',
              cell: (row) => (
                <Button
                  variant="text"
                  onClick={() => {
                    openRun(row.runId)
                  }}
                >
                  查看详情
                </Button>
              )
            }
          ]}
        />
      </Card>
    </>
  )
}

export function AccountPointTotals({
  today,
  total,
  expected,
  conflict = false,
  todaySource,
  totalSource
}: {
  today: number | null
  total: number | null
  expected?: number | null
  conflict?: boolean
  todaySource?: string | null
  totalSource?: string | null
}): ReactElement {
  const diff =
    !conflict && today !== null && expected !== null && expected !== undefined
      ? expected - today
      : null
  const isFulfilled =
    !conflict &&
    today !== null &&
    expected !== null &&
    expected !== undefined &&
    today >= expected &&
    expected > 0
  const sourceLabel = (source: string | null | undefined): string | null =>
    source ? `来源：${source}` : null
  return (
    <dl className="account-point-totals">
      <div>
        <dt>今日得分</dt>
        <dd>
          {conflict ? '数据冲突 / 待复核' : points(today)}
          {expected !== null && expected !== undefined && expected > 0 ? (
            <span
              style={{
                fontSize: '12px',
                marginLeft: '6px',
                fontWeight: 'normal',
                color: 'var(--color-text-secondary, #64748b)'
              }}
            >
              / 预计 {expected} 分
            </span>
          ) : null}
          {isFulfilled ? (
            <span
              className="badge-tag badge-success"
              style={{ marginLeft: '6px', fontSize: '11px', padding: '1px 5px' }}
            >
              已达标
            </span>
          ) : null}
          {diff !== null && diff > 0 ? (
            <span
              className="badge-tag badge-warning"
              style={{ marginLeft: '6px', fontSize: '11px', padding: '1px 5px' }}
            >
              未满分 (差 {diff} 分)
            </span>
          ) : null}
          {sourceLabel(todaySource) ? (
            <span className="muted" style={{ marginLeft: '6px', fontSize: '11px' }}>
              {sourceLabel(todaySource)}
            </span>
          ) : null}
        </dd>
      </div>
      <div>
        <dt>账号总分</dt>
        <dd>
          {conflict ? '数据冲突 / 待复核' : total === null ? '—' : `${String(total)} 分`}
          {sourceLabel(totalSource) ? (
            <span className="muted" style={{ marginLeft: '6px', fontSize: '11px' }}>
              {sourceLabel(totalSource)}
            </span>
          ) : null}
        </dd>
      </div>
    </dl>
  )
}

export function TasksPage({
  state,
  date,
  onDate
}: {
  state: StatePayload | undefined
  date: string
  onDate: (date: string) => void
}): ReactElement {
  const [account, setAccount] = useState('')
  const [status, setStatus] = useState('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const filtered =
    state?.tasks.filter(
      (row) =>
        (!account || row.accountId === account) &&
        (!status || row.status === status) &&
        (!search ||
          `${row.displayName} ${row.type}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()))
    ) ?? []
  const current = Math.min(page, Math.max(1, Math.ceil(filtered.length / 15)))
  return (
    <section className="task-section">
      <PageHeader title="任务状态" description="按账号和日期查看任务；完成状态不等于积分到账" />
      <Card bordered={false}>
        <div className="filter-bar">
          <label className="form-field">
            <span>日期</span>
            <DatePicker
              allowInput
              value={date || state?.localDate || ''}
              clearable={false}
              onChange={(value) => {
                if (value) {
                  onDate(String(value))
                  setPage(1)
                }
              }}
            />
          </label>
          <SelectField
            label="账号"
            value={account}
            onChange={(value) => {
              setAccount(value)
              setPage(1)
            }}
            options={[
              { label: '全部账号', value: '' },
              ...(state?.accounts.map((row) => ({
                label: `${String(row.runAccountIndex)} · ${row.displayAlias}`,
                value: row.accountId
              })) ?? [])
            ]}
          />
          <SelectField
            label="状态"
            value={status}
            onChange={(value) => {
              setStatus(value)
              setPage(1)
            }}
            options={[
              { label: '全部状态', value: '' },
              { label: '待执行', value: 'discovered' },
              { label: '已选择', value: 'selected' },
              { label: '执行中', value: 'running' },
              { label: '已提交', value: 'submitted' },
              { label: '待复核', value: 'verification-pending' },
              { label: '已完成', value: 'completed' },
              { label: '已跳过', value: 'skipped' },
              { label: '失败', value: 'failed' },
              { label: '需处理', value: 'action-required' }
            ]}
          />
          <Field
            label="搜索"
            value={search}
            onChange={(value) => {
              setSearch(value)
              setPage(1)
            }}
            placeholder="搜索任务名称或类型"
          />
        </div>
        <DataTable
          rows={filtered.slice((current - 1) * 15, current * 15)}
          rowKey={(row) => `${row.accountId}:${row.taskId}`}
          empty="没有匹配的任务记录"
          columns={[
            {
              key: 'account',
              title: '账号',
              cell: (row) => {
                const a = state?.accounts.find((item) => item.accountId === row.accountId)
                return a ? `账号 ${String(a.runAccountIndex)} · ${a.displayAlias}` : '历史账号'
              }
            },
            {
              key: 'task',
              title: '任务',
              cell: (row) => (
                <>
                  <strong>{row.displayName}</strong>
                  <small className="muted">{publicText(row.reason ?? row.source)}</small>
                </>
              )
            },
            {
              key: 'status',
              title: '执行状态',
              cell: (row) => (
                <StatusTag
                  value={row.status}
                  label={taskFailure(row.reason).failureLabel ?? stateLabel(row.status)}
                />
              )
            },
            {
              key: 'progress',
              title: '任务进度',
              cell: (row) =>
                row.progress.total === null
                  ? '—'
                  : `${String(row.progress.completed)}/${String(row.progress.total)}`
            },
            { key: 'time', title: '更新时间', cell: (row) => clockTime(row.updatedAt) }
          ]}
        />
        <Pagination
          current={current}
          pageSize={15}
          total={filtered.length}
          showPageSize={false}
          onCurrentChange={setPage}
        />
      </Card>
    </section>
  )
}

export function AccountsPage({
  accounts,
  busy,
  running,
  add,
  edit,
  toggle,
  remove,
  manageCredentials,
  testAccount,
  testAllAccounts,
  testing,
  calibrateAccount,
  calibrating
}: {
  accounts: AccountSummary[]
  busy: boolean
  running: boolean
  add: () => void
  edit: (account: AccountSummary) => void
  toggle: (account: AccountSummary) => void
  remove: (account: AccountSummary) => void
  manageCredentials?: (account: AccountSummary) => void
  testAccount?: (account: AccountSummary) => void
  testAllAccounts?: () => void
  testing?: boolean
  calibrateAccount?: (account: AccountSummary) => void
  calibrating?: boolean
}): ReactElement {
  const [query, setQuery] = useState('')
  const rows = accounts.filter((row) =>
    `${row.displayAlias} ${row.maskedEmail}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())
  )
  return (
    <>
      <PageHeader
        title="账号管理"
        description="管理账号名称和运行资格；账号编号仅用于选择，不代表完成数量"
        actions={
          <div style={{ display: 'flex', gap: '8px' }}>
            {testAllAccounts && (
              <Button
                variant="outline"
                disabled={Boolean(busy || testing)}
                loading={Boolean(testing)}
                onClick={testAllAccounts}
              >
                全员一键体检
              </Button>
            )}
            <Button icon={<AddIcon />} onClick={add}>
              添加账号
            </Button>
          </div>
        }
      />
      <Card bordered={false}>
        <div className="filter-bar">
          <Field
            label="搜索账号"
            value={query}
            onChange={setQuery}
            placeholder="搜索名称或脱敏账号"
          />
          <span className="muted">
            {accounts.filter((row) => row.enabled).length}/{accounts.length} 个已启用
          </span>
        </div>
        {running && <p className="muted">运行期间暂不能更改账号启停状态或删除，名称仍可编辑。</p>}
        <DataTable
          rows={rows}
          rowKey={(row) => row.accountId}
          empty={accounts.length ? '没有匹配的账号' : '尚未添加账号'}
          columns={[
            { key: 'number', title: '编号', cell: (row) => `账号 ${String(row.runAccountIndex)}` },
            {
              key: 'name',
              title: '名称与账号',
              cell: (row) => (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                    <strong>{row.displayAlias}</strong>
                    <div className="credentials-badge-list">
                      {row.hasOAuth ? (
                        <span className="badge-tag badge-success" title="OAuth 令牌已绑定">OAuth</span>
                      ) : (
                        <span className="badge-tag badge-muted" title="未绑定 OAuth">无 OAuth</span>
                      )}
                      {row.hasWebSession ? (
                        <span className="badge-tag badge-success" title="Web Cookie 已导入">Cookie</span>
                      ) : (
                        <span className="badge-tag badge-muted" title="未导入 Cookie">无 Cookie</span>
                      )}
                      {row.hasPassword ? (
                        <span className="badge-tag badge-info" title="已设置密码">密码</span>
                      ) : (
                        <span className="badge-tag badge-muted" title="免密模式">免密</span>
                      )}
                    </div>
                  </div>
                  <small className="muted">{row.maskedEmail}</small>
                </>
              )
            },
            {
              key: 'enabled',
              title: '参与运行',
              cell: (row) => (
                <Switch
                  value={row.enabled}
                  aria-checked={row.enabled}
                  disabled={busy || running}
                  label={['已启用', '已停用']}
                  onChange={() => {
                    toggle(row)
                  }}
                  aria-label={`启用账号 ${String(row.runAccountIndex)}`}
                />
              )
            },
            {
              key: 'edit',
              title: '操作',
              cell: (row) => (
                <div className="account-actions">
                  {testAccount && (
                    <Button
                      variant="text"
                      disabled={Boolean(busy || testing || calibrating)}
                      onClick={() => {
                        testAccount(row)
                      }}
                    >
                      体检
                    </Button>
                  )}
                  {calibrateAccount && (
                    <Button
                      variant="text"
                      disabled={Boolean(busy || testing || calibrating)}
                      onClick={() => {
                        calibrateAccount(row)
                      }}
                    >
                      校准
                    </Button>
                  )}
                  {manageCredentials && (
                    <Button
                      variant="text"
                      disabled={busy}
                      onClick={() => {
                        manageCredentials(row)
                      }}
                    >
                      托管凭证
                    </Button>
                  )}
                  <Button
                    variant="text"
                    disabled={busy}
                    onClick={() => {
                      edit(row)
                    }}
                  >
                    编辑名称
                  </Button>
                  <Button
                    variant="text"
                    theme="danger"
                    icon={<DeleteIcon />}
                    title="删除账号"
                    aria-label={`删除账号 ${String(row.runAccountIndex)}`}
                    disabled={busy || running}
                    onClick={() => {
                      remove(row)
                    }}
                  />
                </div>
              )
            }
          ]}
        />
      </Card>
    </>
  )
}