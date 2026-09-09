import { useEffect, useRef, useState } from 'react'
import { Calendar as TCalendar } from 'tdesign-react/es/calendar/index.js'
import { Card } from 'tdesign-react/es/card/index.js'
import { DatePicker } from 'tdesign-react/es/date-picker/index.js'
import { Empty } from 'tdesign-react/es/empty/index.js'
import { Loading } from 'tdesign-react/es/loading/index.js'
import { Button, DataTable, Feedback, PageHeader, StatusTag } from './UiKit'
import type { ReactElement } from 'react'
import { createRequestQueue } from './requestQueue'
import {
  TaskEvidencePanel,
  type EvidenceRow,
  type CreditRow,
  type TaskSummary
} from './TaskEvidencePanel'
import { PointSummary, type PointStatistics } from './PointSummary'
import { stateLabel, points, clockTime, duration } from './display'
export { stateLabel, points, clockTime, duration } from './display'

interface DailyBalance extends PointStatistics {
  businessDate: string
  dailyBalanceDelta: number | null
  verificationStatus: string
  observedFrom: string | null
  observedAt: string | null
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
interface Run {
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
  activeRunId
}: {
  page: 'history' | 'calendar'
  activeRunId: string | null
}): ReactElement {
  const [selected, setSelected] = useState(() =>
    window.location.hash.startsWith('#run/') ? window.location.hash.slice(5) : ''
  )
  const [number, setNumber] = useState(1)
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
    <HistoryList number={number} setNumber={setNumber} open={open} activeRunId={activeRunId} />
  ) : (
    <Calendar month={month} setMonth={setMonth} open={open} activeRunId={activeRunId} />
  )
}

function HistoryList({
  number,
  setNumber,
  open,
  activeRunId
}: {
  number: number
  setNumber: (value: number) => void
  open: (id: string) => void
  activeRunId: string | null
}): ReactElement {
  const { value, error } = useRead<{ runs: Run[]; hasMore: boolean }>(
    '/api/runs?page=' + String(number),
    activeRunId ?? ''
  )
  return (
    <section>
      <PageHeader title="运行记录" description="每次运行独立保存；点击详情查看账号状态和余额证据" />
      <Feedback error={error} />
      <Card bordered={false}>
        <DataTable
          rows={value?.runs ?? []}
          rowKey={(row) => row.runId}
          loading={!value && !error}
          empty={error ? '记录暂不可用' : '暂无运行记录'}
          columns={[
            {
              key: 'time',
              title: '开始 — 结束 = 执行时长',
              cell: (row) => (
                <>
                  <span>
                    {clockTime(row.startedAt)} —{' '}
                    {row.finishedAt
                      ? clockTime(row.finishedAt)
                      : row.runId === activeRunId
                        ? '进行中'
                        : '—'}
                  </span>
                  <small className="muted">
                    ={' '}
                    {duration(
                      row.startedAt,
                      row.finishedAt ??
                        (row.runId === activeRunId ? new Date().toISOString() : null)
                    )}
                  </small>
                </>
              )
            },
            {
              key: 'status',
              title: '运行 / 数据状态',
              cell: (row) => (
                <div className="tag-group">
                  <StatusTag value={row.status} />
                  <StatusTag value={row.persistence} />
                </div>
              )
            },
            {
              key: 'progress',
              title: '账号进度',
              cell: (row) =>
                '已处理 ' +
                String(row.accountsProcessed) +
                '/' +
                String(row.accountsTotal) +
                ' 个账号'
            },
            {
              key: 'balance',
              title: '本轮实时余额变化',
              cell: (row) => points(row.liveBalanceDelta)
            },
            {
              key: 'action',
              title: '操作',
              cell: (row) => (
                <Button
                  variant="text"
                  onClick={() => {
                    open(row.runId)
                  }}
                >
                  查看详情
                </Button>
              )
            }
          ]}
        />
        <div className="pagination">
          <Button
            variant="outline"
            disabled={number <= 1}
            onClick={() => {
              setNumber(number - 1)
            }}
          >
            上一页
          </Button>
          <span>第 {number} 页</span>
          <Button
            variant="outline"
            disabled={!value?.hasMore}
            onClick={() => {
              setNumber(number + 1)
            }}
          >
            下一页
          </Button>
        </div>
      </Card>
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
              <StatusTag value={value.run.status} />
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
            <div className="section-heading">
              <span>
                已处理 {value.run.accountsProcessed}/{value.run.accountsTotal} 个账号
              </span>
              <Button variant="text" href={'/api/runs/' + encodeURIComponent(id) + '/report'}>
                下载脱敏报告
              </Button>
            </div>
          </Card>
          {value.run.accounts.length === 0 && <Empty description="账号明细尚未取得" />}
          {value.run.accounts.map((account) => (
            <Card bordered={false} className="account-detail" key={account.accountId}>
              <div className="section-heading">
                <h3>
                  账号 {account.accountIndex ?? '—'} · {account.accountLabel}
                </h3>
                <div className="tag-group">
                  <StatusTag value={account.executionState} />
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
                  <dt>未匹配任务</dt>
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
                <span className="day-number">{Number(day.slice(-2))}</span>
                {rows.length > 0 && (
                  <>
                    <span className="day-dot" />
                    <div className="calendar-cell-accounts">
                      {rows.slice(0, 3).map((row) => (
                        <span key={row.accountId}>
                          账号 {row.accountIndex ?? '?'}：{points(row.dailyBalanceDelta)}
                        </span>
                      ))}
                      {rows.length > 3 && <small>另有 {rows.length - 3} 个账号</small>}
                    </div>
                  </>
                )}
              </button>
            )
          }}
        />
      </Card>
      <Card
        bordered={false}
        className="calendar-day-detail"
        title={date + ' · 当日明细'}
        subtitle="选择日期查看账号、余额依据和对应运行"
      >
        {!value ? (
          <Empty description={error ? '暂时无法读取' : '读取中'} />
        ) : entries.length === 0 ? (
          <Empty description="当天无本地记录" />
        ) : (
          entries.map((entry) => (
            <article className="calendar-account" key={entry.accountId}>
              <div className="section-heading">
                <strong>
                  账号 {entry.accountIndex ?? '—'} · {entry.accountLabel}
                </strong>
                <StatusTag value={entry.verificationStatus} />
              </div>
              <p className="balance-number">{points(entry.dailyBalanceDelta)}</p>
              <details>
                <summary>积分依据</summary>
                <PointSummary value={entry} />
              </details>
              <div className="calendar-run-links">
                {entry.records.map((record) => (
                  <Button
                    variant="outline"
                    key={record.runId}
                    onClick={() => {
                      open(record.runId)
                    }}
                  >
                    {stateLabel(record.status)} · 查看
                  </Button>
                ))}
              </div>
            </article>
          ))
        )}
      </Card>
    </section>
  )
}
