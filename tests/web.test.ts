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

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function fixture(runCoordinator?: RunCoordinator) {
  const root = await mkdtemp(join(tmpdir(), 'rewards-next-web-'))
  roots.push(root)
  const webRoot = join(root, 'web')
  await mkdir(webRoot)
  await writeFile(join(webRoot, 'index.html'), '<!doctype html><title>test</title>')
  const store = new SqliteStore(join(root, 'state.sqlite'))
  const adminAuth = new AdminAuthStore(store.database)
  adminAuth.initialize('admin', 'synthetic-admin-password')
  const accounts = new AccountSecretStore(store.database, Buffer.alloc(32, 9))
  const dependencies = {
    adminAuth,
    accounts,
    store,
    webRoot,
    secureCookies: false,
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
  return { app, store, cookie, csrfToken }
}

describe('web API', () => {
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
