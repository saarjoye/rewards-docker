// Run after npm run build. Uses a fresh headless profile and intercepts every request.
/* global document */
import assert from 'node:assert/strict'
import console from 'node:console'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import process from 'node:process'
import { URL } from 'node:url'
import { chromium } from 'patchright'

const executablePath = [
  process.env.SEARCH_SMOKE_BROWSER,
  chromium.executablePath(),
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA &&
    join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'),
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
].find((candidate) => candidate && existsSync(candidate))
if (!executablePath)
  throw new Error(
    'No installed browser found; set SEARCH_SMOKE_BROWSER. No browser will be installed.'
  )

const browser = await chromium.launch({ executablePath, headless: true })
try {
  const context = await browser.newContext({ serviceWorkers: 'block' })
  let settings = {
    delayMinSeconds: 360,
    delayMaxSeconds: 720,
    scroll: true,
    clickResult: false,
    resultVisitSeconds: 8,
    stagnantLimit: 23
  }
  let saves = 0
  const failures = []
  const webRoot = resolve('dist/web')
  await context.route('**/*', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.origin !== 'https://search-settings.invalid') return route.abort()
    const json = (body) =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) })
    if (url.pathname === '/api/session') return json({ csrfToken: 'synthetic-csrf' })
    if (url.pathname === '/api/state')
      return json({
        version: 'synthetic',
        localDate: '2026-09-21',
        accounts: [],
        tasks: [],
        runs: [],
        today: [],
        taskSummary: {},
        runnerReady: false,
        activeRunId: null
      })
    if (url.pathname === '/api/events') return route.fulfill({ status: 204 })
    if (url.pathname === '/api/settings/search') {
      if (request.method() === 'PUT') {
        assert.equal(request.headers()['x-csrf-token'], 'synthetic-csrf')
        settings = request.postDataJSON()
        saves += 1
      }
      return json(settings)
    }
    const path = resolve(webRoot, `.${url.pathname === '/' ? '/index.html' : url.pathname}`)
    if (!path.startsWith(webRoot + sep) || !existsSync(path)) return route.fulfill({ status: 404 })
    const contentType = path.endsWith('.js')
      ? 'text/javascript'
      : path.endsWith('.css')
        ? 'text/css'
        : 'text/html'
    return route.fulfill({ contentType, body: await readFile(path) })
  })
  const page = await context.newPage()
  page.on('pageerror', (error) => failures.push(error.message))
  await page.goto('https://search-settings.invalid/#search')
  const limit = page.getByLabel('连续未获积分停止次数')
  await limit.waitFor()
  await page.waitForFunction(() => document.querySelector('input[max="100"]')?.value === '23')
  const save = page.getByRole('button', { name: '保存搜索设置', exact: true })
  assert.equal(await save.isDisabled(), true)
  await limit.fill('4')
  await save.click()
  await page.getByText('已保存，下一次搜索立即生效。', { exact: true }).waitFor()
  assert.equal(settings.stagnantLimit, 4)
  assert.equal(settings.delayMinSeconds, 360)
  assert.equal(settings.delayMaxSeconds, 720)
  assert.equal(saves, 1)
  await page.reload()
  await page.waitForFunction(() => document.querySelector('input[max="100"]')?.value === '4')
  await limit.fill('101')
  assert.equal(await limit.evaluate((element) => element.checkValidity()), false)
  assert.equal(saves, 1)
  assert.deepEqual(failures, [])
  console.log(
    JSON.stringify({
      passed: true,
      syntheticOnly: true,
      checks: ['Chinese label', 'load', 'save', 'reload', 'range validation', 'long delays']
    })
  )
} finally {
  await browser.close()
}
