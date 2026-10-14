import { useEffect, useRef, useState } from 'react'
import { Calendar as TCalendar } from 'tdesign-react/es/calendar/index.js'
import { Card } from 'tdesign-react/es/card/index.js'
import { DatePicker } from 'tdesign-react/es/date-picker/index.js'
import { Empty } from 'tdesign-react/es/empty/index.js'
import { Loading } from 'tdesign-react/es/loading/index.js'
import { Button, Feedback, PageHeader, StatusTag } from './UiKit'
import type { ReactElement } from 'react'
import { createRequestQueue } from './requestQueue'
import { RunResultSummary, type RunResultFields } from './RunResultSummary'
import { runStatusLabel, accountStatusLabel } from '../../domain/RunOutcome'
import {
  TaskEvidencePanel,
  type EvidenceRow,
  type CreditRow,
  type TaskSummary
} from './TaskEvidencePanel'
import { PointSummary, type PointStatistics } from './PointSummary'
import { LiveRunStream, type StreamEvent } from './LiveRunStream'
import { resolveTaskEarnedPoints } from './TaskPointTable'
import type { StatePayload } from './App'
import { points, clockTime, duration } from './display'
export { stateLabel, points, clockTime, duration } from './display'

interface DailyBalance extends PointStatistics {
  businessDate: string
  dailyBalanceDelta: number | null
  verificationStatus: string
  observedFrom: string | null
  observedAt: string | null
  expectedDailyPoints?: number | null
}
interface RunAccount extends PointStatistics {
  accountId: string
  accountIndex: number | null
  accountLabel: string
  executionState: string
  startedAt: string | null
  endedAt: string | null
  runBalanceDelta: number | null
  reportedTaskPoints: number | null
  confirmedTaskPoints: number | null
  pendingTaskCount: number
  verificationStatus: string
  dailyBalances: DailyBalance[]
  tasks: TaskSummary[]
  taskEvidence?: EvidenceRow[]
  creditEvidence?: CreditRow[]
  runDailyBalances?: PointStatistics[]
}
interface Run extends RunResultFields {
  liveBalanceDelta: number | null
  runId: string
  startedAt: string
  finishedAt?: string
  status: string
  persistence: string
  runBalanceDelta: number | null
  accountsProcessed: number
  accountsTotal: number
  accounts: RunAccount[]
}
interface CalendarEntry extends DailyBalance {
  accountId: string
  accountIndex: number | null
  accountLabel: string
  confirmedTaskPoints: number | null
  records: Array<{ runId: string; status: string }>
}

function useRead<T>(
  path: string,
  revision: string | undefined,
  initialValue?: T
): { value: T | undefined; error: string } {
  const [value, setValue] = useState<T | undefined>(initialValue)
  const [error, setError] = useState('')
  const lastPath = useRef(path)
  useEffect(() => {
    let alive = true
    const controller = new AbortController()
    if (lastPath.current !== path) {
      setValue(undefined)
      lastPath.current = path
    }
    setError('')
    const refresh = createRequestQueue(
      async () => {
        const response = await fetch(path, {
          credentials: 'same-origin',
          signal: controller.signal
        })
        if (!response.ok)
          throw new Error(
            response.status === 404 ? '未找到该运行的本地记录' : '数据读取失败，请刷新重试'
          )
        return (await response.json()) as T
      },
      (next) => {
        if (alive) {
          setValue(next)
          setError('')
        }
      },
      (caught) => {
        if (alive)
          setError(
            caught instanceof Error && caught.message === '未找到该运行的本地记录'
              ? caught.message
              : '数据读取失败，已有观测可能过期'
          )
      }
    )
    void refresh()
    const timer = window.setInterval(() => void refresh(), revision ? 3000 : 10000)
    const onState = () => {
      void refresh()
    }
    window.addEventListener('rewards-state', onState)
    return () => {
      alive = false
      controller.abort()
      window.clearInterval(timer)
      window.removeEventListener('rewards-state', onState)
    }
  }, [path, revision])
  return { value: lastPath.current === path ? value : undefined, error }
}

export function RunPages({
  page,
  activeRunId,
  state
}: {
  page: 'history' | 'calendar'
  activeRunId: string | null
  state?: StatePayload | undefined
}): ReactElement {
  const [selected, setSelected] = useState(() =>
    window.location.hash.startsWith('#run/') ? window.location.hash.slice(5) : ''
  )
  const [month, setMonth] = useState(() =>
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit'
    }).format(new Date())
  )
  useEffect(() => {
    const change = () => {
      setSelected(window.location.hash.startsWith('#run/') ? window.location.hash.slice(5) : '')
    }
    window.addEventListener('hashchange', change)
    return () => {
      window.removeEventListener('hashchange', change)
    }
  }, [])
  function open(id: string) {
    setSelected(id)
    window.location.hash = `run/${id}`
  }
  if (selected)
    return (
      <RunDetail
        id={selected}
        activeRunId={activeRunId}
        backLabel={page === 'calendar' ? '返回日历' : '返回记录'}
        back={() => {
          setSelected('')
          window.location.hash = page
        }}
      />
    )
  return page === 'history' ? (
    <HistoryList activeRunId={activeRunId} state={state} />
  ) : (
    <Calendar month={month} setMonth={setMonth} open={open} activeRunId={activeRunId} />
  )
}

