const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rewards-search-failure-'))
const originalCwd = process.cwd()

try {
    process.chdir(tempRoot)
    const {
        readTaskProgressFile,
        updateSearchTaskFailure,
        updateSearchTaskProgress
    } = require('../../dist/util/TaskProgressStore')
    const { toSearchTaskError } = require('../../dist/util/SearchTaskError')
    const { readRunCheckpointFile, updateRunCheckpoint } = require('../../dist/util/RunCheckpointStore')
    const { readAccountStatusFile, updateAccountStatus } = require('../../dist/util/AccountStatusStore')
    const { finishPointRun, readPointsHistoryFile, startPointRun } = require('../../dist/util/PointsHistoryStore')
    const email = 'partial-search@example.test'

    updateSearchTaskProgress(email, 'desktop', 9, 51, 60)
    const savedFailure = updateSearchTaskFailure(email, 'desktop', {
        completed: 0,
        total: 60,
        message: 'desktop-login PASSKEY_ERROR token=SECRET-CANARY'
    })
    assert.equal(savedFailure.completed, 9)
    assert.equal(savedFailure.total, 60)
    assert.equal(savedFailure.status, '失败')

    const progress = readTaskProgressFile().accounts[0]
    assert.equal(progress.desktop.completed, 9)
    assert.equal(progress.desktop.total, 60)
    assert.equal(progress.desktop.status, '失败')
    assert.equal(progress.details.find(item => item.key === 'desktop-search').status, '失败')
    assert.equal(JSON.stringify(progress).includes('SECRET-CANARY'), false)

    const loginFailure = new Error('登录失败')
    loginFailure.loginState = 'PASSKEY_ERROR'
    const structured = toSearchTaskError(loginFailure, 'desktop-login', 'desktop', 9, 60)
    assert.equal(structured.stage, 'desktop-login')
    assert.equal(structured.loginState, 'PASSKEY_ERROR')
    assert.equal(structured.completed, 9)
    assert.equal(structured.total, 60)
    assert.match(structured.message, /PASSKEY_ERROR/)

    updateAccountStatus(email, {
        state: 'error',
        stage: structured.stage,
        lastMessage: structured.message,
        error: structured.message
    })
    assert.equal(readAccountStatusFile().accounts[0].state, 'error')
    assert.equal(readAccountStatusFile().accounts[0].stage, 'desktop-login')

    updateRunCheckpoint(email, {
        state: 'failed',
        currentTask: 'PC搜索',
        currentStep: structured.stage,
        lastMessage: structured.message,
        error: structured.message
    })
    assert.equal(readRunCheckpointFile().accounts[0].state, 'failed')
    assert.equal(readRunCheckpointFile().accounts[0].currentStep, 'desktop-login')

    const runId = startPointRun(email, 100, { source: 'test' })
    finishPointRun(email, runId, {
        status: 'failed',
        beforePoints: 100,
        afterPoints: 109,
        runGained: 9,
        taskSummary: [{ key: 'desktop', label: 'PC搜索', completed: 9, total: 60, gained: 9, status: '失败' }],
        error: structured.message
    })
    const pointRun = readPointsHistoryFile().days[0].runs[0]
    assert.notEqual(pointRun.status, 'completed')
    assert.equal(
        pointRun.taskSummary.some(item => item.status === '失败'),
        true
    )

    console.log('searchFailureState.test.js passed')
} finally {
    process.chdir(originalCwd)
    fs.rmSync(tempRoot, { recursive: true, force: true })
}
