const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const originalCwd = process.cwd()
const originalDate = global.Date
const originalTz = process.env.TZ
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rewards-local-date-'))
let currentTime = '2026-08-30T23:59:00Z'

class MockDate extends originalDate {
    constructor(...args) {
        super(...(args.length > 0 ? args : [currentTime]))
    }

    static now() {
        return new originalDate(currentTime).getTime()
    }
}

function setTime(value) {
    currentTime = value
}

try {
    process.env.TZ = 'Asia/Shanghai'
    global.Date = MockDate
    process.chdir(tempRoot)

    const { localDateKey } = require('../../dist/util/DateUtils')
    const {
        readTaskProgressFile,
        resetAccountRunProgress,
        updateAccountPointTotals,
        updateSearchTaskProgress,
        updateTaskDetail
    } = require('../../dist/util/TaskProgressStore')
    const { Logger } = require('../../dist/logging/Logger')

    assert.equal(localDateKey(new originalDate('2026-08-30T23:59:00Z')), '2026-08-31')
    assert.equal(localDateKey(new originalDate('2026-08-31T00:01:00Z')), '2026-08-31')
    assert.equal(localDateKey(new originalDate('2026-08-31T16:01:00Z')), '2026-09-01')

    const firstEmail = 'first@example.test'
    const secondEmail = 'second@example.test'

    setTime('2026-08-30T23:59:00Z')
    updateAccountPointTotals(firstEmail, { initialPoints: 1200, currentPoints: 1215, finalPoints: 1215 })
    updateSearchTaskProgress(firstEmail, 'desktop', 15, 5, 20)
    updateSearchTaskProgress(firstEmail, 'mobile', 6, 4, 10)
    updateTaskDetail(firstEmail, {
        key: 'daily-set',
        label: '每日任务',
        group: 'activity',
        completed: 1,
        total: 1,
        gained: 10,
        status: '已完成',
        message: '合成任务已完成'
    })
    updateAccountPointTotals(secondEmail, { initialPoints: 800, currentPoints: 800, finalPoints: 800 })
    updateTaskDetail(secondEmail, {
        key: 'app-activity',
        label: 'App 活动',
        group: 'activity',
        status: '已跳过',
        message: '合成跳过状态'
    })

    setTime('2026-08-31T00:01:00Z')
    let progress = readTaskProgressFile()
    assert.equal(progress.date, '2026-08-31')
    assert.equal(progress.accounts.length, 2)

    let first = progress.accounts.find(account => account.initialPoints === 1200)
    let second = progress.accounts.find(account => account.initialPoints === 800)
    assert.ok(first)
    assert.ok(second)
    assert.equal(first.desktop.completed, 15)
    assert.equal(first.desktop.total, 20)
    assert.equal(first.mobile.completed, 6)
    assert.equal(first.mobile.total, 10)
    assert.deepEqual(first.details.map(detail => detail.label).sort(), ['PC搜索', '每日任务', '移动搜索'])
    assert.deepEqual(
        second.details.map(detail => detail.label),
        ['App 活动']
    )

    updateTaskDetail(firstEmail, {
        key: 'read-to-earn',
        label: '阅读赚取',
        group: 'activity',
        gained: 3,
        status: '已完成',
        message: '跨 UTC 午夜后继续更新'
    })
    progress = readTaskProgressFile()
    first = progress.accounts.find(account => account.initialPoints === 1200)
    assert.ok(first)
    assert.deepEqual(first.details.map(detail => detail.label).sort(), ['PC搜索', '每日任务', '移动搜索', '阅读赚取'])

    resetAccountRunProgress(firstEmail, { initialPoints: 1218, currentPoints: 1218, finalPoints: 1218 })
    progress = readTaskProgressFile()
    first = progress.accounts.find(account => account.initialPoints === 1218)
    second = progress.accounts.find(account => account.initialPoints === 800)
    assert.ok(first)
    assert.ok(second)
    assert.deepEqual(first.details, [])
    assert.deepEqual(
        second.details.map(detail => detail.label),
        ['App 活动']
    )

    const blockedFilter = {
        enabled: true,
        mode: 'whitelist',
        levels: [],
        keywords: [],
        regexPatterns: []
    }
    const logger = new Logger({
        userData: { userName: 'synthetic-user' },
        config: {
            debugLogs: false,
            errorDiagnostics: false,
            consoleLogFilter: blockedFilter,
            webhook: { webhookLogFilter: blockedFilter }
        },
        isMobile: false
    })

    setTime('2026-08-30T23:59:00Z')
    logger.info('main', 'DATE-BOUNDARY', 'before UTC midnight')
    setTime('2026-08-31T00:01:00Z')
    logger.info('main', 'DATE-BOUNDARY', 'after UTC midnight')
    assert.equal(fs.existsSync(path.join(tempRoot, 'logs', '2026-08-30.log')), false)
    assert.equal(fs.existsSync(path.join(tempRoot, 'logs', '2026-08-31.log')), true)

    const sameDayLog = fs.readFileSync(path.join(tempRoot, 'logs', '2026-08-31.log'), 'utf8')
    assert.match(sameDayLog, /2026-08-30T23:59:00\.000Z/)
    assert.match(sameDayLog, /2026-08-31T00:01:00\.000Z/)
    assert.match(sameDayLog, /before UTC midnight/)
    assert.match(sameDayLog, /after UTC midnight/)

    setTime('2026-08-31T15:59:00Z')
    updateTaskDetail(secondEmail, {
        key: 'before-local-midnight',
        label: '本地午夜前任务',
        group: 'activity',
        status: '已完成'
    })
    logger.info('main', 'DATE-BOUNDARY', 'before local midnight')
    assert.equal(readTaskProgressFile().date, '2026-08-31')

    setTime('2026-08-31T16:01:00Z')
    progress = readTaskProgressFile()
    assert.equal(progress.date, '2026-09-01')
    assert.deepEqual(progress.accounts, [])
    logger.info('main', 'DATE-BOUNDARY', 'after local midnight')
    assert.equal(fs.existsSync(path.join(tempRoot, 'logs', '2026-09-01.log')), true)

    console.log('localDateBoundary.test.js passed')
} finally {
    global.Date = originalDate
    process.chdir(originalCwd)
    if (originalTz === undefined) delete process.env.TZ
    else process.env.TZ = originalTz
    fs.rmSync(tempRoot, { recursive: true, force: true })
}
