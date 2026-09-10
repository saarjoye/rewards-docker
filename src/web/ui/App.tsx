import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactElement
} from 'react'
import { Card } from 'tdesign-react/es/card/index.js'
import type { RunResultFields } from './RunResultSummary'
import { Dialog } from 'tdesign-react/es/dialog/index.js'
import { Drawer } from 'tdesign-react/es/drawer/index.js'
import { Loading } from 'tdesign-react/es/loading/index.js'
import { Menu } from 'tdesign-react/es/menu/index.js'
import { Radio } from 'tdesign-react/es/radio/index.js'
import {
  DashboardIcon,
  TaskIcon,
  HistoryIcon,
  CalendarIcon,
  UserIcon,
  NotificationIcon,
  RefreshIcon,
  LogoutIcon,
  MenuIcon,
  PlayCircleIcon
} from 'tdesign-icons-react'
import { createRequestQueue } from './requestQueue'
const RunPages = lazy(async () => ({ default: (await import('./RunPages')).RunPages }))
const ScheduleSettings = lazy(async () => ({
  default: (await import('./ScheduleSettings')).ScheduleSettings
}))
const NotificationSettings = lazy(async () => ({
  default: (await import('./NotificationSettings')).NotificationSettings
}))
import { type PointStatistics } from './PointSummary'
import { AccountsPage, Overview, TasksPage } from './ConsolePages'
import { Button, Feedback, Field, SelectField } from './UiKit'

export interface AccountSummary {
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

export interface StatePayload {
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
  today: Array<
    PointStatistics & {
      accountId: string
      accountLabel: string
      dailyBalanceDelta: number | null
      accountTotalPoints?: number | null
      accountTotalPointsAt?: string | null
      verificationStatus: string
    }
  >
}

interface RunSummary extends RunResultFields {
  runId: string
  localDate: string
  executionMode: 'read-only' | 'mutating'
  status: string
  selectedAccountIndexes: number[]
  startedAt: string
  finishedAt?: string
  runBalanceDelta: number | null
  liveBalanceDelta: number | null
  liveBalanceStatus: string
  accountsProcessed: number
  accountsTotal: number
}

interface ApiErrorPayload {
  error?: string
  message?: string
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
  const [busy, setBusy] = useState(false)
  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const result = await requestJson<{ csrfToken: string }>('/api/login', {
        method: 'POST',
        body: JSON.stringify({ username, password })
      })
      setPassword('')
      onLogin(result.csrfToken)
    } catch {
      setError('登录失败，请检查账号密码或稍后重试。')
    } finally {
      setBusy(false)
    }
  }
  return (
    <main className="login-shell">
      <Card className="login-panel" bordered={false}>
        <div className="brand-mark">R</div>
        <h1>Rewards Next</h1>
        <p className="muted">登录管理控制台</p>
        <form className="stack-form" onSubmit={(event) => void submit(event)}>
          <Field
            label="管理员账号"
            value={username}
            onChange={setUsername}
            autoComplete="username"
            required
            disabled={busy}
          />
          <Field
            label="管理员密码"
            type="password"
            value={password}
            onChange={setPassword}
            autoComplete="current-password"
            required
            disabled={busy}
          />
          <Feedback error={error} />
          <Button type="submit" block loading={busy}>
            登录
          </Button>
        </form>
      </Card>
    </main>
  )
}

