import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { sanitizeText } from './security.mjs'
import { normalizedTasks } from './task-view.mjs'

const TIMEZONE = process.env.TZ || 'Asia/Shanghai'

function numberOrNull(value) {
    if (value === null || value === undefined || value === '') return null
    const number = Number(value)
    return Number.isFinite(number) ? number : null
}

function localDate(iso) {
    const date = new Date(iso)
    if (Number.isNaN(date.getTime())) return new Date().toISOString().slice(0, 10)
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: TIMEZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).formatToParts(date)
    const get = type => parts.find(part => part.type === type)?.value
    return `${get('year')}-${get('month')}-${get('day')}`
}

function runStatus(run) {
    const accounts = Array.isArray(run?.accounts) ? run.accounts : []
    if (accounts.some(account => account.telemetryVersion === 2)) {
        if (accounts.some(account => account.status === 'interrupted')) return 'interrupted'
        if (accounts.length && accounts.every(account => account.status === 'completed')) return 'completed'
        return accounts.some(account => account.collectedPoints > 0 || account.status === 'completed')
            ? 'partial'
            : accounts.some(account => account.success === false)
              ? 'failed'
              : 'partial'
    }
    const successes = accounts.filter(account => account.success === true).length
    const failures = accounts.filter(account => account.success === false).length
    if (run?.exit?.code === 0 && failures === 0) return 'completed'
    if (successes > 0 || numberOrNull(run?.collected) > 0) return 'partial'
    return 'failed'
}

function normalizedSources(account) {
    const source = account?.live?.bySource ?? account?.bySource ?? {}
    const result = {}
    for (const [key, value] of Object.entries(source)) {
        const number = numberOrNull(value)
        if (number !== null && number >= 0) result[sanitizeText(key, 40)] = number
    }
    return result
}

function sum(values) {
    return values.reduce((total, value) => total + (numberOrNull(value) ?? 0), 0)
}

function safeIdentifier(value) {
    const normalized = String(value ?? '').trim()
    return /^[A-Za-z0-9_-]{1,100}$/.test(normalized) ? normalized : null
}

