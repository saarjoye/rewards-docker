import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

import {
  selectAcceptanceAccounts,
  readAcceptanceAccounts
} from '../src/acceptance/AccountAcceptance.js'
import { resolveChromeExecutable } from '../src/acceptance/ChromeExecutable.js'
import { HashedMutationLedger } from '../src/acceptance/HashedMutationLedger.js'
import { buildAcceptancePointsEvidence } from '../src/acceptance/PointsEvidence.js'
import { EncryptedSessionStore } from '../src/auth/EncryptedSessionStore.js'
import { BrowserRuntime } from '../src/browser/BrowserRuntime.js'
import { localDateKey } from '../src/domain/DateKey.js'
import type { TaskRecord } from '../src/domain/Task.js'
import { AccountSecretStore } from '../src/infra/AccountSecretStore.js'
import { DEFAULT_CONFIG } from '../src/infra/Config.js'
import { SqliteStore } from '../src/infra/SqliteStore.js'
import { StructuredLogger } from '../src/infra/StructuredLogger.js'
import { ApplicationRunCoordinator } from '../src/orchestration/RunCoordinator.js'
import { redactText } from '../src/security/Redactor.js'

const rootDirectory = process.cwd()
const maximumRunMs = 90 * 60 * 1000

type TaskScope = 'full' | 'web' | 'daily-set' | 'app' | 'search' | 'claim'
type AcceptanceExecutionMode = 'read-only' | 'mutating'

function taskScope(args: readonly string[]): TaskScope {
  const values = args
    .filter((argument) => argument.startsWith('--scope='))
    .map((argument) => argument.slice('--scope='.length))
  if (values.length > 1) throw new Error('single-account-scope-duplicate')
  const value = values[0] ?? 'full'
  if (!['full', 'web', 'daily-set', 'app', 'search', 'claim'].includes(value)) {
    throw new Error('single-account-scope-invalid')
  }
  return value as TaskScope
}

function executionMode(args: readonly string[]): AcceptanceExecutionMode {
  const occurrences = args.filter((argument) => argument === '--read-only').length
  if (occurrences > 1) throw new Error('single-account-read-only-duplicate')
  return occurrences === 1 ? 'read-only' : 'mutating'
}

function tasksForScope(scope: TaskScope) {
  const full = scope === 'full'
  return {
    dailySet: full || scope === 'web' || scope === 'daily-set',
    specialPromotions: full || scope === 'web',
    morePromotions: full || scope === 'web',
    appActivities: full || scope === 'app',
    appCheckIn: full || scope === 'app',
    readToEarn: full || scope === 'app',
    pcSearch: full || scope === 'search',
    mobileSearch: full,
    punchCards: full || scope === 'web',
    claimBonusPoints: full || scope === 'claim'
  }
}

function groupTasks(tasks: readonly TaskRecord[]) {
  const groups = new Map<
    TaskRecord['type'],
    Array<{
      status: TaskRecord['status']
      completed: number
      total: number | null
      reason?: string
    }>
  >()
  for (const task of tasks) {
    const group = groups.get(task.type) ?? []
    group.push({
      status: task.status,
      completed: task.progress.completed,
      total: task.progress.total,
      ...(task.reason === undefined ? {} : { reason: redactText(task.reason) })
    })
    groups.set(task.type, group)
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([type, items]) => ({ type, count: items.length, items }))
}

async function waitForRun(
  coordinator: ApplicationRunCoordinator,
  store: SqliteStore,
  runId: string
): Promise<ReadonlyArray<{ stage: string; status: string; message?: string }>> {
  const deadline = Date.now() + maximumRunMs
  let lastStage = ''
  let lastSearchProgress = ''
  const transitions: Array<{ stage: string; status: string; message?: string }> = []
  while (coordinator.activeRunId === runId) {
    if (Date.now() >= deadline) {
      coordinator.cancel(runId)
      throw new Error('single-account-full-run-timeout')
    }
    const accountRun = store.listAccountRuns(runId)[0]
    const stage = `${accountRun?.stage ?? 'starting'}:${accountRun?.status ?? 'queued'}`
    if (stage !== lastStage) {
      lastStage = stage
      transitions.push({
        stage: accountRun?.stage ?? 'starting',
        status: accountRun?.status ?? 'queued',
        ...(accountRun?.message === undefined ? {} : { message: redactText(accountRun.message) })
      })
      process.stdout.write(`账号执行阶段：${stage}\n`)
    }
    if (accountRun) {
      const searchTasks = store
        .listTaskState(accountRun.localDate)
        .filter(
          (task) =>
            task.accountId === accountRun.accountId &&
            (task.type === 'pc-search' || task.type === 'mobile-search')
        )
      const progress = searchTasks
        .map(
          (task) =>
            `${task.type}:${String(task.progress.completed)}/${String(task.progress.total ?? '?')}:${task.status}`
        )
        .join('|')
      if (progress && progress !== lastSearchProgress) {
        lastSearchProgress = progress
        process.stdout.write(`搜索进度：${progress}\n`)
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000))
  }
  return transitions
}

