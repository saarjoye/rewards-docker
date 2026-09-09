import { resolve } from 'node:path'

import cookie from '@fastify/cookie'
import rateLimit from '@fastify/rate-limit'
import fastifyStatic from '@fastify/static'
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
import { z } from 'zod'

import { localDateKey } from '../domain/DateKey.js'
import type { RunRequest } from '../domain/RunRequest.js'
import { summarizeTasks } from '../domain/Task.js'
import type { AccountSecretStore } from '../infra/AccountSecretStore.js'
import type { AdminAuthStore } from '../infra/AdminAuthStore.js'
import type { SqliteStore } from '../infra/SqliteStore.js'
import { RunViews } from './RunViews.js'
import { notificationInput, type Notifications } from '../notifications/Notifications.js'

const SESSION_COOKIE = 'rewards_next_session'

const loginSchema = z.object({
  username: z.string().min(1).max(100),
  password: z.string().min(1).max(1024)
})
const accountSchema = z.object({
  email: z.email().max(320),
  password: z.string().min(1).max(1024),
  displayAlias: z.string().trim().min(1).max(80).optional()
})
const accountUpdateSchema = z
  .object({
    password: z.string().min(1).max(1024).optional(),
    displayAlias: z.string().trim().min(1).max(80).optional(),
    enabled: z.boolean().optional()
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'At least one field is required' })
const runRequestSchema = z.discriminatedUnion('accountMode', [
  z.object({
    accountMode: z.literal('continue'),
    runAccountIndex: z.undefined().optional(),
    executionMode: z.enum(['read-only', 'mutating']).default('read-only')
  }),
  z.object({
    accountMode: z.literal('account'),
    runAccountIndex: z.number().int().min(1),
    executionMode: z.enum(['read-only', 'mutating']).default('read-only')
  })
])

export interface RunCoordinator {
  start(request: RunRequest): Promise<{ runId: string; selectedAccountIndexes: readonly number[] }>
  cancel?(runId: string): boolean
  readonly activeRunId: string | undefined
}

export interface WebServerDependencies {
  adminAuth: AdminAuthStore
  accounts: AccountSecretStore
  store: SqliteStore
  webRoot?: string
  secureCookies: boolean
  runCoordinator?: RunCoordinator
  notifications?: Notifications
}

function getSessionToken(request: FastifyRequest): string | undefined {
  return request.cookies[SESSION_COOKIE]
}