export class HistoryStore {
    constructor(dataDir, identity, { logRetentionDays = 7, logLimit = 10000 } = {}) {
        fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })
        this.identity = identity
        this.logRetentionDays = Math.max(1, Math.min(Number(logRetentionDays) || 7, 30))
        this.logLimit = Math.max(100, Math.min(Number(logLimit) || 10000, 100000))
        this.logWrites = 0
        this.dbPath = path.join(dataDir, 'history.db')
        this.db = new DatabaseSync(this.dbPath)
        try {
            fs.chmodSync(this.dbPath, 0o600)
        } catch {}
        this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;')
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS runs (
                run_key TEXT PRIMARY KEY,
                started_at TEXT NOT NULL,
                ended_at TEXT NOT NULL,
                local_date TEXT NOT NULL,
                version TEXT,
                exit_code INTEGER,
                exit_signal TEXT,
                collected INTEGER NOT NULL DEFAULT 0,
                status TEXT NOT NULL,
                imported INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS account_runs (
                run_key TEXT NOT NULL REFERENCES runs(run_key) ON DELETE CASCADE,
                account_key TEXT NOT NULL,
                account_label TEXT NOT NULL,
                initial_points INTEGER,
                final_points INTEGER,
                collected INTEGER NOT NULL DEFAULT 0,
                success INTEGER,
                error_summary TEXT,
                sources_json TEXT NOT NULL DEFAULT '{}',
                tasks_json TEXT NOT NULL DEFAULT '[]',
                PRIMARY KEY (run_key, account_key)
            );
            CREATE TABLE IF NOT EXISTS notifications (
                event_key TEXT PRIMARY KEY,
                event_type TEXT NOT NULL,
                sent_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS diagnostic_logs (
                event_key TEXT PRIMARY KEY,
                run_key TEXT,
                received_at TEXT NOT NULL,
                level TEXT NOT NULL,
                payload_json TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_runs_date ON runs(local_date DESC, ended_at DESC);
            CREATE INDEX IF NOT EXISTS idx_account_runs_account ON account_runs(account_key);
            CREATE INDEX IF NOT EXISTS idx_diagnostic_logs_time ON diagnostic_logs(received_at DESC);
            CREATE INDEX IF NOT EXISTS idx_diagnostic_logs_run ON diagnostic_logs(run_key, received_at);
        `)
        const accountColumns = new Set(
            this.db
                .prepare('PRAGMA table_info(account_runs)')
                .all()
                .map(column => column.name)
        )
        if (!accountColumns.has('tasks_json')) {
            this.db.exec("ALTER TABLE account_runs ADD COLUMN tasks_json TEXT NOT NULL DEFAULT '[]'")
        }
        try {
            this.migrateVerification()
        } catch (error) {
            this.db.close()
            throw error
        }
        this.pruneLogs()
    }

    migrateVerification() {
        this.db.exec('BEGIN IMMEDIATE')
        try {
            for (const table of ['runs', 'account_runs']) {
                const columns = this.db.prepare(`PRAGMA table_info(${table})`).all()
                if (!columns.some(column => column.name === 'verification_json'))
                    this.db.exec(`ALTER TABLE ${table} ADD COLUMN verification_json TEXT`)
            }
            this.db.exec(`CREATE TABLE IF NOT EXISTS point_events (
                event_key TEXT PRIMARY KEY, run_key TEXT NOT NULL, account_key TEXT NOT NULL,
                points REAL NOT NULL, confirmed_at TEXT NOT NULL, local_date TEXT NOT NULL, source TEXT NOT NULL
            ); CREATE INDEX IF NOT EXISTS idx_point_events_date ON point_events(local_date);`)
            this.db.exec('COMMIT')
        } catch (error) {
            this.db.exec('ROLLBACK')
            throw error
        }
    }

    ingestPoints(runKey, accounts) {
        if (!safeIdentifier(runKey)) return
        const insert = this.db.prepare('INSERT OR IGNORE INTO point_events VALUES (?, ?, ?, ?, ?, ?, ?)')
        for (const account of accounts ?? []) {
            if (account.telemetryVersion !== 2) continue
            const accountKey = this.identity.keyFor(account.email ?? 'unknown')
            for (const record of account.pointRecords ?? []) {
                if (
                    !safeIdentifier(record.id) ||
                    typeof record.points !== 'number' ||
                    !Number.isFinite(record.points) ||
                    record.points < 0 ||
                    !Number.isFinite(Date.parse(record.confirmedAt))
                )
                    continue
                const key = crypto.createHash('sha256').update(`${runKey}|${accountKey}|${record.id}`).digest('hex')
                insert.run(
                    key,
                    runKey,
                    accountKey,
                    record.points,
                    record.confirmedAt,
                    localDate(record.confirmedAt),
                    sanitizeText(record.source, 40)
                )
            }
        }
    }

    close() {
        try {
            this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
            this.db.close()
        } catch {}
    }

    runKey(run, accountKeys) {
        return crypto
            .createHash('sha256')
            .update(`${run.startedAt || ''}|${run.endedAt || ''}|${run.version || ''}|${accountKeys.sort().join(',')}`)
            .digest('hex')
    }

    ingest(status, historyPayload) {
        const inserted = []
        const history = Array.isArray(historyPayload?.runs) ? historyPayload.runs : []
        const liveAccounts = new Map(
            (status?.run?.accounts ?? []).map(account => [String(account.email ?? '').toLowerCase(), account])
        )
        const insertRun = this.db.prepare(`
            INSERT OR IGNORE INTO runs
            (run_key, started_at, ended_at, local_date, version, exit_code, exit_signal, collected, status, imported, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
        `)
        const insertAccount = this.db.prepare(`
            INSERT OR REPLACE INTO account_runs
            (run_key, account_key, account_label, initial_points, final_points, collected, success, error_summary, sources_json, tasks_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)

        this.db.exec('BEGIN IMMEDIATE')
        try {
            this.ingestPoints(status?.runId, status?.run?.accounts)
            for (const run of history) {
                if (!run?.startedAt || !run?.endedAt) continue
                const accounts = Array.isArray(run.accounts) ? run.accounts : []
                const accountKeys = accounts.map(account => this.identity.keyFor(account.email ?? 'unknown'))
                const runKey = safeIdentifier(run.id) || this.runKey(run, accountKeys)
                this.ingestPoints(runKey, accounts)
                const result = insertRun.run(
                    runKey,
                    run.startedAt,
                    run.endedAt,
                    localDate(run.endedAt),
                    sanitizeText(run.version ?? '', 40) || null,
                    numberOrNull(run.exit?.code),
                    sanitizeText(run.exit?.signal ?? '', 40) || null,
                    Math.max(0, numberOrNull(run.collected) ?? 0),
                    runStatus(run),
                    new Date().toISOString()
                )
                if (Number(result.changes) > 0) inserted.push(runKey)

                for (const account of accounts) {
                    const email = String(account.email ?? '')
                    const enhanced =
                        run.id && run.id === status?.runId
                            ? (liveAccounts.get(email.toLowerCase()) ?? account)
                            : account
                    insertAccount.run(
                        runKey,
                        this.identity.keyFor(email || 'unknown'),
                        this.identity.labelFor(email),
                        numberOrNull(enhanced.initialPoints),
                        numberOrNull(enhanced.finalPoints ?? enhanced.live?.balance),
                        Math.max(
                            0,
                            numberOrNull(account.collected ?? enhanced.collectedPoints ?? enhanced.live?.gained) ?? 0
                        ),
                        account.success === null || account.success === undefined ? null : account.success ? 1 : 0,
                        account.error ? sanitizeText(account.error, 800) : null,
                        JSON.stringify(normalizedSources(enhanced)),
                        JSON.stringify(this.normalizedTasks(enhanced.tasks))
                    )
                    if (enhanced.telemetryVersion === 2) {
                        this.db
                            .prepare(
                                'UPDATE account_runs SET verification_json = ? WHERE run_key = ? AND account_key = ?'
                            )
                            .run(
                                JSON.stringify({
                                    version: 2,
                                    collected: numberOrNull(enhanced.collectedPoints ?? enhanced.live?.gained),
                                    pending: enhanced.pendingVerification ?? 0,
                                    status: enhanced.status ?? 'unknown',
                                    balanceChange: numberOrNull(enhanced.balanceChange),
                                    unattributedBalanceChange: numberOrNull(enhanced.unattributedBalanceChange)
                                }),
                                runKey,
                                this.identity.keyFor(email || 'unknown')
                            )
                    }
                }
                if (accounts.some(account => account.telemetryVersion === 2)) {
                    const confirmed = this.db
                        .prepare('SELECT SUM(points) AS points FROM point_events WHERE run_key = ?')
                        .get(runKey)
                    this.db.prepare('UPDATE runs SET verification_json = ?, status = ? WHERE run_key = ?').run(
                        JSON.stringify({
                            version: 2,
                            collected: confirmed.points,
                            pending: accounts.reduce((sum, account) => sum + (account.pendingVerification ?? 0), 0)
                        }),
                        runStatus(run),
                        runKey
                    )
                }
            }
            this.db.exec('COMMIT')
        } catch (error) {
            this.db.exec('ROLLBACK')
            throw error
        }
        return inserted
    }

    getRun(runKey) {
        const run = this.db.prepare('SELECT * FROM runs WHERE run_key = ?').get(runKey)
        if (!run) return null
        return this.toPublicRun(run)
    }

    toPublicRun(run) {
        const accounts = this.db
            .prepare('SELECT * FROM account_runs WHERE run_key = ? ORDER BY account_label')
            .all(run.run_key)
            .map(account => ({
                id: account.account_key,
                label: account.account_label,
                initialPoints: numberOrNull(account.initial_points),
                finalPoints: numberOrNull(account.final_points),
                collected: account.verification_json
                    ? JSON.parse(account.verification_json).collected
                    : Number(account.collected || 0),
                verification: account.verification_json ? 'tracked' : 'legacy',
                ...(account.verification_json ? JSON.parse(account.verification_json) : {}),
                success: account.success === null ? null : Boolean(account.success),
                error: account.error_summary,
                sources: JSON.parse(account.sources_json || '{}'),
                tasks: JSON.parse(account.tasks_json || '[]')
            }))
        return {
            id: run.run_key,
            startedAt: run.started_at,
            endedAt: run.ended_at,
            date: run.local_date,
            version: run.version,
            exit: { code: numberOrNull(run.exit_code), signal: run.exit_signal },
            collected: run.verification_json ? JSON.parse(run.verification_json).collected : Number(run.collected || 0),
            verification: run.verification_json ? 'tracked' : 'legacy',
            pendingVerification: run.verification_json ? JSON.parse(run.verification_json).pending : null,
            status: run.status,
            imported: Boolean(run.imported),
            accounts
        }
    }

    list(limit = 50) {
        const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 500))
        const rows = this.db.prepare('SELECT * FROM runs ORDER BY ended_at DESC LIMIT ?').all(safeLimit)
        return { runs: rows.map(row => this.toPublicRun(row)), count: rows.length, persistent: true }
    }

    normalizedTasks(tasks) {
        return normalizedTasks(tasks)
    }

    recordLog(log) {
        const receivedAt = typeof log?.receivedAt === 'string' ? log.receivedAt : new Date().toISOString()
        const runKey = safeIdentifier(log?.runId)
        const payload = {
            id: numberOrNull(log?.id),
            runId: runKey,
            receivedAt,
            ts: typeof log?.ts === 'string' ? sanitizeText(log.ts, 120) : null,
            level: ['debug', 'info', 'warn', 'error'].includes(log?.level) ? log.level : 'info',
            platformLabel: sanitizeText(log?.platformLabel ?? '系统', 40),
            titleLabel: sanitizeText(log?.titleLabel ?? '运行记录', 80),
            displayMessage: sanitizeText(log?.displayMessage ?? log?.message ?? '', 2000),
            message: sanitizeText(log?.message ?? '', 8000)
        }
        const eventKey = crypto
            .createHash('sha256')
            .update(`${runKey || ''}|${receivedAt}|${payload.id ?? ''}|${payload.titleLabel}|${payload.message}`)
            .digest('hex')
        this.db
            .prepare(
                'INSERT OR IGNORE INTO diagnostic_logs(event_key, run_key, received_at, level, payload_json) VALUES (?, ?, ?, ?, ?)'
            )
            .run(eventKey, runKey, receivedAt, payload.level, JSON.stringify(payload))
        this.logWrites++
        if (this.logWrites % 100 === 0) this.pruneLogs()
    }

    listLogs({ limit = 400, runId = null } = {}) {
        const safeLimit = Math.max(1, Math.min(Number(limit) || 400, 2000))
        const rows = runId
            ? this.db
                  .prepare(
                      'SELECT payload_json FROM diagnostic_logs WHERE run_key = ? ORDER BY received_at DESC LIMIT ?'
                  )
                  .all(String(runId), safeLimit)
            : this.db
                  .prepare('SELECT payload_json FROM diagnostic_logs ORDER BY received_at DESC LIMIT ?')
                  .all(safeLimit)
        return rows.map(row => JSON.parse(row.payload_json)).reverse()
    }

    pruneLogs() {
        const cutoff = new Date(Date.now() - this.logRetentionDays * 86400000).toISOString()
        this.db.prepare('DELETE FROM diagnostic_logs WHERE received_at < ?').run(cutoff)
        this.db
            .prepare(
                'DELETE FROM diagnostic_logs WHERE event_key IN (SELECT event_key FROM diagnostic_logs ORDER BY received_at DESC LIMIT -1 OFFSET ?)'
            )
            .run(this.logLimit)
    }

    summary(activeRunId = null) {
        const row = this.db
            .prepare(
                'SELECT COUNT(*) AS runs, COALESCE(SUM(collected), 0) AS collected, MAX(ended_at) AS last_run FROM runs'
            )
            .get()
        const today = localDate(new Date().toISOString())
        const todayRow = this.db
            .prepare('SELECT SUM(points) AS collected FROM point_events WHERE local_date = ?')
            .get(today)
        const pending = this.db
            .prepare('SELECT verification_json FROM runs WHERE local_date = ? AND run_key != ?')
            .all(today, activeRunId ?? '')
            .reduce(
                (sum, run) =>
                    sum + (run.verification_json ? Number(JSON.parse(run.verification_json).pending) || 0 : 0),
                0
            )
        const confirmed = this.db.prepare('SELECT SUM(points) AS points FROM point_events').get()
        return {
            runs: Number(row?.runs || 0),
            collected: numberOrNull(confirmed.points),
            pendingVerification: pending,
            todayCollected: numberOrNull(todayRow?.collected),
            today,
            lastRunAt: row?.last_run ?? null,
            durable: true
        }
    }

    calendar({ start, end, accountId } = {}) {
        const today = localDate(new Date().toISOString())
        const defaultStart = new Date(`${today}T00:00:00Z`)
        defaultStart.setUTCDate(defaultStart.getUTCDate() - 30)
        const safeStart = /^\d{4}-\d{2}-\d{2}$/.test(start || '') ? start : defaultStart.toISOString().slice(0, 10)
        const safeEnd = /^\d{4}-\d{2}-\d{2}$/.test(end || '') ? end : today
        if (safeStart > safeEnd) throw new Error('开始日期不能晚于结束日期')

        const params = [safeStart, safeEnd]
        let accountWhere = ''
        if (accountId) {
            accountWhere = ' AND ar.account_key = ?'
            params.push(String(accountId))
        }
        const rows = this.db
            .prepare(
                `
                SELECT r.local_date, r.run_key, r.status, r.started_at, r.ended_at,
                       ar.account_key, ar.account_label, ar.initial_points, ar.final_points,
                       ar.collected, ar.success, ar.error_summary, ar.sources_json, ar.verification_json
                FROM runs r JOIN account_runs ar ON ar.run_key = r.run_key
                WHERE r.local_date BETWEEN ? AND ?${accountWhere}
                ORDER BY r.local_date DESC, r.ended_at DESC
            `
            )
            .all(...params)

        const accountMap = new Map()
        const dayMap = new Map()
        for (const row of rows) {
            accountMap.set(row.account_key, { id: row.account_key, label: row.account_label })
            const day = dayMap.get(row.local_date) ?? {
                date: row.local_date,
                totalGained: 0,
                statuses: [],
                records: 0,
                sources: {}
            }
            // Legacy amounts remain in records, never in confirmed daily totals.
            day.statuses.push(row.status)
            day.records += 1
            dayMap.set(row.local_date, day)
        }
        const pointRows = this.db
            .prepare(
                'SELECT * FROM point_events WHERE local_date BETWEEN ? AND ?' +
                    (accountId ? ' AND account_key = ?' : '')
            )
            .all(...params)
        for (const point of pointRows) {
            const day = dayMap.get(point.local_date) ?? {
                date: point.local_date,
                totalGained: 0,
                statuses: [],
                records: 0,
                sources: {}
            }
            day.totalGained += point.points
            day.sources[point.source] = (day.sources[point.source] ?? 0) + point.points
            dayMap.set(point.local_date, day)
        }
        const days = [...dayMap.values()].map(day => ({
            date: day.date,
            totalGained: pointRows.some(point => point.local_date === day.date) ? day.totalGained : null,
            status: day.statuses.includes('failed')
                ? day.totalGained > 0
                    ? 'partial'
                    : 'failed'
                : day.statuses.includes('partial')
                  ? 'partial'
                  : 'completed',
            records: day.records,
            sources: day.sources
        }))
        return {
            accounts: [...accountMap.values()],
            range: { start: safeStart, end: safeEnd },
            summary: {
                totalPoints: pointRows.length ? sum(days.map(day => day.totalGained)) : null,
                completedDays: days.filter(day => day.totalGained !== null && day.status === 'completed').length,
                failedDays: days.filter(day => ['failed', 'partial'].includes(day.status)).length,
                highestPointDay: days.reduce(
                    (best, day) =>
                        day.totalGained !== null && (best.points === null || day.totalGained > best.points)
                            ? { date: day.date, points: day.totalGained }
                            : best,
                    { date: '', points: null }
                )
            },
            days,
            records: rows.map(row => ({
                runId: row.run_key,
                date: row.local_date,
                accountId: row.account_key,
                accountLabel: row.account_label,
                startedAt: row.started_at,
                endedAt: row.ended_at,
                beforePoints: numberOrNull(row.initial_points),
                afterPoints: numberOrNull(row.final_points),
                runGained: row.verification_json
                    ? JSON.parse(row.verification_json).collected
                    : Number(row.collected || 0),
                verification: row.verification_json ? 'tracked' : 'legacy',
                status: row.status,
                success: row.success === null ? null : Boolean(row.success),
                error: row.error_summary,
                sources: JSON.parse(row.sources_json || '{}')
            }))
        }
    }

    wasNotified(eventKey) {
        return Boolean(this.db.prepare('SELECT 1 FROM notifications WHERE event_key = ?').get(eventKey))
    }

    recordNotification(eventKey, eventType) {
        this.db
            .prepare('INSERT OR IGNORE INTO notifications(event_key, event_type, sent_at) VALUES (?, ?, ?)')
            .run(eventKey, eventType, new Date().toISOString())
    }

    importLegacy(data, { apply = false } = {}) {
        if (!data || data.version !== 1 || !Array.isArray(data.days)) throw new Error('旧积分历史格式无效')
        const candidates = []
        for (const day of data.days) {
            const runs = Array.isArray(day?.runs) && day.runs.length ? day.runs : [day]
            for (const run of runs) {
                const accountHash = String(run.accountHash ?? day.accountHash ?? '')
                const accountKey = `legacy-${crypto.createHash('sha256').update(accountHash).digest('hex')}`
                const startedAt = run.startedAt || `${day.date}T00:00:00.000Z`
                const endedAt = run.finishedAt || day.updatedAt || startedAt
                const runKey = `legacy-${crypto
                    .createHash('sha256')
                    .update(`${run.id || ''}|${day.date}|${accountHash}|${startedAt}`)
                    .digest('hex')}`
                candidates.push({
                    runKey,
                    accountKey,
                    accountLabel: sanitizeText(run.accountLabel ?? day.accountLabel ?? '历史账号', 100),
                    startedAt,
                    endedAt,
                    date: /^\d{4}-\d{2}-\d{2}$/.test(day.date || '') ? day.date : localDate(endedAt),
                    initialPoints: numberOrNull(run.beforePoints ?? day.beforePoints),
                    finalPoints: numberOrNull(run.afterPoints ?? day.afterPoints),
                    collected: Math.max(0, numberOrNull(run.runGained ?? day.runGained ?? day.todayGained) ?? 0),
                    status: ['completed', 'partial', 'failed', 'skipped'].includes(run.status) ? run.status : 'partial',
                    error: run.error ? sanitizeText(run.error, 800) : null,
                    sources:
                        typeof run.categories === 'object' && run.categories ? run.categories : day.categories || {}
                })
            }
        }
        const existing = candidates.filter(item =>
            this.db.prepare('SELECT 1 FROM runs WHERE run_key = ?').get(item.runKey)
        )
        if (!apply) return { valid: true, candidates: candidates.length, existing: existing.length, inserted: 0 }

        const insertRun = this.db.prepare(`
            INSERT OR IGNORE INTO runs
            (run_key, started_at, ended_at, local_date, version, exit_code, exit_signal, collected, status, imported, created_at)
            VALUES (?, ?, ?, ?, 'legacy-v3', NULL, NULL, ?, ?, 1, ?)
        `)
        const insertAccount = this.db.prepare(`
            INSERT OR IGNORE INTO account_runs
            (run_key, account_key, account_label, initial_points, final_points, collected, success, error_summary, sources_json, tasks_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        let inserted = 0
        this.db.exec('BEGIN IMMEDIATE')
        try {
            for (const item of candidates) {
                const result = insertRun.run(
                    item.runKey,
                    item.startedAt,
                    item.endedAt,
                    item.date,
                    item.collected,
                    item.status,
                    new Date().toISOString()
                )
                if (Number(result.changes) === 0) continue
                inserted++
                insertAccount.run(
                    item.runKey,
                    item.accountKey,
                    item.accountLabel,
                    item.initialPoints,
                    item.finalPoints,
                    item.collected,
                    item.status === 'completed' ? 1 : item.status === 'failed' ? 0 : null,
                    item.error,
                    JSON.stringify(item.sources),
                    '[]'
                )
            }
            this.db.exec('COMMIT')
        } catch (error) {
            this.db.exec('ROLLBACK')
            throw error
        }
        return { valid: true, candidates: candidates.length, existing: existing.length, inserted }
    }
}
