import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

import {
  loginWithManualAssistance,
  readSingleAcceptanceAccount
} from '../src/acceptance/AccountAcceptance.js'
import { summarizeAppOffers } from '../src/acceptance/AppOfferAudit.js'
import { resolveChromeExecutable } from '../src/acceptance/ChromeExecutable.js'
import { EncryptedSessionStore } from '../src/auth/EncryptedSessionStore.js'
import { LoginStateError } from '../src/auth/LoginState.js'
import { AppOAuthClient } from '../src/browser/AppOAuthClient.js'
import { BrowserRuntime } from '../src/browser/BrowserRuntime.js'
import { DashboardClient } from '../src/browser/DashboardClient.js'
import { LoginController } from '../src/browser/LoginController.js'
import { REWARDS_URLS } from '../src/browser/Urls.js'
import type { StructuredLogger } from '../src/infra/StructuredLogger.js'
import { RewardsDiscoveryService } from '../src/rewards/RewardsDiscoveryService.js'
import type { CreditStructure } from '../src/rewards/CreditStructure.js'
import {
  reserveSingleAppAttempt,
  selectSingleAppOffer,
  singleAppPayload
} from '../src/acceptance/SingleAppAttempt.js'
import { localDateKey } from '../src/domain/DateKey.js'

const rootDirectory = process.cwd()
const logger = { write: () => Promise.resolve() } as unknown as StructuredLogger
let auditStage = 'configuration'

async function main(): Promise<void> {
  const account = readSingleAcceptanceAccount(process.env, process.argv.slice(2))

  const temporaryRoot = await mkdtemp(join(tmpdir(), 'rewards-next-app-readonly-'))
  const sessions = new EncryptedSessionStore(join(temporaryRoot, 'sessions'), randomBytes(32))
  const runtime = new BrowserRuntime({
    headless: false,
    sessions,
    executablePath: await resolveChromeExecutable()
  })
  const signal = new AbortController().signal
  let slot: Awaited<ReturnType<BrowserRuntime['openSlot']>> | undefined
  try {
    auditStage = 'browser-open'
    slot = await runtime.openSlot(`app-readonly-${String(account.accountIndex)}`, 'web-mobile')
    const login = new LoginController(logger)
    const client = new DashboardClient(
      slot.context,
      slot.page,
      logger,
      `app-readonly-${String(account.accountIndex)}`,
      `account-${String(account.accountIndex)}`
    )
    process.stdout.write(`账号 ${String(account.accountIndex)}：开始只读 App 认证。\n`)
    auditStage = 'dashboard-navigation'
    await slot.page.goto(REWARDS_URLS.dashboard, {
      waitUntil: 'domcontentloaded',
      timeout: 30_000
    })
    auditStage = 'login'
    await loginWithManualAssistance({
      controller: login,
      page: slot.page,
      credentials: account.credentials,
      manualTimeoutMs: 0,
      signal
    })
    const discovery = new RewardsDiscoveryService()
    auditStage = 'identity-verification'
    let verification = await discovery.verifyAuthenticated(client, signal)
    if (!verification.verification.valid) {
      auditStage = 'bing-login'
      await slot.page.goto(REWARDS_URLS.bingSignIn, {
        waitUntil: 'domcontentloaded',
        timeout: 30_000
      })
      await loginWithManualAssistance({
        controller: login,
        page: slot.page,
        credentials: account.credentials,
        manualTimeoutMs: 0,
        signal
      })
      verification = await discovery.verifyAuthenticated(client, signal)
    }
    if (!verification.verification.valid) throw new Error('app-readonly-bing-unconfirmed')

    const oauth = new AppOAuthClient(
      slot.context,
      slot.page,
      sessions,
      logger,
      login,
      `app-readonly-${String(account.accountIndex)}`,
      `account-${String(account.accountIndex)}`
    )
    auditStage = 'app-authorization'
    const token = await oauth.acquire(
      `app-readonly-${String(account.accountIndex)}`,
      account.credentials,
      signal
    )
    auditStage = 'app-readonly-query'
    let creditStructure: CreditStructure | undefined
    const observation = await client.fetchAppDashboard(token.accessToken, (structure) => {
      creditStructure = structure
    })
    const singleSubmission = process.argv.includes('--single-app-submission')
    let submission:
      | {
          status: string
          taskType?: string
          structure?: CreditStructure
          balanceObserved?: boolean
        }
      | undefined
    if (singleSubmission) {
      const businessDate = localDateKey()
      const offer = selectSingleAppOffer(observation.offers)
      submission = { status: 'no-eligible-task' }
      if (offer) {
        const output = join(rootDirectory, '.codex-output')
        await mkdir(output, { recursive: true })
        const reserved = await reserveSingleAppAttempt(
          output,
          account.credentials.email.trim().toLowerCase(),
          businessDate
        )
        submission = { status: 'already-reserved' }
        if (reserved) {
          if (localDateKey() !== businessDate) throw new Error('single-app-date-changed')
          auditStage = 'single-app-submission'
          submission = { status: 'response-unknown', taskType: offer.type }
          process.stdout.write('准备提交一次 App 任务；防重标记已持久保存。\n')
          try {
            const balance = await client.submitAppActivity(
              token.accessToken,
              singleAppPayload(offer),
              (structure) => {
                if (submission) submission.structure = structure
              }
            )
            submission.status = 'response-received-not-credit-confirmation'
            submission.balanceObserved = balance !== undefined
          } catch {
            process.stdout.write('提交结果未知，保留防重标记，不重试。\n')
          }
        }
      }
      process.stdout.write(`单次任务核查状态：${submission.status}。\n`)
    }
    const report = {
      schemaVersion: 1,
      mode: singleSubmission ? 'single-app-submission' : 'read-only',
      accountIndex: account.accountIndex,
      generatedAt: new Date().toISOString(),
      summaries: summarizeAppOffers(observation.offers),
      creditStructure,
      submission
    }
    const outputDirectory = join(rootDirectory, '.codex-output')
    await mkdir(outputDirectory, { recursive: true })
    const fileName = `account-${String(account.accountIndex)}-app-readonly-${report.generatedAt.replaceAll(/[:.]/g, '-')}.json`
    const outputPath = join(outputDirectory, fileName)
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600
    })
    process.stdout.write(`账号 ${String(account.accountIndex)}：只读 App 元数据完成。\n`)
    process.stdout.write(`脱敏报告：${relative(rootDirectory, outputPath)}\n`)
  } finally {
    await slot?.close().catch(() => undefined)
    await runtime.close().catch(() => undefined)
    await rm(temporaryRoot, { recursive: true, force: true })
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : ''
  const networkCode = message.match(/net::(ERR_[A-Z_]+)/)?.[1]
  const category = /ERR_(?:CONNECTION|NETWORK|NAME|PROXY|TUNNEL|INTERNET)/.test(message)
    ? 'network-failure'
    : /[Tt]imeout|timed out/.test(message)
      ? 'timeout'
      : /[Cc]losed|[Cc]rash/.test(message)
        ? 'browser-closed'
        : 'unclassified'
  process.stderr.write(`审计阶段：${auditStage}；错误分类：${category}。\n`)
  if (networkCode) process.stderr.write(`网络错误码：${networkCode}。\n`)
  if (error instanceof LoginStateError) {
    process.stderr.write('App 只读审计停止：登录未完成，需要人工检查。\n')
  }
  process.stderr.write('App 只读审计失败，未输出异常原文。\n')
  process.exitCode = 1
})
