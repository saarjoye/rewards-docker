import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { localDateKey } from '../src/domain/DateKey.js'
import { AccountSecretStore } from '../src/infra/AccountSecretStore.js'
import { AdminAuthStore } from '../src/infra/AdminAuthStore.js'
import { SqliteStore } from '../src/infra/SqliteStore.js'
import { createServer, type RunCoordinator } from '../src/web/createServer.js'
import { Notifications } from '../src/notifications/Notifications.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function fixture(runCoordinator?: RunCoordinator, withNotifications = false) {
  const root = await mkdtemp(join(tmpdir(), 'rewards-next-web-'))
  roots.push(root)
  const webRoot = join(root, 'web')
  await mkdir(webRoot)
  await writeFile(join(webRoot, 'index.html'), '<!doctype html><title>test</title>')
  const store = new SqliteStore(join(root, 'state.sqlite'))
  const adminAuth = new AdminAuthStore(store.database)
  adminAuth.initialize('admin', 'synthetic-admin-password')
  const accounts = new AccountSecretStore(store.database, Buffer.alloc(32, 9))
  const notificationFetch = vi.fn<typeof fetch>().mockImplementation(async (url) => {
    await Promise.resolve()
    return new Response(
      JSON.stringify(
        typeof url === 'string' && url.includes('gettoken')
          ? { errcode: 0, access_token: 'synthetic-access', expires_in: 7200 }
          : { errcode: 0 }
      )
    )
  })
  const dependencies = {
    adminAuth,
    accounts,
    store,
    webRoot,
    secureCookies: false,
    ...(withNotifications
      ? { notifications: new Notifications(store, Buffer.alloc(32, 9), notificationFetch) }
      : {}),
    ...(runCoordinator ? { runCoordinator } : {})
  }
  const app = await createServer(dependencies)
  const login = await app.inject({
    method: 'POST',
    url: '/api/login',
    payload: { username: 'admin', password: 'synthetic-admin-password' }
  })
  const setCookie = login.headers['set-cookie']
  if (typeof setCookie !== 'string') throw new Error('Synthetic login did not return a cookie')
  const cookie = setCookie.split(';')[0]
  if (!cookie) throw new Error('Synthetic login returned an empty cookie')
  const csrfToken = login.json<{ csrfToken: string }>().csrfToken
  return { app, store, cookie, csrfToken, notificationFetch }
}