function HistoryList({
  activeRunId,
  state
}: {
  activeRunId: string | null
  state?: StatePayload | undefined
}): ReactElement {
  const accountMap = new Map((state?.accounts ?? []).map((a) => [a.accountId, a]))
  const activeRun = state?.runs.find((r) => r.runId === activeRunId)

  const streamEvents: StreamEvent[] = (state?.tasks ?? [])
    .filter((t) => !t.taskId.startsWith('category-'))
    .map((t) => {
      const acc = accountMap.get(t.accountId)
      const earned = resolveTaskEarnedPoints(t)
      return {
        id: `${t.accountId}:${t.taskId}:${t.updatedAt}`,
        time: t.updatedAt,
        accountId: t.accountId,
        accountLabel: acc?.displayAlias ?? '账号',
        accountIndex: acc ? acc.runAccountIndex : undefined,
        taskType: t.type,
        taskId: t.taskId,
        taskName: t.displayName,
        status: t.status,
        progressCompleted: t.progress.completed,
        progressTotal: t.progress.total,
        earnedPoints: earned,
        reason: t.reason,
        isActive: t.status === 'running'
      }
    })

  const currentRunningTask = (state?.tasks ?? []).find((t) => t.status === 'running')
  const currentRunningAccount = currentRunningTask
    ? accountMap.get(currentRunningTask.accountId)
    : null
  const currentAccountLabel = currentRunningAccount
    ? `账号 ${String(currentRunningAccount.runAccountIndex)} · ${currentRunningAccount.displayAlias}`
    : null

  return (
    <section>
      <PageHeader
        title="运行记录"
        description="实时展示各账号执行任务、执行进度、获得积分与失败原因"
      />
      <div className="run-stream-wrapper full-stream">
        <LiveRunStream
          title="实时运行动态滚动流"
          events={streamEvents}
          currentAccountLabel={currentAccountLabel}
          isRunning={Boolean(activeRun)}
        />
      </div>
    </section>
  )
}

