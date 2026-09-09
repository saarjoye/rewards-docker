import type { BrowserContext, Page } from 'patchright'

import { LoginStateError, requiresUserAction, type LoginState } from '../auth/LoginState.js'
import type { AccountBrowserSlot } from '../browser/BrowserRuntime.js'
import type { LoginStateSnapshot } from '../browser/LoginController.js'
import type { FieldEvidence, FieldAvailability } from '../domain/Evidence.js'
import {
  summarizeTasks,
  type CanonicalTaskType,
  type TaskRecord,
  type TaskStatus
} from '../domain/Task.js'
import type { AccountCredentials } from '../infra/AccountSecretStore.js'
import type { SearchQuota } from '../rewards/RewardsModel.js'

export interface AcceptanceAccount {
  accountIndex: number
  credentials: AccountCredentials
}

export type AcceptanceRegionStatus = 'confirmed-cn' | 'region-mismatch' | 'region-unconfirmed'

export interface AcceptanceInspection {
  loginStage: string
  loginTransitions: readonly AcceptanceLoginTransition[]
  executionCapabilities: readonly AcceptanceExecutionCapability[]
  market: FieldEvidence<string>
  searchCounters: {
    pc: FieldEvidence<SearchQuota>
    mobile: FieldEvidence<SearchQuota>
  }
  dataSources: Readonly<Record<'rsc' | 'dom' | 'dashboard' | 'flyout' | 'app-dashboard', boolean>>
  tasks: readonly TaskRecord[]
}

export type AcceptanceExecutionPath =
  | 'report-activity'
  | 'navigate-only'
  | 'interactive-quiz'
  | 'interactive-poll'
  | 'search-browser'
  | 'app-api'
  | 'claim-server-action'
  | 'claim-ui'
  | 'unsupported'

export interface AcceptanceExecutionCapability {
  type: CanonicalTaskType
  path: AcceptanceExecutionPath
}

export interface AcceptanceLoginTransition {
  phase: 'microsoft' | 'bing'
  state: LoginState
  stage: string
  location: 'login-live' | 'login-microsoft' | 'rewards' | 'bing' | 'account' | 'other'
}

export interface AcceptanceTaskSummary {
  type: CanonicalTaskType
  count: number
  executable: number
  statuses: readonly TaskStatus[]
  statusCounts: readonly { status: TaskStatus; count: number }[]
  executionPaths: readonly { path: AcceptanceExecutionPath; count: number }[]
}

export interface AcceptanceAccountReport {
  accountIndex: number
  status: 'passed' | 'region-mismatch' | 'region-unconfirmed' | 'action-required' | 'failed'
  loginStage: string
  loginTransitions: readonly AcceptanceLoginTransition[]
  region: {
    status: AcceptanceRegionStatus
    availability: FieldAvailability
    source: FieldEvidence<string>['source']
  }
  dataSources: Readonly<Record<'rsc' | 'dom' | 'dashboard' | 'flyout' | 'app-dashboard', boolean>>
  tasks: readonly AcceptanceTaskSummary[]
  totals: ReturnType<typeof summarizeTasks>
  searchCounters: {
    pc: { availability: FieldAvailability; status: TaskStatus }
    mobile: { availability: FieldAvailability; status: TaskStatus }
  }
  claimStatus: TaskStatus
  durationMs: number
  errorCode?: string
}

export interface AcceptanceReport {
  schemaVersion: 1
  mode: 'read-only'
  generatedAt: string
  accounts: readonly AcceptanceAccountReport[]
}

export class AcceptanceConfigurationError extends Error {
  constructor(readonly code: string) {
    super(`Acceptance account configuration is invalid: ${code}`)
    this.name = 'AcceptanceConfigurationError'
  }
}

export class AcceptanceInspectionError extends Error {
  constructor(
    readonly status: 'action-required' | 'failed',
    readonly stage: string,
    readonly code: string
  ) {
    super(`Acceptance inspection stopped: ${code}`)
    this.name = 'AcceptanceInspectionError'
  }
}

