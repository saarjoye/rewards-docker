import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import type { Page } from 'patchright'

import {
  AcceptanceInspectionError,
  loginWithManualAssistance,
  readAcceptanceAccounts
} from '../src/acceptance/AccountAcceptance.js'
import { resolveChromeExecutable } from '../src/acceptance/ChromeExecutable.js'
import {
  controlledAccountIndex,
  controlledExecutionPath,
  controlledMutationFingerprint,
  controlledTaskType,
  createControlledClaimAdapter,
  createControlledClaimUiAdapter,
  createControlledNavigationAdapter,
  createControlledMutationAdapter,
  selectControlledClaimCandidate,
  selectControlledClaimUiCandidate,
  selectControlledNavigationCandidate,
  selectControlledMutationCandidate,
  summarizeControlledMutationCandidates
} from '../src/acceptance/ControlledMutationAcceptance.js'
import { EncryptedSessionStore } from '../src/auth/EncryptedSessionStore.js'
import { LoginStateError } from '../src/auth/LoginState.js'
import { BrowserRuntime } from '../src/browser/BrowserRuntime.js'
import { DashboardClient } from '../src/browser/DashboardClient.js'
import { LoginController } from '../src/browser/LoginController.js'
import { BING_ORIGIN, REWARDS_URLS } from '../src/browser/Urls.js'
import { localDateKey } from '../src/domain/DateKey.js'
import { SqliteStore } from '../src/infra/SqliteStore.js'
import { safePath } from '../src/security/Redactor.js'
import type { StructuredLogger } from '../src/infra/StructuredLogger.js'
import { MutationExecutor } from '../src/orchestration/MutationExecutor.js'
import { webOfferExecutionPath } from '../src/rewards/OfferExecution.js'
import { RewardsDiscoveryService } from '../src/rewards/RewardsDiscoveryService.js'

const silentLogger = { write: () => Promise.resolve() } as unknown as StructuredLogger

interface InteractiveQuizPageInspection {
  targetPath: string
  finalPath: string
  framePaths: readonly string[]
  selectorCounts: Readonly<Record<string, number>>
  textSignals: Readonly<Record<string, boolean>>
  interactiveSignatures: ReadonlyArray<{
    tag: string
    id: string
    role: string
    classes: readonly string[]
    attributeNames: readonly string[]
  }>
}

async function inspectInteractiveQuizPage(
  page: Page,
  targetPath: string
): Promise<InteractiveQuizPageInspection> {
  await page.waitForTimeout(4_000)
  const structure = await page.evaluate(() => {
    const selectors = [
      '#rqStartQuiz',
      '[id^="rqAnswerOption"]',
      '.rqOption',
      '.wk_OptionClickClass',
      '[data-option]',
      '[role="radio"]',
      'input[type="radio"]',
      '[role="button"]',
      'button'
    ]
    const selectorCounts = Object.fromEntries(
      selectors.map((selector) => [selector, document.querySelectorAll(selector).length])
    )
    const bodyText = document.body.innerText
    const interactiveSignatures = [
      ...document.querySelectorAll<HTMLElement>(
        'button, [role="button"], [role="radio"], input[type="radio"], [data-option], [id^="rqAnswerOption"], .wk_OptionClickClass'
      )
    ]
      .filter((element) => {
        const style = window.getComputedStyle(element)
        const rectangle = element.getBoundingClientRect()
        return (
          style.visibility !== 'hidden' &&
          style.display !== 'none' &&
          rectangle.width > 0 &&
          rectangle.height > 0
        )
      })
      .slice(0, 30)
      .map((element) => ({
        tag: element.tagName.toLowerCase(),
        id: element.id.slice(0, 80),
        role: (element.getAttribute('role') ?? '').slice(0, 40),
        classes: [...element.classList].map((value) => value.slice(0, 80)).slice(0, 8),
        attributeNames: element
          .getAttributeNames()
          .filter((name) => !['value', 'href', 'aria-label', 'title'].includes(name.toLowerCase()))
          .sort()
          .slice(0, 20)
      }))
    return {
      selectorCounts,
      textSignals: {
        start: /start quiz|开始(?:测验|答题)|立即开始/i.test(bodyText),
        question: /question\s*\d+|第\s*\d+\s*题/i.test(bodyText),
        next: /next question|下一题|继续/i.test(bodyText),
        complete: /quiz complete|completed|测验完成|已完成/i.test(bodyText)
      },
      interactiveSignatures
    }
  })
  return {
    targetPath,
    finalPath: safePath(page.url()),
    framePaths: page.frames().map((frame) => safePath(frame.url())),
    ...structure
  }
}

