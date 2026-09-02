const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { ClaimBonusPoints } = require('../../dist/functions/activities/api/ClaimBonusPoints')
const BrowserFunc = require('../../dist/browser/BrowserFunc').default

function dashboardError(status = 504) {
    return {
        stage: 'dashboard',
        message: `dashboard unavailable (${status})`,
        apiStatus: status,
        apiReason: `API 服务端错误 (${status})`,
        fallbackReason: '合成页面无 dashboard',
        apiFailureKind: 'server',
        attempts: 3,
        elapsedMs: 25
    }
}

function snapshot(confidence, points, source = null, error = null) {
    return { confidence, points, source, error, observedAt: points === null ? null : new Date().toISOString() }
}

function fakeBot(snapshots, options = {}) {
    const logs = []
    let snapshotCalls = 0
    let mutationCalls = 0
    let clickCalls = 0
    let recordCalls = 0
    const bot = {
        isMobile: true,
        rewardsVersion: options.rewardsVersion ?? 'modern',
        requestToken: options.requestToken ?? '',
        userData: {
            currentPoints: 100,
            geoLocale: 'CN',
            timezoneOffset: '480'
        },
        cookies: { mobile: [], desktop: [] },
        fingerprint: { headers: {} },
        mainMobilePage: {},
        logger: {
            info: (...args) => logs.push(args.join(' ')),
            warn: (...args) => logs.push(args.join(' ')),
            debug: (...args) => logs.push(args.join(' ')),
            error: (...args) => logs.push(args.join(' '))
        },
        utils: { wait: async () => {} },
        browser: {
            func: {
                callServerAction: async () => {
                    mutationCalls += 1
                    return options.serverActionOk ?? true
                },
                clickClaimBonusPointsButton: async () => {
                    clickCalls += 1
                    return options.clickOk ?? false
                },
                getCurrentPointsSnapshot: async () => snapshots[Math.min(snapshotCalls++, snapshots.length - 1)],
                buildCookieHeaderForUrl: () => 'COOKIE-CANARY'
            }
        },
        axios: options.axios ?? { request: async () => ({ status: 200 }) },
        recordPointGain: () => {
            recordCalls += 1
        }
    }
    return {
        bot,
        logs,
        get snapshotCalls() {
            return snapshotCalls
        },
        get mutationCalls() {
            return mutationCalls
        },
        get clickCalls() {
            return clickCalls
        },
        get recordCalls() {
            return recordCalls
        }
    }
}

