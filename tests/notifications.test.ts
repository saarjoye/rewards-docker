import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { SqliteStore } from '../src/infra/SqliteStore.js'
import { Notifications, notificationInput } from '../src/notifications/Notifications.js'
import { decryptBytes, encryptBytes, type EncryptedEnvelope } from '../src/security/CryptoVault.js'

const config = {
  enabled: true,
  corpId: 'synthetic-corp',
  agentId: '1',
  corpSecret: 'synthetic-secret',
  toUser: '@all',
  maxAttempts: 3
}
const response = (body: object) => new Response(JSON.stringify(body), { status: 200 })
const requestUrl = (input: Parameters<typeof fetch>[0]) =>
  new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
function fixture() {
  const store = new SqliteStore(':memory:')
  const send = vi.fn<typeof fetch>().mockImplementation(async (url) => {
    await Promise.resolve()
    return typeof url === 'string' && url.includes('gettoken')
      ? response({ errcode: 0, access_token: 'synthetic-access', expires_in: 7200 })
      : response({ errcode: 0 })
  })
  let now = Date.parse('2026-09-09T00:00:00Z')
  const create = () => new Notifications(store, Buffer.alloc(32, 9), send, () => now)
  const service = create()
  service.save(config)
  const runId = randomUUID()
  now += 1000
  store.createRun({
    runId,
    localDate: '2026-09-09',
    executionMode: 'mutating',
    selectedAccountIndexes: [1, 2],
    startedAt: new Date(now).toISOString()
  })
  const complete = () => {
    store.upsertTask(
      {
        taskId: 'completed-fixture',
        accountId: 'synthetic',
        localDate: '2026-09-09',
        sourceTaskId: 'fixture',
        source: 'rsc',
        type: 'daily-set',
        displayName: 'Synthetic completed task',
        executable: true,
        required: true,
        status: 'completed',
        progress: { completed: 1, total: 1 },
        updatedAt: new Date(now).toISOString()
      },
      runId
    )
    store.ledger.lifecycle({
      runId,
      accountId: 'synthetic',
      accountIndex: 1,
      accountLabel: 's***@example.com',
      startedAt: new Date(now).toISOString(),
      endedAt: new Date(now + 1000).toISOString(),
      executionState: 'completed',
      updatedAt: new Date(now + 1000).toISOString()
    })
  }
  return {
    store,
    service,
    send,
    runId,
    complete,
    create,
    advance: () => {
      now += 60_000
    }
  }
}

