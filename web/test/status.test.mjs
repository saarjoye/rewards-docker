import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { AccountIdentity } from '../src/security.mjs'
import { buildPublicState, publicLog } from '../src/status.mjs'

test('browser maintenance logs have concrete Chinese summaries and retain redacted originals', () => {
    for (const [title, message, expected] of [
        ['COOKIE-SYNC', 'Applied 3 response cookie(s) and persisted the updated session', /已同步 3 条/],
        ['SEARCH-COOKIE-SEED', 'Refreshed cookie cache | previous=253 | current=253', /已刷新会话缓存/],
        ['SEARCH-CLOSE-TABS', 'Found 2 tab(s) open (min: 1, max: 1)', /当前打开 2 个标签页/],
        ['SEARCH-CLOSE-TABS', 'Closed 1/1 excess tab(s) to reach max of 1', /已关闭 1\/1 个/],
        ['GHOST-CLICK', 'Trying to click selector: #sb_form_q, options: undefined', /正在点击搜索输入框/],
        ['GHOST-CLICK', 'Trying to click selector: #b_results .b_algo h2, options: undefined', /正在打开搜索结果页面/]
    ]) {
        const log = publicLog({ title, message, level: 'debug', platform: 'DESKTOP' })
        assert.match(log.displayMessage, expected)
        assert.match(log.titleLabel, /[\u4e00-\u9fff]/)
        assert.equal(log.platformLabel, '桌面端')
        assert.ok(log.message)
    }
})

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

test('separates task-confirmed points from reconciled balance gains', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mrs-status-reconciliation-'))
    try {
        const identity = new AccountIdentity(directory)
        const accountId = identity.keyFor('first@example.com')
        const state = buildPublicState({
            status: { state: 'idle', run: { accounts: [] } },
            points: { accounts: [] },
            configuredAccounts: { accounts: [{ index: 1, email: 'first@example.com' }] },
            identity,
            historySummary: {
                today: '2026-09-05',
                todayGained: 22,
                confirmedPoints: 6,
                unattributedPoints: 16,
                pendingPoints: null,
                balanceReconciliation: [
                    {
                        accountKey: accountId,
                        runGained: 22,
                        todayGained: 22,
                        confirmedPoints: 6,
                        unattributedPoints: 16,
                        pendingPoints: null,
                        pendingTaskCount: 1,
                        balanceDelta: 22,
                        balanceReconciliation: { status: 'confirmed' }
                    }
                ]
            },
            notificationStatus: { enabled: false }
        })
        assert.equal(state.accounts[0].points.runGained, 22)
        assert.equal(state.accounts[0].points.confirmedPoints, 6)
        assert.equal(state.accounts[0].points.unattributedPoints, 16)
        assert.equal(state.accounts[0].points.collected, 6)
        assert.equal(state.history.todayGained, 22)
    } finally {
        fs.rmSync(directory, { recursive: true, force: true })
    }
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

test('translates React parsing and dashboard fallback logs into Chinese summaries', () => {
    const cases = [
        [
            'REACT-PARSE',
            'Concatenated flight chunks | pages=2 | chunks=14 | length=3821 | perSource=[7c/1900b, 7c/1921b]',
            /已合并页面数据块：页面 2 个，数据块 14 个，长度 3821/
        ],
        ['REACT-PARSE', 'Parsed offers | total=9 | reportable=4', /已解析任务：共 9 项，可执行 4 项/],
        ['REACT-PARSE', 'Parsed offer ids | offer-a, offer-b(skip)', /已解析任务标识：offer-a, offer-b（跳过）/],
        ['REACT-PARSE', 'Parsed streaks | bing:2/7', /已解析连续任务：bing:2\/7/],
        [
            'REACT-PARSE',
            'Parsed streak protection | enabled=false | remainingDays=null | streakCounter=3',
            /已解析连续签到保护：已启用 否，剩余天数 未读取，连续签到 3 天/
        ],
        [
            'REACT-PARSE',
            'Parsed account | level=2 | available=null | toGo=80 | lifetime=1200',
            /已解析账号数据：等级 2，可用积分 未读取，距离下一等级 80，累计积分 1200/
        ],
        [
            'REACT-PARSE',
            'Account state empty - membership/header objects not found in payload',
            /账号状态为空：响应中未找到会员或页头对象/
        ],
        [
            'GET-DASHBOARD-DATA',
            'Using partial Bing flyout dashboard | suspectedLimited=false | botMarkers=true | activitiesCollapsed=false',
            /使用不完整的 Bing 浮层任务数据：疑似受限 否，检测到机器人标记 是，任务列表折叠 否/
        ],
        ['GET-DASHBOARD-DATA', 'Primary dashboard and Bing flyout fallback failed | message=timeout', /主任务面板和 Bing 浮层备用数据均不可用/]
    ]

    for (const [title, message, expected] of cases) {
        const log = publicLog({ title, message, level: 'debug', platform: 'DESKTOP' })
        assert.match(log.displayMessage, expected)
        assert.match(log.displayMessage, /[\u4e00-\u9fff]/)
        assert.equal(log.message, message)
    }
})

test('translates core flow and search progress without exposing English status text', () => {
    const cases = [
        ['FLOW', 'Starting session for person@example.com', /正在初始化当前账号任务流程/],
        ['BROWSER', 'Mobile Browser started | person@example.com', /移动端浏览器已启动/],
        ['SEARCH-MANAGER', 'Starting bonus search farming', /开始执行奖励搜索/],
        ['SEARCH-MANAGER', 'Search summary | mobile=30 | desktop=20 | bonus=0 | total=50', /搜索任务结束：移动端 30 分/],
        ['SEARCH-BING', 'Query queue exhausted, stopping', /搜索词已用尽，本轮搜索停止/]
    ]
    for (const [title, message, expected] of cases) {
        const log = publicLog({ title, message, level: 'info', platform: 'MOBILE' })
        assert.match(log.displayMessage, expected)
        assert.match(log.displayMessage, /[\u4e00-\u9fff]/)
    }
})
