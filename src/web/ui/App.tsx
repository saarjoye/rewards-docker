import type { TaskPointDetail } from '../../domain/TaskPointDetail'
import {
  useCallback,
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
import { Checkbox } from 'tdesign-react/es/checkbox/index.js'
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
  PlayCircleIcon,
  SearchIcon,
  InternetIcon
} from 'tdesign-icons-react'
import { createRequestQueue } from './requestQueue'
const RunPages = lazy(async () => ({ default: (await import('./RunPages')).RunPages }))
const ScheduleSettings = lazy(async () => ({
  default: (await import('./ScheduleSettings')).ScheduleSettings
}))
const NotificationSettings = lazy(async () => ({
  default: (await import('./NotificationSettings')).NotificationSettings
}))
const SearchSettings = lazy(async () => ({
  default: (await import('./SearchSettings')).SearchSettings
}))
const NetworkSettings = lazy(async () => ({
  default: (await import('./NetworkSettings')).NetworkSettings
}))
import { type PointStatistics } from './PointSummary'
import { AccountsPage, Overview, TasksPage } from './ConsolePages'
import { Button, Feedback, Field, SelectField } from './UiKit'
import { versionLabel } from './display'

export interface AccountSummary {
  accountId: string
  runAccountIndex: number
  displayAlias: string
  maskedEmail: string
  enabled: boolean
  hasPassword?: boolean
  hasOAuth?: boolean
  hasWebSession?: boolean
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
  version: string
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
      accountTotalPointsSource?: string | null
      dailyBalanceDeltaSource?: string | null
      verificationStatus: string
      taskPointDetails?: TaskPointDetail[]
      expectedDailyPoints?: number | null
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


export interface HealthCheckResult {
  accountId: string
  overallValid: boolean
  balance: number
  nickname?: string
  conflict?: boolean
  conflictMessage?: string
  cookie: {
    valid: boolean
    balance?: number
    userName?: string
    streakDays?: number
    stamps?: { progress: number; max: number }
    pcSearch?: string
    message: string
  }
  token: {
    valid: boolean
    balance?: number
    readProgress?: string
    message: string
    refreshedToken?: unknown
  }
}

function HealthReportModal({
  visible,
  onClose,
  reports,
  accounts
}: {
  visible: boolean
  onClose: () => void
  reports: HealthCheckResult[] | null
  accounts: AccountSummary[]
}): ReactElement {
  const accountMap = useMemo(() => {
    return new Map(accounts.map((a) => [a.accountId, a]))
  }, [accounts])

  return (
    <Dialog
      header="账号秒级体检诊断报告"
      visible={visible}
      onClose={onClose}
      footer={
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '12px' }}>
          <Button onClick={onClose}>确定</Button>
        </div>
      }
      width="680px"
      destroyOnClose
    >
      <div className="health-report-container">
        {!reports || reports.length === 0 ? (
          <p className="muted">暂无体检数据</p>
        ) : (
          reports.map((report) => {
            const acc = accountMap.get(report.accountId)
            const title = acc?.displayAlias || report.nickname || report.accountId.slice(0, 8)
            const email = acc?.maskedEmail || ''
            return (
              <div
                key={report.accountId}
                className={`health-card ${report.overallValid ? 'health-card-valid' : 'health-card-invalid'}`}
              >
                <div className="health-card-header">
                  <div className="health-card-title">
                    <strong>{title}</strong>
                    {email && <span className="muted" style={{ fontSize: '12px' }}>({email})</span>}
                    {report.conflict ? (
                      <span className="badge-tag badge-danger" style={{ background: '#fee2e2', color: '#dc2626' }}>
                        双轨绑定冲突
                      </span>
                    ) : report.overallValid ? (
                      <span className="badge-tag badge-success">正常在线</span>
                    ) : (
                      <span className="badge-tag badge-warning">需要关注</span>
                    )}
                  </div>
                  <div className="health-card-balance">
                    实时余额: {report.conflict ? '数据冲突' : report.balance > 0 ? `${String(report.balance)} 分` : '—'}
                  </div>
                </div>

                {report.conflict && (
                  <div
                    style={{
                      background: '#fef2f2',
                      border: '1px solid #f87171',
                      color: '#991b1b',
                      borderRadius: '4px',
                      padding: '8px 12px',
                      margin: '8px 0 12px',
                      fontSize: '13px'
                    }}
                  >
                    ⚠️ {report.conflictMessage || '双轨凭据冲突：Cookie 与 Token 对应账号不一致，已拦截历史写入'}
                  </div>
                )}

                <div className="health-card-grid">
                  <div className="health-card-col">
                    <div className="health-col-title">
                      <span>Web 会话 (Cookie)</span>
                      {report.cookie.valid ? (
                        <span className="badge-tag badge-success">有效</span>
                      ) : (
                        <span className="badge-tag badge-muted">未就绪</span>
                      )}
                    </div>
                    <div className="health-metric-row">
                      <span>连签天数:</span>
                      <span>{report.cookie.streakDays !== undefined ? `${String(report.cookie.streakDays)} 天` : '—'}</span>
                    </div>
                    <div className="health-metric-row">
                      <span>印章进度:</span>
                      <span>
                        {report.cookie.stamps
                          ? `${String(report.cookie.stamps.progress)} / ${String(report.cookie.stamps.max)}`
                          : '—'}
                      </span>
                    </div>
                    <div className="health-metric-row">
                      <span>PC 搜索:</span>
                      <span>{report.cookie.pcSearch || '—'}</span>
                    </div>
                    <div className="health-col-msg">{report.cookie.message}</div>
                  </div>

                  <div className="health-card-col">
                    <div className="health-col-title">
                      <span>移动端/API (Token)</span>
                      {report.token.valid ? (
                        <span className="badge-tag badge-success">有效</span>
                      ) : (
                        <span className="badge-tag badge-muted">未就绪</span>
                      )}
                    </div>
                    <div className="health-metric-row">
                      <span>阅读新闻:</span>
                      <span>{report.token.readProgress || '—'}</span>
                    </div>
                    <div className="health-metric-row">
                      <span>Token 续期:</span>
                      <span>
                        {report.token.refreshedToken ? (
                          <span style={{ color: '#16a34a' }}>已自动续期</span>
                        ) : (
                          '无需续期'
                        )}
                      </span>
                    </div>
                    <div className="health-col-msg">{report.token.message}</div>
                  </div>
                </div>
              </div>
            )
          })
        )}
      </div>
    </Dialog>
  )
}

