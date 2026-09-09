import { useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { createRequestQueue } from './requestQueue'
import { TaskEvidencePanel, type EvidenceRow } from './TaskEvidencePanel'
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
  tasks: Array<{ taskId: string; displayName: string; status: string; reason?: string }>
  taskEvidence?: EvidenceRow[]
}
interface Run {
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
    `/api/runs?page=${String(number)}`,
    activeRunId ?? ''
  )
  return (
    <section>
      <h2>运行记录</h2>
      {error && (
        <p role="alert" className="notice error">
          {error}
        </p>
      )}
      {!value && <p className="empty">读取中</p>}
      {value?.runs.length === 0 && <p className="empty">暂无运行记录</p>}
      <div className="run-records">
        {value?.runs.map((run) => (
          <article className="run-record" key={run.runId}>
            <div>
              <strong>{stateLabel(run.status)}</strong>
              <span>{stateLabel(run.persistence)}</span>
            </div>
            <p>
              {clockTime(run.startedAt)} —{' '}
              {run.finishedAt
                ? clockTime(run.finishedAt)
                : ['running', 'cancelling'].includes(run.status)
                  ? '进行中'
                  : '待确认'}
            </p>
            <p>
              执行时长：
              {duration(
                run.startedAt,
                run.finishedAt ?? (run.runId === activeRunId ? new Date().toISOString() : null)
              )}
            </p>
            <div>
              <span>
                已处理 {run.accountsProcessed}/{run.accountsTotal} 个账号
              </span>
              <strong>{points(run.runBalanceDelta)}</strong>
              <button
                type="button"
                onClick={() => {
                  open(run.runId)
                }}
              >
                查看详情
              </button>
            </div>
          </article>
        ))}
      </div>
      <div className="pagination">
        <button
          disabled={number <= 1}
          onClick={() => {
            setNumber(number - 1)
          }}
        >
          上一页
        </button>
        <span>第 {number} 页</span>
        <button
          disabled={!value?.hasMore}
          onClick={() => {
            setNumber(number + 1)
          }}
        >
          下一页
        </button>
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
    `/api/runs/${encodeURIComponent(id)}`,
    activeRunId ?? ''
  )
  return (
    <section>
      <div className="section-heading">
        <h2>运行详情</h2>
        <button onClick={back}>{backLabel}</button>
      </div>
      {error && (
        <p role="alert" className="notice error">
          {error}
        </p>
      )}
      {!value && !error && <p className="empty">读取中</p>}
      {value && (
        <>
          <p className="run-timing">
            {clockTime(value.run.startedAt)} —{' '}
            {value.run.finishedAt
              ? clockTime(value.run.finishedAt)
              : id === activeRunId
                ? '进行中'
                : '待确认'}{' '}
            ={' '}
            {duration(
              value.run.startedAt,
              value.run.finishedAt ?? (id === activeRunId ? new Date().toISOString() : null)
            )}
          </p>
          <p>
            {stateLabel(value.run.status)} · {stateLabel(value.run.persistence)} · Asia/Shanghai
          </p>
          {value.run.accounts.map((account) => (
            <section className="account-detail" key={account.accountId}>
              <h2>
                账号 {account.accountIndex ?? '待确认'} · {account.accountLabel}
              </h2>
              <p>
                {stateLabel(account.executionState)} · 余额{stateLabel(account.verificationStatus)}
              </p>
              <p className="run-timing">
                {clockTime(account.startedAt)} —{' '}
                {account.endedAt
                  ? clockTime(account.endedAt)
                  : account.executionState === 'running' && id === activeRunId
                    ? '进行中'
                    : '待确认'}{' '}
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
                  <dt>本次余额变化</dt>
                  <dd>{points(account.runBalanceDelta)}</dd>
                </div>
                <div>
                  <dt>待确认任务</dt>
                  <dd>{account.pendingTaskCount}</dd>
                </div>
              </dl>
              <PointSummary value={account} />
              {account.dailyBalances.map((day) => (
                <div key={day.businessDate}>
                  {day.businessDate} · 观测余额净变化 {points(day.dailyBalanceDelta)} ·{' '}
                  {stateLabel(day.verificationStatus)}
                  <small className="observation">
                    {clockTime(day.observedFrom)} — {clockTime(day.observedAt)}
                  </small>
                  <PointSummary value={day} />
                </div>
              ))}
              <TaskEvidencePanel tasks={account.tasks} evidence={account.taskEvidence ?? []} />
            </section>
          ))}
          <a href={`/api/runs/${encodeURIComponent(id)}/report`} download>
            下载脱敏报告
          </a>
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
    `/api/calendar?month=${month}`,
    activeRunId ?? ''
  )
  const days = new Date(Number(month.slice(0, 4)), Number(month.slice(5)), 0).getDate()
  const weekdayOffset =
    (new Date(Number(month.slice(0, 4)), Number(month.slice(5)) - 1, 1).getDay() + 6) % 7
  return (
    <section>
      <div className="section-heading">
        <h2>积分日历</h2>
        <label>
          月份
          <input
            type="month"
            value={month}
            onChange={(event) => {
              if (event.target.value) setMonth(event.target.value)
            }}
          />
        </label>
      </div>
      <p className="observation">当日已观测余额净变化 · Asia/Shanghai</p>
      {error && (
        <p role="alert" className="notice error">
          {error}
        </p>
      )}
      <div className="calendar-grid">
        {['一', '二', '三', '四', '五', '六', '日'].map((day) => (
          <span className="calendar-weekday" key={day}>
            周{day}
          </span>
        ))}
        {Array.from({ length: weekdayOffset }, (_, index) => (
          <span aria-hidden="true" className="calendar-spacer" key={`spacer-${String(index)}`} />
        ))}
        {Array.from({ length: days }, (_, i) => {
          const date = `${month}-${String(i + 1).padStart(2, '0')}`
          const entries = value?.entries.filter((row) => row.businessDate === date) ?? []
          return (
            <article className="calendar-day" key={date}>
              <h3>{i + 1} 日</h3>
              {entries.length === 0 && <p className="observation">{value ? '无记录' : '读取中'}</p>}
              {entries.map((entry) => (
                <div className="calendar-account" key={entry.accountId}>
                  <strong>
                    账号 {entry.accountIndex ?? '待确认'} · {entry.accountLabel}
                  </strong>
                  <span>
                    {points(entry.dailyBalanceDelta)} · {stateLabel(entry.verificationStatus)}
                  </span>
                  <details>
                    <summary>积分依据</summary>
                    <PointSummary value={entry} />
                  </details>
                  {entry.records.map((record) => (
                    <button
                      key={record.runId}
                      onClick={() => {
                        open(record.runId)
                      }}
                    >
                      {stateLabel(record.status)} · 查看
                    </button>
                  ))}
                </div>
              ))}
            </article>
          )
        })}
      </div>
    </section>
  )
}
