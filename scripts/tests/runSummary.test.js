const assert = require('node:assert/strict')
const {
    buildWeComAccountMessage,
    calculateKnownPointTotals,
    formatAccountPoints,
    resolveRunExitCode
} = require('../../dist/util/RunSummary')

const successful = {
    email: 'success@example.invalid',
    initialPoints: 100,
    finalPoints: 125,
    collectedPoints: 25,
    taskSummary: [],
    duration: 10,
    success: true
}
const failed = {
    email: 'failed@example.invalid',
    initialPoints: null,
    finalPoints: null,
    collectedPoints: null,
    taskSummary: [],
    duration: 5,
    success: false,
    error: {
        stage: 'dashboard',
        message: 'dashboard 获取失败：API 鉴权失败；页面数据不完整',
        apiStatus: 401,
        fallbackReason: '页面数据不完整'
    }
}

assert.deepEqual(calculateKnownPointTotals([successful, failed]), {
    initialPoints: 100,
    finalPoints: 125,
    collectedPoints: 25,
    knownAccounts: 1,
    unknownAccounts: 1
})
assert.equal(resolveRunExitCode([successful, failed]), 1)
assert.equal(resolveRunExitCode([successful]), 0)
assert.equal(resolveRunExitCode([successful], true), 1)
assert.equal(formatAccountPoints(successful).compact, '+25 | 100→125')
assert.equal(formatAccountPoints(failed).compact, '未计算 | 未知（dashboard 获取失败）→未知')

const message = buildWeComAccountMessage(failed, '2026-08-29 12:00:00', '5秒')
assert.match(message, /任务前总积分：未知（dashboard 获取失败）/)
assert.match(message, /任务后总积分：未知/)
assert.match(message, /本次总增加：未计算/)
assert.match(message, /错误：dashboard 获取失败：API 鉴权失败；页面数据不完整/)
assert.equal(message.includes('0→0'), false)

console.log('runSummary.test.js passed')
