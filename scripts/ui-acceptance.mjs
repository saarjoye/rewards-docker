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
const thirdAccountLabel = accounts.list()[2].displayAlias
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
const startRequests = []
const cancelRequests = []
const providerOrigins = []
const runCoordinator = {
  activeRunId: runId,
  start: async (request) => {
    startRequests.push(request)
    await new Promise((done) => setTimeout(done, 250))
    return { runId: randomUUID() }
  },
  cancel: (id) => {
    cancelRequests.push(id)
    return true
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
    const target = new URL(String(url))
    assert.ok(
      ['https://qyapi.weixin.qq.com', 'https://notify.example.test'].includes(target.origin)
    )
    assert.ok(target.pathname.startsWith('/cgi-bin/'))
    providerOrigins.push(target.origin)
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
let page
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
  page = await context.newPage()
  page.setDefaultTimeout(15000)
  const pageErrors = []
  page.on('pageerror', (error) => {
    pageErrors.push(error.message)
  })
  await page.goto(origin)
  let screenshots = 0
  for (const width of [1440, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 900 })
    await page.getByLabel('管理员账号').waitFor()
    await capture('login-' + String(width))
  }
  await page.getByRole('button', { name: '登录', exact: true }).click()
  assert.equal(
    await page.getByLabel('管理员账号').evaluate((node) => node.validity.valueMissing),
    true
  )
  await page.getByLabel('管理员账号').fill('synthetic-admin')
  await page.getByLabel('管理员密码').fill('synthetic-wrong')
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await page.getByRole('alert').filter({ hasText: '登录失败' }).waitFor()
  await page.locator('input[autocomplete=username]').fill('synthetic-admin')
  await page.locator('input[autocomplete=current-password]').fill('synthetic-password')
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await page.locator('.workspace-toolbar').waitFor()
  async function capture(name) {
    await page.evaluate(async () => {
      await Promise.all(
        globalThis.document
          .getAnimations()
          .filter((a) => a.effect?.getTiming().iterations !== Infinity)
          .map((a) => a.finished.catch(() => undefined))
      )
      globalThis.scrollTo(0, 0)
    })
    if (await page.locator('.topbar').count()) {
      assert.equal(
        await page
          .locator('.topbar')
          .evaluate((node) => Math.round(node.getBoundingClientRect().top)),
        0,
        'Topbar must stay at viewport top'
      )
      assert.equal(
        await page.locator('.t-drawer__mask:visible').count(),
        0,
        'Drawer overlay must be gone'
      )
    }
    await page.screenshot({ path: join(output, name + '-viewport.png') })
    await page.screenshot({ path: join(output, name + '.png'), fullPage: true })
    if (
      await page.evaluate(
        () => globalThis.document.documentElement.scrollWidth > globalThis.innerWidth
      )
    ) {
      console.log(
        JSON.stringify(
          await page.locator('*').evaluateAll((nodes) =>
            nodes
              .filter((n) => n.getBoundingClientRect().right > globalThis.innerWidth + 1)
              .slice(0, 15)
              .map((n) => ({
                tag: n.tagName,
                class: n.className,
                width: n.getBoundingClientRect().width
              }))
          )
        )
      )
    }
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
  async function navigate(name) {
    if (await page.getByRole('button', { name: '打开导航', exact: true }).isVisible())
      await page.getByRole('button', { name: '打开导航', exact: true }).click()
    const link = page.getByRole('link', { name, exact: true })
    await link.focus()
    await link.press('Enter')
    await page.getByRole('navigation', { name: '移动管理视图' }).waitFor({ state: 'hidden' })
  }
  async function openHistory() {
    await navigate('运行记录')
    await page.getByRole('heading', { name: '运行记录', exact: true }).waitFor()
  }
  async function captureDrawer(name) {
    await page.locator('.t-drawer--open').waitFor()
    await page.evaluate(async () => {
      await Promise.all(
        globalThis.document
          .getAnimations()
          .filter((a) => a.effect?.getTiming().iterations !== Infinity)
          .map((a) => a.finished.catch(() => undefined))
      )
    })
    const bounds = await page.locator('.t-drawer--open .t-drawer__content-wrapper').boundingBox()
    assert.ok(bounds && bounds.x >= -1 && bounds.x + bounds.width <= page.viewportSize().width + 1)
    await page.screenshot({ path: join(output, name + '-viewport.png') })
    screenshots += 1
  }
  for (const width of [1440, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 900 })
    await navigate('概览')
    await page.getByRole('heading', { name: '概览', exact: true }).waitFor()
    await capture('overview-' + String(width))
    await navigate('账号管理')
    await page.getByLabel('搜索账号').fill('no-fixture-match')
    await page.getByText('没有匹配的账号', { exact: true }).filter({ visible: true }).waitFor()
    await page.getByLabel('搜索账号').fill('')
    assert.equal(await page.getByRole('switch', { name: '启用账号 3' }).isDisabled(), true)
    await capture('accounts-' + String(width))
    await page.getByRole('button', { name: '添加账号', exact: true }).click()
    await page.getByLabel('Microsoft 账号', { exact: true }).waitFor()
    await captureDrawer('account-drawer-' + String(width))
    await page.locator('.t-drawer--open .t-drawer__close-btn').click()
    await page.getByLabel('Microsoft 账号', { exact: true }).waitFor({ state: 'hidden' })
    await page.getByRole('button', { name: '运行控制', exact: true }).click()
    await captureDrawer('run-drawer-' + String(width))
    await page.locator('.t-drawer--open .t-drawer__close-btn').click()
    await page.locator('.t-drawer__mask:visible').waitFor({ state: 'hidden' })
    assert.equal(
      await page
        .getByRole('button', { name: '运行控制', exact: true })
        .evaluate((node) => node === globalThis.document.activeElement),
      true
    )
    if (width === 1440) {
      await page.getByRole('button', { name: '编辑名称', exact: true }).first().click()
      await page.getByLabel('名称', { exact: true }).fill('合成别名')
      await page.getByRole('button', { name: '保存名称', exact: true }).click()
      await page.getByText('合成别名', { exact: true }).first().waitFor()
      await page.getByRole('button', { name: '运行控制', exact: true }).click()
      await page.getByRole('button', { name: '停止运行', exact: true }).click()
      await page.getByRole('button', { name: '取消', exact: true }).click()
      assert.equal(cancelRequests.length, 0)
      await page.getByRole('button', { name: '停止运行', exact: true }).click()
      await page.getByRole('button', { name: '确认停止', exact: true }).click()
      await page.getByRole('button', { name: '确认停止', exact: true }).waitFor({ state: 'hidden' })
      assert.deepEqual(cancelRequests, [runId])
      await page.locator('.t-drawer--open .t-drawer__close-btn').click()
      await page.locator('.t-drawer__mask:visible').waitFor({ state: 'hidden' })
    }
    await openHistory()
    await capture('history-' + String(width))
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
    await navigate('积分日历')
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
    await page
      .getByRole('button', { name: /无记录$/ })
      .first()
      .click()
    await page.getByText('当天无本地记录', { exact: true }).waitFor()
    await page.getByLabel('月份', { exact: true }).fill(localDate.slice(0, 7))
    await page.getByLabel('月份', { exact: true }).press('Enter')
    await page.getByRole('button', { name: localDate + ' 有记录', exact: true }).click()
    await page.getByRole('button', { name: '进行中 · 查看', exact: true }).click()
    await page.locator('.account-detail').waitFor()
    await navigate('任务')
    await page
      .locator('.task-section')
      .filter({ has: page.getByRole('heading', { name: '任务状态', exact: true }) })
      .locator('.responsive-data')
      .waitFor()
    await capture('tasks-' + String(width))
    await page.getByLabel('搜索任务', { exact: true }).fill('not-present')
    await page
      .getByText('没有符合筛选条件的任务', { exact: true })
      .filter({ visible: true })
      .waitFor()
    await page.getByRole('button', { name: '重置筛选', exact: true }).click()
    await navigate('消息推送')
    await page.getByLabel('企业 ID', { exact: true }).waitFor()
    if (width === 1440) {
      await page.getByRole('switch', { name: '启用企业微信推送' }).click()
      await page.getByLabel('企业 ID', { exact: true }).fill('synthetic-corp')
      await page.getByLabel('应用 AgentId', { exact: true }).fill('1')
      await page.getByLabel('应用 Secret', { exact: true }).fill('synthetic-secret')
      await page.getByLabel('企业微信反代地址', { exact: true }).fill('https://notify.example.test')
      assert.equal(
        await page.getByRole('button', { name: '发送测试消息', exact: true }).isDisabled(),
        true
      )
      await page.getByRole('link', { name: '概览', exact: true }).click()
      await page.getByRole('button', { name: '继续编辑', exact: true }).click()
      assert.equal(await page.getByLabel('企业 ID', { exact: true }).inputValue(), 'synthetic-corp')
      await page.getByRole('button', { name: '保存配置', exact: true }).click()
      await page.getByRole('status').filter({ hasText: '配置已加密保存' }).waitFor()
      assert.equal(await page.getByLabel('应用 Secret', { exact: true }).inputValue(), '')
      await page.getByRole('button', { name: '发送测试消息', exact: true }).click()
      await page.getByRole('status').filter({ hasText: '接口已接受测试消息' }).waitFor()
      assert.deepEqual(providerOrigins, [
        'https://notify.example.test',
        'https://notify.example.test'
      ])
    }
    await capture('notifications-' + String(width))
    await page.reload()
    await page.getByLabel('企业 ID', { exact: true }).waitFor()
    assert.equal(await page.getByLabel('企业 ID', { exact: true }).inputValue(), 'synthetic-corp')
    assert.equal(
      await page.getByLabel('企业微信反代地址', { exact: true }).inputValue(),
      'https://notify.example.test'
    )
    assert.equal(await page.getByLabel('应用 Secret', { exact: true }).inputValue(), '')
    if (width === 1440) {
      await page.getByLabel('企业 ID', { exact: true }).fill('unsaved-fixture')
      const dialogPromise = page.waitForEvent('dialog')
      const reload = page.reload().catch(() => undefined)
      const dialog = await dialogPromise
      assert.equal(dialog.type(), 'beforeunload')
      await dialog.dismiss()
      await reload
      assert.equal(
        await page.getByLabel('企业 ID', { exact: true }).inputValue(),
        'unsaved-fixture'
      )
      await page.getByRole('link', { name: '概览', exact: true }).click()
      await page.getByRole('button', { name: '放弃并离开', exact: true }).click()
      await page.getByRole('heading', { name: '概览', exact: true }).waitFor()
    }
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
  await navigate('积分日历')
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
  await page.locator('.account-detail').getByText('已确认', { exact: true }).first().waitFor()
  assert.equal(await evidence.evaluate((node) => node.open), true)
  await capture('detail-finalized-320')
  await navigate('积分日历')
  await page.getByRole('button', { name: '执行已结束 · 查看', exact: true }).waitFor()
  assert.match(await page.locator('.calendar-account').first().innerText(), /已确认[\s\S]*\+88 分/)
  await page.goto(origin + '/#run/' + randomUUID())
  await page.reload()
  await page.getByRole('alert').filter({ hasText: '未找到该运行的本地记录' }).waitFor()
  assert.equal(await page.locator('.account-detail').count(), 0)
  await page.getByRole('button', { name: '返回记录', exact: true }).click()
  await page.getByRole('button', { name: '查看详情', exact: true }).waitFor()
  await navigate('账号管理')
  await page.getByRole('button', { name: '添加账号', exact: true }).click()
  await page.getByLabel('Microsoft 账号', { exact: true }).fill('fixture4@example.test')
  await page.getByLabel('密码', { exact: true }).fill('synthetic-only')
  await page.getByLabel('显示名称', { exact: true }).fill('新增合成账号')
  await page.getByRole('button', { name: '保存账号', exact: true }).click()
  await page.getByText('新增合成账号', { exact: true }).filter({ visible: true }).waitFor()
  await page.getByRole('switch', { name: '启用账号 4' }).click()
  await page.waitForFunction(() =>
    [...globalThis.document.querySelectorAll('[aria-label="启用账号 4"]')].every(
      (node) => node.getAttribute('aria-checked') === 'false'
    )
  )
  await page.getByRole('button', { name: '新建运行', exact: true }).click()
  await page.getByText('指定账号', { exact: true }).click()
  await page.getByLabel('运行账号', { exact: true }).click()
  await page.getByText('账号 3 · ' + thirdAccountLabel, { exact: true }).click()
  assert.equal(await page.getByText('账号 4 · 新增合成账号', { exact: true }).count(), 0)
  await page.getByText('执行任务', { exact: true }).click()
  await page.getByText('只读检查', { exact: true }).click()
  await page.getByRole('button', { name: '开始检查', exact: true }).dblclick()
  await page.locator('.t-drawer__mask:visible').waitFor({ state: 'hidden' })
  assert.deepEqual(startRequests, [
    { accountMode: 'account', runAccountIndex: 3, executionMode: 'read-only' }
  ])
  assert.deepEqual(pageErrors, [])
  const result = {
    passed: true,
    notificationSettings: true,
    allPages: true,
    accountOperations: true,
    runControls: true,
    unsavedProtection: true,
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
} catch (error) {
  await page
    ?.screenshot({ path: join(output, 'failure.png'), fullPage: true })
    .catch(() => undefined)
  throw error
} finally {
  await browser?.close()
  await app.close()
  store.close()
}
