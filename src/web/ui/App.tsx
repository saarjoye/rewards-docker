import { useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent, ReactElement } from 'react'
import { createRequestQueue } from './requestQueue'
import { RunPages, stateLabel, points, clockTime, duration } from './RunPages'

interface AccountSummary {
  accountId: string
  runAccountIndex: number
  displayAlias: string
  maskedEmail: string
  enabled: boolean
}

interface TaskState {
  taskId: string
  accountId: string
  type: string
  source: string
  sourceTaskId: string
  displayName: string
  executable: boolean
  required: boolean
  status: string
  progress: { completed: number; total: number | null }
  reason?: string
  updatedAt: string
}

interface StatePayload {
  localDate: string
  accounts: AccountSummary[]
  tasks: TaskState[]
  taskSummary: {
    discovered: number
    executable: number
    completed: number
    skipped: number
    failed: number
    verificationPending: number
    actionRequired: number
    unknown: number
  }
  runnerReady: boolean
  activeRunId: string | null
  runs: RunSummary[]
  today: Array<{
    accountId: string
    accountLabel: string
    dailyBalanceDelta: number | null
    verificationStatus: string
  }>
}

interface RunSummary {
  runId: string
  localDate: string
  executionMode: 'read-only' | 'mutating'
  status: string
  selectedAccountIndexes: number[]
  startedAt: string
  finishedAt?: string
  runBalanceDelta: number | null
  accountsProcessed: number
  accountsTotal: number
}

interface ApiErrorPayload {
  error?: string
  message?: string
}

const taskNames: Record<string, string> = {
  'claim-bonus-points': '领取奖励积分',
  'app-activity': 'App 活动',
  'daily-set': '每日任务',
  'special-promotion': '特殊活动',
  'more-promotion': '更多推广',
  'app-check-in': '每日签到',
  'read-to-earn': '阅读赚取',
  'punch-card': '打卡活动',
  'mobile-search': '移动搜索',
  'pc-search': 'PC 搜索',
  unknown: '未知任务'
}

const statusNames: Record<string, string> = {
  discovered: '待执行',
  selected: '已选择',
  running: '进行中',
  submitted: '已提交',
  'verification-pending': '待复核',
  completed: '已完成',
  skipped: '已跳过',
  failed: '失败',
  'action-required': '需要操作',
  unknown: '未知'
}

async function requestJson<T>(path: string, init?: RequestInit, csrfToken?: string): Promise<T> {
  const headers = new Headers(init?.headers)
  if (init?.body) headers.set('content-type', 'application/json')
  if (csrfToken) headers.set('x-csrf-token', csrfToken)
  const response = await fetch(path, { ...init, headers, credentials: 'same-origin' })
  const payload = (await response.json().catch(() => ({}))) as T & ApiErrorPayload
  if (!response.ok)
    throw new Error(payload.message ?? payload.error ?? `HTTP ${String(response.status)}`)
  return payload
}

function LoginView({ onLogin }: { onLogin: (token: string) => void }): ReactElement {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault()
    setSubmitting(true)
    setError('')
    try {
      const result = await requestJson<{ csrfToken: string }>('/api/login', {
        method: 'POST',
        body: JSON.stringify({ username, password })
      })
      onLogin(result.csrfToken)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '登录失败')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="login-shell">
      <section className="login-panel" aria-labelledby="login-title">
        <div className="brand-mark" aria-hidden="true">
          R
        </div>
        <h1 id="login-title">Rewards Next</h1>
        <p className="muted">管理控制台</p>
        <form onSubmit={(event) => void submit(event)}>
          <label>
            管理员账号
            <input
              value={username}
              onChange={(event) => {
                setUsername(event.target.value)
              }}
              autoComplete="username"
              required
            />
          </label>
          <label>
            管理员密码
            <input
              type="password"
              value={password}
              onChange={(event) => {
                setPassword(event.target.value)
              }}
              autoComplete="current-password"
              required
            />
          </label>
          {error && (
            <p className="inline-error" role="alert">
              {error}
            </p>
          )}
          <button className="primary wide" disabled={submitting} type="submit">
            {submitting ? '登录中' : '登录'}
          </button>
        </form>
      </section>
    </main>
  )
}