function RunDetail({
  id,
  back,
  backLabel,
  activeRunId
}: {
  id: string
  back: () => void
  backLabel: string
  activeRunId: string | null
}): ReactElement {
  const { value, error } = useRead<{ run: Run }>(
    '/api/runs/' + encodeURIComponent(id),
    activeRunId ?? ''
  )
  return (
    <section>
      <PageHeader
        title="运行详情"
        description="执行状态、余额变化和任务到账依据分别展示"
        actions={
          <Button variant="outline" onClick={back}>
            {backLabel}
          </Button>
        }
      />
      <Feedback error={error} />
      {!value && !error && <Loading text="读取中" />}
      {value && (
        <>
          <Card bordered={false} className="run-summary">
            <div className="tag-group">
              <StatusTag value={value.run.status} label={runStatusLabel(value.run.status)} />
              <StatusTag value={value.run.persistence} />
              <span className="muted">Asia/Shanghai</span>
            </div>
            <p className="run-timing">
              {clockTime(value.run.startedAt)} —{' '}
              {value.run.finishedAt
                ? clockTime(value.run.finishedAt)
                : id === activeRunId
                  ? '进行中'
                  : '—'}{' '}
              ={' '}
              {duration(
                value.run.startedAt,
                value.run.finishedAt ?? (id === activeRunId ? new Date().toISOString() : null)
              )}
            </p>
            <RunResultSummary run={value.run} />
            <div className="run-stream-wrapper">
              <LiveRunStream
                title="本轮运行任务动态"
                events={value.run.accounts.flatMap((account) =>
                  account.tasks.map((task) => ({
                    id: `${account.accountId}:${task.taskId}`,
                    time: account.startedAt ?? value.run.startedAt,
                    accountId: account.accountId,
                    accountLabel: account.accountLabel,
                    accountIndex: account.accountIndex ?? undefined,
                    taskType: task.type ?? 'unknown',
                    taskName: task.displayName,
                    status: task.status,
                    progressCompleted: (task.progress?.completed ?? task.taskProgress?.completed) ?? undefined,
                    progressTotal: (task.progress?.total ?? task.taskProgress?.total) ?? undefined,
                    earnedPoints: resolveTaskEarnedPoints(task) ?? undefined,
                    reason: task.reason ?? undefined,
                    isActive: task.status === 'running'
                  }))
                )}
                currentAccountLabel={
                  value.run.accounts.find((a) => a.executionState === 'running')?.accountLabel
                }
                isRunning={id === activeRunId}
              />
            </div>
            <div className="section-heading">
              <span>
                已结束 {value.run.accountsProcessed}/{value.run.accountsTotal} 个账号
              </span>
              <Button variant="text" href={'/api/runs/' + encodeURIComponent(id) + '/report'}>
                下载脱敏报告
              </Button>
            </div>
          </Card>
          {value.run.accounts.length === 0 && <Empty description="暂无账号明细" />}
          {value.run.accounts.map((account) => (
            <Card bordered={false} className="account-detail" key={account.accountId}>
              <div className="section-heading">
                <h3>
                  账号 {account.accountIndex ?? '—'} · {account.accountLabel}
                </h3>
                <div className="tag-group">
                  <StatusTag
                    value={account.executionState}
                    label={accountStatusLabel(account.executionState)}
                  />
                  <span>
                    余额
                    <StatusTag value={account.verificationStatus} />
                  </span>
                </div>
              </div>
              <p className="run-timing">
                {clockTime(account.startedAt)} —{' '}
                {account.endedAt
                  ? clockTime(account.endedAt)
                  : account.executionState === 'running' && id === activeRunId
                    ? '进行中'
                    : '—'}{' '}
                ={' '}
                {duration(
                  account.startedAt,
                  account.endedAt ??
                    (account.executionState === 'running' && id === activeRunId
                      ? new Date().toISOString()
                      : null)
                )}
              </p>
              <dl className="balance-fields">
                <div>
                  <dt>本轮实时余额变化</dt>
                  <dd>{points(account.liveBalanceDelta)}</dd>
                </div>
                <div>
                  <dt>未完成任务</dt>
                  <dd>{account.pendingTaskCount}</dd>
                </div>
              </dl>
              <PointSummary value={account} />
              {(account.runDailyBalances?.length ?? 0) > 1 && (
                <details>
                  <summary>本轮跨日分账</summary>
                  {account.runDailyBalances?.map((day) => (
                    <PointSummary key={day.statisticScope?.businessDate} value={day} />
                  ))}
                </details>
              )}
              <details className="daily-evidence">
                <summary>按日期查看余额证据（{account.dailyBalances.length} 天）</summary>
                {account.dailyBalances.map((day) => (
                  <div className="daily-record" key={day.businessDate}>
                    <div className="section-heading">
                      <strong>
                        {day.businessDate} · {points(day.dailyBalanceDelta)}
                      </strong>
                      <StatusTag value={day.verificationStatus} />
                    </div>
                    <p className="muted">
                      {clockTime(day.observedFrom)} — {clockTime(day.observedAt)}
                    </p>
                    <PointSummary value={day} />
                  </div>
                ))}
              </details>
              <TaskEvidencePanel
                tasks={account.tasks}
                evidence={account.taskEvidence ?? []}
                creditEvidence={account.creditEvidence ?? []}
              />
            </Card>
          ))}
        </>
      )}
    </section>
  )
}

