import { z } from 'zod'
import { isIP } from 'node:net'
import type { SqliteStore } from '../infra/SqliteStore.js'
import { decryptBytes, encryptBytes, type EncryptedEnvelope } from '../security/CryptoVault.js'
import { redactText } from '../security/Redactor.js'
import { RunViews } from '../web/RunViews.js'

const officialApiBase = 'https://qyapi.weixin.qq.com'
const apiBaseUrl = z
  .string()
  .trim()
  .max(512)
  .transform((input, context) => {
    if (!input) return officialApiBase
    try {
      const url = new URL(input)
      if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        !url.hostname.includes('.') ||
        isIP(url.hostname) ||
        url.hostname.startsWith('[') ||
        /\.(localhost|local|internal)$/.test(url.hostname) ||
        !/^[\w/-]*$/.test(url.pathname)
      )
        throw new Error('invalid')
      return url.origin + url.pathname.replace(/\/+$/, '').replace(/\/cgi-bin$/, '')
    } catch {
      context.addIssue({ code: 'custom', message: 'invalid-notification-api-base' })
      return z.NEVER
    }
  })

export const notificationInput = z
  .object({
    enabled: z.boolean(),
    corpId: z
      .string()
      .trim()
      .max(128)
      .regex(/^[\w-]*$/),
    agentId: z.string().trim().max(16).regex(/^\d*$/),
    corpSecret: z.string().trim().max(512).default(''),
    toUser: z
      .string()
      .trim()
      .min(1)
      .max(1024)
      .regex(/^(@all|[\w.@|-]+)$/),
    maxAttempts: z.number().int().min(1).max(8).default(5),
    apiBaseUrl: apiBaseUrl.optional()
  })
  .strict()
type Settings = z.infer<typeof notificationInput> & { apiBaseUrl: string }
interface Job {
  notificationKey: string
  kind: string
  payload: string
  status: string
  attempts: number
  nextAttemptAt: number
  lastError: string | null
  acceptedAt: string | null
}
const defaults: Settings = {
  enabled: false,
  corpId: '',
  agentId: '',
  corpSecret: '',
  toUser: '@all',
  maxAttempts: 5,
  apiBaseUrl: officialApiBase
}
const points = (value: number | null) =>
  value === null ? '待确认' : `${value > 0 ? '+' : ''}${String(value)} 分`
const time = (value?: string | null) =>
  value
    ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
    : '待确认'
const states: Record<string, string> = {
  completed: '完成',
  partial: '部分完成',
  failed: '失败',
  cancelled: '已停止',
  interrupted: '中断',
  'action-required': '需要人工处理'
}

/** Durable, at-least-once notification delivery; provider acceptance is not client receipt. */
export class Notifications {
  private flight: Promise<void> | undefined
  private timer: ReturnType<typeof setInterval> | undefined
  private stopped = false
  private token: { value: string; expiresAt: number } | undefined
  private serviceError: string | null = null
  private unsubscribe: (() => void) | undefined

