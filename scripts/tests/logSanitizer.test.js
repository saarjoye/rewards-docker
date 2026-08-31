const assert = require('node:assert/strict')
const { stampLogLine } = require('../../dist/web/logSanitizer')

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

console.log('logSanitizer.test.js passed')