function Calendar({
  month,
  setMonth,
  open,
  activeRunId
}: {
  month: string
  setMonth: (value: string) => void
  open: (id: string) => void
  activeRunId: string | null
}): ReactElement {
  const { value, error } = useRead<{ entries: CalendarEntry[] }>(
    '/api/calendar?month=' + month,
    activeRunId ?? ''
  )
  const [selected, setSelected] = useState(() =>
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date())
  )
  const date = selected.startsWith(month)
    ? selected
    : (value?.entries[0]?.businessDate ?? month + '-01')
  const entries = value?.entries.filter((row) => row.businessDate === date) ?? []

  const monthEntries = (value?.entries ?? []).filter((r) => r.businessDate.startsWith(month))
  const monthTotal = monthEntries.reduce((sum, r) => sum + (r.dailyBalanceDelta ?? 0), 0)
  const dayTotals = new Map<string, number>()
  for (const e of monthEntries) {
    dayTotals.set(e.businessDate, (dayTotals.get(e.businessDate) ?? 0) + (e.dailyBalanceDelta ?? 0))
  }
  let maxDayGain = 0
  let maxDayDate = '—'
  for (const [d, gain] of dayTotals) {
    if (gain > maxDayGain) {
      maxDayGain = gain
      maxDayDate = d
    }
  }
  const recordedDays = dayTotals.size

  return (
    <section>
      <PageHeader
        title="积分日历"
        description="当日已观测余额净变化 · Asia/Shanghai"
        actions={
          <label className="form-field">
            <span>月份</span>
            <DatePicker
              allowInput
              mode="month"
              value={month}
              clearable={false}
              onChange={(value) => {
                if (/^\d{4}-\d{2}$/.test(String(value))) setMonth(String(value))
              }}
            />
          </label>
        }
      />
      <Feedback error={error} />
      <div className="calendar-month-stats">
        <Card bordered={false} className="calendar-stat-card">
          <span className="muted">本月全账号净收益</span>
          <strong className="metric-value">{monthTotal > 0 ? `+${String(monthTotal)}` : monthTotal} 分</strong>
        </Card>
        <Card bordered={false} className="calendar-stat-card">
          <span className="muted">单日最高收益</span>
          <strong className="metric-value">
            {maxDayGain > 0 ? `+${String(maxDayGain)} 分` : '—'}
            {maxDayDate !== '—' && <small className="muted">（${maxDayDate.slice(5)}）</small>}
          </strong>
        </Card>
        <Card bordered={false} className="calendar-stat-card">
          <span className="muted">打卡记录天数</span>
          <strong className="metric-value">{recordedDays} 天</strong>
        </Card>
      </div>
      <Card bordered={false} className="calendar-panel">
        <TCalendar
          controllerConfig={false}
          year={Number(month.slice(0, 4))}
          month={Number(month.slice(5))}
          value={date}
          theme="full"
          firstDayOfWeek={1}
          cell={(cell) => {
            const day = cell.formattedDate ?? ''
            const rows = value?.entries.filter((row) => row.businessDate === day) ?? []
            const dayTotalGain = rows.reduce(
              (sum, row) => sum + (row.dailyBalanceDelta ?? 0),
              0
            )
            return (
              <button
                className={
                  'calendar-cell-button ' +
                  (day === date ? 'selected' : '') +
                  (cell.belongTo ? ' outside' : '')
                }
                aria-label={day + (rows.length ? ' 有记录' : ' 无记录')}
                aria-pressed={day === date}
                onClick={() => {
                  setSelected(day)
                  if (day.slice(0, 7) !== month) setMonth(day.slice(0, 7))
                }}
              >
                <div className="calendar-cell-header">
                  <span className="day-number">{Number(day.slice(-2))}</span>
                  {rows.length > 0 && (
                    <span
                      className={`day-total-badge ${dayTotalGain < 0 ? 'negative' : ''}`}
                      title={`当日全账号总得分：${points(dayTotalGain)}`}
                    >
                      {dayTotalGain > 0 ? `+${String(dayTotalGain)}` : String(dayTotalGain)}分
                    </span>
                  )}
                </div>
                {rows.length > 0 && (
                  <div className="calendar-cell-accounts">
                    {rows.map((row) => (
                      <span
                        key={row.accountId}
                        className={`calendar-acc-row ${
                          (row.dailyBalanceDelta ?? 0) < 0 ? 'acc-negative' : ''
                        }`}
                      >
                        <span className="acc-idx">账号 {row.accountIndex ?? '?'}:</span>
                        <strong className="acc-pts">{points(row.dailyBalanceDelta)}</strong>
                      </span>
                    ))}
                  </div>
                )}
              </button>
            )
          }}
        />
      </Card>
      <Card
        bordered={false}
        className="calendar-day-detail"
        title={date + ' · 当日账号收益明细'}
        subtitle="点击下方查看按钮跳转至该次运行详情"
      >
        {!value ? (
          <Empty description={error ? '暂时无法读取' : '读取中'} />
        ) : entries.length === 0 ? (
          <Empty description="当天无本地记录" />
        ) : (
          <div className="calendar-accounts-grid">
            {entries.map((entry) => (
              <article className="calendar-account-card" key={entry.accountId}>
                <div className="section-heading">
                  <strong>
                    账号 {entry.accountIndex ?? '—'} · {entry.accountLabel}
                  </strong>
                  <StatusTag value={entry.verificationStatus} />
                </div>
                <div className="calendar-acc-gain">
                  <span className="muted">当日净收益</span>
                  <strong
                    className={`balance-number ${
                      (entry.dailyBalanceDelta ?? 0) < 0 ? 'text-negative' : ''
                    }`}
                  >
                    {points(entry.dailyBalanceDelta)}
                  </strong>
                </div>
                {entry.confirmedTaskPoints != null && (
                  <p className="muted">已确认任务得分：{points(entry.confirmedTaskPoints)}</p>
                )}
                <div className="calendar-run-links">
                  {entry.records.map((record) => (
                    <Button
                      variant="outline"
                      key={record.runId}
                      onClick={() => {
                        open(record.runId)
                      }}
                    >
                      {runStatusLabel(record.status)} · 查看
                    </Button>
                  ))}
                </div>
              </article>
            ))}
          </div>
        )}
      </Card>
    </section>
  )
}
