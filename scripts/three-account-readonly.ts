import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

import {
  AcceptanceInspectionError,
  loginWithManualAssistance,
  readAcceptanceAccounts,
  runAcceptanceSequence,
  selectAcceptanceAccounts,
  type AcceptanceAccount,
  type AcceptanceExecutionCapability,
  type AcceptanceExecutionPath,
  type AcceptanceInspection,
  type AcceptanceLoginTransition
} from '../src/acceptance/AccountAcceptance.js'
import { resolveChromeExecutable } from '../src/acceptance/ChromeExecutable.js'
import { EncryptedSessionStore } from '../src/auth/EncryptedSessionStore.js'
import { LoginStateError } from '../src/auth/LoginState.js'
import { BrowserRuntime, type AccountBrowserSlot } from '../src/browser/BrowserRuntime.js'
import { DashboardClient } from '../src/browser/DashboardClient.js'
import { LoginController } from '../src/browser/LoginController.js'
import { REWARDS_URLS } from '../src/browser/Urls.js'
import { localDateKey } from '../src/domain/DateKey.js'
import type { StructuredLogger } from '../src/infra/StructuredLogger.js'
import { RewardsDiscoveryService } from '../src/rewards/RewardsDiscoveryService.js'
import type { RewardsDiscoverySnapshot, RewardOffer } from '../src/rewards/RewardsModel.js'
import { webOfferExecutionPath } from '../src/rewards/OfferExecution.js'

function hasAction(snapshot: RewardsDiscoverySnapshot, action: string): boolean {
  return Object.keys(snapshot.actionIds).some((name) =>
    name.toLowerCase().includes(action.toLowerCase())
  )
}

function executionPath(
  type: AcceptanceExecutionCapability['type'],
  executable: boolean,
  offer: RewardOffer | undefined,
  snapshot: RewardsDiscoverySnapshot
): AcceptanceExecutionPath {
  if (!executable) return 'unsupported'
  if (type === 'pc-search' || type === 'mobile-search') return 'search-browser'
  if (type === 'app-activity' || type === 'app-check-in' || type === 'read-to-earn') {
    return 'app-api'
  }
  if (type === 'claim-bonus-points') {
    return hasAction(snapshot, 'reportClaimAllPoints') ? 'claim-server-action' : 'claim-ui'
  }
  return offer ? webOfferExecutionPath(offer, hasAction(snapshot, 'reportActivity')) : 'unsupported'
}

const rootDirectory = process.cwd()

const silentLogger = {
  write: () => Promise.resolve()
} as unknown as StructuredLogger

async function acceptanceStage<T>(
  accountIndex: number,
  label: string,
  stage: string | (() => string),
  code: string | (() => string),
  operation: () => Promise<T>
): Promise<T> {
  const startedAt = Date.now()
  process.stdout.write(`账号 ${String(accountIndex)} 开始阶段：${label}。\n`)
  try {
    const result = await operation()
    process.stdout.write(
      `账号 ${String(accountIndex)} 完成阶段：${label}，耗时 ${String(Date.now() - startedAt)}ms。\n`
    )
    return result
  } catch (error) {
    process.stdout.write(
      `账号 ${String(accountIndex)} 阶段停止：${label}，耗时 ${String(Date.now() - startedAt)}ms。\n`
    )
    if (error instanceof AcceptanceInspectionError) throw error
    if (error instanceof Error && error.name === 'LoginStateError') throw error
    throw new AcceptanceInspectionError(
      'failed',
      typeof stage === 'string' ? stage : stage(),
      typeof code === 'string' ? code : code()
    )
  }
}

