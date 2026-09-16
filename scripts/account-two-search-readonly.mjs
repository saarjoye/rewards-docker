import process from 'node:process'
import { resolve } from 'node:path'
import { setTimeout, clearTimeout } from 'node:timers'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { BrowserRuntime } from '../dist/server/browser/BrowserRuntime.js'
import { LoginController } from '../dist/server/browser/LoginController.js'
import { DashboardClient, DashboardFetchError } from '../dist/server/browser/DashboardClient.js'
import { REWARDS_URLS } from '../dist/server/browser/Urls.js'
import { resolveChromeExecutable } from '../dist/server/acceptance/ChromeExecutable.js'
import { loginWithManualAssistance } from '../dist/server/acceptance/AccountAcceptance.js'
import { SearchExecutor } from '../dist/server/orchestration/SearchExecutor.js'
import { DEFAULT_CONFIG } from '../dist/server/infra/Config.js'
import { localDateKey } from '../dist/server/domain/DateKey.js'

const emit = (event) =>
  process.stdout.write(
    JSON.stringify({ at: new Date().toISOString(), accountIndex: 2, ...event }) + '\n'
  )
let browser
let slot
let timer
let phase = 'configuration'
let submittedCount = 0
let unknownSubmissionCount = 0
const oneSearch = process.argv.includes('--allow-one-search')
const receipt = resolve('.codex-output/account-two-2026-09-10-one-search.json')
try {
  if (!process.argv.includes('--allow-login')) throw new Error('login-not-authorized')
  if (oneSearch && existsSync(receipt)) throw new Error('single-search-already-attempted')
  if (localDateKey() !== '2026-09-10') throw new Error('baseline-date-mismatch')
  process.loadEnvFile(resolve('.env'))
  const credentials = {
    email: process.env.ACCOUNT_2_EMAIL,
    password: process.env.ACCOUNT_2_PASSWORD
  }
  if (!credentials.email || !credentials.password) throw new Error('second-account-config-missing')
  for (const key of Object.keys(process.env)) {
    if (/^ACCOUNT_\d+_(EMAIL|PASSWORD)$/.test(key) || /^(https?|all|no)_proxy$/i.test(key))
      delete process.env[key]
  }
  const logger = {
    write: (event) => {
      if (event.event === 'login-state') emit({ event: 'login-state', state: event.status })
      if (event.event === 'search-dashboard-observation')
        emit({
          event: event.event,
          source: event.source,
          availability: event.availability,
          completed: event.completed,
          total: event.total,
          remaining: event.remaining,
          observedAt: event.observedAt,
          durationMs: event.durationMs,
          usedFallback: event.usedFallback,
          attempt: event.attempt,
          result: event.status
        })
      return Promise.resolve()
    }
  }
  browser = new BrowserRuntime({
    headless: false,
    executablePath: await resolveChromeExecutable({
      LOCALAPPDATA: process.env.LOCALAPPDATA,
      PROGRAMFILES: process.env.PROGRAMFILES,
      'PROGRAMFILES(X86)': process.env['PROGRAMFILES(X86)']
    }),
    sessions: {
      read: () => Promise.resolve(undefined),
      commitVerified: () => {
        throw new Error('session-persistence-disabled')
      }
    }
  })
  const controller = new globalThis.AbortController()
  timer = setTimeout(() => controller.abort(new Error('readonly-deadline')), 10 * 60_000)
  process.once('SIGINT', () => controller.abort(new Error('user-cancelled')))
  phase = 'browser-launch'
  slot = await browser.openSlot('readonly-account-two', 'web-desktop')
  const login = new LoginController(logger)
  for (const [stage, url] of [
    ['microsoft-login', REWARDS_URLS.login],
    ['bing-login', REWARDS_URLS.bingSignIn]
  ]) {
    phase = stage
    emit({ event: 'stage', stage })
    await slot.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await loginWithManualAssistance({
      controller: login,
      page: slot.page,
      credentials,
      signal: controller.signal,
      manualTimeoutMs: 300000,
      onActionRequired: () => emit({ event: 'manual-login-required', waitSeconds: 300 })
    })
  }
  credentials.email = undefined
  credentials.password = undefined
  phase = 'readonly-dashboard'
  emit({
    event: 'stage',
    stage: phase,
    baseline: '45/60',
    businessDate: '2026-09-10',
    newSearchesAllowed: false
  })
  const client = new DashboardClient(slot.context, slot.page, logger, 'readonly-check', 'account-2')
  const readonlyClient = {
    fetchDashboard: async (signal, deadline) => {
      const observation = await client.fetchDashboard(signal, deadline)
      if (observation.rewardsUser.value !== true)
        throw new DashboardFetchError('identity-not-confirmed', 401, 1, 0)
      return observation
    }
  }
  let baseline = 45
  if (oneSearch) {
    const initial = await readonlyClient.fetchDashboard(controller.signal, Date.now() + 55000)
    const counter = initial.pcSearch
    emit({
      event: 'baseline',
      source: counter.source,
      availability: counter.availability,
      completed: counter.value?.completed ?? null,
      total: counter.value?.total ?? null
    })
    if (
      counter.availability !== 'valid' ||
      !counter.value ||
      counter.value.total !== 60 ||
      counter.value.completed < 45
    )
      throw new Error('baseline-not-valid')
    baseline = counter.value.completed
    if (baseline === 60) throw new Error('quota-already-complete-no-search')
    phase = 'single-authorized-search'
    emit({ event: 'stage', stage: phase, maximumSubmissions: 1 })
  }
  let pages = 0
  const executor = new SearchExecutor(
    {
      newPage: () => {
        if (!oneSearch || pages++ >= 1) throw new Error('search-submission-disabled')
        return slot.context.newPage()
      }
    },
    readonlyClient,
    logger,
    { ...DEFAULT_CONFIG.search, scroll: false, clickResult: false },
    'readonly-check',
    'account-2'
  )
  const result = await executor.run({
    task: {
      taskId: 'readonly-account-two:2026-09-10:pc-search',
      accountId: 'readonly-account-two',
      localDate: '2026-09-10',
      sourceTaskId: 'pc-search',
      type: 'pc-search',
      source: 'legacy-getuserinfo',
      displayName: 'PC 搜索只读复核',
      executable: oneSearch,
      required: true,
      status: oneSearch ? 'running' : 'verification-pending',
      progress: { completed: baseline, total: 60 },
      updatedAt: new Date().toISOString()
    },
    mobile: false,
    readOnly: !oneSearch,
    ...(oneSearch ? { singleQuery: '中国古代桥梁建筑特点' } : {}),
    signal: controller.signal,
    onProgress: (task) => {
      const summary = task.searchObservation
      if (!summary) return
      if (
        oneSearch &&
        summary.result === 'submission-started' &&
        unknownSubmissionCount === 0 &&
        submittedCount === 0
      ) {
        mkdirSync(resolve('.codex-output'), { recursive: true })
        writeFileSync(
          receipt,
          JSON.stringify({
            accountIndex: 2,
            businessDate: '2026-09-10',
            baseline,
            attemptedAt: new Date().toISOString(),
            maximumSubmissions: 1
          }),
          { flag: 'wx', mode: 0o600 }
        )
        emit({ event: 'submission-started', maximumSubmissions: 1 })
      }
      if (summary.submittedCount > submittedCount)
        emit({ event: 'search-submitted', submittedCount: summary.submittedCount })
      submittedCount = summary.submittedCount
      unknownSubmissionCount = summary.unknownSubmissionCount
    },
    beforeSubmit: () => {
      if (localDateKey() !== '2026-09-10') throw new Error('baseline-date-mismatch')
    }
  })
  emit({
    event: 'result',
    status: result.status,
    completed: result.progress.completed,
    total: result.progress.total,
    baseline,
    growthObserved:
      result.searchObservation?.state === 'progress-confirmed' &&
      result.progress.completed > baseline,
    state: result.searchObservation?.state ?? null,
    newSubmissions: submittedCount,
    unknownSubmissionCount
  })
} catch {
  emit({
    event: 'stopped',
    stage: phase,
    reason: 'controlled-check-not-completed',
    newSubmissions: submittedCount,
    unknownSubmissionCount
  })
  process.exitCode = 1
} finally {
  if (timer) clearTimeout(timer)
  await slot?.close().catch(() => undefined)
  await browser?.close().catch(() => undefined)
}