async function inspectBingFlyoutSurface(
  page: Page,
  candidates: ReadonlyArray<{
    taskType: string
    sourceTaskId: string
    destinationUrl: string
  }>
): Promise<unknown> {
  await page.goto(BING_ORIGIN, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  await page.waitForTimeout(1_500)
  const triggerSelectors = [
    '#id_rh',
    '[aria-label*="Microsoft Rewards" i]',
    '[title*="Microsoft Rewards" i]',
    'a[href*="rewards" i]'
  ]
  let triggerSelector: string | undefined
  for (const selector of triggerSelectors) {
    const trigger = page.locator(selector).first()
    if ((await trigger.count()) > 0 && (await trigger.isVisible().catch(() => false))) {
      triggerSelector = selector
      await trigger.click({ timeout: 10_000 })
      break
    }
  }
  await page.waitForTimeout(2_000)

  const frames = page.frames()
  const frameSummaries = []
  for (const frame of frames) {
    const linkPaths = await frame
      .locator('a[href]')
      .evaluateAll((anchors) =>
        [...new Set(anchors.map((anchor) => (anchor as HTMLAnchorElement).href))].slice(0, 40)
      )
      .catch(() => [] as string[])
    frameSummaries.push({
      path: safePath(frame.url()),
      anchors: await frame
        .locator('a[href]')
        .count()
        .catch(() => 0),
      buttons: await frame
        .locator('button, [role="button"]')
        .count()
        .catch(() => 0),
      pressables: await frame
        .locator('[data-react-aria-pressable]')
        .count()
        .catch(() => 0),
      linkPaths: [...new Set(linkPaths.map((url) => safePath(url)))]
    })
  }
  const matches = []
  for (const candidate of candidates) {
    let exactLinkCount = 0
    let wrappedLinkCount = 0
    let sourceMarkerCount = 0
    for (const frame of frames) {
      const linkCounts = await frame
        .locator('a[href]')
        .evaluateAll((anchors, input) => {
          const decoded = (value: string): string => {
            let current = value
            for (let attempt = 0; attempt < 3; attempt += 1) {
              try {
                const next = decodeURIComponent(current)
                if (next === current) break
                current = next
              } catch {
                break
              }
            }
            return current
          }
          return {
            exactLinkCount: anchors.filter(
              (anchor) => (anchor as HTMLAnchorElement).href === input.destinationUrl
            ).length,
            wrappedLinkCount: anchors.filter((anchor) =>
              decoded((anchor as HTMLAnchorElement).href).includes(input.destinationUrl)
            ).length,
            bingHostEquivalentLinkCount: anchors.filter((anchor) => {
              try {
                const actual = new URL((anchor as HTMLAnchorElement).href)
                const expected = new URL(input.destinationUrl)
                const canonicalQuery = (url: URL): string =>
                  [...url.searchParams.entries()]
                    .sort(([leftKey, leftValue], [rightKey, rightValue]) =>
                      `${leftKey}\0${leftValue}`.localeCompare(`${rightKey}\0${rightValue}`)
                    )
                    .map(([key, value]) => `${key}=${value}`)
                    .join('&')
                const isPublicBing = (host: string): boolean =>
                  host === 'bing.com' ||
                  ((host === 'www.bing.com' || host === 'cn.bing.com') &&
                    host.endsWith('.bing.com'))
                return (
                  isPublicBing(actual.hostname.toLowerCase()) &&
                  isPublicBing(expected.hostname.toLowerCase()) &&
                  actual.pathname === expected.pathname &&
                  canonicalQuery(actual) === canonicalQuery(expected)
                )
              } catch {
                return false
              }
            }).length,
            pathOnlyCount: anchors.filter((anchor) => {
              try {
                return (
                  new URL((anchor as HTMLAnchorElement).href).pathname ===
                  new URL(input.destinationUrl).pathname
                )
              } catch {
                return false
              }
            }).length
          }
        }, candidate)
        .catch(() => ({
          exactLinkCount: 0,
          wrappedLinkCount: 0,
          bingHostEquivalentLinkCount: 0,
          pathOnlyCount: 0
        }))
      const markerCount = await frame
        .locator('*')
        .evaluateAll((elements, sourceTaskId) => {
          const lowerMarker = sourceTaskId.toLowerCase()
          return elements.filter((element) =>
            element
              .getAttributeNames()
              .some((name) =>
                (element.getAttribute(name) ?? '').toLowerCase().includes(lowerMarker)
              )
          ).length
        }, candidate.sourceTaskId)
        .catch(() => 0)
      const counts = { ...linkCounts, sourceMarkerCount: markerCount }
      exactLinkCount += counts.exactLinkCount
      wrappedLinkCount += counts.wrappedLinkCount
      sourceMarkerCount += counts.sourceMarkerCount
    }
    matches.push({
      taskType: candidate.taskType,
      targetPath: safePath(candidate.destinationUrl),
      exactLinkCount,
      wrappedLinkCount,
      sourceMarkerCount
    })
  }
  return {
    triggerFound: triggerSelector !== undefined,
    triggerKind: triggerSelector ?? 'none',
    frameCount: frames.length,
    frames: frameSummaries,
    matches
  }
}

interface ControlledMutationLedger {
  schemaVersion: 1
  submittedFingerprints: string[]
}

async function readMutationLedger(path: string): Promise<ControlledMutationLedger> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<ControlledMutationLedger>
    const submittedFingerprints = Array.isArray(parsed.submittedFingerprints)
      ? parsed.submittedFingerprints.filter(
          (value): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
        )
      : []
    return { schemaVersion: 1, submittedFingerprints: [...new Set(submittedFingerprints)] }
  } catch {
    return { schemaVersion: 1, submittedFingerprints: [] }
  }
}

