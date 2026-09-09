import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { setTimeout } from 'node:timers'
import console from 'node:console'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { URL } from 'node:url'
import { chromium } from 'patchright'
import { resolveChromeExecutable } from '../.codex-output/next-build/server/acceptance/ChromeExecutable.js'
import { SqliteStore } from '../.codex-output/next-build/server/infra/SqliteStore.js'
import { AdminAuthStore } from '../.codex-output/next-build/server/infra/AdminAuthStore.js'
import { AccountSecretStore } from '../.codex-output/next-build/server/infra/AccountSecretStore.js'
import { createServer } from '../.codex-output/next-build/server/web/createServer.js'
import { Notifications } from '../.codex-output/next-build/server/notifications/Notifications.js'

const store = new SqliteStore(':memory:')
const adminAuth = new AdminAuthStore(store.database)
adminAuth.initialize('synthetic-admin', 'synthetic-password')
const accounts = new AccountSecretStore(store.database, Buffer.alloc(32, 7))
for (const index of [1, 2, 3]) {
  accounts.create({
    email: `fixture${String(index)}@example.test`,
    password: 'synthetic-only',
    displayAlias: `测试账号 ${String(index)}`
  })
}
const accountId = accounts.list()[2].accountId
const runId = randomUUID()
const now = new Date()
const localDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(now)
const start = new Date(now.getTime() - 60000).toISOString()
store.createRun({
  runId,
  localDate,
  executionMode: 'read-only',
  selectedAccountIndexes: [3],
  startedAt: start
})
store.updateRun(runId, 'running')
store.ledger.lifecycle({
  runId,
  accountId,
  accountIndex: 3,
  accountLabel: 'f***@e***.test',
  startedAt: start,
  endedAt: null,
  executionState: 'running',
  updatedAt: start
})
for (const [phase, value, observedAt] of [
  ['start', 5000, start],
  ['live', 5088, now.toISOString()]
]) {
  store.ledger.balance(runId, accountId, phase, {
    value,
    availability: 'valid',
    confidence: 0.9,
    source: 'bing-flyout',
    observedAt
  })
}
store.upsertTask(
  {
    taskId: 'synthetic-task',
    accountId,
    localDate,
    sourceTaskId: 'synthetic-offer',
    type: 'daily-set',
    source: 'rsc',
    displayName: '合成任务',
    executable: true,
    required: true,
    status: 'completed',
    progress: { completed: 1, total: 1 },
    updatedAt: now.toISOString()
  },
  runId
)
const runCoordinator = {
  activeRunId: runId,
  start: async () => {
    throw new Error('Disabled in UI acceptance')
  }
}
for (const row of [
  { kind: 'execution', executionState: 'running', completed: 0, total: 30, observedAt: start },
  {
    kind: 'response',
    accepted: true,
    balance: 5088,
    observedAt: new Date(now.getTime() - 1000).toISOString()
  },
  { kind: 'verification', completed: 30, total: 30, observedAt: now.toISOString() }
])
  store.ledger.recordTaskEvidence({
    runId,
    accountId,
    taskId: 'synthetic-task',
    source: 'app-dashboard',
    ...row
  })