export function App(): ReactElement {
  const [restoring, setRestoring] = useState(true)
  const [page, setPage] = useState<
    | 'overview'
    | 'tasks'
    | 'history'
    | 'calendar'
    | 'accounts'
    | 'notifications'
    | 'schedule'
    | 'search'
    | 'network'
  >(() => {
    const hash = window.location.hash.slice(1)
    if (hash.startsWith('run/')) return 'history'
    return hash === 'tasks' ||
      hash === 'history' ||
      hash === 'calendar' ||
      hash === 'accounts' ||
      hash === 'notifications' ||
      hash === 'schedule' ||
      hash === 'search' ||
      hash === 'network'
      ? hash
      : 'overview'
  })
  const [taskDate, setTaskDate] = useState('')
  const taskDateRef = useRef(taskDate)
  taskDateRef.current = taskDate
  const [submitting, setSubmitting] = useState(false)
  const [editingAccount, setEditingAccount] = useState('')
  const [deletingAccount, setDeletingAccount] = useState<AccountSummary | null>(null)
  const [managingAccount, setManagingAccount] = useState<AccountSummary | null>(null)
  const [testingHealth, setTestingHealth] = useState(false)
  const [healthReports, setHealthReports] = useState<HealthCheckResult[] | null>(null)
  const [showHealthModal, setShowHealthModal] = useState(false)
  const [alias, setAlias] = useState('')
  const [csrfToken, setCsrfToken] = useState<string>()
  const [state, setState] = useState<StatePayload>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [calibratingAccount, setCalibratingAccount] = useState<AccountSummary | null>(null)
  const [calibrateMode, setCalibrateMode] = useState<'remote' | 'manual'>('remote')
  const [manualBalanceStr, setManualBalanceStr] = useState('')
  const [manualTodayPointsStr, setManualTodayPointsStr] = useState('')
  const [calibrating, setCalibrating] = useState(false)
  const [accountMode, setAccountMode] = useState<'continue' | 'account'>('continue')
  const [executionMode, setExecutionMode] = useState<'read-only' | 'mutating'>('read-only')
  const [runAccountIndex, setRunAccountIndex] = useState(1)
  const [retryPendingSearch, setRetryPendingSearch] = useState(false)
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
        : { accountMode, runAccountIndex, executionMode, retryPendingSearch }
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

  async function deleteAccount(): Promise<void> {
    if (!deletingAccount || submitting || state?.activeRunId) return
    const accountId = deletingAccount.accountId
    setSubmitting(true)
    setError('')
    try {
      await requestJson(`/api/accounts/${accountId}`, { method: 'DELETE' }, csrfToken)
      setDeletingAccount(null)
      setAccountMode('continue')
      setRunAccountIndex(1)
      setRetryPendingSearch(false)
      try {
        const latest = await requestJson<StatePayload>(
          `/api/state${taskDateRef.current ? `?date=${taskDateRef.current}` : ''}`
        )
        setState(latest)
      } catch {
        setError('账号已删除，但列表刷新失败，请刷新核对')
      }
    } catch (caught) {
      if (caught instanceof Error && caught.message === 'run-already-active') {
        setError('运行期间不能删除账号')
      } else {
        try {
          const latest = await requestJson<StatePayload>(
            `/api/state${taskDateRef.current ? `?date=${taskDateRef.current}` : ''}`
          )
          setState(latest)
          if (latest.accounts.some((account) => account.accountId === accountId)) {
            setError('删除未成功，账号仍保留')
          } else {
            setDeletingAccount(null)
            setAccountMode('continue')
            setRunAccountIndex(1)
            setRetryPendingSearch(false)
          }
        } catch {
          setError('删除结果未确认，请刷新账号列表核对')
        }
      }
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
    { id: 'schedule' as const, label: '定时任务', icon: <CalendarIcon /> },
    { id: 'search' as const, label: '搜索设置', icon: <SearchIcon /> },
    { id: 'network' as const, label: '网络设置', icon: <InternetIcon /> }
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
        hash === 'schedule' ||
        hash === 'search' ||
        hash === 'network'
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
  
  const testAccount = async (account: AccountSummary): Promise<void> => {
    setTestingHealth(true)
    setError('')
    try {
      const data = await requestJson<{ result: HealthCheckResult }>(
        `/api/accounts/${encodeURIComponent(account.accountId)}/test`,
        { method: 'POST' },
        csrfToken
      )
      setHealthReports([data.result])
      setShowHealthModal(true)
      await loadState()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '体检执行失败')
    } finally {
      setTestingHealth(false)
    }
  }

  const testAllAccounts = async (): Promise<void> => {
    setTestingHealth(true)
    setError('')
    try {
      const data = await requestJson<{ results: HealthCheckResult[] }>(
        '/api/accounts/test-all',
        { method: 'POST' },
        csrfToken
      )
      setHealthReports(data.results)
      setShowHealthModal(true)
      await loadState()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '全员体检执行失败')
    } finally {
      setTestingHealth(false)
    }
  }

  const executeCalibration = async (): Promise<void> => {
    if (!calibratingAccount) return
    setCalibrating(true)
    setError('')
    setMessage('')
    try {
      const body: { balance?: number; todayPoints?: number } = {}
      if (calibrateMode === 'manual') {
        const val = parseInt(manualBalanceStr.trim(), 10)
        if (isNaN(val) || val < 0) {
          setError('请输入有效的非负整数积分')
          setCalibrating(false)
          return
        }
        body.balance = val
        if (manualTodayPointsStr.trim()) {
          const tVal = parseInt(manualTodayPointsStr.trim(), 10)
          if (!isNaN(tVal) && tVal >= 0) {
            body.todayPoints = tVal
          }
        }
      }
      const data = await requestJson<{ success: boolean; balance: number; message?: string }>(
        `/api/accounts/${encodeURIComponent(calibratingAccount.accountId)}/calibrate`,
        {
          method: 'POST',
          body: JSON.stringify(body)
        },
        csrfToken
      )
      setMessage(data.message || `积分校准成功：已回填 ${String(data.balance)} 分`)
      setCalibratingAccount(null)
      await loadState()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '积分校准失败')
    } finally {
      setCalibrating(false)
    }
  }

  const startCalibration = (accountId: string) => {
    const account = state?.accounts.find((a) => a.accountId === accountId)
    if (!account) return
    setError('')
    setMessage('')
    setCalibratingAccount(account)
    setCalibrateMode('remote')
    setManualBalanceStr('')
    setManualTodayPointsStr('')
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
          <span className="header-version" data-testid="app-version">
            版本 {versionLabel(state?.version)}
          </span>
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
        <Feedback error={error} message={message} />
        {page === 'overview' && <Overview state={state} openRun={openRun} onCalibrateAccount={startCalibration} />}
        {page === 'tasks' && <TasksPage state={state} date={taskDate} onDate={setTaskDate} />}
        <Suspense fallback={<Loading text="页面加载中" />}>
          {(page === 'history' || page === 'calendar') && (
            <RunPages key={page} page={page} activeRunId={state?.activeRunId ?? null} state={state} />
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
              manageCredentials={(account: AccountSummary) => {
                rememberTrigger()
                setManagingAccount(account)
              }}
              toggle={(account) => void toggleAccount(account)}
              remove={(account) => {
                rememberTrigger()
                setDeletingAccount(account)
              }}
              testAccount={(account) => {
                void testAccount(account)
              }}
              testAllAccounts={() => {
                void testAllAccounts()
              }}
              testing={testingHealth}
              calibrateAccount={(account) => {
                setError('')
                setMessage('')
                setCalibratingAccount(account)
                setCalibrateMode('remote')
                setManualBalanceStr('')
              }}
              calibrating={calibrating}
            />
          )}
          {page === 'notifications' && (
            <NotificationSettings csrfToken={csrfToken} onUnsavedChange={setUnsaved} />
          )}
          {page === 'schedule' && (
            <ScheduleSettings csrfToken={csrfToken} onUnsavedChange={setUnsaved} />
          )}
          {page === 'search' && (
            <SearchSettings csrfToken={csrfToken} onUnsavedChange={setUnsaved} accounts={state?.accounts ?? []} />
          )}
          {page === 'network' && (
            <NetworkSettings csrfToken={csrfToken} onUnsavedChange={setUnsaved} />
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
        size="520px"
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
      <Drawer
        header={managingAccount ? `凭据与会话托管: ${managingAccount.displayAlias}` : '凭据与会话托管'}
        visible={managingAccount !== null}
        onBeforeClose={restoreTrigger}
        onClose={() => {
          setManagingAccount(null)
        }}
        footer={false}
        size="540px"
        destroyOnClose
      >
        {managingAccount && (
          <CredentialsDrawerContent
            account={managingAccount}
            csrfToken={csrfToken}
            onUpdated={async () => {
              await loadState()
            }}
          />
        )}
      </Drawer>
      <HealthReportModal
        visible={showHealthModal}
        onClose={() => {
          setShowHealthModal(false)
        }}
        reports={healthReports}
        accounts={state?.accounts ?? []}
      />
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
      <Dialog
        header="删除账号？"
        visible={deletingAccount !== null}
        onClose={() => {
          if (!submitting) {
            setDeletingAccount(null)
            restoreTrigger()
          }
        }}
        confirmBtn={{
          content: '永久删除',
          theme: 'danger',
          loading: submitting,
          disabled: Boolean(state?.activeRunId)
        }}
        onConfirm={() => void deleteAccount()}
      >
        将删除 {deletingAccount?.displayAlias}（{deletingAccount?.maskedEmail}
        ）的账号配置与加密会话。此操作无法撤销；已有运行及积分历史保留。
      </Dialog>
      <Dialog
        header="校准真实积分并回填"
        visible={Boolean(calibratingAccount)}
        onClose={() => {
          if (!calibrating) {
            setCalibratingAccount(null)
            restoreTrigger()
          }
        }}
        confirmBtn={{
          content: calibrating ? '正在校准...' : '确认校准并回填',
          loading: calibrating,
          disabled: calibrating || (calibrateMode === 'manual' && !manualBalanceStr.trim())
        }}
        onConfirm={() => void executeCalibration()}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <p>
            正在校准账号：<strong>{calibratingAccount?.displayAlias}</strong>
            <span className="muted">（{calibratingAccount?.maskedEmail}）</span>
          </p>
          <div className="form-field">
            <label>校准方式</label>
            <Radio.Group
              value={calibrateMode}
              onChange={(value) => { setCalibrateMode(value) }}
              disabled={calibrating}
              options={[
                { label: '从微软远程读取实时总积分（推荐）', value: 'remote' },
                { label: '手动输入微软真实总积分', value: 'manual' }
              ]}
            />
          </div>
          {calibrateMode === 'remote' ? (
            <p className="muted" style={{ margin: 0 }}>
              系统将通过 Cookie / App Token 向微软官方接口获取实时真实总积分与今日已获积分，直接写入项目并重置开盘基准，自动清理口径冲突与历史脏观测，消除 [数据冲突] 异常并恢复正常统计。
            </p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <Field
                label="真实总积分"
                value={manualBalanceStr}
                onChange={setManualBalanceStr}
                placeholder="例如 12993"
                required
                disabled={calibrating}
              />
              <Field
                label="今日已获得积分（选填）"
                value={manualTodayPointsStr}
                onChange={setManualTodayPointsStr}
                placeholder="例如 275（不填则默认今日增长为 0）"
                disabled={calibrating}
              />
              <p className="muted" style={{ margin: 0, fontSize: '12px' }}>
                当网络异常或接口受限时，可直接输入官网当前真实积分与今日已获积分，将作为权威基准直接写入系统并清除冲突。
              </p>
            </div>
          )}
        </div>
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
                if (value === 'continue') setRetryPendingSearch(false)
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
                if (value === 'read-only') setRetryPendingSearch(false)
              }}
              disabled={Boolean(state?.activeRunId)}
              options={[
                { label: '只读检查', value: 'read-only' },
                { label: '执行任务', value: 'mutating' }
              ]}
            />
          </div>
          {accountMode === 'account' && executionMode === 'mutating' && (
            <div className="form-field">
              <Checkbox
                checked={retryPendingSearch}
                onChange={(checked) => {
                  setRetryPendingSearch(checked)
                }}
                disabled={Boolean(state?.activeRunId)}
              >
                授权重试未确认的搜索（最多一次）
              </Checkbox>
              <p className="muted">仅对指定账号生效，提交后会等待进度复核。</p>
            </div>
          )}
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

const OAUTH_AUTHORIZE_URL =
  'https://login.live.com/oauth20_authorize.srf?client_id=0000000040170455&response_type=code&scope=service::prod.rewardsplatform.microsoft.com::MBI_SSL&redirect_uri=https://login.live.com/oauth20_desktop.srf'

function AccountForm({
  csrfToken,
  onBusyChange,
  onCreated
}: {
  csrfToken: string
  onBusyChange: (busy: boolean) => void
  onCreated: () => Promise<void>
}): ReactElement {
  const [mode, setMode] = useState<'managed' | 'password'>('managed')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [alias, setAlias] = useState('')
  const [oauthCode, setOauthCode] = useState('')
  const [cookies, setCookies] = useState('')
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
            ...(password ? { password } : {}),
            ...(alias.trim() ? { displayAlias: alias.trim() } : {}),
            ...(mode === 'managed' && oauthCode.trim() ? { oauthCode: oauthCode.trim() } : {}),
            ...(mode === 'managed' && cookies.trim() ? { cookies: cookies.trim() } : {})
          })
        },
        csrfToken
      )
      setPassword('')
      setOauthCode('')
      setCookies('')
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
      <div className="credentials-mode-tabs" role="tablist">
        <button
          type="button"
          className={`credentials-mode-tab ${mode === 'managed' ? 'active' : ''}`}
          onClick={() => {
            setMode('managed')
          }}
        >
          OAuth + Cookie 托管（推荐）
        </button>
        <button
          type="button"
          className={`credentials-mode-tab ${mode === 'password' ? 'active' : ''}`}
          onClick={() => {
            setMode('password')
          }}
        >
          账号密码（传统模式）
        </button>
      </div>

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

      {mode === 'managed' ? (
        <>
          <div className="oauth-helper-card">
            <p style={{ margin: '0 0 6px 0', fontWeight: 600 }}>1. 绑定微软官方 OAuth 授权（免密运行核心）：</p>
            <p style={{ margin: '0 0 8px 0' }} className="muted">
              在已登录此账号的浏览器中打开下方授权页面，同意后浏览器将重定向至空白页，复制地址栏完整 URL 或 code 粘贴到下方：
            </p>
            <a
              href={OAUTH_AUTHORIZE_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="oauth-link-btn"
            >
              打开微软官方授权页面 ↗
            </a>
            <Field
              label="授权重定向链接或授权码"
              value={oauthCode}
              onChange={setOauthCode}
              placeholder="https://login.live.com/oauth20_desktop.srf?code=... 或 code 字符串"
              disabled={busy}
            />
          </div>

          <div className="form-field">
            <label>2. 托管 Web Cookie（可选，绕过无头登录风控）：</label>
            <textarea
              className="native-textarea"
              rows={4}
              value={cookies}
              onChange={(e) => {
                setCookies(e.target.value)
              }}
              placeholder="粘贴 Cookie-Editor 导出的 JSON 数组、Playwright storageState 或 HTTP Cookie 标头 (name=value; ...)"
              disabled={busy}
            />
            <small className="muted">支持 bing.com 与 rewards.bing.com 的登录 Cookie，免受无头验证码拦截。</small>
          </div>

          <Field
            label="备用密码（可选）"
            type="password"
            value={password}
            onChange={setPassword}
            autoComplete="new-password"
            placeholder="纯免密模式可直接留空"
            disabled={busy}
          />
        </>
      ) : (
        <Field
          label="密码"
          type="password"
          value={password}
          onChange={setPassword}
          autoComplete="new-password"
          required
          disabled={busy}
        />
      )}

      <Feedback error={error} />
      <Button type="submit" block loading={busy}>
        保存账号
      </Button>
    </form>
  )
}