export function App(): ReactElement {
  const [restoring, setRestoring] = useState(true)
  const [page, setPage] = useState<
    'overview' | 'tasks' | 'history' | 'calendar' | 'accounts' | 'notifications' | 'schedule'
  >(() => {
    const hash = window.location.hash.slice(1)
    if (hash.startsWith('run/')) return 'history'
    return hash === 'tasks' ||
      hash === 'history' ||
      hash === 'calendar' ||
      hash === 'accounts' ||
      hash === 'notifications' ||
      hash === 'schedule'
      ? hash
      : 'overview'
  })
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
  const [accountSaving, setAccountSaving] = useState(false)
  const [unsaved, setUnsaved] = useState(false)
  const unsavedRef = useRef(false)
  unsavedRef.current = unsaved
  const [leaveTarget, setLeaveTarget] = useState('')
  const lastHash = useRef(window.location.hash)
  const main = useRef<HTMLElement>(null)
  const overlayTrigger = useRef<HTMLElement | null>(null)
  const rememberTrigger = () => {
    overlayTrigger.current = document.activeElement as HTMLElement | null
  }
  const restoreTrigger = () => {
    overlayTrigger.current?.focus({ preventScroll: true })
  }

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

  useEffect(() => {
    if (!csrfToken) return
    const stream = new EventSource('/api/events')
    let timer: ReturnType<typeof setTimeout> | undefined
    const refresh = () => {
      if (timer) return
      timer = setTimeout(() => {
        timer = undefined
        void loadState()
        window.dispatchEvent(new Event('rewards-state'))
      }, 150)
    }
    stream.onopen = refresh
    stream.onmessage = refresh
    return () => {
      stream.close()
      if (timer) clearTimeout(timer)
    }
  }, [csrfToken, loadState])

  const selectedAccount = useMemo(
    () => state?.accounts.find((account) => account.runAccountIndex === runAccountIndex),
    [runAccountIndex, state]
  )

  async function startRun(): Promise<void> {
    if (
      !state?.runnerReady ||
      submitting ||
      state.activeRunId ||
      (accountMode === 'account' && !selectedAccount?.enabled)
    )
      return
    setSubmitting(true)
    setError('')
    const body =
      accountMode === 'continue'
        ? { accountMode, executionMode }
        : { accountMode, runAccountIndex, executionMode }
    try {
      await requestJson('/api/runs', { method: 'POST', body: JSON.stringify(body) }, csrfToken)
      setShowRun(false)
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
    if (submitting || !editingAccount || !alias.trim()) return
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

  const [showRun, setShowRun] = useState(false)
  const [showNavigation, setShowNavigation] = useState(false)
  const [confirmStop, setConfirmStop] = useState(false)
  const views = [
    { id: 'overview' as const, label: '概览', icon: <DashboardIcon /> },
    { id: 'tasks' as const, label: '任务', icon: <TaskIcon /> },
    { id: 'history' as const, label: '运行记录', icon: <HistoryIcon /> },
    { id: 'calendar' as const, label: '积分日历', icon: <CalendarIcon /> },
    { id: 'accounts' as const, label: '账号管理', icon: <UserIcon /> },
    { id: 'notifications' as const, label: '消息推送', icon: <NotificationIcon /> },
    { id: 'schedule' as const, label: '定时任务', icon: <CalendarIcon /> }
  ]
  useEffect(() => {
    const change = () => {
      if (unsavedRef.current && window.location.hash !== lastHash.current) {
        setLeaveTarget(window.location.hash)
        window.history.replaceState(null, '', lastHash.current || '#overview')
        return
      }
      lastHash.current = window.location.hash
      setShowNavigation(false)
      window.scrollTo({ top: 0, behavior: 'instant' })
      main.current?.focus({ preventScroll: true })
      const hash = window.location.hash.slice(1)
      if (hash.startsWith('run/'))
        setPage((previous) => (previous === 'calendar' ? previous : 'history'))
      else if (
        hash === 'overview' ||
        hash === 'tasks' ||
        hash === 'history' ||
        hash === 'calendar' ||
        hash === 'accounts' ||
        hash === 'notifications' ||
        hash === 'schedule'
      )
        setPage(hash)
    }
    window.addEventListener('hashchange', change)
    return () => {
      window.removeEventListener('hashchange', change)
    }
  }, [])
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'instant' })
    main.current?.focus({ preventScroll: true })
  }, [page])
  const navigate = (target: string) => {
    if (unsavedRef.current) {
      setLeaveTarget(target)
      return
    }
    if (target === 'logout') {
      void logout()
      return
    }
    window.location.hash = target
    setShowNavigation(false)
  }
  const openRun = (id: string) => {
    navigate('#run/' + id)
  }
  const navigation = (
    <Menu value={page} width="100%">
      {views.map((view) => (
        <Menu.MenuItem
          key={view.id}
          value={view.id}
          icon={view.icon}
          href={'#' + view.id}
          onClick={() => {
            setShowNavigation(false)
          }}
        >
          {view.label}
        </Menu.MenuItem>
      ))}
    </Menu>
  )
  if (restoring)
    return (
      <main className="login-shell">
        <Loading text="正在恢复管理会话" />
      </main>
    )
  if (!csrfToken) return <LoginView onLogin={setCsrfToken} />
  return (
    <div
      className={'app-shell page-' + page}
      onClickCapture={(event) => {
        const anchor = (event.target as HTMLElement).closest<HTMLAnchorElement>('a[href^="#"]')
        if (anchor && unsavedRef.current && anchor.hash !== window.location.hash) {
          event.preventDefault()
          event.stopPropagation()
          setShowNavigation(false)
          setLeaveTarget(anchor.hash)
        }
      }}
    >
      <header className="topbar">
        <div className="brand-row">
          <Button
            className="mobile-menu"
            variant="text"
            shape="square"
            icon={<MenuIcon />}
            aria-label="打开导航"
            onClick={() => {
              rememberTrigger()
              setShowNavigation(true)
            }}
          />
          <div className="brand-mark small">R</div>
          <h1>Rewards Next</h1>
        </div>
        <div className="header-actions">
          <span className="header-date">{state?.localDate} · 上海时间</span>
          <Button
            variant="text"
            icon={<RefreshIcon />}
            loading={loading}
            onClick={() => void loadState()}
          >
            刷新
          </Button>
          <Button
            variant="text"
            icon={<LogoutIcon />}
            onClick={() => {
              navigate('logout')
            }}
          >
            退出
          </Button>
        </div>
      </header>
      <aside className="navigation-rail">
        <nav aria-label="管理视图">{navigation}</nav>
        <div className="rail-footer">
          Rewards 管理控制台
          <br />
          Asia/Shanghai
        </div>
      </aside>
      <main className="content-area" ref={main} tabIndex={-1}>
        <div className="workspace-toolbar">
          <span className="muted">
            {state?.activeRunId ? '有任务正在运行，状态自动更新' : '当前空闲'}
          </span>
          <Button
            icon={<PlayCircleIcon />}
            onClick={() => {
              rememberTrigger()
              if (!selectedAccount?.enabled)
                setRunAccountIndex(state?.accounts.find((a) => a.enabled)?.runAccountIndex ?? 1)
              setShowRun(true)
            }}
          >
            {state?.activeRunId ? '运行控制' : '新建运行'}
          </Button>
        </div>
        <Feedback error={error} />
        {page === 'overview' && <Overview state={state} openRun={openRun} />}
        {page === 'tasks' && <TasksPage state={state} date={taskDate} onDate={setTaskDate} />}
        <Suspense fallback={<Loading text="页面加载中" />}>
          {(page === 'history' || page === 'calendar') && (
            <RunPages key={page} page={page} activeRunId={state?.activeRunId ?? null} />
          )}
          {page === 'accounts' && (
            <AccountsPage
              accounts={state?.accounts ?? []}
              busy={submitting}
              running={Boolean(state?.activeRunId)}
              add={() => {
                rememberTrigger()
                setShowAccountForm(true)
              }}
              edit={(account) => {
                setEditingAccount(account.accountId)
                setAlias(account.displayAlias)
              }}
              toggle={(account) => void toggleAccount(account)}
            />
          )}
          {page === 'notifications' && (
            <NotificationSettings csrfToken={csrfToken} onUnsavedChange={setUnsaved} />
          )}
          {page === 'schedule' && (
            <ScheduleSettings csrfToken={csrfToken} onUnsavedChange={setUnsaved} />
          )}
        </Suspense>
      </main>
      <Drawer
        header="导航"
        placement="left"
        visible={showNavigation}
        onBeforeClose={restoreTrigger}
        onClose={() => {
          setShowNavigation(false)
        }}
        footer={false}
        size="280px"
        destroyOnClose
      >
        <nav aria-label="移动管理视图">{navigation}</nav>
      </Drawer>
      <Drawer
        header="添加账号"
        visible={showAccountForm}
        onBeforeClose={restoreTrigger}
        onClose={() => {
          if (!accountSaving) setShowAccountForm(false)
        }}
        footer={false}
        size="480px"
        destroyOnClose
      >
        <AccountForm
          csrfToken={csrfToken}
          onBusyChange={setAccountSaving}
          onCreated={async () => {
            setShowAccountForm(false)
            await loadState()
          }}
        />
      </Drawer>
      <Dialog
        header="编辑账号名称"
        visible={Boolean(editingAccount)}
        onClose={() => {
          if (!submitting) setEditingAccount('')
        }}
        confirmBtn={{ content: '保存名称', loading: submitting, disabled: !alias.trim() }}
        onConfirm={() => void saveAlias()}
      >
        <Field
          label="名称"
          value={alias}
          onChange={setAlias}
          maxLength={80}
          required
          disabled={submitting}
        />
      </Dialog>
      <Drawer
        header={state?.activeRunId ? '运行控制' : '新建运行'}
        destroyOnClose
        visible={showRun}
        onBeforeClose={restoreTrigger}
        onClose={() => {
          if (!submitting) setShowRun(false)
        }}
        footer={false}
        size="480px"
      >
        <div className="stack-form">
          <Feedback error={error} />
          <div className="form-field">
            <label>运行范围</label>
            <Radio.Group
              value={accountMode}
              onChange={(value) => {
                setAccountMode(value)
              }}
              disabled={Boolean(state?.activeRunId)}
              options={[
                { label: '继续未完成', value: 'continue' },
                { label: '指定账号', value: 'account' }
              ]}
            />
          </div>
          {accountMode === 'account' && (
            <SelectField
              label="运行账号"
              value={String(runAccountIndex)}
              onChange={(value) => {
                setRunAccountIndex(Number(value))
              }}
              disabled={Boolean(state?.activeRunId)}
              options={
                state?.accounts
                  .filter((a) => a.enabled)
                  .map((a) => ({
                    label: '账号 ' + String(a.runAccountIndex) + ' · ' + a.displayAlias,
                    value: String(a.runAccountIndex)
                  })) ?? []
              }
            />
          )}
          <div className="form-field">
            <label>执行方式</label>
            <Radio.Group
              value={executionMode}
              onChange={(value) => {
                setExecutionMode(value)
              }}
              disabled={Boolean(state?.activeRunId)}
              options={[
                { label: '只读检查', value: 'read-only' },
                { label: '执行任务', value: 'mutating' }
              ]}
            />
          </div>
          <p className="muted">
            {executionMode === 'read-only'
              ? '检查任务和现有状态，不提交积分任务。'
              : '执行所选账号的可用任务，结果未知的已提交任务仅复核。'}
          </p>
          {!state?.runnerReady && <Feedback error="执行器尚未就绪" />}
          {!state?.accounts.some((a) => a.enabled) && <p className="muted">请先添加并启用账号。</p>}
          {state?.activeRunId ? (
            <>
              <Button
                variant="outline"
                onClick={() => {
                  openRun(state.activeRunId ?? '')
                  setShowRun(false)
                }}
              >
                查看当前运行
              </Button>
              <Button
                theme="danger"
                variant="outline"
                disabled={submitting}
                onClick={() => {
                  setConfirmStop(true)
                }}
              >
                停止运行
              </Button>
            </>
          ) : (
            <Button
              block
              loading={submitting}
              disabled={
                !state?.runnerReady ||
                !state.accounts.some((a) => a.enabled) ||
                (accountMode === 'account' && !selectedAccount?.enabled)
              }
              onClick={() => void startRun()}
            >
              {executionMode === 'read-only' ? '开始检查' : '开始执行'}
            </Button>
          )}
        </div>
      </Drawer>
      <Dialog
        header="有未保存的修改"
        visible={Boolean(leaveTarget)}
        body="离开将放弃当前输入；也可以留在本页继续编辑并保存。"
        cancelBtn="继续编辑"
        confirmBtn="放弃并离开"
        onClose={() => {
          setLeaveTarget('')
        }}
        onConfirm={() => {
          const target = leaveTarget
          setLeaveTarget('')
          setUnsaved(false)
          unsavedRef.current = false
          navigate(target)
        }}
      />
      <Dialog
        header="停止当前运行？"
        visible={confirmStop}
        onClose={() => {
          if (!submitting) setConfirmStop(false)
        }}
        confirmBtn={{ content: '确认停止', theme: 'danger', loading: submitting }}
        onConfirm={() => {
          void cancelRun().then(() => {
            setConfirmStop(false)
          })
        }}
      >
        正在执行的操作将等待退出；已完成账号和已保存的积分证据会保留。
      </Dialog>
    </div>
  )
}