export function App(): ReactElement {
  const [restoring, setRestoring] = useState(true)
  const [page, setPage] = useState<'overview' | 'tasks' | 'history' | 'calendar' | 'accounts'>(
    () => {
      const hash = window.location.hash.slice(1)
      if (hash.startsWith('run/')) return 'history'
      return hash === 'tasks' || hash === 'history' || hash === 'calendar' || hash === 'accounts'
        ? hash
        : 'overview'
    }
  )
  const [taskAccount, setTaskAccount] = useState('')
  const [taskStatus, setTaskStatus] = useState('')
  const [taskDate, setTaskDate] = useState('')
  const taskDateRef = useRef(taskDate)
  taskDateRef.current = taskDate
  const [submitting, setSubmitting] = useState(false)
  const [editingAccount, setEditingAccount] = useState('')
  const [alias, setAlias] = useState('')
  const [csrfToken, setCsrfToken] = useState<string>()
  const [state, setState] = useState<StatePayload>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [accountMode, setAccountMode] = useState<'continue' | 'account'>('continue')
  const [executionMode, setExecutionMode] = useState<'read-only' | 'mutating'>('read-only')
  const [runAccountIndex, setRunAccountIndex] = useState(1)
  const [showAccountForm, setShowAccountForm] = useState(false)

  const loadState = useMemo(
    () =>
      createRequestQueue(
        async () => {
          setLoading(true)
          return await requestJson<StatePayload>(
            `/api/state${taskDateRef.current ? `?date=${taskDateRef.current}` : ''}`
          )
        },
        (value) => {
          setState(value)
          setLoading(false)
          setError('')
        },
        (caught) => {
          const message = caught instanceof Error ? caught.message : '状态读取失败'
          if (message === 'authentication-required') setCsrfToken(undefined)
          else setError('状态读取失败，已有数据可能过期')
          setLoading(false)
        }
      ),
    []
  )

  useEffect(() => {
    let alive = true
    void requestJson<{ csrfToken: string }>('/api/session')
      .then((value) => {
        if (alive) setCsrfToken(value.csrfToken)
      })
      .catch(() => undefined)
      .finally(() => {
        if (alive) setRestoring(false)
      })
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    if (csrfToken) void loadState()
  }, [csrfToken, loadState, taskDate])

  useEffect(() => {
    if (!csrfToken) return
    const timer = window.setInterval(() => void loadState(), state?.activeRunId ? 3000 : 10000)
    return () => {
      window.clearInterval(timer)
    }
  }, [csrfToken, loadState, state?.activeRunId])

  const selectedAccount = useMemo(
    () => state?.accounts.find((account) => account.runAccountIndex === runAccountIndex),
    [runAccountIndex, state]
  )

  async function startRun(): Promise<void> {
    if (!state?.runnerReady || submitting) return
    setSubmitting(true)
    setError('')
    const body =
      accountMode === 'continue'
        ? { accountMode, executionMode }
        : { accountMode, runAccountIndex, executionMode }
    try {
      await requestJson('/api/runs', { method: 'POST', body: JSON.stringify(body) }, csrfToken)
      await loadState()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '启动失败')
    } finally {
      setSubmitting(false)
    }
  }

  async function cancelRun(): Promise<void> {
    if (!state?.activeRunId || submitting) return
    setSubmitting(true)
    try {
      await requestJson(`/api/runs/${state.activeRunId}/cancel`, { method: 'POST' }, csrfToken)
      await loadState()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '停止失败')
    } finally {
      setSubmitting(false)
    }
  }

  async function toggleAccount(account: AccountSummary): Promise<void> {
    if (submitting) return
    setSubmitting(true)
    try {
      await requestJson(
        `/api/accounts/${account.accountId}`,
        { method: 'PATCH', body: JSON.stringify({ enabled: !account.enabled }) },
        csrfToken
      )
      await loadState()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '账号更新失败')
    } finally {
      setSubmitting(false)
    }
  }

  async function logout(): Promise<void> {
    try {
      await requestJson('/api/logout', { method: 'POST' }, csrfToken)
    } finally {
      setCsrfToken(undefined)
      setState(undefined)
    }
  }

  async function saveAlias(): Promise<void> {
    setSubmitting(true)
    try {
      await requestJson(
        `/api/accounts/${editingAccount}`,
        { method: 'PATCH', body: JSON.stringify({ displayAlias: alias }) },
        csrfToken
      )
      setEditingAccount('')
      await loadState()
    } catch {
      setError('名称更新失败')
    } finally {
      setSubmitting(false)
    }
  }
  if (restoring) return <main className="login-shell">正在恢复管理会话</main>
  if (!csrfToken) return <LoginView onLogin={setCsrfToken} />

  return (
    <div className={`app-shell page-${page}`}>
      <header className="topbar">
        <div className="brand-row">
          <div className="brand-mark small" aria-hidden="true">
            R
          </div>
          <div>
            <h1>Rewards Next</h1>
            <span>{state?.localDate ?? '---- -- --'}</span>
          </div>
        </div>
        <div className="header-actions">
          <button type="button" onClick={() => void loadState()} disabled={loading}>
            刷新
          </button>
          <button type="button" onClick={() => void logout()}>
            退出
          </button>
        </div>
      </header>

      <main className="workspace">
        <aside className="account-rail">
          <div className="section-heading">
            <h2>账号</h2>
            <button
              className="primary compact"
              type="button"
              onClick={() => {
                setShowAccountForm((value) => !value)
              }}
            >
              {showAccountForm ? '取消' : '添加'}
            </button>
          </div>
          {showAccountForm && (
            <AccountForm
              csrfToken={csrfToken}
              onCreated={async () => {
                setShowAccountForm(false)
                await loadState()
              }}
            />
          )}
          <div className="account-list">
            {state?.accounts.map((account) => (
              <article
                className={`account-item ${account.enabled ? '' : 'disabled'}`}
                key={account.accountId}
              >
                <div className="account-index">{account.runAccountIndex}</div>
                <div className="account-copy">
                  <strong>{account.displayAlias}</strong>
                  <span>{account.maskedEmail}</span>
                </div>
                <button
                  className="text-button"
                  type="button"
                  disabled={submitting || Boolean(state.activeRunId)}
                  onClick={() => void toggleAccount(account)}
                >
                  {account.enabled ? '停用' : '启用'}
                </button>
                <button
                  className="text-button"
                  disabled={submitting}
                  onClick={() => {
                    setEditingAccount(account.accountId)
                    setAlias(account.displayAlias)
                  }}
                >
                  改名
                </button>
                {editingAccount === account.accountId && (
                  <form
                    className="alias-form"
                    onSubmit={(event) => {
                      event.preventDefault()
                      void saveAlias()
                    }}
                  >
                    <label>
                      名称
                      <input
                        value={alias}
                        onChange={(event) => {
                          setAlias(event.target.value)
                        }}
                        maxLength={80}
                        required
                      />
                    </label>
                    <button disabled={submitting || !alias.trim()}>保存</button>
                    <button
                      type="button"
                      onClick={() => {
                        setEditingAccount('')
                      }}
                    >
                      取消
                    </button>
                  </form>
                )}
              </article>
            ))}
            {state?.accounts.length === 0 && <p className="empty">暂无账号</p>}
          </div>
        </aside>

        <section className="content-area">
          <nav className="view-tabs" aria-label="管理视图">
            {(['overview', 'tasks', 'history', 'calendar', 'accounts'] as const).map((view) => (
              <button
                key={view}
                aria-current={page === view ? 'page' : undefined}
                onClick={() => {
                  setPage(view)
                  window.location.hash = view
                }}
              >
                {
                  {
                    overview: '概览',
                    tasks: '任务',
                    history: '运行记录',
                    calendar: '积分日历',
                    accounts: '账号管理'
                  }[view]
                }
              </button>
            ))}
          </nav>
          {page === 'history' || page === 'calendar' ? (
            <RunPages key={page} page={page} activeRunId={state?.activeRunId ?? null} />
          ) : (
            <>
              <div className="runbar">
                <div className="segmented" aria-label="运行范围">
                  <button
                    className={accountMode === 'continue' ? 'active' : ''}
                    type="button"
                    onClick={() => {
                      setAccountMode('continue')
                    }}
                  >
                    继续未完成
                  </button>
                  <button
                    className={accountMode === 'account' ? 'active' : ''}
                    type="button"
                    onClick={() => {
                      setAccountMode('account')
                    }}
                  >
                    指定账号
                  </button>
                </div>
                {accountMode === 'account' && (
                  <select
                    value={runAccountIndex}
                    onChange={(event) => {
                      setRunAccountIndex(Number(event.target.value))
                    }}
                    aria-label="运行账号"
                  >
                    {state?.accounts.map((account) => (
                      <option key={account.accountId} value={account.runAccountIndex}>
                        {account.runAccountIndex}. {account.displayAlias}
                      </option>
                    ))}
                  </select>
                )}
                <div className="segmented" aria-label="执行方式">
                  <button
                    className={executionMode === 'read-only' ? 'active' : ''}
                    type="button"
                    onClick={() => {
                      setExecutionMode('read-only')
                    }}
                  >
                    只读检查
                  </button>
                  <button
                    className={executionMode === 'mutating' ? 'active' : ''}
                    type="button"
                    onClick={() => {
                      setExecutionMode('mutating')
                    }}
                  >
                    执行任务
                  </button>
                </div>
                <button
                  className="primary"
                  type="button"
                  disabled={
                    !state?.runnerReady ||
                    submitting ||
                    Boolean(state.activeRunId) ||
                    (accountMode === 'account' && !selectedAccount)
                  }
                  onClick={() => void startRun()}
                >
                  {submitting
                    ? '处理中'
                    : state?.activeRunId
                      ? '运行中'
                      : executionMode === 'read-only'
                        ? '开始检查'
                        : '开始执行'}
                </button>
                {state?.activeRunId && (
                  <button type="button" disabled={submitting} onClick={() => void cancelRun()}>
                    停止
                  </button>
                )}
              </div>

              {state && !state.runnerReady && (
                <div className="notice">执行器尚未接入，账号与任务账本可正常管理。</div>
              )}
              {error && (
                <div className="notice error" role="alert">
                  {error}
                </div>
              )}

              {page === 'overview' && (
                <section className="daily-balances">
                  <h2>今日已观测余额变化</h2>
                  {!state ? (
                    <p>读取中</p>
                  ) : state.today.length === 0 ? (
                    <p className="observation">暂无余额观测</p>
                  ) : (
                    state.today.map((day) => (
                      <p key={day.accountId}>
                        {day.accountLabel} · {points(day.dailyBalanceDelta)} ·{' '}
                        {stateLabel(day.verificationStatus)}
                      </p>
                    ))
                  )}
                </section>
              )}

              <section className="metrics" aria-label="任务统计">
                <Metric label="任务" value={state?.taskSummary.discovered} />
                <Metric label="已完成" value={state?.taskSummary.completed} tone="success" />
                <Metric
                  label="待复核"
                  value={state?.taskSummary.verificationPending}
                  tone="warning"
                />
                <Metric label="失败" value={state?.taskSummary.failed} tone="danger" />
                <Metric label="未知" value={state?.taskSummary.unknown} />
              </section>

              <section className="task-section recent-runs">
                <div className="section-heading">
                  <h2>最近运行</h2>
                  <span>{state?.runs.length ?? 0} 次</span>
                </div>
                <div className="task-table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>时间</th>
                        <th>范围</th>
                        <th>方式</th>
                        <th>状态</th>
                        <th>报告</th>
                      </tr>
                    </thead>
                    <tbody>
                      {state?.runs.map((run) => (
                        <tr key={run.runId}>
                          <td>
                            {clockTime(run.startedAt)}
                            <small>
                              {clockTime(run.finishedAt)} ·{' '}
                              {duration(
                                run.startedAt,
                                run.finishedAt ??
                                  (run.runId === state.activeRunId
                                    ? new Date().toISOString()
                                    : null)
                              )}
                            </small>
                          </td>
                          <td>
                            已处理 {run.accountsProcessed}/{run.accountsTotal} 个账号
                            <small>{points(run.runBalanceDelta)}</small>
                          </td>
                          <td>{run.executionMode === 'read-only' ? '只读' : '执行'}</td>
                          <td>
                            <span className={`status status-${run.status}`}>
                              {stateLabel(run.status)}
                            </span>
                          </td>
                          <td>
                            <button
                              onClick={() => {
                                window.location.hash = `run/${run.runId}`
                                setPage('history')
                              }}
                            >
                              查看
                            </button>
                            <a href={`/api/runs/${run.runId}/report`} download>
                              下载
                            </a>
                          </td>
                        </tr>
                      ))}
                      {state?.runs.length === 0 && (
                        <tr>
                          <td className="empty table-empty" colSpan={5}>
                            暂无运行记录
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </section>

              <section className="task-section">
                <div className="section-heading">
                  <h2>任务状态</h2>
                  <span>{loading ? '读取中' : `${String(state?.tasks.length ?? 0)} 项`}</span>
                </div>
                <div className="task-filters">
                  <label>
                    日期
                    <input
                      type="date"
                      value={taskDate || state?.localDate || ''}
                      onChange={(event) => {
                        setTaskDate(event.target.value)
                      }}
                    />
                  </label>
                  <label>
                    账号
                    <select
                      value={taskAccount}
                      onChange={(event) => {
                        setTaskAccount(event.target.value)
                      }}
                    >
                      <option value="">全部账号</option>
                      {state?.accounts.map((account) => (
                        <option key={account.accountId} value={account.accountId}>
                          {account.displayAlias}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    状态
                    <select
                      value={taskStatus}
                      onChange={(event) => {
                        setTaskStatus(event.target.value)
                      }}
                    >
                      <option value="">全部状态</option>
                      {Object.entries(statusNames).map(([key, label]) => (
                        <option key={key} value={key}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <div className="task-table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>账号</th>
                        <th>任务</th>
                        <th>状态</th>
                        <th>进度</th>
                        <th>更新时间</th>
                      </tr>
                    </thead>
                    <tbody>
                      {state?.tasks
                        .filter(
                          (task) =>
                            (!taskAccount || task.accountId === taskAccount) &&
                            (!taskStatus || task.status === taskStatus)
                        )
                        .map((task) => {
                          const account = state.accounts.find(
                            (item) => item.accountId === task.accountId
                          )
                          return (
                            <tr key={task.taskId}>
                              <td>
                                {account
                                  ? `${String(account.runAccountIndex)}. ${account.displayAlias}`
                                  : '已移除账号'}
                              </td>
                              <td>
                                <strong>{task.displayName || taskNames[task.type]}</strong>
                                {task.reason && <small>{task.reason}</small>}
                              </td>
                              <td>
                                <span className={`status status-${task.status}`}>
                                  {statusNames[task.status] ?? task.status}
                                </span>
                              </td>
                              <td>
                                {task.progress.total === null
                                  ? '待确认'
                                  : `${String(task.progress.completed)}/${String(task.progress.total)}`}
                              </td>
                              <td>
                                {new Date(task.updatedAt).toLocaleTimeString('zh-CN', {
                                  hour12: false
                                })}
                              </td>
                            </tr>
                          )
                        })}
                      {state?.tasks.length === 0 && (
                        <tr>
                          <td className="empty table-empty" colSpan={5}>
                            今日暂无任务记录
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </section>
            </>
          )}
        </section>
      </main>
    </div>
  )
}

function Metric({
  label,
  value,
  tone = ''
}: {
  label: string
  value: number | undefined
  tone?: string
}): ReactElement {
  return (
    <div className={`metric ${tone}`}>
      <span>{label}</span>
      <strong>{value ?? '待确认'}</strong>
    </div>
  )
}

function AccountForm({
  csrfToken,
  onCreated
}: {
  csrfToken: string
  onCreated: () => Promise<void>
}): ReactElement {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [displayAlias, setDisplayAlias] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault()
    setSubmitting(true)
    setError('')
    try {
      const body: { email: string; password: string; displayAlias?: string } = { email, password }
      if (displayAlias.trim()) body.displayAlias = displayAlias.trim()
      await requestJson('/api/accounts', { method: 'POST', body: JSON.stringify(body) }, csrfToken)
      await onCreated()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '账号添加失败')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form className="account-form" onSubmit={(event) => void submit(event)}>
      <label>
        显示名称
        <input
          value={displayAlias}
          onChange={(event) => {
            setDisplayAlias(event.target.value)
          }}
        />
      </label>
      <label>
        Microsoft 账号
        <input
          type="email"
          value={email}
          onChange={(event) => {
            setEmail(event.target.value)
          }}
          autoComplete="username"
          required
        />
      </label>
      <label>
        密码
        <input
          type="password"
          value={password}
          onChange={(event) => {
            setPassword(event.target.value)
          }}
          autoComplete="new-password"
          required
        />
      </label>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      <button className="primary wide" disabled={submitting} type="submit">
        {submitting ? '保存中' : '保存账号'}
      </button>
    </form>
  )
}