  constructor(
    private readonly store: SqliteStore,
    private readonly key: Buffer,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now
  ) {
    const db = store.database
    db.exec('BEGIN IMMEDIATE')
    try {
      db.exec(`CREATE TABLE IF NOT EXISTS notification_settings (
        id INTEGER PRIMARY KEY CHECK(id = 1), schema_version INTEGER NOT NULL,
        encrypted TEXT NOT NULL, enabled_since TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS notification_jobs (
        notification_key TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL,
        status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL, last_error TEXT, accepted_at TEXT
      );
      CREATE INDEX IF NOT EXISTS notification_due ON notification_jobs(status, next_attempt_at);`)
      const add = (table: string, name: string, definition: string) => {
        const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
        if (!columns.some((column) => column.name === name))
          db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`)
      }
      add('notification_settings', 'enabled', 'INTEGER NOT NULL DEFAULT 0')
      add('notification_settings', 'api_base_encrypted', 'TEXT')
      for (const name of ['run_id', 'account_id', 'event_key', 'created_at'])
        add('notification_jobs', name, 'TEXT')
      db.prepare('UPDATE notification_settings SET enabled=?, schema_version=2 WHERE id=1').run(
        Number(this.settings().config.enabled)
      )
      db.exec(`CREATE TRIGGER IF NOT EXISTS enqueue_account_completion AFTER INSERT ON account_completions
        WHEN EXISTS(SELECT 1 FROM notification_settings WHERE enabled=1 AND julianday(NEW.ended_at)>=julianday(enabled_since))
        BEGIN
          INSERT OR IGNORE INTO notification_jobs(notification_key,kind,payload,status,next_attempt_at,run_id,account_id,event_key,created_at)
          VALUES('account:' || NEW.run_id || ':' || NEW.account_id,'account','','pending',0,NEW.run_id,NEW.account_id,NEW.event_key,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
        END;`)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  private encode(value: unknown): string {
    return JSON.stringify(encryptBytes(Buffer.from(JSON.stringify(value)), this.key))
  }

  private decode(value: string): unknown {
    const envelope = JSON.parse(value) as EncryptedEnvelope
    return JSON.parse(decryptBytes(envelope, this.key).toString('utf8')) as unknown
  }

  private settings(): { config: Settings; since: string } {
    const row = this.store.database
      .prepare(
        'SELECT encrypted, enabled_since, api_base_encrypted FROM notification_settings WHERE id = 1'
      )
      .get() as
      | { encrypted: string; enabled_since: string; api_base_encrypted: string | null }
      | undefined
    if (!row) return { config: { ...defaults }, since: new Date(this.now()).toISOString() }
    const parsed = notificationInput.parse(this.decode(row.encrypted))
    return {
      config: {
        ...parsed,
        apiBaseUrl: row.api_base_encrypted
          ? apiBaseUrl.parse(this.decode(row.api_base_encrypted))
          : officialApiBase
      },
      since: row.enabled_since
    }
  }

  status() {
    const { config } = this.settings()
    const recent = this.store.database
      .prepare(
        `SELECT notification_key AS notificationKey, kind, status, attempts,
      next_attempt_at AS nextAttemptAt, last_error AS lastError, accepted_at AS acceptedAt,
      accepted_at AS sentAt, run_id AS runId, account_id AS accountKey, created_at AS createdAt
      FROM notification_jobs ORDER BY rowid DESC LIMIT 20`
      )
      .all() as Omit<Job, 'payload'>[]
    return {
      enabled: config.enabled,
      corpId: config.corpId,
      agentId: config.agentId,
      toUser: config.toUser,
      maxAttempts: config.maxAttempts,
      apiBaseUrl: config.apiBaseUrl,
      hasSecret: Boolean(config.corpSecret),
      channel: 'wecom-application' as const,
      serviceError: this.serviceError,
      recent
    }
  }

  save(input: unknown) {
    if (this.flight) throw new Error('notification-busy')
    const current = this.settings()
    const parsed = notificationInput.parse(input)
    const config: Settings = {
      ...parsed,
      apiBaseUrl: parsed.apiBaseUrl ?? current.config.apiBaseUrl
    }
    config.corpSecret ||= current.config.corpSecret
    if (config.enabled && (!config.corpId || !config.agentId || !config.corpSecret))
      throw new Error('notification-config-incomplete')
    const since =
      !current.config.enabled && config.enabled ? new Date(this.now()).toISOString() : current.since
    const db = this.store.database
    db.exec('BEGIN IMMEDIATE')
    try {
      // A destination change must not send an old queued payload to new recipients.
      if (
        config.corpId !== current.config.corpId ||
        config.agentId !== current.config.agentId ||
        config.toUser !== current.config.toUser
      ) {
        db.prepare(
          "UPDATE notification_jobs SET status = 'cancelled' WHERE status IN ('pending', 'failed', 'sending')"
        ).run()
      }
      // Keep the original encrypted shape readable by earlier application versions.
      const { apiBaseUrl: transportBase, ...legacyConfig } = config
      db.prepare(
        `INSERT INTO notification_settings(id, schema_version, encrypted, enabled_since) VALUES(1, 1, ?, ?)
        ON CONFLICT(id) DO UPDATE SET encrypted=excluded.encrypted, enabled_since=excluded.enabled_since`
      ).run(this.encode(legacyConfig), since)
      db.prepare('UPDATE notification_settings SET api_base_encrypted=? WHERE id=1').run(
        transportBase === officialApiBase ? null : this.encode(transportBase)
      )
      db.prepare('UPDATE notification_settings SET enabled=?, schema_version=2 WHERE id=1').run(
        Number(config.enabled)
      )
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    this.token = undefined
    return this.status()
  }

  private discover(): void {
    const { config, since } = this.settings()
    if (!config.enabled) return
    const runs = this.store.database
      .prepare(
        `SELECT run_id AS runId FROM runs WHERE julianday(COALESCE(finished_at, started_at)) >= julianday(?)
      AND NOT EXISTS (SELECT 1 FROM notification_jobs WHERE notification_key = 'run:' || runs.run_id)`
      )
      .all(since) as { runId: string }[]
    const views = new RunViews(this.store)
    const insert = this.store.database.prepare(`INSERT OR IGNORE INTO notification_jobs
      (notification_key, kind, payload, status, next_attempt_at) VALUES (?, ?, ?, 'pending', ?)`)
    for (const { runId } of runs) {
      const run = views.run(runId)
      if (!run) continue
      if (['completed', 'partial', 'failed', 'cancelled', 'interrupted'].includes(run.status)) {
        const message = [
          'Microsoft Rewards 运行汇总',
          `状态：${states[run.status] ?? '待确认'}`,
          `模式：${run.executionMode === 'read-only' ? '只读检查' : '执行任务'}`,
          `开始：${time(run.startedAt)}`,
          `结束：${time(run.finishedAt)}`,
          `已完成账号：${String(run.accountsCompleted)}/${String(run.accountsTotal)}`,
          `已处理账号：${String(run.accountsProcessed)}`,
          `中断账号：${String(run.accounts.filter((account) => ['cancelled', 'interrupted'].includes(account.executionState)).length)}`,
          `失败账号：${String(run.accounts.filter((account) => account.executionState === 'failed').length)}`,
          `未完成账号：${String(run.accountsTotal - run.accountsCompleted)}`,
          `整体确认积分：${points(run.confirmedTaskPoints)}`,
          `待确认积分：${points(run.pendingTaskPoints)}`,
          `本次余额变化：${points(run.runBalanceDelta)}`,
          `运行：${runId.slice(0, 8)}`
        ].join('\n')
        insert.run(`run:${runId}`, 'run', this.encode(message), this.now())
        this.store.database
          .prepare(
            'UPDATE notification_jobs SET run_id=?, created_at=COALESCE(created_at,?) WHERE notification_key=?'
          )
          .run(runId, new Date(this.now()).toISOString(), `run:${runId}`)
      }
    }
  }

  private async provider(
    base: string,
    path: string,
    init?: RequestInit
  ): Promise<Record<string, unknown>> {
    const response = await this.fetchImpl(`${base}/cgi-bin/${path}`, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.timeout(10_000)
    })
    if (!response.ok) throw new Error('provider-http-error')
    const result = z.record(z.string(), z.unknown()).parse(await response.json())
    if (result.errcode !== undefined && result.errcode !== 0) {
      const code =
        typeof result.errcode === 'number' && Number.isSafeInteger(result.errcode)
          ? String(result.errcode)
          : 'unknown'
      throw new Error(`provider-code-${code}`)
    }
    return result
  }

  private async send(message: string): Promise<void> {
    const { config } = this.settings()
    if (!config.enabled) throw new Error('notifications-disabled')
    if (!this.token || this.token.expiresAt <= this.now()) {
      const data = await this.provider(
        config.apiBaseUrl,
        `gettoken?${new URLSearchParams({ corpid: config.corpId, corpsecret: config.corpSecret }).toString()}`
      )
      if (typeof data.access_token !== 'string' || !data.access_token)
        throw new Error('provider-invalid-response')
      this.token = {
        value: data.access_token,
        expiresAt:
          this.now() +
          Math.max(
            0,
            Math.min(typeof data.expires_in === 'number' ? data.expires_in : 0, 7200) - 120
          ) *
            1000
      }
    }
    const result = await this.provider(
      config.apiBaseUrl,
      `message/send?${new URLSearchParams({ access_token: this.token.value }).toString()}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          touser: config.toUser,
          agentid: Number(config.agentId),
          msgtype: 'text',
          text: { content: message },
          enable_duplicate_check: 1,
          duplicate_check_interval: 1800
        })
      }
    )
    if (
      result.errcode !== 0 ||
      result.invaliduser ||
      result.invalidparty ||
      result.invalidtag ||
      result.unlicenseduser
    )
      throw new Error('provider-rejected')
  }

  async test(): Promise<{ status: 'accepted' }> {
    if (this.flight) throw new Error('notification-busy')
    const work = this.send(
      `Microsoft Rewards Next 推送测试\n时间：${time(new Date(this.now()).toISOString())}`
    )
    this.flight = work
    try {
      await work
      return { status: 'accepted' }
    } catch (error) {
      throw publicFailure(error)
    } finally {
      this.flight = undefined
    }
  }

  tick(): Promise<void> {
    if (this.flight) return this.flight
    const work = this.process()
    this.flight = work
    void work
      .finally(() => {
        this.flight = undefined
      })
      .catch(() => undefined)
    return work
  }

  private async process(): Promise<void> {
    try {
      if (!this.canSend()) return
      this.discover()
      const jobs = this.store.database
        .prepare(
          `SELECT notification_key AS notificationKey, payload, attempts
        FROM notification_jobs WHERE status IN ('pending','sending') AND next_attempt_at<=? ORDER BY rowid LIMIT 10`
        )
        .all(this.now()) as Pick<Job, 'notificationKey' | 'payload' | 'attempts'>[]
      for (const job of jobs) {
        if (!this.canSend()) break
        if (job.attempts >= this.settings().config.maxAttempts) {
          this.store.database
            .prepare(
              "UPDATE notification_jobs SET status='failed', last_error='attempt-limit-after-restart' WHERE notification_key=?"
            )
            .run(job.notificationKey)
          continue
        }
        this.store.database
          .prepare(
            "UPDATE notification_jobs SET status='sending', attempts=attempts+1, next_attempt_at=? WHERE notification_key=?"
          )
          .run(this.now() + 60_000, job.notificationKey)
        try {
          await this.send(
            job.payload
              ? z.string().parse(this.decode(job.payload))
              : this.completionMessage(job.notificationKey)
          )
          this.store.database
            .prepare(
              "UPDATE notification_jobs SET status='sent', last_error=NULL, accepted_at=? WHERE notification_key=?"
            )
            .run(new Date(this.now()).toISOString(), job.notificationKey)
        } catch (error) {
          this.token = undefined
          const attempts = job.attempts + 1
          this.store.database
            .prepare(
              'UPDATE notification_jobs SET status=?, attempts=?, last_error=?, next_attempt_at=? WHERE notification_key=?'
            )
            .run(
              attempts >= this.settings().config.maxAttempts ? 'failed' : 'pending',
              attempts,
              safeFailure(error),
              this.now() + Math.min(30_000 * 2 ** (attempts - 1), 3600_000),
              job.notificationKey
            )
        }
      }
      this.serviceError = null
    } catch {
      this.serviceError = 'notification-storage-error'
    }
  }

  private canSend(): boolean {
    return !this.stopped && this.settings().config.enabled
  }

  start(): void {
    if (this.timer) return
    this.stopped = false
    this.unsubscribe = this.store.subscribe(() => {
      void this.tick()
    })
    this.timer = setInterval(() => {
      void this.tick()
    }, 1000)
    this.timer.unref()
    void this.tick()
  }

  async close(): Promise<void> {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    this.unsubscribe?.()
    this.unsubscribe = undefined
    await this.flight?.catch(() => undefined)
  }

  private completionMessage(key: string): string {
    const row = this.store.database
      .prepare(
        `SELECT c.payload_json FROM account_completions c
      JOIN notification_jobs j ON j.event_key=c.event_key WHERE j.notification_key=?`
      )
      .get(key) as { payload_json: string } | undefined
    if (!row) throw new Error('completion-evidence-missing')
    const event = JSON.parse(row.payload_json) as {
      runId: string
      accountId: string
      accountLabel: string
      executionState: string
      startedAt: string | null
      endedAt: string
      collectedPoints: number | null
    }
    const stats = this.store.ledger.credits.reconcile(
      event.accountId,
      event.collectedPoints,
      undefined,
      event.runId
    )
    return [
      'Microsoft Rewards 账号任务完成',
      `账号：${redactText(event.accountLabel)}`,
      `账号状态：${states[event.executionState] ?? '待确认'}`,
      `开始时间：${time(event.startedAt)}`,
      `完成时间：${time(event.endedAt)}`,
      `本次余额变化：${points(event.collectedPoints)}`,
      `已确认任务积分：${points(stats.confirmedTaskPoints)}`,
      `任务上报积分：${points(stats.reportedTaskPoints)}`,
      `待确认积分：${points(stats.pendingTaskPoints)}`,
      `统计可信度：${stats.creditVerificationStatus === 'confirmed' ? '已确认' : stats.creditVerificationStatus === 'partial' ? '部分确认' : '待确认'}`,
      ...(stats.confirmedTaskPoints === null && event.executionState === 'completed'
        ? ['账号任务已完成，积分待确认']
        : []),
      `运行：${event.runId.slice(0, 8)}`
    ].join('\n')
  }
}

function safeFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : ''
  return /^(provider-code-\d+|provider-rejected|provider-http-error|provider-invalid-response|notifications-disabled)$/.test(
    message
  )
    ? message
    : 'network-or-provider-error'
}

// Do not attach the original provider error: it can contain a credential-bearing URL.
function publicFailure(error: unknown): Error {
  return new Error(safeFailure(error))
}
