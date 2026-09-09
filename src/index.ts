import { resolve } from 'node:path'

import { AccountSecretStore } from './infra/AccountSecretStore.js'
import { EncryptedSessionStore } from './auth/EncryptedSessionStore.js'
import { BrowserRuntime } from './browser/BrowserRuntime.js'
import { AdminAuthStore } from './infra/AdminAuthStore.js'
import { loadConfigOrDefault } from './infra/Config.js'
import { loadOrCreateMasterKey } from './infra/KeyProvider.js'
import { SqliteStore } from './infra/SqliteStore.js'
import { StructuredLogger } from './infra/StructuredLogger.js'
import { ApplicationRunCoordinator } from './orchestration/RunCoordinator.js'
import { Scheduler } from './orchestration/Scheduler.js'
import { createServer } from './web/createServer.js'
import { Notifications } from './notifications/Notifications.js'

const dataDirectory = resolve(process.env.DATA_DIR ?? './data')
const sessionsDirectory = resolve(process.env.SESSIONS_DIR ?? './sessions')
const secretPath = process.env.CREDENTIAL_KEY_FILE ?? '/run/secrets/rewards_master_key'
const fallbackKeyPath = resolve(dataDirectory, 'keys/master.key')
const configPath = resolve(process.env.CONFIG_PATH ?? './config.json')
const logsDirectory = resolve(process.env.LOGS_DIR ?? './logs')

const masterKey = await loadOrCreateMasterKey(secretPath, fallbackKeyPath)
const store = new SqliteStore(resolve(dataDirectory, 'rewards-next.sqlite'))
store.recoverInterruptedRuns()
const adminAuth = new AdminAuthStore(store.database)
const accounts = new AccountSecretStore(store.database, masterKey)
const sessions = new EncryptedSessionStore(sessionsDirectory, masterKey)
const config = await loadConfigOrDefault(configPath)
const logger = new StructuredLogger(logsDirectory)
const browser = new BrowserRuntime({
  headless: process.env.REWARDS_HEADLESS !== 'false',
  sessions,
  ...(process.env.REWARDS_BROWSER_EXECUTABLE
    ? { executablePath: process.env.REWARDS_BROWSER_EXECUTABLE }
    : {})
})
const coordinator = new ApplicationRunCoordinator(
  accounts,
  store,
  sessions,
  browser,
  logger,
  config
)
const scheduler = new Scheduler(
  store.database,
  process.env.RUN_SCHEDULE ?? process.env.CRON_SCHEDULE
)
const notifications = new Notifications(store, masterKey)

if (!adminAuth.isInitialized()) {
  const username = process.env.WEB_ADMIN_USER
  const password = process.env.WEB_ADMIN_PASSWORD
  if (username && password && !password.startsWith('<')) adminAuth.initialize(username, password)
}

const app = await createServer({
  adminAuth,
  accounts,
  store,
  runCoordinator: coordinator,
  notifications,
  scheduler,
  webRoot: resolve(process.cwd(), 'dist/web'),
  secureCookies: process.env.WEB_SECURE_COOKIES === 'true'
})

const host = process.env.WEB_HOST ?? '0.0.0.0'
const port = Number.parseInt(process.env.WEB_PORT ?? '3000', 10)

const shutdown = async (): Promise<void> => {
  scheduler.stop()
  try {
    await coordinator.stopAndWait('interrupted')
  } finally {
    await browser.close()
    await app.close()
    store.close()
  }
}

let shuttingDown = false
const handleShutdown = (): void => {
  if (shuttingDown) return
  shuttingDown = true
  void shutdown().catch(() => {
    process.exitCode = 1
  })
}
process.once('SIGINT', handleShutdown)
process.once('SIGTERM', handleShutdown)

await app.listen({ host, port })
notifications.start()

scheduler.start(async () => {
  await coordinator.start({ accountMode: 'continue', executionMode: 'mutating' })
})

if (process.env.RUN_ON_START === 'true') {
  await coordinator.start({ accountMode: 'continue', executionMode: 'mutating' })
}