export function readAcceptanceAccounts(
  env: Readonly<Record<string, string | undefined>>
): readonly AcceptanceAccount[] {
  const configuredIndexes = new Set<number>()
  for (const key of Object.keys(env)) {
    const match = /^ACCOUNT_(\d+)_(EMAIL|PASSWORD)$/.exec(key)
    if (match?.[1]) configuredIndexes.add(Number(match[1]))
  }
  if ([...configuredIndexes].some((index) => index < 1 || index > 3)) {
    throw new AcceptanceConfigurationError('unexpected-account-index')
  }

  return [1, 2, 3].map((accountIndex) => {
    const email = env[`ACCOUNT_${String(accountIndex)}_EMAIL`]
    const password = env[`ACCOUNT_${String(accountIndex)}_PASSWORD`]
    if (!email?.trim() || !password) {
      throw new AcceptanceConfigurationError(`incomplete-account-${String(accountIndex)}`)
    }
    return {
      accountIndex,
      credentials: { email: email.trim(), password }
    }
  })
}

export function readSingleAcceptanceAccount(
  env: Readonly<Record<string, string | undefined>>,
  args: readonly string[]
): AcceptanceAccount {
  const selected = selectAcceptanceAccounts(
    args,
    [1, 2, 3].map((accountIndex) => ({
      accountIndex,
      credentials: { email: '', password: '' }
    }))
  )
  if (selected.length !== 1 || !selected[0])
    throw new AcceptanceConfigurationError('single-account-required')
  const accountIndex = selected[0].accountIndex
  const email = env[`ACCOUNT_${String(accountIndex)}_EMAIL`]
  const password = env[`ACCOUNT_${String(accountIndex)}_PASSWORD`]
  if (!email?.trim() || !password)
    throw new AcceptanceConfigurationError('selected-account-incomplete')
  return { accountIndex, credentials: { email: email.trim(), password } }
}

export function selectAcceptanceAccounts(
  args: readonly string[],
  accounts: readonly AcceptanceAccount[]
): readonly AcceptanceAccount[] {
  const values = args
    .filter((argument) => argument.startsWith('--account-index='))
    .map((argument) => argument.slice('--account-index='.length))
  if (values.length === 0) return accounts
  if (values.length > 1) throw new AcceptanceConfigurationError('account-index-duplicate')
  const value = values[0]
  if (value === undefined || !/^\d+$/.test(value)) {
    throw new AcceptanceConfigurationError('account-index-invalid')
  }
  const accountIndex = Number(value)
  const account = accounts.find((candidate) => candidate.accountIndex === accountIndex)
  if (!Number.isSafeInteger(accountIndex) || account === undefined) {
    throw new AcceptanceConfigurationError('account-index-out-of-range')
  }
  return [account]
}

export function classifyAcceptanceRegion(market: FieldEvidence<string>): AcceptanceRegionStatus {
  if (market.availability !== 'valid' || market.value === undefined) return 'region-unconfirmed'
  return market.value.toUpperCase() === 'CN' ? 'confirmed-cn' : 'region-mismatch'
}

const TASK_TYPES: readonly CanonicalTaskType[] = [
  'claim-bonus-points',
  'app-activity',
  'daily-set',
  'special-promotion',
  'more-promotion',
  'app-check-in',
  'read-to-earn',
  'punch-card',
  'mobile-search',
  'pc-search',
  'unknown'
]

function taskSummary(
  tasks: readonly TaskRecord[],
  capabilities: readonly AcceptanceExecutionCapability[]
): readonly AcceptanceTaskSummary[] {
  return TASK_TYPES.map((type) => {
    const matching = tasks.filter((task) => task.type === type)
    const paths = capabilities.filter((capability) => capability.type === type)
    return {
      type,
      count: matching.length,
      executable: matching.filter((task) => task.executable).length,
      statuses: [...new Set(matching.map((task) => task.status))].sort(),
      statusCounts: [...new Set(matching.map((task) => task.status))].sort().map((status) => ({
        status,
        count: matching.filter((task) => task.status === status).length
      })),
      executionPaths: [...new Set(paths.map((capability) => capability.path))]
        .sort()
        .map((path) => ({
          path,
          count: paths.filter((capability) => capability.path === path).length
        }))
    }
  })
}

