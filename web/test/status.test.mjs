import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { AccountIdentity } from '../src/security.mjs'
import { buildPublicState, publicLog } from '../src/status.mjs'

test('maps core and account states to Chinese without exposing email', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mrs-status-'))
    try {
        const identity = new AccountIdentity(directory)
        const state = buildPublicState({
            status: {
                state: 'running',
                version: '4.3.2',
                run: {
                    version: '4.3.2',
                    accountsTotal: 2,
                    accountsSeen: 1,
                    live: { currentAccount: 'first@example.com' },
                    accounts: [
                        {
                            email: 'first@example.com',
                            success: null,
                            earnable: { mobile: null, browser: 60, app: 30 },
                            tasks: [
                                {
                                    id: 'offer-1',
                                    title: '每日活动',
                                    status: 'running',
                                    expectedPoints: null,
                                    earnedPoints: 5
                                }
                            ],
                            live: { balance: 100, gained: 15, bySource: { checkIn: 15 } }
                        }
                    ]
                }
            },
            points: { currentAccount: 'first@example.com', collected: 15, accounts: [] },
            configuredAccounts: {
                accounts: [
                    { index: 1, email: 'first@example.com', geoLocale: 'CN', langCode: 'zh-CN' },
                    { index: 2, email: 'second@example.com', geoLocale: 'CN', langCode: 'zh-CN' }
                ]
            },
            identity,
            historySummary: { runs: 0, collected: 0, todayCollected: 20, today: '2026-09-05' },
            notificationStatus: { enabled: false }
        })
        assert.equal(state.core.label, '运行中')
        assert.equal(state.accounts[0].status.label, '运行中')
        assert.equal(state.accounts[1].status.label, '等待执行')
        assert.equal(state.accounts[0].earnable.mobile, null)
        assert.equal(state.accounts[0].tasks[0].expectedPoints, null)
        assert.equal(state.history.todayCollected, 20)
        assert.doesNotMatch(JSON.stringify(state), /first@example\.com|second@example\.com/)
    } finally {
        fs.rmSync(directory, { recursive: true, force: true })
    }
})

test('reports unavailable core without inventing account state', () => {
    const state = buildPublicState({
        status: null,
        points: null,
        configuredAccounts: null,
        identity: null,
        historySummary: { runs: 2 },
        notificationStatus: { enabled: false }
    })
    assert.equal(state.core.label, '核心离线')
    assert.deepEqual(state.accounts, [])
})

test('translates login failures into clear Chinese summaries', () => {
    const accountError = publicLog({
        level: 'error',
        platform: 'MOBILE',
        title: 'LOGIN',
        message: 'Account error: Unknown Error'
    })
    const fatalError = publicLog({
        level: 'error',
        platform: 'MOBILE',
        title: 'LOGIN',
        message: 'Fatal error: Microsoft login error: Unknown Error'
    })
    const flowError = publicLog({
        level: 'error',
        platform: 'MAIN',
        title: 'FLOW',
        message: 'Mobile flow failed for person@example.com: Microsoft login error: Unknown Error'
    })

    assert.equal(accountError.titleLabel, '账号登录')
    assert.equal(accountError.displayMessage, '账号登录失败：登录页面未返回可识别的错误原因')
    assert.equal(fatalError.displayMessage, '账号登录失败：登录页面未返回可识别的错误原因')
    assert.equal(flowError.displayMessage, '移动端账号流程失败：登录页面未返回可识别的错误原因')
    assert.doesNotMatch(JSON.stringify(flowError), /person@example\.com/)
})

test('preserves Chinese login retry counts and outcomes in public steps', () => {
    for (const [level, message] of [
        ['warn', '桌面端登录原因未知，30 秒后第 2/3 次重新登录'],
        ['info', '移动端重新登录成功，继续后续任务'],
        ['error', '桌面端已重试登录 3 次，仍未成功，本次桌面端流程结束']
    ]) {
        const log = publicLog({ title: 'LOGIN-RETRY', level, message })
        assert.equal(log.titleLabel, '重新登录')
        assert.equal(log.displayMessage, message)
    }
})
