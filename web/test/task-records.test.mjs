import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { HistoryStore } from '../src/history.mjs'
import { AccountIdentity } from '../src/security.mjs'
import { normalizedTasks } from '../src/task-view.mjs'
import { publicLog } from '../src/status.mjs'
import { filterAndGroupLogs, taskTableMarkup, taskStatusLabel } from '../public/run-view.js'

function withHistory(action) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mrs-verified-'))
    const identity = new AccountIdentity(directory)
    const store = new HistoryStore(directory, identity)
    try {
        action(store, directory, identity)
    } finally {
        store.close()
        fs.rmSync(directory, { recursive: true, force: true })
    }
}
function fixture(id = 'run-one', points = 3, at = '2026-09-05T16:01:00.000Z') {
    return {
        id,
        startedAt: '2026-09-05T15:50:00.000Z',
        endedAt: '2026-09-05T16:05:00.000Z',
        exit: { code: 0 },
        version: '4.3.2',
        collected: points,
        accounts: [
            {
                email: 'synthetic@example.com',
                telemetryVersion: 2,
                status: 'partial',
                success: false,
                initialPoints: 100,
                finalPoints: 110,
                collectedPoints: points,
                pendingVerification: 1,
                balanceChange: 10,
                unattributedBalanceChange: 10 - points,
                tasks: [
                    {
                        id: 'app:mobile:read',
                        title: '阅读',
                        status: 'partial',
                        telemetryVersion: 2,
                        verification: 'confirmed',
                        earnedPoints: points
                    }
                ],
                pointRecords: [{ id: 'event-one', taskId: 'app:mobile:read', source: 'app', points, confirmedAt: at }]
            }
        ]
    }
}
test('active points and completed import deduplicate by run/account/event across midnight', () =>
    withHistory(store => {
        const run = fixture()
        store.ingest({ runId: run.id, run: { accounts: run.accounts } }, { runs: [] })
        store.ingest({ runId: run.id, run: { accounts: run.accounts } }, { runs: [run] })
        store.ingest({}, { runs: [run, run] })
        assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM point_events').get().count, 1)
        assert.equal(store.calendar({ start: '2026-09-05', end: '2026-09-05' }).summary.totalPoints, null)
        assert.equal(store.calendar({ start: '2026-09-06', end: '2026-09-06' }).summary.totalPoints, 3)
        const saved = store.getRun(run.id)
        assert.equal(saved.collected, 3)
        assert.equal(saved.pendingVerification, 1)
        assert.equal(saved.accounts[0].unattributedBalanceChange, 7)
        assert.doesNotMatch(JSON.stringify(saved), /synthetic@example.com/)
    }))
test('different runs for the same account never overwrite historical task evidence', () =>
    withHistory(store => {
        const old = fixture('old-run', 3)
        const current = fixture('new-run', 10)
        store.ingest({ runId: current.id, run: { accounts: current.accounts } }, { runs: [old] })
        assert.equal(store.getRun(old.id).accounts[0].collected, 3)
        assert.equal(store.getRun(old.id).accounts[0].tasks[0].earnedPoints, 3)
        assert.equal(store.getRun(old.id).accounts[0].initialPoints, 100)
    }))
test('unknown gain stays nullable and legacy amounts remain separate from confirmed statistics', () =>
    withHistory(store => {
        const pending = fixture('pending-run')
        pending.accounts[0].collectedPoints = null
        pending.accounts[0].pointRecords = []
        pending.accounts[0].tasks[0].earnedPoints = null
        store.ingest(
            {},
            {
                runs: [
                    pending,
                    {
                        ...fixture('legacy-run', 40),
                        accounts: [{ email: 'synthetic@example.com', collected: 40, success: true }]
                    }
                ]
            }
        )
        assert.equal(store.getRun('pending-run').collected, null)
        assert.equal(store.getRun('pending-run').accounts[0].collected, null)
        assert.equal(store.getRun('legacy-run').collected, 40)
        assert.equal(store.getRun('legacy-run').verification, 'legacy')
        assert.equal(store.calendar({ start: '2026-09-06', end: '2026-09-06' }).summary.totalPoints, null)
    }))
test('verification migration is idempotent and preserves legacy amounts', () =>
    withHistory(store => {
        store.db
            .prepare(
                "INSERT INTO runs (run_key,started_at,ended_at,local_date,collected,status,created_at) VALUES ('old','x','x','2026-09-05',42,'completed','x')"
            )
            .run()
        store.migrateVerification()
        store.migrateVerification()
        assert.equal(store.getRun('old').collected, 42)
        assert.equal(store.getRun('old').verification, 'legacy')
    }))
