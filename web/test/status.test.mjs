import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { AccountIdentity } from '../src/security.mjs'
import { buildPublicState } from '../src/status.mjs'

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
            historySummary: { runs: 0, collected: 0 },
            notificationStatus: { enabled: false }
        })
        assert.equal(state.core.label, '运行中')
        assert.equal(state.accounts[0].status.label, '运行中')
        assert.equal(state.accounts[1].status.label, '等待执行')
        assert.equal(state.accounts[0].earnable.mobile, null)
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
