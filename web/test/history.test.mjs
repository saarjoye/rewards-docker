import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { HistoryStore } from '../src/history.mjs'
import { AccountIdentity } from '../src/security.mjs'

test('persists completed runs once and never stores the full email', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mrs-history-'))
    const store = new HistoryStore(directory, new AccountIdentity(directory))
    try {
        const history = {
            runs: [
                {
                    startedAt: '2026-09-03T01:00:00.000Z',
                    endedAt: '2026-09-03T02:00:00.000Z',
                    version: '4.3.2',
                    exit: { code: 0, signal: null },
                    collected: 66,
                    accounts: [{ email: 'private@example.com', collected: 66, success: true, error: null }]
                }
            ]
        }
        const status = {
            lastExit: { at: '2026-09-03T02:00:00.000Z' },
            run: {
                accounts: [
                    {
                        email: 'private@example.com',
                        initialPoints: 100,
                        finalPoints: 166,
                        live: { gained: 66, balance: 166, bySource: { read: 21, checkIn: 15 } }
                    }
                ]
            }
        }
        assert.equal(store.ingest(status, history).length, 1)
        assert.equal(store.ingest(status, history).length, 0)
        const saved = store.list()
        assert.equal(saved.count, 1)
        assert.equal(saved.runs[0].accounts[0].collected, 66)
        assert.deepEqual(saved.runs[0].accounts[0].sources, { read: 21, checkIn: 15 })
        assert.doesNotMatch(JSON.stringify(saved), /private@example\.com/)
        const calendar = store.calendar({ start: '2026-09-03', end: '2026-09-03' })
        assert.equal(calendar.summary.totalPoints, 66)
    } finally {
        store.close()
        const databaseBytes = fs.readFileSync(path.join(directory, 'history.db')).toString('latin1')
        assert.doesNotMatch(databaseBytes, /private@example\.com/)
        fs.rmSync(directory, { recursive: true, force: true })
    }
})

test('previews and deduplicates legacy history imports', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mrs-import-'))
    const store = new HistoryStore(directory, new AccountIdentity(directory))
    try {
        const legacy = {
            version: 1,
            days: [
                {
                    date: '2026-09-02',
                    accountHash: 'old-hash',
                    accountLabel: 'o***@e***.com',
                    runs: [
                        {
                            id: 'old-run',
                            startedAt: '2026-09-02T01:00:00.000Z',
                            finishedAt: '2026-09-02T02:00:00.000Z',
                            runGained: 30,
                            status: 'completed',
                            categories: { pcSearch: 30 }
                        }
                    ]
                }
            ]
        }
        assert.deepEqual(store.importLegacy(legacy), { valid: true, candidates: 1, existing: 0, inserted: 0 })
        assert.equal(store.importLegacy(legacy, { apply: true }).inserted, 1)
        assert.equal(store.importLegacy(legacy, { apply: true }).inserted, 0)
    } finally {
        store.close()
        fs.rmSync(directory, { recursive: true, force: true })
    }
})