function AccountForm({
  csrfToken,
  onBusyChange,
  onCreated
}: {
  csrfToken: string
  onBusyChange: (busy: boolean) => void
  onCreated: () => Promise<void>
}): ReactElement {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [alias, setAlias] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    onBusyChange(true)
    setError('')
    try {
      await requestJson(
        '/api/accounts',
        {
          method: 'POST',
          body: JSON.stringify({
            email,
            password,
            ...(alias.trim() ? { displayAlias: alias.trim() } : {})
          })
        },
        csrfToken
      )
      setPassword('')
      await onCreated()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '账号添加失败')
    } finally {
      setBusy(false)
      onBusyChange(false)
    }
  }
  return (
    <form className="stack-form" onSubmit={(event) => void submit(event)}>
      <Field label="显示名称" value={alias} onChange={setAlias} maxLength={80} disabled={busy} />
      <Field
        label="Microsoft 账号"
        type="email"
        value={email}
        onChange={setEmail}
        autoComplete="username"
        required
        disabled={busy}
      />
      <Field
        label="密码"
        type="password"
        value={password}
        onChange={setPassword}
        autoComplete="new-password"
        required
        disabled={busy}
      />
      <Feedback error={error} />
      <Button type="submit" block loading={busy}>
        保存账号
      </Button>
    </form>
  )
}