function searchCounter(
  tasks: readonly TaskRecord[],
  type: 'pc-search' | 'mobile-search',
  evidence: FieldEvidence<SearchQuota>
): { availability: FieldAvailability; status: TaskStatus } {
  const task = tasks.find((item) => item.type === type)
  if (!task) return { availability: evidence.availability, status: 'unknown' }
  return {
    availability: evidence.availability,
    status: task.status
  }
}

function claimStatus(tasks: readonly TaskRecord[]): TaskStatus {
  const task = tasks.find((item) => item.type === 'claim-bonus-points')
  if (!task) return 'unknown'
  if (task.status === 'skipped' && (task.progress.completed !== 1 || task.progress.total !== 1)) {
    return 'unknown'
  }
  return task.status
}

export function createAcceptanceAccountReport(input: {
  accountIndex: number
  inspection: AcceptanceInspection
  durationMs: number
}): AcceptanceAccountReport {
  const regionStatus = classifyAcceptanceRegion(input.inspection.market)
  return {
    accountIndex: input.accountIndex,
    status:
      regionStatus === 'confirmed-cn'
        ? 'passed'
        : regionStatus === 'region-mismatch'
          ? 'region-mismatch'
          : 'region-unconfirmed',
    loginStage: input.inspection.loginStage,
    loginTransitions: input.inspection.loginTransitions,
    region: {
      status: regionStatus,
      availability: input.inspection.market.availability,
      source: input.inspection.market.source
    },
    dataSources: input.inspection.dataSources,
    tasks: taskSummary(input.inspection.tasks, input.inspection.executionCapabilities),
    totals: summarizeTasks(input.inspection.tasks),
    searchCounters: {
      pc: searchCounter(input.inspection.tasks, 'pc-search', input.inspection.searchCounters.pc),
      mobile: searchCounter(
        input.inspection.tasks,
        'mobile-search',
        input.inspection.searchCounters.mobile
      )
    },
    claimStatus: claimStatus(input.inspection.tasks),
    durationMs: input.durationMs
  }
}

export interface AcceptanceLoginController {
  login(page: Page, credentials: AccountCredentials, signal: AbortSignal): Promise<void>
  detectCurrentState(page: Page): Promise<LoginStateSnapshot>
}

export async function loginWithManualAssistance(input: {
  controller: AcceptanceLoginController
  page: Page
  credentials: AccountCredentials
  signal: AbortSignal
  manualTimeoutMs?: number
  pollIntervalMs?: number
  now?: () => number
  sleep?: (milliseconds: number) => Promise<void>
  onActionRequired?: (state: LoginState) => void
}): Promise<string> {
  const now = input.now ?? Date.now
  const sleep = input.sleep ?? ((milliseconds: number) => input.page.waitForTimeout(milliseconds))
  try {
    await input.controller.login(input.page, input.credentials, input.signal)
    return 'login-complete'
  } catch (error) {
    if (!(error instanceof LoginStateError) || !requiresUserAction(error.loginState)) throw error
    input.onActionRequired?.(error.loginState)
  }

  const deadline = now() + (input.manualTimeoutMs ?? 300_000)
  while (now() < deadline) {
    if (input.signal.aborted) throw input.signal.reason
    const snapshot = await input.controller.detectCurrentState(input.page)
    if (snapshot.state === 'error-alert') {
      throw new AcceptanceInspectionError('failed', snapshot.loginStage, 'login-error-alert')
    }
    if (requiresUserAction(snapshot.state)) {
      await sleep(input.pollIntervalMs ?? 2_500)
      continue
    }
    try {
      await input.controller.login(input.page, input.credentials, input.signal)
      return 'login-complete-after-user-action'
    } catch (error) {
      if (!(error instanceof LoginStateError) || !requiresUserAction(error.loginState)) throw error
      input.onActionRequired?.(error.loginState)
    }
  }
  throw new AcceptanceInspectionError('action-required', 'login-user-action', 'user-action-timeout')
}