;(async () => {
    const pendingFixture = fakeBot([
        snapshot('unknown', null, null, dashboardError()),
        snapshot('unknown', null, null, dashboardError())
    ])
    const pending = await new ClaimBonusPoints(pendingFixture.bot).claimBonusPoints()
    assert.equal(pending.status, 'pending-verification')
    assert.equal(pendingFixture.mutationCalls, 1)
    assert.equal(pendingFixture.snapshotCalls, 2)
    assert.equal(pendingFixture.recordCalls, 0)

    const delayedFixture = fakeBot([
        snapshot('cached', 100, 'api', dashboardError()),
        snapshot('confirmed', 110, 'api-points', null)
    ])
    const delayed = await new ClaimBonusPoints(delayedFixture.bot).claimBonusPoints()
    assert.equal(delayed.status, 'verified')
    assert.equal(delayed.gainedPoints, 10)
    assert.equal(delayedFixture.mutationCalls, 1)
    assert.equal(delayedFixture.snapshotCalls, 2)
    assert.equal(delayedFixture.recordCalls, 1)

    const skippedFixture = fakeBot([], { serverActionOk: false, clickOk: false })
    const skipped = await new ClaimBonusPoints(skippedFixture.bot).claimBonusPoints()
    assert.equal(skipped.status, 'skipped')
    assert.equal(skippedFixture.mutationCalls, 1)
    assert.equal(skippedFixture.clickCalls, 1)
    assert.equal(skippedFixture.snapshotCalls, 0)

    const clickBot = {
        isMobile: true,
        logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
        utils: { wait: async () => {}, randomDelay: () => 0 }
    }
    const browserFunc = new BrowserFunc(clickBot)
    let openDialogGotoCalls = 0
    const openDialogModes = []
    const openDialogPage = {
        evaluate: async (_callback, mode) => {
            openDialogModes.push(mode)
            return { clicked: true, phase: 'confirm', score: 130 }
        },
        goto: async () => {
            openDialogGotoCalls += 1
        },
        waitForLoadState: async () => {}
    }
    assert.equal(await browserFunc.clickClaimBonusPointsButton(openDialogPage), true)
    assert.deepEqual(openDialogModes, ['confirm'])
    assert.equal(openDialogGotoCalls, 0)

    let delayedEntryCalls = 0
    let delayedConfirmCalls = 0
    let delayedGotoCalls = 0
    const delayedEntryPage = {
        evaluate: async (_callback, mode) => {
            if (mode === 'entry-or-confirm') {
                delayedEntryCalls += 1
                return delayedEntryCalls >= 2
                    ? { clicked: true, phase: 'entry', score: 130 }
                    : { clicked: false, reason: 'no-entry-button' }
            }
            delayedConfirmCalls += 1
            return delayedConfirmCalls >= 3
                ? { clicked: true, phase: 'confirm', score: 130 }
                : { clicked: false, reason: 'no-confirm-button' }
        },
        goto: async () => {
            delayedGotoCalls += 1
        },
        waitForLoadState: async () => {}
    }
    assert.equal(await browserFunc.clickClaimBonusPointsButton(delayedEntryPage), true)
    assert.equal(delayedGotoCalls, 1)
    assert.equal(delayedEntryCalls, 2)
    assert.equal(delayedConfirmCalls, 3)

    let requestOnceCalls = 0
    const legacyFixture = fakeBot(
        [snapshot('unknown', null, null, dashboardError()), snapshot('unknown', null, null, dashboardError())],
        {
            rewardsVersion: 'legacy',
            requestToken: 'VERIFY-CANARY',
            axios: {
                requestOnce: async (_request, timeout) => {
                    requestOnceCalls += 1
                    assert.equal(timeout, 15000)
                    return { status: 200 }
                },
                request: async () => {
                    throw new Error('global retry path must not be used')
                }
            }
        }
    )
    assert.equal((await new ClaimBonusPoints(legacyFixture.bot).claimBonusPoints()).status, 'pending-verification')
    assert.equal(requestOnceCalls, 1)
    const claimLogs = legacyFixture.logs.join('\n')
    assert.equal(claimLogs.includes('COOKIE-CANARY'), false)
    assert.equal(claimLogs.includes('VERIFY-CANARY'), false)

    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rewards-claim-partial-'))
    const originalCwd = process.cwd()
    try {
        process.chdir(tempRoot)
        const { finishPointRun, readPointsHistoryFile, startPointRun } = require('../../dist/util/PointsHistoryStore')
        const runId = startPointRun('synthetic@example.test', 100, { source: 'test' })
        finishPointRun('synthetic@example.test', runId, {
            status: 'partial',
            beforePoints: 100,
            taskSummary: [{ key: 'daily', label: '领取奖励积分', gained: 0, status: '积分待复核' }],
            balanceUnconfirmed: true
        })
        const run = readPointsHistoryFile().days[0].runs[0]
        assert.equal(run.status, 'partial')
        assert.equal(run.balanceUnconfirmed, true)
        assert.equal(run.runGained, 0)
    } finally {
        process.chdir(originalCwd)
        fs.rmSync(tempRoot, { recursive: true, force: true })
    }

    console.log('claimBonusVerification.test.js passed')
})().catch(error => {
    console.error(error)
    process.exit(1)
})
