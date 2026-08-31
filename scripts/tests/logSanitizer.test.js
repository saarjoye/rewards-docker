const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { stampLogLine } = require('../../dist/web/logSanitizer')
const { Logger } = require('../../dist/logging/Logger')
const { safeUrlForLog, sanitizeLogMessage } = require('../../dist/util/LogSanitizer')

assert.equal(
    stampLogLine('[2026-6-22, 17:57:12] [6/22/2026, 5:57:12 PM] user [INFO] done'),
    '[2026-6-22, 17:57:12] user [INFO] done'
)

assert.equal(
    stampLogLine('[2026-6-22, 17:57:12] [Mon Jun 22 17:57:12 CST 2026] [run_daily.sh] 脚本完成'),
    '[2026-6-22, 17:57:12] [run_daily.sh] 脚本完成'
)

assert.equal(
    stampLogLine('[2026-06-22T09:57:12.000Z] [6/22/2026, 5:57:12 PM] user [WARN] message'),
    '[2026-6-22, 17:57:12] user [WARN] message'
)

const sensitiveUrl =
    'https://login.live.com/oauth20_desktop.srf?code=CODE-CANARY&state=STATE-CANARY&access_token=TOKEN-CANARY'
assert.equal(safeUrlForLog(sensitiveUrl), 'https://login.live.com/oauth20_desktop.srf')
const sanitized = sanitizeLogMessage(
    `${sensitiveUrl} Authorization=AUTH-CANARY Cookie=COOKIE-CANARY {"refresh_token":"REFRESH-CANARY"}`
)
for (const canary of [
    'CODE-CANARY',
    'STATE-CANARY',
    'TOKEN-CANARY',
    'AUTH-CANARY',
    'COOKIE-CANARY',
    'REFRESH-CANARY'
]) {
    assert.equal(sanitized.includes(canary), false)
}

const previousCwd = process.cwd()
const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'rewards-logger-test-'))
try {
    process.chdir(temporaryDirectory)
    const blockedDebugFilter = { enabled: true, mode: 'blacklist', levels: ['debug'] }
    const logger = new Logger({
        userData: { userName: 'synthetic-user' },
        config: {
            debugLogs: true,
            errorDiagnostics: false,
            consoleLogFilter: blockedDebugFilter,
            webhook: {
                webhookLogFilter: blockedDebugFilter,
                discord: { enabled: false, url: '' },
                ntfy: { enabled: false, url: '' }
            }
        }
    })
    logger.debug('main', 'OAUTH', sensitiveUrl)
    const logFile = path.join(temporaryDirectory, 'logs', fs.readdirSync(path.join(temporaryDirectory, 'logs'))[0])
    const persisted = fs.readFileSync(logFile, 'utf8')
    assert.match(persisted, /\[REDACTED\]/)
    for (const canary of ['CODE-CANARY', 'STATE-CANARY', 'TOKEN-CANARY']) {
        assert.equal(persisted.includes(canary), false)
    }
} finally {
    process.chdir(previousCwd)
    fs.rmSync(temporaryDirectory, { recursive: true, force: true })
}

console.log('logSanitizer.test.js passed')