async function inspectAccount(
  account: AcceptanceAccount,
  slot: AccountBrowserSlot,
  signal: AbortSignal
): Promise<AcceptanceInspection> {
  const loginTrace: {
    phase: 'microsoft' | 'bing'
    stage: string | undefined
    state: string | undefined
    transitions: AcceptanceLoginTransition[]
  } = {
    phase: 'microsoft',
    stage: undefined,
    state: undefined,
    transitions: []
  }

  const classifyLocation = (url: string | undefined): AcceptanceLoginTransition['location'] => {
    if (!url) return 'other'
    try {
      const host = new URL(url).hostname.toLowerCase()
      if (host === 'login.live.com') return 'login-live'
      if (host === 'login.microsoft.com' || host === 'login.microsoftonline.com') {
        return 'login-microsoft'
      }
      if (host === 'rewards.bing.com') return 'rewards'
      if (host === 'bing.com' || host.endsWith('.bing.com')) return 'bing'
      if (host === 'account.microsoft.com') return 'account'
    } catch {
      return 'other'
    }
    return 'other'
  }
  const traceLogger = {
    write: (event: { event: string; stage?: string; status?: string; path?: string }) => {
      if (event.event === 'login-state') {
        loginTrace.stage = event.stage
        loginTrace.state = event.status
        if (event.status && event.stage) {
          const transition: AcceptanceLoginTransition = {
            phase: loginTrace.phase,
            state: event.status as AcceptanceLoginTransition['state'],
            stage: event.stage,
            location: classifyLocation(event.path)
          }
          const previous = loginTrace.transitions.at(-1)
          if (
            !previous ||
            previous.phase !== transition.phase ||
            previous.state !== transition.state ||
            previous.location !== transition.location
          ) {
            loginTrace.transitions.push(transition)
            if (loginTrace.transitions.length > 30) loginTrace.transitions.shift()
          }
        }
      }
      return Promise.resolve()
    }
  } as unknown as StructuredLogger
  const controller = new LoginController(traceLogger)
  const tracedLogin = async (
    phase: 'microsoft' | 'bing',
    operation: () => Promise<string>
  ): Promise<string> => {
    loginTrace.phase = phase
    try {
      return await operation()
    } catch (error) {
      if (error instanceof LoginStateError && error.loginStage === 'login-timeout') {
        const sequence = loginTrace.transitions
          .filter((transition) => transition.phase === phase)
          .map((transition) => transition.state)
          .join('-')
        throw new AcceptanceInspectionError(
          'failed',
          error.loginStage,
          `${phase}-login-timeout-sequence-${sequence || 'empty'}`
        )
      }
      throw error
    } finally {
      const sequence = loginTrace.transitions
        .filter((transition) => transition.phase === phase)
        .map((transition) => transition.state)
        .join(' -> ')
      process.stdout.write(
        `账号 ${String(account.accountIndex)} ${phase} 登录轨迹：${sequence || 'empty'}。\n`
      )
    }
  }
  const client = new DashboardClient(
    slot.context,
    slot.page,
    silentLogger,
    `acceptance-${String(account.accountIndex)}`,
    `account-${String(account.accountIndex)}`
  )
  await acceptanceStage(
    account.accountIndex,
    'Microsoft 登录导航',
    'microsoft-login-navigation',
    'microsoft-login-navigation-failed',
    () =>
      slot.page.goto(REWARDS_URLS.login, {
        waitUntil: 'domcontentloaded',
        timeout: 30_000
      })
  )
  let loginStage = await acceptanceStage(
    account.accountIndex,
    'Microsoft 登录',
    () => loginTrace.stage ?? 'microsoft-login',
    () => `microsoft-login-${loginTrace.state ?? 'failed'}`,
    () =>
      tracedLogin('microsoft', () =>
        loginWithManualAssistance({
          controller,
          page: slot.page,
          credentials: account.credentials,
          signal,
          onActionRequired: () => {
            process.stdout.write(
              `账号 ${String(account.accountIndex)} 需要人工完成登录验证，等待最多 5 分钟。\n`
            )
          }
        })
      )
  )

  const discoveryService = new RewardsDiscoveryService()
  let verification = await acceptanceStage(
    account.accountIndex,
    'Rewards 身份验证',
    'rewards-verification',
    'rewards-verification-failed',
    () => discoveryService.verifyAuthenticated(client, signal)
  )
  if (!verification.verification.valid) {
    await acceptanceStage(
      account.accountIndex,
      'Bing 登录导航',
      'bing-login-navigation',
      'bing-login-navigation-failed',
      () =>
        slot.page.goto(REWARDS_URLS.bingSignIn, {
          waitUntil: 'domcontentloaded',
          timeout: 30_000
        })
    )
    loginStage = await acceptanceStage(
      account.accountIndex,
      'Bing 登录',
      () => loginTrace.stage ?? 'bing-login',
      () => `bing-login-${loginTrace.state ?? 'failed'}`,
      () =>
        tracedLogin('bing', () =>
          loginWithManualAssistance({
            controller,
            page: slot.page,
            credentials: account.credentials,
            signal,
            onActionRequired: () => {
              process.stdout.write(
                `账号 ${String(account.accountIndex)} 需要人工完成 Bing 登录验证，等待最多 5 分钟。\n`
              )
            }
          })
        )
    )
    verification = await acceptanceStage(
      account.accountIndex,
      'Bing 身份验证',
      'bing-verification',
      'bing-verification-failed',
      () => discoveryService.verifyAuthenticated(client, signal)
    )
  }
  if (!verification.verification.valid) {
    const currentHost = (() => {
      try {
        const host = new URL(slot.page.url()).hostname.toLowerCase()
        if (host === 'bing.com' || host.endsWith('.bing.com')) return 'bing'
        if (host === 'rewards.bing.com') return 'rewards'
        if (host === 'login.live.com' || host.startsWith('login.microsoft')) return 'login'
        return 'other'
      } catch {
        return 'invalid-url'
      }
    })()
    throw new AcceptanceInspectionError(
      'failed',
      verification.verification.failedStage === 'bing'
        ? 'bing-session-error'
        : 'login-verification',
      verification.verification.failedStage === 'bing'
        ? `bing-identity-unconfirmed-at-${currentHost}`
        : (verification.verification.failedStage ?? 'login-verification-failed')
    )
  }

  const discovery = await acceptanceStage(
    account.accountIndex,
    '任务发现',
    'task-discovery',
    'task-discovery-failed',
    () =>
      discoveryService.discover({
        accountId: `acceptance-account-${String(account.accountIndex)}`,
        localDate: localDateKey(),
        client,
        ...(verification.observation === undefined
          ? {}
          : { initialObservation: verification.observation }),
        signal
      })
  )
  const executionCapabilities = discovery.tasks.map((task) => {
    const descriptor = discovery.descriptors.get(task.taskId)
    return {
      type: task.type,
      path: executionPath(task.type, task.executable, descriptor?.offer, discovery.snapshot)
    }
  })
  return {
    loginStage,
    loginTransitions: loginTrace.transitions,
    executionCapabilities,
    market: discovery.snapshot.market,
    searchCounters: {
      pc: discovery.snapshot.pcSearch,
      mobile: discovery.snapshot.mobileSearch
    },
    dataSources: discovery.dataSources,
    tasks: discovery.tasks
  }
}