async function main(): Promise<void> {
  const configured = readAcceptanceAccounts(process.env)
  const selected = selectAcceptanceAccounts(process.argv.slice(2), configured)
  if (selected.length !== 1) throw new Error('single-account-index-required')
  const account = selected[0]
  if (!account) throw new Error('single-account-missing')
  const scope = taskScope(process.argv.slice(2))
  const mode = executionMode(process.argv.slice(2))
  const localDate = localDateKey()
  const outputDirectory = join(rootDirectory, '.codex-output')

  const temporaryRoot = await mkdtemp(join(tmpdir(), 'rewards-next-full-run-'))
  const mutationLedger = new HashedMutationLedger(
    join(outputDirectory, 'acceptance-state', 'mutation-ledger.sqlite'),
    account.accountIndex,
    localDate
  )
  const store = new SqliteStore(join(temporaryRoot, 'data', 'rewards-next.sqlite'))
  const key = randomBytes(32)
  const accounts = new AccountSecretStore(store.database, key)
  for (const configuredAccount of configured) {
    accounts.create({
      ...configuredAccount.credentials,
      displayAlias: `account-${String(configuredAccount.accountIndex)}`
    })
  }
  const sessions = new EncryptedSessionStore(join(temporaryRoot, 'sessions'), key)
  const browser = new BrowserRuntime({
    headless: false,
    sessions,
    executablePath: await resolveChromeExecutable()
  })
  const logger = new StructuredLogger(join(temporaryRoot, 'logs'))
  const config = {
    ...DEFAULT_CONFIG,
    tasks: tasksForScope(scope)
  }
  const coordinator = new ApplicationRunCoordinator(
    accounts,
    store,
    sessions,
    browser,
    logger,
    config,
    mutationLedger
  )
  let runId: string | undefined
  try {
    const started = await coordinator.start({
      accountMode: 'account',
      runAccountIndex: account.accountIndex,
      executionMode: mode
    })
    runId = started.runId
    process.stdout.write(
      `开始执行账号 ${String(account.accountIndex)}，范围：${scope}，模式：${mode}。\n`
    )
    const transitions = await waitForRun(coordinator, store, started.runId)

    const run = store.listRuns(100).find((candidate) => candidate.runId === started.runId)
    const accountRun = store.listAccountRuns(started.runId)[0]
    const tasks = store
      .listTaskState(run?.localDate ?? localDate)
      .filter((task) => task.accountId === accountRun?.accountId)
    const pointsEvidence = accountRun
      ? buildAcceptancePointsEvidence(
          store.getLatestPointsHistory(accountRun.accountId, run?.localDate ?? localDate)
        )
      : buildAcceptancePointsEvidence(undefined)
    const report = {
      schemaVersion: 1,
      mode,
      scope,
      generatedAt: new Date().toISOString(),
      accountIndex: account.accountIndex,
      runStatus: run?.status ?? 'unknown',
      accountStatus: accountRun?.status ?? 'unknown',
      stage: accountRun?.stage ?? 'unknown',
      transitions,
      ...(accountRun?.message === undefined ? {} : { message: redactText(accountRun.message) }),
      pointsEvidence,
      tasks: groupTasks(tasks)
    }
    await mkdir(outputDirectory, { recursive: true })
    const fileName = `account-${String(account.accountIndex)}-full-${report.generatedAt.replaceAll(/[:.]/g, '-')}.json`
    const outputPath = join(outputDirectory, fileName)
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600
    })
    process.stdout.write(`完整执行状态：${report.accountStatus}。\n`)
    process.stdout.write(
      report.pointsEvidence.confirmed
        ? `积分复核：已确认，增量 ${String(report.pointsEvidence.delta)}。\n`
        : '积分复核：未确认。\n'
    )
    process.stdout.write(`脱敏报告：${relative(rootDirectory, outputPath)}\n`)
    if (report.accountStatus !== 'success') process.exitCode = 1
  } finally {
    if (runId && coordinator.activeRunId === runId) coordinator.cancel(runId)
    await browser.close().catch(() => undefined)
    store.close()
    mutationLedger.close()
    await rm(temporaryRoot, { recursive: true, force: true })
  }
}

void main().catch((error: unknown) => {
  const code = error instanceof Error ? error.message : 'single-account-full-run-failed'
  process.stderr.write(`单账号完整执行未完成：${code}\n`)
  process.exitCode = 1
})