describe('web API', () => {
  it('returns identical account reconciliation in state, detail, report and calendar', async () => {
    const { app, store, cookie } = await fixture()
    try {
      const runId = randomUUID()
      const date = localDateKey()
      const start = `${date}T00:00:00Z`
      const end = `${date}T02:00:00Z`
      store.createRun({
        runId,
        localDate: date,
        executionMode: 'mutating',
        selectedAccountIndexes: [3],
        startedAt: start
      })
      for (const [phase, value, observedAt] of [
        ['start', 5312, start],
        ['end', 5517, end]
      ] as const)
        store.ledger.balance(runId, 'synthetic', phase, {
          availability: 'valid',
          value,
          source: 'bing-flyout',
          confidence: 1,
          observedAt
        })
      for (const [source, value] of [
        ['app-dashboard', 30],
        ['bing-flyout', 60],
        ['rsc', 30]
      ] as const)
        store.ledger.credits.record({
          runId,
          accountId: 'synthetic',
          taskId: source,
          source,
          officialCreditId: source,
          observedAt: `${date}T01:00:00Z`,
          reportedPoints: value,
          earnedPoints: value,
          verificationStatus: 'confirmed',
          evidenceSource: 'official-credit',
          submitted: true
        })
      store.ledger.lifecycle({
        runId,
        accountId: 'synthetic',
        accountIndex: 3,
        accountLabel: 'Synthetic',
        startedAt: start,
        endedAt: end,
        executionState: 'completed',
        updatedAt: end
      })
      store.updateRun(runId, 'completed', end)
      const results = await Promise.all(
        [
          '/api/state',
          `/api/runs/${runId}`,
          `/api/runs/${runId}/report`,
          `/api/calendar?month=${date.slice(0, 7)}`
        ].map((url) => app.inject({ method: 'GET', url, headers: { cookie } }))
      )
      for (const result of results) expect(result.statusCode).toBe(200)
      const expected = {
        reportedTaskPoints: 120,
        confirmedTaskPoints: 120,
        pendingTaskPoints: 0,
        unattributedBalanceDelta: 85,
        overreportedTaskPoints: 0
      }
      expect(results[0]?.json<{ today: object[] }>().today[0]).toMatchObject({
        ...expected,
        dailyBalanceDelta: 205
      })
      expect(results[1]?.json<{ accounts: object[] }>().accounts[0]).toMatchObject({
        ...expected,
        runBalanceDelta: 205
      })
      expect(results[2]?.json<{ accounts: object[] }>().accounts[0]).toMatchObject(expected)
      expect(results[3]?.json<{ entries: object[] }>().entries[0]).toMatchObject({
        ...expected,
        dailyBalanceDelta: 205
      })
    } finally {
      await app.close()
      store.close()
    }
  })
  it('streams only refresh signals and restores updates after reconnect', async () => {
    const { app, store, cookie } = await fixture()
    try {
      const origin = await app.listen({ host: '127.0.0.1', port: 0 })
      expect((await fetch(`${origin}/api/events`)).status).toBe(401)
      for (let connection = 0; connection < 2; connection++) {
        const response = await fetch(`${origin}/api/events`, {
          headers: { cookie },
          signal: AbortSignal.timeout(3000)
        })
        expect(response.headers.get('content-type')).toBe('text/event-stream')
        if (!response.body) throw new Error('Missing event stream')
        const reader = response.body.getReader()
        expect(new TextDecoder().decode((await reader.read()).value)).toBe('data: state\n\n')
        store.ledger.lifecycle({
          runId: 'synthetic-sse',
          accountId: 'synthetic',
          accountIndex: 1,
          accountLabel: 'Synthetic',
          startedAt: '2026-09-09T00:00:00Z',
          endedAt: '2026-09-09T00:01:00Z',
          executionState: 'completed',
          updatedAt: '2026-09-09T00:01:00Z'
        })
        expect(new TextDecoder().decode((await reader.read()).value)).toBe('data: state\n\n')
        await reader.cancel()
      }
      expect(store.database.prepare('SELECT COUNT(*) AS n FROM account_completions').get()?.n).toBe(
        1
      )
    } finally {
      await app.close()
      store.close()
    }
  })
  it('protects notification settings and test sends with session and CSRF without returning secrets', async () => {
    const { app, store, cookie, csrfToken, notificationFetch } = await fixture(undefined, true)
    try {
      expect(
        (await app.inject({ method: 'GET', url: '/api/notifications/wecom' })).statusCode
      ).toBe(401)
      const payload = {
        enabled: true,
        corpId: 'synthetic-corp',
        agentId: '1',
        corpSecret: 'synthetic-secret',
        toUser: '@all'
      }
      expect(
        (
          await app.inject({
            method: 'PUT',
            url: '/api/notifications/wecom',
            headers: { cookie },
            payload
          })
        ).statusCode
      ).toBe(403)
      const saved = await app.inject({
        method: 'PUT',
        url: '/api/notifications/wecom',
        headers: { cookie, 'x-csrf-token': csrfToken },
        payload
      })
      expect(saved.statusCode).toBe(200)
      expect(saved.body).not.toContain('synthetic-secret')
      const read = await app.inject({
        method: 'GET',
        url: '/api/notifications/wecom',
        headers: { cookie }
      })
      expect(read.headers['cache-control']).toBe('no-store')
      expect(read.json<{ hasSecret: boolean }>().hasSecret).toBe(true)
      expect(notificationFetch).not.toHaveBeenCalled()
      const tested = await app.inject({
        method: 'POST',
        url: '/api/notifications/wecom/test',
        headers: { cookie, 'x-csrf-token': csrfToken }
      })
      expect(tested.json()).toEqual({ status: 'accepted' })
      expect(notificationFetch).toHaveBeenCalledTimes(2)
    } finally {
      await app.close()
      store.close()
    }
  })

  it('restores an authenticated session without replacing it', async () => {
    const { app, store, cookie, csrfToken } = await fixture()
    try {
      const response = await app.inject({ method: 'GET', url: '/api/session', headers: { cookie } })
      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({ csrfToken })
      expect(response.headers['cache-control']).toBe('no-store')
    } finally {
      await app.close()
      store.close()
    }
  })

  it('queries older runs directly and shares calendar and detail balance values', async () => {
    const { app, store, cookie } = await fixture()
    try {
      const id = randomUUID()
      for (let index = 0; index < 102; index += 1)
        store.createRun({
          runId: index === 0 ? id : randomUUID(),
          localDate: '2026-09-08',
          executionMode: 'read-only',
          selectedAccountIndexes: [3],
          startedAt: new Date(Date.UTC(2026, 8, 8, 0, index)).toISOString()
        })
      store.ledger.lifecycle({
        runId: id,
        accountId: 'synthetic',
        accountIndex: 3,
        accountLabel: 'Synthetic',
        startedAt: '2026-09-08T00:00:00Z',
        endedAt: null,
        executionState: 'running',
        updatedAt: '2026-09-08T00:00:00Z'
      })
      for (const [index, value] of [5312, 5517].entries())
        store.ledger.balance(id, 'synthetic', index === 0 ? 'start' : 'end', {
          value,
          availability: 'valid',
          source: 'bing-flyout',
          confidence: 0.9,
          observedAt: `2026-09-08T00:0${String(index)}:00Z`
        })
      const detail = await app.inject({
        method: 'GET',
        url: `/api/runs/${id}`,
        headers: { cookie }
      })
      expect(detail.statusCode).toBe(200)
      expect(detail.json<{ run: { runBalanceDelta: number } }>().run.runBalanceDelta).toBe(205)
      const calendar = await app.inject({
        method: 'GET',
        url: '/api/calendar?month=2026-09',
        headers: { cookie }
      })
      expect(
        calendar.json<{ entries: Array<{ dailyBalanceDelta: number }> }>().entries[0]
          ?.dailyBalanceDelta
      ).toBe(205)
      const report = await app.inject({
        method: 'GET',
        url: `/api/runs/${id}/report`,
        headers: { cookie }
      })
      expect(report.statusCode).toBe(200)
      expect(report.json<{ tasks: unknown[] }>().tasks).toEqual([])
      const list = await app.inject({ method: 'GET', url: '/api/runs?page=6', headers: { cookie } })
      expect(list.json<{ runs: unknown[] }>().runs).toHaveLength(2)
    } finally {
      await app.close()
      store.close()
    }
  })

  it('requires authentication and never returns plaintext account credentials', async () => {
    const { app, store, cookie, csrfToken } = await fixture()
    try {
      expect((await app.inject({ method: 'GET', url: '/api/state' })).statusCode).toBe(401)
      const create = await app.inject({
        method: 'POST',
        url: '/api/accounts',
        headers: { cookie, 'x-csrf-token': csrfToken },
        payload: {
          email: 'account@example.test',
          password: 'synthetic-account-password',
          displayAlias: 'Account One'
        }
      })
      expect(create.statusCode).toBe(201)
      const accountId = create.json<{ account: { accountId: string } }>().account.accountId
      store.upsertTask({
        taskId: `${accountId}:${localDateKey()}:claim`,
        accountId,
        localDate: localDateKey(),
        sourceTaskId: 'claim',
        type: 'claim-bonus-points',
        source: 'rsc',
        displayName: '领取奖励积分',
        executable: true,
        required: true,
        status: 'completed',
        progress: { completed: 1, total: 1 },
        updatedAt: new Date().toISOString()
      })
      const state = await app.inject({ method: 'GET', url: '/api/state', headers: { cookie } })
      expect(state.statusCode).toBe(200)
      expect(state.body).not.toContain('account@example.test')
      expect(state.body).not.toContain('synthetic-account-password')
      const statePayload = state.json<{ accounts: unknown[]; tasks: unknown[] }>()
      expect(statePayload.accounts[0]).toMatchObject({
        runAccountIndex: 1,
        displayAlias: 'Account One',
        enabled: true
      })
      expect(statePayload.tasks[0]).toMatchObject({
        sourceTaskId: 'claim',
        source: 'rsc',
        executable: true,
        required: true,
        progress: { completed: 1, total: 1 }
      })
    } finally {
      await app.close()
      store.close()
    }
  })

  it('passes explicit continue and one-based account requests to the runner', async () => {
    const start = vi
      .fn<RunCoordinator['start']>()
      .mockResolvedValue({ runId: 'synthetic-run', selectedAccountIndexes: [1] })
    const { app, store, cookie, csrfToken } = await fixture({ start, activeRunId: undefined })
    try {
      const headers = { cookie, 'x-csrf-token': csrfToken }
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/runs',
            headers,
            payload: { accountMode: 'continue' }
          })
        ).statusCode
      ).toBe(202)
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/runs',
            headers,
            payload: { accountMode: 'account', runAccountIndex: 1 }
          })
        ).statusCode
      ).toBe(202)
      expect(start).toHaveBeenNthCalledWith(1, {
        accountMode: 'continue',
        executionMode: 'read-only'
      })
      expect(start).toHaveBeenNthCalledWith(2, {
        accountMode: 'account',
        runAccountIndex: 1,
        executionMode: 'read-only'
      })
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/runs',
            headers,
            payload: { accountMode: 'account', runAccountIndex: 0 }
          })
        ).statusCode
      ).toBe(400)
    } finally {
      await app.close()
      store.close()
    }
  })
})