async function recordSubmittedFingerprint(
  path: string,
  ledger: ControlledMutationLedger,
  fingerprint: string
): Promise<void> {
  if (!ledger.submittedFingerprints.includes(fingerprint)) {
    ledger.submittedFingerprints.push(fingerprint)
  }
  const temporaryPath = `${path}.tmp`
  await writeFile(temporaryPath, `${JSON.stringify(ledger, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600
  })
  await rename(temporaryPath, path)
}

async function main(): Promise<void> {
  const accounts = readAcceptanceAccounts(process.env)
  const accountIndex = controlledAccountIndex(process.argv.slice(2), accounts.length)
  const executionPath = controlledExecutionPath(process.argv.slice(2))
  const requestedTaskType = controlledTaskType(process.argv.slice(2))
  const account = accounts[accountIndex - 1]
  if (!account) throw new Error('controlled-account-missing')
  const accountKey = `controlled-account-${String(accountIndex)}`
  const rootDirectory = process.cwd()
  const outputDirectory = join(rootDirectory, '.codex-output')
  await mkdir(outputDirectory, { recursive: true })
  const ledgerPath = join(outputDirectory, 'controlled-mutation-ledger.json')
  const ledger = await readMutationLedger(ledgerPath)
  const recordOnly = process.argv.includes('--record-current-as-submitted')
  const inspectServerActions = process.argv.includes('--inspect-server-actions')
  const inspectClaimControls = process.argv.includes('--inspect-claim-controls')
  const inspectExpandedClaimControls = process.argv.includes('--inspect-expanded-claim-controls')
  const inspectInteractiveQuiz = process.argv.includes('--inspect-interactive-quiz')
  const inspectCandidates =
    inspectServerActions ||
    inspectClaimControls ||
    inspectExpandedClaimControls ||
    inspectInteractiveQuiz ||
    process.argv.includes('--inspect-candidates')
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'rewards-next-controlled-'))
  const runtime = new BrowserRuntime({
    headless: false,
    sessions: new EncryptedSessionStore(join(temporaryRoot, 'sessions'), randomBytes(32)),
    executablePath: await resolveChromeExecutable()
  })
  const store = new SqliteStore(join(temporaryRoot, 'state.sqlite'))
  const controller = new AbortController()
  let slot: Awaited<ReturnType<BrowserRuntime['openSlot']>> | undefined
  let operationPerformed = false
  let readOnlyTargetNavigationPerformed = false
  let transportStatus: number | undefined
  let transportAcknowledged: boolean | undefined
  const startedAt = Date.now()
  try {
    slot = await runtime.openSlot(accountKey, 'web-desktop')
    const login = new LoginController(silentLogger)
    await slot.page.goto(REWARDS_URLS.login, {
      waitUntil: 'domcontentloaded',
      timeout: 30_000
    })
    await loginWithManualAssistance({
      controller: login,
      page: slot.page,
      credentials: account.credentials,
      signal: controller.signal,
      onActionRequired: () => {
        process.stdout.write(
          `账号 ${String(accountIndex)} 需要人工完成登录验证，等待最多 5 分钟。\n`
        )
      }
    })

    const client = new DashboardClient(
      slot.context,
      slot.page,
      silentLogger,
      'controlled-mutation',
      `account-${String(accountIndex)}`
    )
    const discoveryService = new RewardsDiscoveryService()
    let verification = await discoveryService.verifyAuthenticated(client, controller.signal)
    if (!verification.verification.valid) {
      await slot.page.goto(REWARDS_URLS.bingSignIn, {
        waitUntil: 'domcontentloaded',
        timeout: 30_000
      })
      await loginWithManualAssistance({
        controller: login,
        page: slot.page,
        credentials: account.credentials,
        signal: controller.signal
      })
      verification = await discoveryService.verifyAuthenticated(client, controller.signal)
    }
    if (!verification.verification.valid) throw new Error('controlled-login-unverified')

    const discovery = await discoveryService.discover({
      accountId: accountKey,
      localDate: localDateKey(),
      client,
      ...(verification.observation === undefined
        ? {}
        : { initialObservation: verification.observation }),
      signal: controller.signal
    })
    const excludedFingerprints = new Set(ledger.submittedFingerprints)
    if (inspectInteractiveQuiz) {
      const quizCandidates = [...discovery.descriptors.values()].filter(
        (descriptor) =>
          descriptor.task.type === 'daily-set' &&
          descriptor.task.status === 'discovered' &&
          descriptor.task.executable &&
          descriptor.offer?.destinationUrl !== undefined &&
          webOfferExecutionPath(
            descriptor.offer,
            Object.keys(discovery.snapshot.actionIds).some((name) =>
              name.toLowerCase().includes('reportactivity')
            )
          ) === 'interactive-quiz'
      )
      process.stdout.write(`交互式 Quiz 只读诊断：候选数量 ${String(quizCandidates.length)}。\n`)
      if (quizCandidates.length !== 1) return
      const destinationUrl = quizCandidates[0]?.offer?.destinationUrl
      if (!destinationUrl) throw new Error('controlled-quiz-target-missing')
      readOnlyTargetNavigationPerformed = true
      const activated = await client.openOfferForInteraction(destinationUrl)
      try {
        process.stdout.write(
          `Quiz 页面结构：${JSON.stringify(
            await inspectInteractiveQuizPage(activated.page, safePath(destinationUrl))
          )}\n`
        )
      } finally {
        await activated.close()
      }
      return
    }
    const selection =
      executionPath === 'navigate-only'
        ? {
            path: 'navigate-only' as const,
            candidate: selectControlledNavigationCandidate(
              discovery,
              excludedFingerprints,
              requestedTaskType
            )
          }
        : executionPath === 'claim-server-action'
          ? {
              path: 'claim-server-action' as const,
              candidate: selectControlledClaimCandidate(discovery, excludedFingerprints)
            }
          : executionPath === 'claim-ui'
            ? {
                path: 'claim-ui' as const,
                candidate: selectControlledClaimUiCandidate(discovery, excludedFingerprints)
              }
            : {
                path: 'report-activity' as const,
                candidate: selectControlledMutationCandidate(discovery, excludedFingerprints)
              }
    if (inspectCandidates) {
      if (inspectExpandedClaimControls) {
        process.stdout.write(
          `展开后领取控件只读诊断：${JSON.stringify(await client.inspectExpandedClaimControls())}\n`
        )
        return
      }
      if (inspectClaimControls) {
        process.stdout.write(
          `领取控件只读诊断：${JSON.stringify(await client.inspectClaimControls())}\n`
        )
        return
      }
      const actionNames = Object.keys(discovery.snapshot.actionIds).sort()
      const reportActivityMatches = actionNames.filter((name) =>
        name.toLowerCase().includes('reportactivity')
      )
      process.stdout.write(
        `受控候选只读诊断：path=${executionPath} actions=${String(actionNames.length)} reportActivityMatches=${String(reportActivityMatches.length)} deploymentId=${discovery.snapshot.deploymentId ? 'present' : 'missing'} routerStateTree=${discovery.snapshot.routerStateTree ? 'present' : 'missing'} eligibleCandidate=${selection.candidate ? 'present' : 'missing'}。\n`
      )
      if (inspectServerActions) {
        process.stdout.write(`动作名称：${actionNames.join(', ') || 'none'}。\n`)
      }
      process.stdout.write(
        `候选结构摘要：${JSON.stringify(summarizeControlledMutationCandidates(discovery))}\n`
      )
      if (executionPath === 'navigate-only') {
        const navigationCandidates = [...discovery.descriptors.values()].filter(
          (descriptor) =>
            descriptor.task.status === 'discovered' &&
            descriptor.task.executable &&
            descriptor.offer?.destinationUrl !== undefined &&
            webOfferExecutionPath(descriptor.offer, reportActivityMatches.length > 0) ===
              'navigate-only'
        )
        const inspections = []
        const flyoutCandidates = []
        for (const descriptor of navigationCandidates) {
          const destinationUrl = descriptor.offer?.destinationUrl
          if (!destinationUrl) continue
          const destination = new URL(destinationUrl)
          inspections.push({
            taskType: descriptor.task.type,
            source: descriptor.task.source,
            targetPath: safePath(destinationUrl),
            queryKeys: [...destination.searchParams.keys()].map((key) => key.toLowerCase()).sort(),
            progressTotal:
              descriptor.task.progress.total === null
                ? 'missing'
                : descriptor.task.progress.total === 0
                  ? 'zero'
                  : 'positive',
            dailySetDate: descriptor.offer?.attributes?.daily_set_date ?? 'missing',
            activityType: descriptor.offer?.activityType ?? 'missing',
            promotionType: descriptor.offer?.attributes?.promotionType ?? 'missing',
            promotionSubtype: descriptor.offer?.attributes?.promotionSubtype ?? 'missing',
            attributeKeys: Object.keys(descriptor.offer?.attributes ?? {}).sort(),
            ...(await client.inspectOfferLink(destinationUrl))
          })
          if (descriptor.offer?.source === 'bing-flyout') {
            flyoutCandidates.push({
              taskType: descriptor.task.type,
              sourceTaskId: descriptor.task.sourceTaskId,
              destinationUrl
            })
          }
        }
        process.stdout.write(`导航候选页面结构：${JSON.stringify(inspections)}\n`)
        process.stdout.write(
          `Bing flyout 卡片结构：${JSON.stringify(await inspectBingFlyoutSurface(slot.page, flyoutCandidates))}\n`
        )
      }
      return
    }
    if (!selection.candidate) {
      process.stdout.write(
        `账号 ${String(accountIndex)} 没有符合受控条件的未完成 ${executionPath} 任务，未执行外部操作。\n`
      )
      return
    }
    const candidate = selection.candidate

    const fingerprint = controlledMutationFingerprint(candidate.task)
    await recordSubmittedFingerprint(ledgerPath, ledger, fingerprint)
    if (recordOnly) {
      process.stdout.write(
        `账号 ${String(accountIndex)} 当前候选已写入本地幂等账本，本次未执行外部操作。\n`
      )
      return
    }

    store.upsertTask(candidate.task)
    process.stdout.write(
      `账号 ${String(accountIndex)} 已选择一个未完成的 ${candidate.task.type} 任务，准备执行一次 ${executionPath}。\n`
    )
    const adapter =
      selection.path === 'navigate-only'
        ? createControlledNavigationAdapter({
            client,
            candidate: selection.candidate,
            onNavigation: () => {
              operationPerformed = true
            }
          })
        : selection.path === 'claim-server-action'
          ? createControlledClaimAdapter({
              client,
              candidate: selection.candidate,
              onTransportResult: (result) => {
                transportStatus = result.status
                transportAcknowledged = result.acknowledged
              }
            })
          : selection.path === 'claim-ui'
            ? createControlledClaimUiAdapter({
                client,
                candidate: selection.candidate,
                onTransportResult: (result) => {
                  transportStatus = result.status
                  transportAcknowledged = result.acknowledged
                }
              })
            : createControlledMutationAdapter({
                client,
                candidate: selection.candidate,
                onTransportResult: (result) => {
                  transportStatus = result.status
                  transportAcknowledged = result.acknowledged
                }
              })
    if (executionPath !== 'navigate-only') operationPerformed = true
    const outcome = await new MutationExecutor(store).execute(
      candidate.task,
      adapter,
      controller.signal
    )
    const report = {
      schemaVersion: 1,
      mode: 'single-controlled-mutation',
      generatedAt: new Date().toISOString(),
      accountIndex,
      taskType: candidate.task.type,
      requestedTaskType: requestedTaskType ?? 'any',
      actionPath: executionPath,
      mutationSent: executionPath !== 'navigate-only' && operationPerformed,
      navigationPerformed: executionPath === 'navigate-only' && operationPerformed,
      ...(transportStatus === undefined ? {} : { transportStatus }),
      ...(transportAcknowledged === undefined ? {} : { transportAcknowledged }),
      status: outcome.status,
      verificationConfirmed: outcome.verification?.confirmed ?? false,
      ...(discovery.snapshot.availablePoints.availability === 'valid' &&
      discovery.snapshot.availablePoints.value !== undefined &&
      outcome.verification?.points?.availability === 'valid' &&
      outcome.verification.points.value !== undefined
        ? {
            pointsDelta:
              outcome.verification.points.value - discovery.snapshot.availablePoints.value
          }
        : {}),
      durationMs: Date.now() - startedAt
    }
    const outputPath = join(
      outputDirectory,
      `controlled-mutation-${report.generatedAt.replaceAll(/[:.]/g, '-')}.json`
    )
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600
    })
    process.stdout.write(`受控任务状态：${outcome.status}。\n`)
    process.stdout.write(`脱敏报告：${relative(rootDirectory, outputPath)}\n`)
    if (outcome.status !== 'verified') process.exitCode = 1
  } finally {
    controller.abort(new Error('controlled-mutation-finished'))
    await slot?.close().catch(() => undefined)
    await runtime.close().catch(() => undefined)
    store.close()
    await rm(temporaryRoot, { recursive: true, force: true })
    if (!operationPerformed) {
      process.stdout.write(
        readOnlyTargetNavigationPerformed
          ? '本次未执行 mutation；仅完成一次 Quiz 目标页只读检查。\n'
          : '本次未执行外部操作。\n'
      )
    }
  }
}

void main().catch((error: unknown) => {
  const code =
    error instanceof LoginStateError
      ? error.loginStage
      : error instanceof AcceptanceInspectionError
        ? error.code
        : error instanceof Error && /^controlled-[a-z-]+$/.test(error.message)
          ? error.message
          : 'controlled-mutation-failed'
  process.stderr.write(`受控 mutation 未完成：${code}\n`)
  process.exitCode = 1
})
