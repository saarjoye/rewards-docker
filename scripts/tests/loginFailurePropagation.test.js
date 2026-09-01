const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rewards-login-failure-'))
const originalCwd = process.cwd()

async function main() {
    try {
        process.chdir(tempRoot)

        const { ensureSuccessfulLogin } = require('../../dist/util/AuthenticatedFlow')
        const { LoginStateError } = require('../../dist/browser/auth/Login')
        const { readAccountStatusFile, updateAccountStatus } = require('../../dist/util/AccountStatusStore')
        const { readRunCheckpointFile, updateRunCheckpoint } = require('../../dist/util/RunCheckpointStore')
        const { readTaskProgressFile, updateAccountRunFailure } = require('../../dist/util/TaskProgressStore')
        const { readPointsHistoryFile, recordPointFailure } = require('../../dist/util/PointsHistoryStore')

        const email = 'login-failure@example.test'
        const loginError = new LoginStateError('ERROR_ALERT', '密码错误 password=SECRET-CANARY', {
            loginStage: 'login-error-alert',
            url: 'https://login.live.com/login.srf',
            host: 'login.live.com',
            path: '/login.srf'
        })
        let dashboardCalls = 0
        let searchCalls = 0

        const runAuthenticatedFlow = async () => {
            await ensureSuccessfulLogin(async () => {
                throw loginError
            })
            dashboardCalls++
            searchCalls++
        }

        await assert.rejects(runAuthenticatedFlow(), error => error === loginError)

        assert.equal(dashboardCalls, 0)
        assert.equal(searchCalls, 0)

        const failureMessage = loginError.errorMessage
        updateAccountStatus(email, {
            state: 'error',
            stage: loginError.loginStage,
            lastMessage: failureMessage,
            error: failureMessage
        })
        updateRunCheckpoint(email, {
            state: 'failed',
            currentTask: '登录验证失败',
            currentStep: loginError.loginStage,
            lastMessage: failureMessage,
            error: failureMessage
        })
        updateAccountRunFailure(email, loginError.loginStage, failureMessage)
        recordPointFailure(email, {
            stage: loginError.loginStage,
            error: failureMessage,
            source: 'test'
        })

        const accountStatus = readAccountStatusFile().accounts[0]
        const checkpoint = readRunCheckpointFile().accounts[0]
        const progress = readTaskProgressFile().accounts[0]
        const history = readPointsHistoryFile()

        assert.equal(accountStatus.state, 'error')
        assert.equal(accountStatus.stage, 'login-error-alert')
        assert.equal(checkpoint.state, 'failed')
        assert.equal(checkpoint.currentStep, 'login-error-alert')
        assert.notEqual(checkpoint.state, 'completed')
        assert.equal(progress.currentStage, 'login-error-alert')
        assert.equal(progress.details.find(item => item.key === 'login-failure').status, '失败')
        assert.equal(history.days.length, 0)
        assert.equal(history.failures.length, 1)
        assert.equal(history.failures[0].stage, 'login-error-alert')

        const persisted = JSON.stringify({ accountStatus, checkpoint, progress, history })
        assert.equal(persisted.includes('SECRET-CANARY'), false)

        console.log('loginFailurePropagation.test.js passed')
    } finally {
        process.chdir(originalCwd)
        fs.rmSync(tempRoot, { recursive: true, force: true })
    }
}

main().catch(error => {
    console.error(error)
    process.exitCode = 1
})