test('failed migration rolls back all added columns and tables', () => {
    const db = new DatabaseSync(':memory:')
    db.exec('CREATE TABLE runs (id TEXT); CREATE TABLE account_runs (id TEXT);')
    const exec = db.exec.bind(db)
    db.exec = sql => {
        if (sql.includes('CREATE TABLE IF NOT EXISTS point_events')) throw new Error('synthetic migration failure')
        return exec(sql)
    }
    try {
        assert.throws(() => HistoryStore.prototype.migrateVerification.call({ db }), /synthetic/)
        for (const table of ['runs', 'account_runs'])
            assert.equal(db.prepare(`PRAGMA table_info(${table})`).all().length, 1)
    } finally {
        db.close()
    }
})
test('tasks distinguish nullable values, all statuses and known waiting deadlines', () => {
    const now = Date.parse('2026-09-05T00:03:00Z')
    const base = {
        id: 'task',
        title: '合成任务',
        status: 'running',
        telemetryVersion: 2,
        verification: 'pending',
        startedAt: '2026-09-05T00:00:00Z',
        updatedAt: '2026-09-05T00:00:00Z',
        earnedPoints: null
    }
    assert.equal(normalizedTasks([base], now)[0].stale, true)
    assert.equal(normalizedTasks([{ ...base, waitUntil: '2026-09-05T00:02:50Z' }], now)[0].stale, false)
    assert.equal(normalizedTasks([{ ...base, terminal: true }], now)[0].stale, false)
    assert.equal(normalizedTasks([{ ...base, progress: { current: null, total: null } }])[0].progress, null)
    for (const status of [
        'pending',
        'running',
        'verifying',
        'completed',
        'partial',
        'stopped',
        'failed',
        'skipped',
        'locked',
        'interrupted'
    ]) {
        assert.equal(normalizedTasks([{ ...base, status }])[0].status, status)
        assert.notEqual(taskStatusLabel(status), '待确认')
    }
    const html = taskTableMarkup(normalizedTasks([{ ...base, title: '<script>test</script>' }]))
    assert.match(html, /待确认/)
    assert.doesNotMatch(html, /<script>/)
})
test('unknown log modules retain redacted content and structured identifiers never reach public logs', () => {
    const a = publicLog({
        title: 'NEW-MODULE',
        level: 'info',
        message: '正在核对任务 token=synthetic-secret person@example.com'
    })
    assert.equal(a.titleLabel, 'NEW-MODULE')
    assert.match(a.displayMessage, /正在核对任务/)
    assert.doesNotMatch(JSON.stringify(a), /synthetic-secret|person@example.com/)
    assert.match(
        publicLog({ title: 'NEW-MODULE', level: 'info', message: 'Starting synthetic step 3' }).displayMessage,
        /Starting synthetic step 3/
    )
    const event = publicLog({
        title: 'TASK-EVENT',
        message: JSON.stringify({
            accountRef: 'private-reference',
            eventId: 'private-event',
            title: '阅读',
            action: '等待复核'
        })
    })
    assert.doesNotMatch(JSON.stringify(event), /private-reference|private-event/)
    assert.match(event.displayMessage, /等待复核/)
    const snapshot = publicLog({
        title: 'TASK-SNAPSHOT',
        message: JSON.stringify({ accountRef: 'private-reference', dataStatus: 'available', tasks: [] })
    })
    assert.doesNotMatch(JSON.stringify(snapshot), /private-reference/)
    assert.match(snapshot.displayMessage, /共 0 项/)
})
test('only consecutive identical debug messages collapse; errors and warnings stay visible', () => {
    const debug = {
        level: 'debug',
        title: 'test',
        message: 'same',
        displayMessage: '同一动作',
        receivedAt: '2026-09-05T00:00:00Z'
    }
    const logs = [
        debug,
        { ...debug, receivedAt: '2026-09-05T00:00:01Z' },
        { ...debug, level: 'warn' },
        debug,
        { ...debug, level: 'error' },
        { ...debug, level: 'error' }
    ]
    const grouped = filterAndGroupLogs(logs)
    assert.equal(grouped.length, 5)
    assert.equal(grouped[0].repeatCount, 2)
    assert.equal(grouped[0].lastReceivedAt, '2026-09-05T00:00:01Z')
    assert.equal(filterAndGroupLogs(logs, { level: 'error', query: '同一动作' }).length, 2)
    assert.equal(filterAndGroupLogs(logs, { query: '不存在' }).length, 0)
})