interface CredentialsStatusPayload {
  accountId: string
  hasPassword: boolean
  oauth: {
    bound: boolean
    hasRefreshToken: boolean
    expiresAt?: string
    validatedAt?: string
  }
  webSession: {
    bound: boolean
    desktopCookieCount: number
    mobileCookieCount: number
    validatedAt?: string
  }
}

function CredentialsDrawerContent({
  account,
  csrfToken,
  onUpdated
}: {
  account: AccountSummary
  csrfToken?: string
  onUpdated: () => Promise<void>
}): ReactElement {
  const [status, setStatus] = useState<CredentialsStatusPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')

  const [newPassword, setNewPassword] = useState('')
  const [oauthInput, setOauthInput] = useState('')
  const [cookieInput, setCookieInput] = useState('')

  const fetchStatus = useCallback(async () => {
    try {
      const data = await requestJson<CredentialsStatusPayload>(
        `/api/accounts/${account.accountId}/credentials-status`
      )
      setStatus(data)
      setError('')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '获取凭证状态失败')
    } finally {
      setLoading(false)
    }
  }, [account.accountId])

  useEffect(() => {
    void fetchStatus()
  }, [fetchStatus])

  async function handleUpdatePassword(clear = false): Promise<void> {
    if (busy) return
    setBusy(true)
    setError('')
    setMessage('')
    try {
      await requestJson(
        `/api/accounts/${account.accountId}`,
        {
          method: 'PATCH',
          body: JSON.stringify({ password: clear ? '' : newPassword })
        },
        csrfToken
      )
      setNewPassword('')
      setMessage(clear ? '密码已成功清除（进入免密模式）' : '密码已成功更新')
      await fetchStatus()
      await onUpdated()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '更新密码失败')
    } finally {
      setBusy(false)
    }
  }

  async function handleImportOAuth(): Promise<void> {
    if (busy || !oauthInput.trim()) return
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const res = await requestJson<{ success: boolean; expiresAt: string }>(
        `/api/accounts/${account.accountId}/oauth`,
        {
          method: 'POST',
          body: JSON.stringify({ code: oauthInput.trim() })
        },
        csrfToken
      )
      setOauthInput('')
      setMessage(`OAuth 授权兑换成功！有效期至 ${new Date(res.expiresAt).toLocaleString()}`)
      await fetchStatus()
      await onUpdated()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'OAuth 绑定失败')
    } finally {
      setBusy(false)
    }
  }

  async function handleImportCookies(): Promise<void> {
    if (busy || !cookieInput.trim()) return
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const res = await requestJson<{ success: boolean; cookieCount: number }>(
        `/api/accounts/${account.accountId}/cookies`,
        {
          method: 'POST',
          body: JSON.stringify({ cookies: cookieInput.trim() })
        },
        csrfToken
      )
      setCookieInput('')
      setMessage(`成功导入并更新 ${String(res.cookieCount)} 个 Cookie！`)
      await fetchStatus()
      await onUpdated()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Cookie 导入失败')
    } finally {
      setBusy(false)
    }
  }

  async function handleClearSession(): Promise<void> {
    if (busy) return
    setBusy(true)
    setError('')
    setMessage('')
    try {
      await requestJson(
        `/api/accounts/${account.accountId}/session`,
        {
          method: 'DELETE'
        },
        csrfToken
      )
      setMessage('该账号的全部托管会话已清空')
      await fetchStatus()
      await onUpdated()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '清空会话失败')
    } finally {
      setBusy(false)
    }
  }

  if (loading) {
    return <p className="muted">正在加载凭证状态...</p>
  }

  return (
    <div className="credentials-drawer-body">
      <Feedback error={error} message={message} />

      <div className="credentials-section">
        <h4>
          <span>OAuth 授权令牌</span>
          {status?.oauth.bound ? (
            <span className="badge-tag badge-success">已绑定</span>
          ) : (
            <span className="badge-tag badge-muted">未绑定</span>
          )}
        </h4>
        {status?.oauth.bound ? (
          <p className="muted" style={{ margin: '0 0 10px 0', fontSize: '12px' }}>
            {status.oauth.hasRefreshToken ? '✅ 包含长效刷新令牌（支持自动静默续期）' : '⚠️ 未包含刷新令牌'}
            {status.oauth.expiresAt && ` · 到期时间: ${new Date(status.oauth.expiresAt).toLocaleString()}`}
          </p>
        ) : (
          <p className="muted" style={{ margin: '0 0 10px 0', fontSize: '12px' }}>
            绑定 OAuth 授权码后，签到与阅读等操作将免登录直接调用官方接口，大幅降低风控概率。
          </p>
        )}
        <div className="oauth-helper-card" style={{ marginBottom: '8px' }}>
          <a
            href={OAUTH_AUTHORIZE_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="oauth-link-btn"
          >
            打开微软官方授权页面 ↗
          </a>
          <Field
            label="粘贴授权跳转 URL 或 code="
            value={oauthInput}
            onChange={setOauthInput}
            placeholder="https://login.live.com/oauth20_desktop.srf?code=... 或 code"
            disabled={busy}
          />
          <div style={{ marginTop: '8px' }}>
            <Button
              onClick={() => void handleImportOAuth()}
              disabled={busy || !oauthInput.trim()}
              loading={busy}
            >
              换取并绑定 OAuth 令牌
            </Button>
          </div>
        </div>
      </div>

      <div className="credentials-section">
        <h4>
          <span>Web 会话 Cookie</span>
          {status?.webSession.bound ? (
            <span className="badge-tag badge-success">已导入</span>
          ) : (
            <span className="badge-tag badge-muted">未导入</span>
          )}
        </h4>
        {status?.webSession.bound ? (
          <p className="muted" style={{ margin: '0 0 10px 0', fontSize: '12px' }}>
            已存储 Desktop: {status.webSession.desktopCookieCount} 个 / Mobile: {status.webSession.mobileCookieCount} 个 Cookie
            {status.webSession.validatedAt && ` · 更新于: ${new Date(status.webSession.validatedAt).toLocaleString()}`}
          </p>
        ) : (
          <p className="muted" style={{ margin: '0 0 10px 0', fontSize: '12px' }}>
            托管浏览器 Cookie 可供 PC/移动端搜索直接复用已登录会话，免除无头浏览器登录风险。
          </p>
        )}
        <div className="form-field">
          <textarea
            className="native-textarea"
            rows={4}
            value={cookieInput}
            onChange={(e) => {
              setCookieInput(e.target.value)
            }}
            placeholder="粘贴 Cookie-Editor 导出的 JSON 数组、Playwright storageState 或 HTTP Cookie 标头 (name=value; ...)"
            disabled={busy}
          />
        </div>
        <div style={{ marginTop: '8px' }}>
          <Button
            onClick={() => void handleImportCookies()}
            disabled={busy || !cookieInput.trim()}
            loading={busy}
          >
            导入并覆盖 Web Cookie
          </Button>
        </div>
      </div>

      <div className="credentials-section">
        <h4>
          <span>账号密码</span>
          {status?.hasPassword ? (
            <span className="badge-tag badge-info">已配置</span>
          ) : (
            <span className="badge-tag badge-muted">免密模式</span>
          )}
        </h4>
        <Field
          label="设置或修改密码"
          type="password"
          value={newPassword}
          onChange={setNewPassword}
          placeholder="输入新密码"
          disabled={busy}
        />
        <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
          <Button
            onClick={() => void handleUpdatePassword(false)}
            disabled={busy || !newPassword.trim()}
            loading={busy}
          >
            保存密码
          </Button>
          {status?.hasPassword && (
            <Button
              variant="text"
              theme="danger"
              onClick={() => void handleUpdatePassword(true)}
              disabled={busy}
            >
              清除密码（转为免密）
            </Button>
          )}
        </div>
      </div>

      <div className="credentials-section" style={{ borderColor: 'rgba(239, 68, 68, 0.3)' }}>
        <h4 style={{ color: '#dc2626' }}>危险操作：清空已存会话</h4>
        <p className="muted" style={{ fontSize: '12px', margin: '0 0 10px 0' }}>
          将清除此账号已保存的所有 OAuth 令牌和 Web Cookie，账号本身与历史积分记录不受影响。
        </p>
        <Button
          theme="danger"
          onClick={() => void handleClearSession()}
          disabled={busy || (!status?.oauth.bound && !status?.webSession.bound)}
          loading={busy}
        >
          清空所有已存会话
        </Button>
      </div>
    </div>
  )
}
