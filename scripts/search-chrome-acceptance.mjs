import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import console from 'node:console'
import { URL } from 'node:url'
import { setTimeout, clearTimeout } from 'node:timers'
import { mkdir } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { chromium } from 'patchright'
import { resolveChromeExecutable } from '../dist/server/acceptance/ChromeExecutable.js'
import { DashboardClient } from '../dist/server/browser/DashboardClient.js'
import { RewardsTaskExecutor } from '../dist/server/rewards/RewardsTaskExecutor.js'
import { SqliteStore } from '../dist/server/infra/SqliteStore.js'
import { AdminAuthStore } from '../dist/server/infra/AdminAuthStore.js'
import { AccountSecretStore } from '../dist/server/infra/AccountSecretStore.js'
import { DEFAULT_CONFIG } from '../dist/server/infra/Config.js'
import { createServer } from '../dist/server/web/createServer.js'
import { localDateKey } from '../dist/server/domain/DateKey.js'

// All identities and payloads here are synthetic. APIRequestContext is explicitly
// redirected to loopback because browser routing does not intercept its requests.
const store = new SqliteStore(':memory:')
const adminAuth = new AdminAuthStore(store.database)
adminAuth.initialize('synthetic-admin', 'synthetic-password')
const accounts = new AccountSecretStore(store.database, Buffer.alloc(32, 7))
accounts.create({
  email: 'fixture@example.test',
  password: 'synthetic-only',
  displayAlias: '测试账号'
})
const accountId = accounts.list()[0].accountId
const coordinator = { activeRunId: undefined }
const app = await createServer({
  store,
  adminAuth,
  accounts,
  secureCookies: false,
  webRoot: resolve('dist/web'),
  runCoordinator: coordinator
})
let samples = []
let reads = 0
app.get('/synthetic-dashboard', (_request, reply) => {
  reads += 1
  const sample = samples.length > 1 ? samples.shift() : samples[0]
  if (sample === 'request-error') return reply.code(503).send({})
  if (sample === 'authentication-error') return reply.code(401).send({})
  const counter =
    sample === 'missing'
      ? undefined
      : sample === 'invalid'
        ? [{ pointProgress: null, pointProgressMax: 60 }]
        : [{ pointProgress: sample, pointProgressMax: 60 }]
  return {
    dashboard: {
      userStatus: { isRewardsUser: true, counters: counter ? { pcSearch: counter } : {} }
    }
  }
})
const output = resolve('.codex-output/search-chrome')
await mkdir(output, { recursive: true })
let browser
const results = []
try {
  const origin = await app.listen({ port: 18789, host: '127.0.0.1' })
  browser = await chromium.launch({
    executablePath: await resolveChromeExecutable(),
    headless: true,
    args: [
      '--no-proxy-server',
      '--disable-background-networking',
      '--disable-sync',
      '--disable-extensions',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'
    ]
  })
  const uiContext = await browser.newContext()
  await uiContext.route('**/*', (route) =>
    new URL(route.request().url()).origin === origin ? route.continue() : route.abort()
  )
  const ui = await uiContext.newPage()
  await ui.goto(origin)
  await ui.getByLabel('管理员账号').fill('synthetic-admin')
  await ui.getByLabel('管理员密码').fill('synthetic-password')
  await ui.getByRole('button', { name: '登录', exact: true }).click()
  await ui.locator('.workspace-toolbar').waitFor()

  const cases = [
    {
      name: 'delayed-growth',
      samples: [45, 48, 60],
      expected: 'completed',
      progress: 60,
      submissions: 2
    },
    {
      name: 'five-unresolved',
      samples: [45],
      recovery: true,
      expected: 'partial',
      progress: 45,
      submissions: 0
    },
    {
      name: 'missing-counter',
      samples: ['missing'],
      recovery: true,
      expected: 'partial',
      progress: 45,
      submissions: 0
    },
    {
      name: 'invalid-counter',
      samples: ['invalid'],
      recovery: true,
      expected: 'partial',
      progress: 45,
      submissions: 0
    },
    {
      name: 'smaller-counter',
      samples: [42],
      recovery: true,
      expected: 'partial',
      progress: 45,
      submissions: 0
    },
    {
      name: 'request-error',
      samples: ['request-error'],
      recovery: true,
      expected: 'failed',
      progress: 45,
      submissions: 0
    },
    {
      name: 'authentication-error',
      samples: ['authentication-error'],
      recovery: true,
      expected: 'failed',
      progress: 45,
      submissions: 0
    },
    {
      name: 'page-error',
      samples: [45],
      pageError: true,
      expected: 'failed',
      progress: 45,
      submissions: 0
    }
  ]
  for (const test of cases) {
    samples = [...test.samples]
    reads = 0
    const context = await browser.newContext()
    let submissions = 0
    await context.route('**/*', (route) => {
      const url = new URL(route.request().url())
      if (test.pageError) return route.abort()
      if (url.hostname !== 'www.bing.com')
        return route.fulfill({ contentType: 'text/html', body: '<html><body></body></html>' })
      if (url.pathname === '/search') submissions += 1
      return route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><html><body><form action="https://www.bing.com/search"><input name="q" aria-label="搜索"><button type="submit">搜索</button></form></body></html>'
      })
    })
    const page = await context.newPage()
    const runId = randomUUID()
    const now = new Date().toISOString()
    const localDate = localDateKey(new Date())
    const task = {
      taskId: `${accountId}:${localDate}:${test.name}`,
      accountId,
      localDate,
      sourceTaskId: 'pc-search',
      type: 'pc-search',
      source: 'legacy-getuserinfo',
      displayName: 'PC 搜索验收',
      executable: true,
      required: true,
      status: 'running',
      progress: { completed: 45, total: 60 },
      updatedAt: now,
      ...(test.recovery
        ? {
            searchObservation: {
              runId,
              submittedCount: 5,
              unknownSubmissionCount: 0,
              awaitingProgress: true,
              completed: 45,
              total: 60,
              observedAt: now,
              result: 'submitted'
            }
          }
        : {})
    }
    store.createRun({
      runId,
      localDate,
      executionMode: 'mutating',
      selectedAccountIndexes: [1],
      startedAt: now
    })
    store.updateRun(runId, 'running')
    store.ledger.lifecycle({
      runId,
      accountId,
      accountIndex: 1,
      accountLabel: '测试账号',
      startedAt: now,
      endedAt: null,
      executionState: 'running',
      updatedAt: now
    })
    store.upsertTask(task, runId)
    coordinator.activeRunId = runId
    const logs = []
    const logger = {
      write: (event) => {
        logs.push(event)
        return Promise.resolve()
      }
    }
    const adapterContext = {
      newPage: () => context.newPage(),
      request: {
        get: (_url, options) =>
          context.request.get(origin + '/synthetic-dashboard', {
            timeout: options?.timeout ?? 10000
          })
      }
    }
    const client = new DashboardClient(adapterContext, page, logger, runId, 'synthetic')
    const config = {
      ...DEFAULT_CONFIG,
      search: {
        ...DEFAULT_CONFIG.search,
        delayMinSeconds: 0,
        delayMaxSeconds: 0,
        scroll: false,
        clickResult: false
      }
    }
    const controller = new globalThis.AbortController()
    const timeout = setTimeout(() => controller.abort(new Error('synthetic-case-deadline')), 180000)
    try {
      await ui.goto(origin + '/#run/' + runId)
      await ui.locator('.task-evidence summary').click()
      const execution = new RewardsTaskExecutor(
        adapterContext,
        client,
        store,
        logger,
        config,
        runId,
        'synthetic'
      ).executeTypes({
        discovery: { tasks: [task], descriptors: new Map([[task.taskId, { task }]]) },
        types: ['pc-search'],
        mode: 'mutating',
        signal: controller.signal
      })
      // Attach a rejection handler while checking the live UI.
      const completed = execution.then(
        (value) => ({ value }),
        (error) => ({ error })
      )
      if (test.name === 'delayed-growth') {
        await ui.waitForFunction(
          () => /最后确认进度：48\s*\/\s*60/.test(globalThis.document.body.innerText),
          { timeout: 30000 }
        )
      }
      const outcome = await completed
      if (outcome.error) throw outcome.error
      assert.equal(outcome.value.status, test.expected)
      assert.equal(submissions, test.submissions)
      const saved = store.ledger.tasks(runId)[0]
      assert.equal(saved.progress.completed, test.progress)
      assert.equal(saved.progress.total, 60)
      const events = store.ledger.taskEvidence(runId).filter((row) => row.search)
      assert.equal(new Set(events.map((row) => row.search.eventId)).size, events.length)
      assert.equal(store.ledger.credits.rowsForRun(runId).length, 0)
      for (const event of events.filter((row) => row.search.kind === 'observation')) {
        assert.equal(typeof event.search.durationMs, 'number')
        assert.equal(typeof event.search.usedFallback, 'boolean')
      }
      store.ledger.lifecycle({
        runId,
        accountId,
        accountIndex: 1,
        accountLabel: '测试账号',
        startedAt: now,
        endedAt: new Date().toISOString(),
        executionState: test.expected,
        updatedAt: new Date().toISOString()
      })
      store.updateRun(runId, test.expected, new Date().toISOString())
      await ui.waitForFunction(
        ({ label }) =>
          globalThis.document.querySelector('.run-summary')?.textContent?.includes(label),
        {
          label: { completed: '全部完成', partial: '部分完成', failed: '执行失败' }[test.expected]
        },
        { timeout: 15000 }
      )
      await ui.waitForFunction(
        ({ expected }) =>
          globalThis.document.body.innerText.includes('最后确认进度：' + expected + ' / 60'),
        { expected: test.progress },
        { timeout: 15000 }
      )
      if (test.name === 'delayed-growth' || test.name === 'five-unresolved') {
        for (const width of [1440, 768, 390, 320]) {
          await ui.setViewportSize({ width, height: 960 })
          assert.equal(
            await ui.evaluate(
              () => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth
            ),
            true
          )
          assert.doesNotMatch(await ui.locator('body').innerText(), /待确认|未取得|未匹配/)
          await ui.screenshot({
            path: join(output, test.name + '-' + width + '.png'),
            fullPage: true
          })
        }
        await ui.setViewportSize({ width: 1440, height: 960 })
      }
      const observationLogs = logs.filter((event) => event.event === 'search-dashboard-observation')
      assert.doesNotMatch(
        JSON.stringify(observationLogs),
        /accountAlias|Cookie|Authorization|https?:\/\//
      )
      results.push({
        scenario: test.name,
        status: test.expected,
        progress: `${test.progress}/60`,
        newSubmissions: submissions,
        dashboardReads: reads,
        evidenceCount: events.length
      })
      console.log(JSON.stringify(results.at(-1)))
    } finally {
      clearTimeout(timeout)
      await context.close()
    }
  }
  console.log(
    JSON.stringify({
      ok: true,
      browser: await browser.version(),
      scenarios: results.length,
      screenshotCount: 8,
      realRewardsRequests: 0
    })
  )
} finally {
  await browser?.close()
  await app.close()
  store.close()
}