describe('persistent enterprise notifications', () => {
  it.each([
    { opening: 1000, latest: 1110, total: '1110 分', delta: '+110 分' },
    { opening: 0, latest: 0, total: '0 分', delta: '0 分' },
    { opening: null, latest: null, total: '—', delta: '—' }
  ])(
    'shows the latest total separately from the run change: $total',
    async ({ opening, latest, total, delta }) => {
      const { store, service, send, runId, complete } = fixture()
      try {
        if (opening !== null) {
          for (const [phase, value, observedAt] of [
            ['start', opening, '2026-09-09T00:00:01Z'],
            ['live', latest, '2026-09-09T00:00:02Z']
          ] as const) {
            store.ledger.balance(runId, 'synthetic', phase, {
              value,
              observedAt,
              availability: 'valid',
              confidence: 1,
              source: 'rsc'
            })
          }
        }
        complete()
        await service.tick()
        const body = send.mock.calls.find(
          ([url]) => typeof url === 'string' && url.includes('message/send')
        )?.[1]?.body
        expect(body).toContain(`实时总分：${total}`)
        expect(body).toContain(`本轮实时余额变化：${delta}`)
        expect(body).not.toContain('余额确认：')
        expect(body).not.toContain('待确认')
      } finally {
        store.close()
      }
    }
  )

  it('upgrades an old settings table idempotently without rewriting existing encrypted settings', () => {
    const store = new SqliteStore(':memory:')
    const key = Buffer.alloc(32, 9)
    const encrypted = JSON.stringify(encryptBytes(Buffer.from(JSON.stringify(config)), key))
    try {
      store.database.exec(`CREATE TABLE notification_settings (
        id INTEGER PRIMARY KEY, schema_version INTEGER NOT NULL, encrypted TEXT NOT NULL,
        enabled_since TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0
      )`)
      store.database
        .prepare('INSERT INTO notification_settings VALUES(1,2,?,?,1)')
        .run(encrypted, '2026-09-09T00:00:00Z')
      for (let i = 0; i < 2; i++) {
        const service = new Notifications(store, key)
        expect(service.status().apiBaseUrl).toBe('https://qyapi.weixin.qq.com')
        expect(
          store.database.prepare('SELECT encrypted FROM notification_settings').get()?.encrypted
        ).toBe(encrypted)
      }
    } finally {
      store.close()
    }
  })

  it('persists a reverse proxy for both provider calls, preserves omitted edits, and resets to official on blank', async () => {
    const { store, service, send, create } = fixture()
    try {
      service.save({ ...config, apiBaseUrl: 'https://notify.example.test/wecom/cgi-bin/' })
      expect(service.status().apiBaseUrl).toBe('https://notify.example.test/wecom')
      const stored = store.database
        .prepare('SELECT encrypted, api_base_encrypted FROM notification_settings')
        .get() as { encrypted: string; api_base_encrypted: string }
      expect(stored.api_base_encrypted).not.toContain('notify.example.test')
      const originalShape = JSON.parse(
        decryptBytes(
          JSON.parse(stored.encrypted) as EncryptedEnvelope,
          Buffer.alloc(32, 9)
        ).toString('utf8')
      ) as unknown
      expect(notificationInput.omit({ apiBaseUrl: true }).parse(originalShape)).toEqual(config)
      const restarted = create()
      restarted.save({ ...config, corpSecret: '' })
      await restarted.test()
      expect(send.mock.calls.map(([url]) => requestUrl(url).pathname)).toEqual([
        '/wecom/cgi-bin/gettoken',
        '/wecom/cgi-bin/message/send'
      ])
      expect(
        send.mock.calls.every(
          ([url, init]) =>
            requestUrl(url).origin === 'https://notify.example.test' && init?.redirect === 'error'
        )
      ).toBe(true)
      send.mockClear()
      restarted.save({ ...config, apiBaseUrl: '' })
      await restarted.test()
      expect(send.mock.calls).toHaveLength(2)
      expect(
        send.mock.calls.every(([url]) => requestUrl(url).origin === 'https://qyapi.weixin.qq.com')
      ).toBe(true)
    } finally {
      store.close()
    }
  })

  it.each([
    'http://notify.example.test',
    'https://user:synthetic@notify.example.test',
    'https://notify.example.test/?key=synthetic',
    'https://notify.example.test/#fragment',
    'https://127.0.0.1',
    'https://[::1]',
    'https://localhost',
    'file:///tmp/mock'
  ])('rejects unsafe reverse proxy configuration without fetching: %s', (apiBaseUrl) => {
    const { store, service, send } = fixture()
    try {
      expect(() => service.save({ ...config, apiBaseUrl })).toThrow()
      expect(send).not.toHaveBeenCalled()
    } finally {
      store.close()
    }
  })

  it('atomically queues ACCOUNT-END without a formal run, and rolls the event back if queuing fails', async () => {
    const { store, service, send } = fixture()
    try {
      const event = {
        runId: 'no-formal-run',
        accountId: 'orphan',
        accountIndex: 1,
        accountLabel: 's***@example.test',
        startedAt: '2026-09-09T00:00:01Z',
        endedAt: '2026-09-09T00:00:02Z',
        executionState: 'completed' as const,
        updatedAt: '2026-09-09T00:00:02Z'
      }
      store.ledger.lifecycle(event)
      expect(store.getRun(event.runId)).toBeUndefined()
      expect(service.status().recent[0]).toMatchObject({
        notificationKey: 'account:no-formal-run:orphan',
        status: 'pending'
      })
      await service.tick()
      expect(service.status().recent[0]?.status).toBe('sent')
      store.ledger.lifecycle(event)
      await service.tick()
      expect(
        send.mock.calls.filter(([url]) => typeof url === 'string' && url.includes('message/send'))
      ).toHaveLength(1)
      store.database.exec(
        "CREATE TRIGGER simulate_queue_failure BEFORE INSERT ON notification_jobs BEGIN SELECT RAISE(ABORT,'synthetic failure'); END"
      )
      expect(() => {
        store.ledger.lifecycle({ ...event, accountId: 'rollback' })
      }).toThrow()
      expect(
        store.ledger.accounts(event.runId).some((account) => account.accountId === 'rollback')
      ).toBe(false)
    } finally {
      store.close()
    }
  })

  it('protects completed account history while another account and the run are interrupted', async () => {
    const { store, service, complete, runId } = fixture()
    try {
      store.upsertAccountRun({
        runId,
        accountId: 'synthetic',
        runAccountIndex: 1,
        localDate: '2026-09-09',
        status: 'success',
        updatedAt: '2026-09-09T00:00:01Z'
      })
      complete()
      store.upsertAccountRun({
        runId,
        accountId: 'synthetic',
        runAccountIndex: 1,
        localDate: '2026-09-09',
        status: 'failed',
        updatedAt: '2026-09-09T00:00:05Z'
      })
      store.ledger.lifecycle({
        runId,
        accountId: 'second',
        accountIndex: 2,
        accountLabel: 'b***@example.test',
        startedAt: '2026-09-09T00:00:03Z',
        endedAt: null,
        executionState: 'running',
        updatedAt: '2026-09-09T00:00:03Z'
      })
      store.updateRun(runId, 'running')
      store.recoverInterruptedRuns()
      expect(store.getRun(runId)?.status).toBe('interrupted')
      expect(store.ledger.accounts(runId).map((account) => account.executionState)).toEqual([
        'completed',
        'interrupted'
      ])
      expect(store.listAccountRuns(runId)[0]?.status).toBe('success')
      await service.tick()
      expect(service.status().recent).toHaveLength(2)
    } finally {
      store.close()
    }
  })

  it('sends each serial account promptly through lifecycle signals, then sends the run summary', async () => {
    const { store, service, complete, runId } = fixture()
    service.start()
    try {
      await service.tick()
      complete()
      await vi.waitFor(() => {
        expect(service.status().recent[0]?.status).toBe('sent')
      })
      store.ledger.lifecycle({
        runId,
        accountId: 'second',
        accountIndex: 2,
        accountLabel: 'b***@example.test',
        startedAt: '2026-09-09T00:00:03Z',
        endedAt: '2026-09-09T00:00:04Z',
        executionState: 'completed',
        updatedAt: '2026-09-09T00:00:04Z'
      })
      await vi.waitFor(() => {
        expect(service.status().recent.filter((job) => job.status === 'sent')).toHaveLength(2)
      })
      store.updateRun(runId, 'completed', '2026-09-09T00:00:05Z')
      await vi.waitFor(() => {
        expect(service.status().recent.filter((job) => job.status === 'sent')).toHaveLength(3)
      })
    } finally {
      await service.close()
      store.close()
    }
  })

  it('migrates an existing file database repeatedly and restores a pending job after closing it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'next-notification-test-'))
    let store = new SqliteStore(join(directory, 'fixture.sqlite'))
    try {
      const oldRun = randomUUID()
      store.createRun({
        runId: oldRun,
        localDate: '2020-01-01',
        executionMode: 'read-only',
        selectedAccountIndexes: [],
        startedAt: '2020-01-01T00:00:00Z'
      })
      store.updateRun(oldRun, 'completed', '2020-01-01T00:01:00Z')
      const sender = vi
        .fn<typeof fetch>()
        .mockRejectedValueOnce(new Error('synthetic-network-failure'))
        .mockImplementation(async (url) => {
          await Promise.resolve()
          return response(
            typeof url === 'string' && url.includes('gettoken')
              ? { errcode: 0, access_token: 'synthetic-access', expires_in: 7200 }
              : { errcode: 0 }
          )
        })
      let now = Date.parse('2026-09-09T00:00:00Z')
      const service = new Notifications(store, Buffer.alloc(32, 9), sender, () => now)
      service.save(config)
      await service.tick()
      expect(service.status().recent).toHaveLength(0)
      const newRun = randomUUID()
      store.createRun({
        runId: newRun,
        localDate: '2026-09-09',
        executionMode: 'read-only',
        selectedAccountIndexes: [],
        startedAt: new Date(now).toISOString()
      })
      store.updateRun(newRun, 'completed', new Date(now).toISOString())
      await service.tick()
      expect(service.status().recent[0]?.status).toBe('pending')
      store.close()
      store = new SqliteStore(join(directory, 'fixture.sqlite'))
      now += 60_000
      const reopened = new Notifications(store, Buffer.alloc(32, 9), sender, () => now)
      expect(reopened.status().hasSecret).toBe(true)
      expect(store.getRun(oldRun)?.finishedAt).toBe('2020-01-01T00:01:00Z')
      expect(
        store.database.prepare('SELECT COUNT(*) AS n FROM notification_settings').get()?.n
      ).toBe(1)
      await reopened.tick()
      expect(reopened.status().recent[0]?.status).toBe('sent')
    } finally {
      store.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('rolls back schema creation if an incompatible index name already exists', () => {
    const store = new SqliteStore(':memory:')
    try {
      store.database.exec('CREATE TABLE notification_due (id INTEGER)')
      expect(() => new Notifications(store, Buffer.alloc(32, 9))).toThrow()
      expect(
        store.database
          .prepare("SELECT name FROM sqlite_master WHERE name='notification_settings'")
          .get()
      ).toBeUndefined()
    } finally {
      store.close()
    }
  })

  it('stops after the configured retry limit and never calls an arbitrary endpoint', async () => {
    const { store, service, send, complete, advance } = fixture()
    try {
      complete()
      send.mockImplementation(async () => {
        await Promise.resolve()
        return response({ errcode: 40013, errmsg: 'sensitive-provider-message' })
      })
      for (let i = 0; i < 3; i++) {
        await service.tick()
        advance()
        advance()
      }
      expect(service.status().recent[0]).toMatchObject({
        status: 'failed',
        attempts: 3,
        lastError: 'provider-code-40013'
      })
      await service.tick()
      expect(send).toHaveBeenCalledTimes(3)
      expect(
        send.mock.calls.every(
          ([url]) =>
            typeof url === 'string' && url.startsWith('https://qyapi.weixin.qq.com/cgi-bin/')
        )
      ).toBe(true)
    } finally {
      store.close()
    }
  })

  it('encrypts settings, never returns a secret, and preserves it on blank edits', () => {
    const { store, service } = fixture()
    try {
      expect(JSON.stringify(service.status())).not.toContain(config.corpSecret)
      expect(
        JSON.stringify(store.database.prepare('SELECT * FROM notification_settings').all())
      ).not.toContain(config.corpSecret)
      service.save({ ...config, corpSecret: '' })
      expect(service.status().hasSecret).toBe(true)
      expect(() => service.save({ ...config, agentId: 'bad' })).toThrow()
    } finally {
      store.close()
    }
  })

  it('sends account completion before run end, then a separate interruption summary, without duplicates', async () => {
    const { store, service, send, runId, complete, create } = fixture()
    try {
      complete()
      await Promise.all([service.tick(), service.tick()])
      expect(service.status().recent).toHaveLength(1)
      expect(service.status().recent[0]?.status).toBe('sent')
      const messages = () =>
        send.mock.calls.filter(([url]) => typeof url === 'string' && url.includes('message/send'))
      expect(messages()).toHaveLength(1)
      expect(messages()[0]?.[1]?.body).toContain('已匹配到账积分：—')
      expect(messages()[0]?.[1]?.body).not.toContain('待确认')
      store.updateRun(runId, 'interrupted')
      await service.tick()
      expect(messages()).toHaveLength(2)
      await create().tick()
      expect(messages()).toHaveLength(2)
      expect(store.ledger.accounts(runId)[0]?.executionState).toBe('completed')
    } finally {
      store.close()
    }
  })

  it('retains safe failure information and retries after restart and backoff', async () => {
    const { store, service, send, complete, create, advance } = fixture()
    try {
      complete()
      send.mockRejectedValueOnce(new Error('secret response must not escape'))
      await service.tick()
      expect(service.status().recent[0]).toMatchObject({
        status: 'pending',
        attempts: 1,
        lastError: 'network-or-provider-error'
      })
      expect(JSON.stringify(service.status())).not.toContain('secret response')
      const restarted = create()
      await restarted.tick()
      expect(service.status().recent[0]?.attempts).toBe(1)
      advance()
      await restarted.tick()
      expect(service.status().recent[0]?.status).toBe('sent')
    } finally {
      store.close()
    }
  })

  it('does not send while disabled, does not replay old runs, and rejects provider partial delivery', async () => {
    const { store, service, send, complete } = fixture()
    try {
      complete()
      service.save({ ...config, enabled: false })
      await service.tick()
      expect(send).not.toHaveBeenCalled()
      send.mockImplementation(async () => {
        await Promise.resolve()
        return response({ errcode: 0, invaliduser: 'synthetic', access_token: 'synthetic-access' })
      })
      service.save(config)
      await expect(service.test()).rejects.toThrow('provider-rejected')
    } finally {
      store.close()
    }
  })
})