export async function createServer(dependencies: WebServerDependencies): Promise<FastifyInstance> {
  const views = new RunViews(dependencies.store)
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024 })
  const streams = new Set<() => void>()
  app.addHook('preClose', async () => {
    for (const close of streams) close()
    await Promise.resolve()
  })
  await app.register(cookie)
  await app.register(rateLimit, { global: false, max: 10, timeWindow: '1 minute' })

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError) {
      return reply.code(400).send({ error: 'invalid-request' })
    }
    if (error instanceof Error && error.name === 'RunAlreadyActiveError') {
      return reply.code(409).send({ error: 'run-already-active' })
    }
    return reply.code(500).send({ error: 'internal-error' })
  })

  app.get('/healthz', () => ({ ok: true }))
  app.get('/api/bootstrap', () => ({ initialized: dependencies.adminAuth.isInitialized() }))

  app.post(
    '/api/login',
    { config: { rateLimit: { max: 5, timeWindow: '5 minutes' } } },
    async (request, reply) => {
      const body = loginSchema.parse(request.body)
      if (!dependencies.adminAuth.authenticate(body.username, body.password)) {
        return reply.code(401).send({ error: 'invalid-credentials' })
      }

      const session = dependencies.adminAuth.createSession(body.username)
      reply.setCookie(SESSION_COOKIE, session.token, {
        httpOnly: true,
        sameSite: 'strict',
        secure: dependencies.secureCookies,
        path: '/',
        expires: new Date(session.expiresAt)
      })
      return { csrfToken: session.csrfToken, expiresAt: session.expiresAt }
    }
  )

  app.addHook('preHandler', async (request, reply) => {
    if (
      !request.url.startsWith('/api/') ||
      ['/api/bootstrap', '/api/login'].includes(request.url)
    ) {
      return
    }

    const token = getSessionToken(request)
    if (!token || !dependencies.adminAuth.validateSession(token)) {
      return reply.code(401).send({ error: 'authentication-required' })
    }

    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      const csrf = request.headers['x-csrf-token']
      if (typeof csrf !== 'string' || !dependencies.adminAuth.validateSession(token, csrf)) {
        return reply.code(403).send({ error: 'csrf-validation-failed' })
      }
    }
  })

  app.post('/api/logout', (request, reply) => {
    const token = getSessionToken(request)
    if (token) dependencies.adminAuth.revokeSession(token)
    reply.clearCookie(SESSION_COOKIE, { path: '/' })
    return { ok: true }
  })

  app.get('/api/session', (request, reply) => {
    reply.header('cache-control', 'no-store')
    const session = dependencies.adminAuth.restoreSession(getSessionToken(request) ?? '')
    return session ?? reply.code(401).send({ error: 'authentication-required' })
  })

  app.get('/api/notifications/wecom', (_request, reply) => {
    reply.header('cache-control', 'no-store')
    return (
      dependencies.notifications?.status() ??
      reply.code(503).send({ error: 'notifications-unavailable' })
    )
  })
  app.get('/api/events', (request, reply) => {
    reply.hijack()
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive'
    })
    const emit = () => {
      if (!reply.raw.destroyed) reply.raw.write('data: state\n\n')
    }
    const unsubscribe = dependencies.store.subscribe(emit)
    const heartbeat = setInterval(() => {
      if (!reply.raw.destroyed) reply.raw.write(': heartbeat\n\n')
    }, 15000)
    heartbeat.unref()
    const close = () => {
      reply.raw.end()
    }
    streams.add(close)
    reply.raw.once('close', () => {
      clearInterval(heartbeat)
      unsubscribe()
      streams.delete(close)
    })
    emit()
  })
  app.put('/api/notifications/wecom', (request, reply) => {
    if (!dependencies.notifications)
      return reply.code(503).send({ error: 'notifications-unavailable' })
    const input = notificationInput.parse(request.body)
    try {
      return dependencies.notifications.save(input)
    } catch (error) {
      if (error instanceof Error && error.message === 'notification-busy')
        return reply.code(409).send({ error: 'notification-busy' })
      if (error instanceof Error && error.message === 'notification-config-incomplete')
        return reply.code(400).send({ error: 'notification-config-incomplete' })
      throw error
    }
  })
  app.post(
    '/api/notifications/wecom/test',
    { config: { rateLimit: { max: 1, timeWindow: '1 minute' } } },
    async (_request, reply) => {
      if (!dependencies.notifications)
        return reply.code(503).send({ error: 'notifications-unavailable' })
      try {
        return await dependencies.notifications.test()
      } catch (error) {
        const message = error instanceof Error ? error.message : ''
        if (message === 'notification-busy') return reply.code(409).send({ error: message })
        return reply.code(502).send({
          error:
            /^(provider-code-\d+|provider-rejected|provider-http-error|provider-invalid-response|notifications-disabled|network-or-provider-error)$/.test(
              message
            )
              ? message
              : 'notification-test-failed'
        })
      }
    }
  )
  app.addHook('onClose', async () => {
    await dependencies.notifications?.close()
  })

  app.get('/api/state', (request) => {
    const localDate = localDateKey()
    const { date } = z
      .object({
        date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .default(localDate)
      })
      .parse(request.query)
    const accounts = dependencies.accounts.list()
    const tasks = dependencies.store.listTaskState(date)
    const taskSummary = summarizeTasks(tasks)
    return {
      localDate,
      accounts,
      tasks,
      taskSummary,
      runnerReady: dependencies.runCoordinator !== undefined,
      activeRunId: dependencies.runCoordinator?.activeRunId ?? null,
      runs: dependencies.store
        .listRuns(10)
        .map((run) => views.run(run.runId, dependencies.runCoordinator?.activeRunId)),
      today: views.today()
    }
  })

  app.post('/api/accounts', async (request, reply) => {
    const body = accountSchema.parse(request.body)
    const accountId = dependencies.accounts.create({
      email: body.email,
      password: body.password,
      ...(body.displayAlias === undefined ? {} : { displayAlias: body.displayAlias })
    })
    const account = dependencies.accounts.list().find((item) => item.accountId === accountId)
    return reply.code(201).send({ account })
  })

  app.patch('/api/accounts/:accountId', async (request, reply) => {
    const { accountId } = z.object({ accountId: z.uuid() }).parse(request.params)
    const body = accountUpdateSchema.parse(request.body)
    if (body.enabled !== undefined && dependencies.runCoordinator?.activeRunId) {
      return reply.code(409).send({ error: 'run-already-active' })
    }
    const update = {
      ...(body.password === undefined ? {} : { password: body.password }),
      ...(body.displayAlias === undefined ? {} : { displayAlias: body.displayAlias }),
      ...(body.enabled === undefined ? {} : { enabled: body.enabled })
    }
    if (!dependencies.accounts.update(accountId, update)) {
      return reply.code(404).send({ error: 'account-not-found' })
    }
    const account = dependencies.accounts.list().find((item) => item.accountId === accountId)
    return { account }
  })

  app.post('/api/runs', async (request, reply) => {
    const body = runRequestSchema.parse(request.body)
    if (!dependencies.runCoordinator) {
      return reply.code(409).send({ error: 'runner-not-configured' })
    }
    const runRequest: RunRequest =
      body.accountMode === 'continue'
        ? { accountMode: 'continue', executionMode: body.executionMode }
        : {
            accountMode: 'account',
            runAccountIndex: body.runAccountIndex,
            executionMode: body.executionMode
          }
    return reply.code(202).send(await dependencies.runCoordinator.start(runRequest))
  })

  app.get('/api/runs/:runId', async (request, reply) => {
    const { runId } = z.object({ runId: z.uuid() }).parse(request.params)
    const run = views.run(runId, dependencies.runCoordinator?.activeRunId)
    if (!run) return reply.code(404).send({ error: 'run-not-found' })
    return { run, accounts: run.accounts }
  })

  app.get('/api/runs', (request) => {
    const { page, pageSize } = z
      .object({
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(50).default(20)
      })
      .parse(request.query)
    const rows = dependencies.store.listRuns(pageSize + 1, (page - 1) * pageSize)
    return {
      page,
      hasMore: rows.length > pageSize,
      runs: rows
        .slice(0, pageSize)
        .map((row) => views.run(row.runId, dependencies.runCoordinator?.activeRunId))
    }
  })

  app.get('/api/calendar', (request) => {
    const { month } = z
      .object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) })
      .parse(request.query)
    return {
      month,
      timezone: 'Asia/Shanghai',
      entries: views.calendar(month, dependencies.runCoordinator?.activeRunId)
    }
  })

  app.post('/api/runs/:runId/cancel', async (request, reply) => {
    const { runId } = z.object({ runId: z.uuid() }).parse(request.params)
    if (!dependencies.runCoordinator?.cancel?.(runId)) {
      return reply.code(409).send({ error: 'run-not-active' })
    }
    return reply.code(202).send({ ok: true })
  })

  app.get('/api/runs/:runId/report', async (request, reply) => {
    const { runId } = z.object({ runId: z.uuid() }).parse(request.params)
    const run = views.run(runId, dependencies.runCoordinator?.activeRunId)
    if (!run) return reply.code(404).send({ error: 'run-not-found' })
    const accounts = run.accounts
    const accountIndexes = new Map(accounts.map((item) => [item.accountId, item.accountIndex]))
    const tasks = run.tasks.map((task) => ({
      accountIndex: accountIndexes.get(task.accountId),
      type: task.type,
      status: task.status,
      progress: task.progress,
      ...(task.reason === undefined ? {} : { reason: task.reason }),
      updatedAt: task.updatedAt
    }))
    reply.header('content-disposition', `attachment; filename="rewards-run-${run.localDate}.json"`)
    return {
      schemaVersion: 1,
      run: {
        localDate: run.localDate,
        executionMode: run.executionMode,
        status: run.status,
        selectedAccountIndexes: run.selectedAccountIndexes,
        startedAt: run.startedAt,
        ...(run.finishedAt === undefined ? {} : { finishedAt: run.finishedAt })
      },
      accounts: accounts.map((account) => ({
        accountIndex: account.accountIndex,
        status: account.executionState,
        startedAt: account.startedAt,
        endedAt: account.endedAt,
        runBalanceDelta: account.runBalanceDelta,
        liveBalanceDelta: account.liveBalanceDelta,
        liveBalanceStatus: account.liveBalanceStatus,
        confirmedBalanceDelta: account.confirmedBalanceDelta,
        unmatchedBalancePoints: account.unmatchedBalancePoints,
        unattributedBalancePoints: account.unattributedBalancePoints,
        attributionStatus: account.attributionStatus,
        statisticScope: account.statisticScope,
        runDailyBalances: account.runDailyBalances,
        dailyBalances: account.dailyBalances,
        confirmedTaskPoints: account.confirmedTaskPoints,
        reportedTaskPoints: account.reportedTaskPoints,
        pendingTaskPoints: account.pendingTaskPoints,
        unattributedBalanceDelta: account.unattributedBalanceDelta,
        overreportedTaskPoints: account.overreportedTaskPoints,
        verificationStatus: account.verificationStatus
      })),
      tasks
    }
  })

  const webRoot = dependencies.webRoot ?? resolve(process.cwd(), 'dist/web')
  await app.register(fastifyStatic, { root: webRoot, wildcard: false })
  app.get('/*', async (_request, reply) => reply.sendFile('index.html'))
  return app
}