const app = await createServer({
  store,
  adminAuth,
  accounts,
  secureCookies: false,
  webRoot: resolve('.codex-output/next-build/web'),
  runCoordinator,
  notifications: new Notifications(store, Buffer.alloc(32, 7), async (url) => {
    assert.ok(String(url).startsWith('https://qyapi.weixin.qq.com/cgi-bin/'))
    return new globalThis.Response(
      JSON.stringify(
        String(url).includes('gettoken')
          ? { errcode: 0, access_token: 'synthetic-access', expires_in: 7200 }
          : { errcode: 0 }
      )
    )
  })
})
app.addHook('onSend', async (_request, reply, payload) => {
  reply.header(
    'content-security-policy',
    "default-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'"
  )
  return payload
})
const output = resolve('.codex-output/ui-acceptance')
await mkdir(output, { recursive: true })
let browser
try {
  const origin = await app.listen({ port: 0, host: '127.0.0.1' })
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
  const context = await browser.newContext()
  let failDetail = false
  let delayDetail = false
  await context.route('**/*', async (route) => {
    if (
      !route
        .request()
        .url()
        .startsWith(origin + '/')
    )
      return route.abort()
    if (new URL(route.request().url()).pathname === '/api/runs/' + runId) {
      if (failDetail) return route.fulfill({ status: 503, body: '{}' })
      if (delayDetail) {
        const response = await route.fetch()
        await new Promise((done) => setTimeout(done, 1200))
        return route.fulfill({ response })
      }
    }
    return route.continue()
  })
  const page = await context.newPage()
  page.setDefaultTimeout(15000)
  const pageErrors = []
  page.on('pageerror', (error) => {
    pageErrors.push(error.message)
  })
  await page.goto(origin)
  await page.locator('input[autocomplete=username]').fill('synthetic-admin')
  await page.locator('input[autocomplete=current-password]').fill('synthetic-password')
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await page.locator('nav').waitFor()
  let screenshots = 0
  async function capture(name) {
    assert.equal(
      await page.evaluate(
        () => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth
      ),
      true,
      'Horizontal overflow: ' + name
    )
    const badControls = await page.locator('button, select, input').evaluateAll(
      (nodes) =>
        nodes.filter((node) => {
          const rect = node.getBoundingClientRect()
          return (
            rect.width > 0 &&
            rect.height > 0 &&
            (rect.x < -1 || rect.right > globalThis.innerWidth + 1)
          )
        }).length
    )
    assert.equal(badControls, 0, 'Control overflow: ' + name)
    await page.screenshot({ path: join(output, name + '.png'), fullPage: true })
    screenshots += 1
  }
  async function openHistory() {
    await page.getByRole('button', { name: '运行记录', exact: true }).click()
    await page.getByRole('heading', { name: '运行记录', exact: true }).waitFor()
  }
  for (const width of [1440, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 900 })
    await openHistory()
    await page.getByRole('button', { name: '查看详情', exact: true }).click()
    await page.locator('.account-detail').waitFor()
    assert.match(await page.locator('.balance-fields').first().innerText(), /\+88 分/)
    assert.match(await page.locator('.account-detail').innerText(), /未归属余额变化\s*\+88 分/)
    const evidence = page.locator('.task-evidence').first()
    await evidence.locator('summary').click()
    assert.match(await evidence.innerText(), /未取得到账证据/)
    assert.match(await evidence.innerText(), /5088 分/)
    await page.getByLabel('记录类型').selectOption('response')
    assert.equal(await evidence.locator('tbody tr').count(), 1)
    await page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/api/runs/' + runId
    )
    assert.equal(await evidence.evaluate((node) => node.open), true)
    assert.equal(await page.getByLabel('记录类型').inputValue(), 'response')
    await capture('detail-' + String(width))
    await page.reload()
    await page.locator('.account-detail').waitFor()
    assert.equal(new URL(page.url()).hash, '#run/' + runId)
    await page.getByRole('button', { name: '积分日历', exact: true }).click()
    await page.locator('.calendar-account').first().waitFor()
    assert.match(
      await page.locator('.calendar-account').first().innerText(),
      /账号 3 · f\*\*\*@e\*\*\*\.test/
    )
    assert.match(await page.locator('.calendar-account').first().innerText(), /\+88 分/)
    await page.locator('.calendar-account details summary').first().click()
    assert.match(
      await page.locator('.calendar-account').first().innerText(),
      /未归属余额变化\s*\+88 分/
    )
    await capture('calendar-' + String(width))
    await page.getByRole('button', { name: '进行中 · 查看', exact: true }).click()
    await page.locator('.account-detail').waitFor()
    await page.getByRole('button', { name: '任务', exact: true }).click()
    await page
      .locator('.task-section')
      .filter({ has: page.getByRole('heading', { name: '任务状态', exact: true }) })
      .locator('.task-table-wrap')
      .waitFor()
    await capture('tasks-' + String(width))
    await page.getByRole('button', { name: '消息推送', exact: true }).click()
    await page.getByLabel('企业 ID', { exact: true }).waitFor()
    if (width === 1440) {
      await page.getByLabel('启用企业微信推送').check()
      await page.getByLabel('企业 ID', { exact: true }).fill('synthetic-corp')
      await page.getByLabel('应用 AgentId', { exact: true }).fill('1')
      await page.getByLabel('应用 Secret', { exact: true }).fill('synthetic-secret')
      await page.getByRole('button', { name: '保存配置', exact: true }).click()
      await page.getByRole('status').filter({ hasText: '配置已加密保存' }).waitFor()
      assert.equal(await page.getByLabel('应用 Secret', { exact: true }).inputValue(), '')
      await page.getByRole('button', { name: '发送测试消息', exact: true }).click()
      await page.getByRole('status').filter({ hasText: '接口已接受测试消息' }).waitFor()
    }
    await capture('notifications-' + String(width))
    await page.reload()
    await page.getByLabel('企业 ID', { exact: true }).waitFor()
    assert.equal(await page.getByLabel('企业 ID', { exact: true }).inputValue(), 'synthetic-corp')
    assert.equal(await page.getByLabel('应用 Secret', { exact: true }).inputValue(), '')
    await openHistory()
    await page.getByRole('button', { name: '查看详情', exact: true }).click()
    await page.locator('.account-detail').waitFor()
  }
  const evidence = page.locator('.task-evidence').first()
  await evidence.locator('summary').click()
  failDetail = true
  await page.getByRole('alert').filter({ hasText: '已有观测可能过期' }).waitFor()
  assert.match(await page.locator('.balance-fields').first().innerText(), /\+88 分/)
  failDetail = false
  await page.waitForFunction(
    () =>
      ![...globalThis.document.querySelectorAll('[role=alert]')].some((node) =>
        node.textContent.includes('已有观测可能过期')
      )
  )
  assert.equal(await evidence.evaluate((node) => node.open), true)
  // An old response must not replace the next selected page.
  delayDetail = true
  await page.waitForRequest((request) => new URL(request.url()).pathname === '/api/runs/' + runId)
  await page.getByRole('button', { name: '积分日历', exact: true }).click()
  await page.locator('.calendar-account').first().waitFor()
  await page.waitForTimeout(1500)
  assert.equal(await page.getByRole('heading', { name: '积分日历', exact: true }).count(), 1)
  delayDetail = false
  await page.getByRole('button', { name: '进行中 · 查看', exact: true }).click()
  await page.locator('.account-detail').waitFor()
  await evidence.locator('summary').click()
  const endedAt = new Date().toISOString()
  store.updateRun(runId, 'completed', endedAt)
  runCoordinator.activeRunId = undefined
  store.ledger.balance(runId, accountId, 'end', {
    value: 5088,
    availability: 'valid',
    source: 'bing-flyout',
    confidence: 0.9,
    observedAt: endedAt
  })
  store.ledger.lifecycle({
    ...store.ledger.accounts(runId)[0],
    endedAt,
    executionState: 'completed',
    updatedAt: endedAt
  })
  await page.getByText('执行已结束 · 余额已确认', { exact: true }).waitFor()
  assert.equal(await evidence.evaluate((node) => node.open), true)
  await capture('detail-finalized-320')
  await page.getByRole('button', { name: '积分日历', exact: true }).click()
  await page.getByRole('button', { name: '执行已结束 · 查看', exact: true }).waitFor()
  assert.match(await page.locator('.calendar-account').first().innerText(), /\+88 分 · 已确认/)
  await page.goto(origin + '/#run/' + randomUUID())
  await page.reload()
  await page.getByRole('alert').filter({ hasText: '未找到该运行的本地记录' }).waitFor()
  assert.equal(await page.locator('.account-detail').count(), 0)
  await page.getByRole('button', { name: '返回记录', exact: true }).click()
  await page.getByRole('button', { name: '查看详情', exact: true }).waitFor()
  assert.deepEqual(pageErrors, [])
  const result = {
    passed: true,
    notificationSettings: true,
    widths: [1440, 768, 390, 320],
    screenshots,
    reload: true,
    finalizationWithoutReload: true,
    evidenceExpansionPreserved: true,
    staleFailureRecovery: true,
    delayedResponseIsolation: true,
    unknownRunRecovery: true
  }
  await writeFile(join(output, 'result.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result))
} finally {
  await browser?.close()
  await app.close()
  store.close()
}
