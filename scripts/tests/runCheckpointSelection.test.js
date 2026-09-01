const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rewards-checkpoint-test-'))
const originalCwd = process.cwd()

try {
    process.chdir(tempRoot)
    const {
        readRunCheckpointFile,
        selectAccountsForRun,
        selectAccountsWithoutCheckpoint,
        syncRunCheckpointFromAccountCheck,
        updateRunCheckpoint
    } = require('../../dist/util/RunCheckpointStore')
    const accounts = [{ email: 'first@example.test' }, { email: 'second@example.test' }, { email: 'last@example.test' }]

    const allSelection = selectAccountsWithoutCheckpoint(accounts, { mode: 'all' })
    assert.deepEqual(allSelection.selected, accounts)
    assert.deepEqual(allSelection.skipped, [])
    assert.equal(allSelection.interrupted, 0)
    assert.equal(fs.existsSync(path.join(tempRoot, 'logs', 'run-checkpoint.json')), false)

    const firstSelection = selectAccountsWithoutCheckpoint(accounts, {
        mode: 'account',
        targetAccountIndex: 1
    })
    assert.deepEqual(firstSelection.selected, [accounts[0]])

    const lastSelection = selectAccountsWithoutCheckpoint(accounts, {
        mode: 'account',
        targetAccountIndex: accounts.length
    })
    assert.deepEqual(lastSelection.selected, [accounts[accounts.length - 1]])

    for (const invalidIndex of [0, -1, accounts.length + 1]) {
        assert.throws(
            () =>
                selectAccountsWithoutCheckpoint(accounts, {
                    mode: 'account',
                    targetAccountIndex: invalidIndex
                }),
            /1\.\.3/
        )
    }

    const accountSelection = selectAccountsWithoutCheckpoint(accounts, {
        mode: 'account',
        targetAccountIndex: 2
    })
    assert.deepEqual(accountSelection.selected, [accounts[1]])
    assert.deepEqual(accountSelection.skipped, [accounts[0], accounts[2]])
    assert.equal(fs.existsSync(path.join(tempRoot, 'logs', 'run-checkpoint.json')), false)

    updateRunCheckpoint(accounts[0].email, {
        state: 'completed',
        currentTask: 'old task',
        currentStep: 'account-end',
        lastMessage: 'old completed state'
    })
    let saved = readRunCheckpointFile().accounts[0]
    assert.equal(saved.state, 'completed')
    assert.ok(saved.finishedAt)

    const formalContinue = selectAccountsForRun(accounts, { mode: 'continue', runSource: 'test' })
    assert.deepEqual(formalContinue.selected, [accounts[1], accounts[2]])
    assert.deepEqual(formalContinue.skipped, [accounts[0]])

    const continueSelection = selectAccountsWithoutCheckpoint(accounts, {
        mode: 'continue',
        targetAccountIndex: 1
    })
    assert.deepEqual(continueSelection.selected, accounts)

    syncRunCheckpointFromAccountCheck(accounts[0].email, {
        hasPendingTasks: true,
        message: '账号刷新：检测到未完成任务，等待继续执行',
        runSource: 'test',
        pid: 123
    })
    saved = readRunCheckpointFile().accounts[0]
    assert.equal(saved.state, 'pending')
    assert.equal(saved.currentStep, 'account-check')
    assert.equal(saved.runMode, 'continue')
    assert.equal(saved.runSource, 'test')
    assert.equal(saved.finishedAt, undefined)

    syncRunCheckpointFromAccountCheck(accounts[0].email, {
        hasPendingTasks: false,
        message: '账号刷新：dashboard 已无可执行任务，今日已完成'
    })
    saved = readRunCheckpointFile().accounts[0]
    assert.equal(saved.state, 'completed')
    assert.equal(saved.currentStep, 'account-check')
    assert.ok(saved.finishedAt)

    console.log('runCheckpointSelection.test.js passed')
} finally {
    process.chdir(originalCwd)
    fs.rmSync(tempRoot, { recursive: true, force: true })
}