function installAbortHandler(controller: AbortController): () => void {
  const abort = (): void => {
    controller.abort(new Error('Acceptance interrupted'))
  }
  process.once('SIGINT', abort)
  process.once('SIGTERM', abort)
  return () => {
    process.off('SIGINT', abort)
    process.off('SIGTERM', abort)
  }
}

async function main(): Promise<void> {
  const configuredAccounts = readAcceptanceAccounts(process.env)
  const accounts = selectAcceptanceAccounts(process.argv.slice(2), configuredAccounts)
  const executablePath = await resolveChromeExecutable()
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'rewards-next-acceptance-'))
  const runtime = new BrowserRuntime({
    headless: false,
    sessions: new EncryptedSessionStore(join(temporaryRoot, 'sessions'), randomBytes(32)),
    executablePath
  })
  const abortController = new AbortController()
  const removeAbortHandlers = installAbortHandler(abortController)
  try {
    const report = await runAcceptanceSequence(
      accounts,
      {
        openSlot: (account) =>
          runtime.openSlot(`acceptance-account-${String(account.accountIndex)}`, 'web-desktop'),
        inspect: inspectAccount,
        onAccountStart: (accountIndex) => {
          process.stdout.write(`开始只读验收账号 ${String(accountIndex)}。\n`)
        },
        onAccountComplete: (accountReport) => {
          process.stdout.write(
            `账号 ${String(accountReport.accountIndex)} 只读验收状态：${accountReport.status}。\n`
          )
        }
      },
      abortController.signal
    )
    const outputDirectory = join(rootDirectory, '.codex-output')
    await mkdir(outputDirectory, { recursive: true })
    const accountLabel =
      accounts.length === 1
        ? `account-${String(accounts[0]?.accountIndex)}-readonly`
        : 'three-account-readonly'
    const fileName = `${accountLabel}-${report.generatedAt.replaceAll(/[:.]/g, '-')}.json`
    const outputPath = join(outputDirectory, fileName)
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600
    })
    process.stdout.write(`脱敏报告：${relative(rootDirectory, outputPath)}\n`)
    if (report.accounts.some((account) => account.status !== 'passed')) process.exitCode = 1
  } finally {
    removeAbortHandlers()
    await runtime.close().catch(() => undefined)
    await rm(temporaryRoot, { recursive: true, force: true })
  }
}

function reportFatal(error: unknown): void {
  const code =
    error instanceof AcceptanceInspectionError
      ? error.code
      : error instanceof Error && 'code' in error && typeof error.code === 'string'
        ? error.code
        : 'acceptance-startup-failed'
  process.stderr.write(`账号只读验收未启动：${code}\n`)
  process.exitCode = 1
}

void main().catch(reportFatal)