export interface AcceptanceSequenceDependencies {
  openSlot(account: AcceptanceAccount): Promise<AccountBrowserSlot>
  inspect(
    account: AcceptanceAccount,
    slot: AccountBrowserSlot,
    signal: AbortSignal
  ): Promise<AcceptanceInspection>
  now?: () => number
  generatedAt?: () => string
  onAccountStart?: (accountIndex: number) => void
  onAccountComplete?: (report: AcceptanceAccountReport) => void
}

function emptySources(): AcceptanceAccountReport['dataSources'] {
  return { rsc: false, dom: false, dashboard: false, flyout: false, 'app-dashboard': false }
}

function failedAccountReport(
  accountIndex: number,
  durationMs: number,
  error: unknown
): AcceptanceAccountReport {
  const known = error instanceof AcceptanceInspectionError
  const login = error instanceof LoginStateError
  const loginErrorCode = (() => {
    if (!login) return undefined
    if (error.loginStage === 'login-timeout') {
      const host = error.host.toLowerCase()
      const location =
        host === 'login.live.com' || host.startsWith('login.microsoft')
          ? 'login'
          : host === 'rewards.bing.com'
            ? 'rewards'
            : host === 'bing.com' || host.endsWith('.bing.com')
              ? 'bing'
              : 'other'
      return `login-timeout-at-${location}`
    }
    if (error.loginState !== 'error-alert') return error.loginState
    if (/incorrect|invalid credential|wrong password|密码.*(?:错误|不正确)/i.test(error.message)) {
      return 'login-invalid-credentials'
    }
    if (/locked|blocked|锁定|冻结/i.test(error.message)) return 'login-account-restricted'
    if (/too many|try again later|稍后重试|次数过多/i.test(error.message)) {
      return 'login-rate-limited'
    }
    return 'login-error-alert'
  })()
  return {
    accountIndex,
    status: known ? error.status : 'failed',
    loginStage: known ? error.stage : login ? error.loginStage : 'acceptance-failed',
    loginTransitions: [],
    region: {
      status: 'region-unconfirmed',
      availability: 'unknown',
      source: 'browser-response'
    },
    dataSources: emptySources(),
    tasks: taskSummary([], []),
    totals: summarizeTasks([]),
    searchCounters: {
      pc: { availability: 'unknown', status: 'unknown' },
      mobile: { availability: 'unknown', status: 'unknown' }
    },
    claimStatus: 'unknown',
    durationMs,
    errorCode: known ? error.code : (loginErrorCode ?? 'acceptance-failed')
  }
}

export async function runAcceptanceSequence(
  accounts: readonly AcceptanceAccount[],
  dependencies: AcceptanceSequenceDependencies,
  signal = new AbortController().signal
): Promise<AcceptanceReport> {
  const now = dependencies.now ?? Date.now
  const seenContexts = new Set<BrowserContext>()
  const reports: AcceptanceAccountReport[] = []
  for (const account of accounts) {
    dependencies.onAccountStart?.(account.accountIndex)
    const started = now()
    let slot: AccountBrowserSlot | undefined
    let report: AcceptanceAccountReport
    try {
      slot = await dependencies.openSlot(account)
      if (seenContexts.has(slot.context)) {
        throw new AcceptanceInspectionError('failed', 'context-isolation', 'context-reused')
      }
      seenContexts.add(slot.context)
      const inspection = await dependencies.inspect(account, slot, signal)
      report = createAcceptanceAccountReport({
        accountIndex: account.accountIndex,
        inspection,
        durationMs: Math.max(0, now() - started)
      })
    } catch (error) {
      report = failedAccountReport(account.accountIndex, Math.max(0, now() - started), error)
    } finally {
      await slot?.close().catch(() => undefined)
    }
    reports.push(report)
    dependencies.onAccountComplete?.(report)
  }
  return {
    schemaVersion: 1,
    mode: 'read-only',
    generatedAt: dependencies.generatedAt?.() ?? new Date().toISOString(),
    accounts: reports
  }
}
