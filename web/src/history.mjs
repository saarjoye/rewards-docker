import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { sanitizeText } from './security.mjs'
import { normalizedTasks } from './task-view.mjs'
import { reconcileAccountDay, reconcileDailyPoints } from './point-reconciliation.mjs'

const TIMEZONE = 'Asia/Shanghai'

function numberOrNull(value) {
    if (value === null || value === undefined || value === '') return null
    const number = Number(value)
    return Number.isFinite(number) ? number : null
}

function localDate(iso) {
    const date = new Date(iso)
    if (Number.isNaN(date.getTime())) return localDate(new Date().toISOString())
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
    if (run?.exit?.signal) return 'interrupted'
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
    const known = values.map(numberOrNull).filter(value => value !== null)
    return known.length ? known.reduce((total, value) => total + value, 0) : null
}

function dateRange(start, end) {
    const result = []
    const cursor = new Date(`${start}T00:00:00Z`)
    const last = new Date(`${end}T00:00:00Z`)
    while (cursor <= last) {
        result.push(cursor.toISOString().slice(0, 10))
        cursor.setUTCDate(cursor.getUTCDate() + 1)
    }
    return result
}

function accountGain(account) {
    return numberOrNull(account?.collectedPoints)
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
            const eventColumns = this.db.prepare('PRAGMA table_info(point_events)').all()
            if (!eventColumns.some(column => column.name === 'evidence_json'))
                this.db.exec('ALTER TABLE point_events ADD COLUMN evidence_json TEXT')
            this.db.exec(`CREATE TABLE IF NOT EXISTS balance_snapshots (
                snapshot_id TEXT PRIMARY KEY, account_key TEXT NOT NULL, run_key TEXT NOT NULL,
                balance REAL NOT NULL, observed_at TEXT NOT NULL, business_date TEXT NOT NULL,
                source TEXT NOT NULL, reliability TEXT NOT NULL, phase TEXT NOT NULL
            ); CREATE INDEX IF NOT EXISTS idx_balance_snapshots_day ON balance_snapshots(account_key, business_date);`)
            this.db.exec('COMMIT')
        } catch (error) {
            this.db.exec('ROLLBACK')
            throw error
        }
    }

    ingestPoints(runKey, accounts) {
        if (!safeIdentifier(runKey)) return
        const insert = this.db.prepare('INSERT OR IGNORE INTO point_events (event_key, run_key, account_key, points, confirmed_at, local_date, source, evidence_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        for (const account of accounts ?? []) {
            if (account.telemetryVersion !== 2) continue
            const accountKey = this.identity.keyFor(account.email ?? 'unknown')
            for (const phase of ['start', 'end', 'live']) {
                const balance = numberOrNull(phase === 'start' ? account.initialPoints : phase === 'end' ? account.finalPoints : account.live?.balance)
                const observedAt = phase === 'start' ? account.initialObservedAt : phase === 'end' ? account.finalObservedAt : account.balanceObservedAt
                if (balance === null || balance < 0 || !observedAt || !Number.isFinite(Date.parse(observedAt))) continue
                const snapshotId = crypto.createHash('sha256').update(`${accountKey}|${runKey}|${phase}|${observedAt}`).digest('hex')
                this.db.prepare('INSERT OR IGNORE INTO balance_snapshots VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
                    .run(snapshotId, accountKey, runKey, balance, observedAt, localDate(observedAt), 'core-balance', 'reliable', phase)
            }
            for (const record of account.pointRecords ?? []) {
                if (
                    !safeIdentifier(record.id) ||
                    typeof record.points !== 'number' ||
                    !Number.isFinite(record.points) ||
                    record.points < 0 ||
                    !Number.isFinite(Date.parse(record.confirmedAt))
                )
                    continue
                const creditKey = safeIdentifier(record.creditKey)
                const evidence = {
                    creditKey, identityStable: Boolean(creditKey && record.identityStable === true),
                    verificationStatus: ['confirmed', 'confirmed-zero'].includes(record.verificationStatus) ? record.verificationStatus : 'unverified',
                    evidenceSource: ['official-credit', 'official-progress', 'isolated-balance'].includes(record.evidenceSource) ? record.evidenceSource : null,
                    legacyUnverified: !creditKey,
                    taskId: sanitizeText(record.taskId, 180)
                }
                const key = crypto.createHash('sha256').update(creditKey ? `${accountKey}|${creditKey}` : `${runKey}|${accountKey}|${record.id}`).digest('hex')
                insert.run(
                    key,
                    runKey,
                    accountKey,
                    record.points,
                    record.confirmedAt,
                    localDate(record.confirmedAt),
                    sanitizeText(record.source, 40),
                    JSON.stringify(evidence)
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
        if (status) this.liveStatus = status
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
            INSERT INTO account_runs
            (run_key, account_key, account_label, initial_points, final_points, collected, success, error_summary, sources_json, tasks_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(run_key, account_key) DO UPDATE SET
                account_label = excluded.account_label,
                initial_points = COALESCE(excluded.initial_points, account_runs.initial_points),
                final_points = COALESCE(excluded.final_points, account_runs.final_points),
                collected = CASE
                    WHEN excluded.collected > 0 OR account_runs.collected = 0 THEN excluded.collected
                    ELSE account_runs.collected
                END,
                success = COALESCE(excluded.success, account_runs.success),
                error_summary = COALESCE(excluded.error_summary, account_runs.error_summary),
                sources_json = CASE WHEN excluded.sources_json <> '{}' THEN excluded.sources_json ELSE account_runs.sources_json END,
                tasks_json = CASE WHEN excluded.tasks_json <> '[]' THEN excluded.tasks_json ELSE account_runs.tasks_json END
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
                        numberOrNull(enhanced.finalPoints),
                        Math.max(
                            0,
                            accountGain(account) ?? numberOrNull(account.collected) ?? accountGain(enhanced) ?? 0
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
                                    version: 3,
                                    collected: null,
                                    confirmedPoints: null,
                                    pending: enhanced.pendingVerification ?? 0,
                                    status: enhanced.status ?? 'unknown',
                                    balanceChange: numberOrNull(enhanced.balanceChange),
                                    unattributedBalanceChange: null
                                }),
                                runKey,
                                this.identity.keyFor(email || 'unknown')
                            )
                    }
                }
                if (accounts.some(account => account.telemetryVersion === 2)) {
                    this.db.prepare('UPDATE runs SET verification_json = ?, status = ? WHERE run_key = ?').run(
                        JSON.stringify({
                            version: 3,
                            collected: null,
                            confirmedPoints: null,
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

    reconciliationRows(accountId = null) {
        const rows = this.db
            .prepare(
                `SELECT r.run_key, r.started_at, r.ended_at,
                        ar.account_key, ar.account_label, ar.initial_points, ar.final_points,
                        ar.tasks_json, ar.verification_json, r.status
                 FROM runs r JOIN account_runs ar ON ar.run_key = r.run_key
                 ${accountId ? 'WHERE ar.account_key = ?' : ''}
                 ORDER BY ar.account_key, r.started_at, r.ended_at`
            )
            .all(...(accountId ? [accountId] : []))
        return rows.map(row => {
            let verification = {}
            try {
                verification = row.verification_json ? JSON.parse(row.verification_json) : {}
            } catch {}
            return {
                runKey: row.run_key,
                durable: true,
                status: row.status,
                accountKey: row.account_key,
                accountLabel: row.account_label,
                startedAt: row.started_at,
                endedAt: row.ended_at,
                initialPoints: numberOrNull(row.initial_points),
                finalPoints: numberOrNull(row.final_points),
                finalSource: verification.balanceReconciliation?.lastSource ?? null,
                legacyUnverified: verification.version !== 3,
                tasks: JSON.parse(row.tasks_json || '[]')
            }
        })
    }

    reconciliation(date, accountId = null, currentRunId = null) {
        const rows = this.reconciliationRows(accountId)
        const live = this.liveStatus
        for (const account of live?.runId ? live.run?.accounts ?? [] : []) {
            const key = this.identity.keyFor(account.email ?? 'unknown')
            if (accountId && key !== accountId) continue
            if (rows.some(row => row.runKey === live.runId && row.accountKey === key)) continue
            rows.push({ runKey: live.runId, accountKey: key, accountLabel: this.identity.labelFor(account.email ?? ''),
                startedAt: live.startedAt, endedAt: null, tasks: account.tasks ?? [],
                status: account.status === 'interrupted' ? 'interrupted' : account.finalObservedAt ? 'completed-pending-persist' : ['starting', 'running', 'stopping'].includes(live.state) ? live.state : 'pending' })
        }
        const snapshots = this.db.prepare('SELECT * FROM balance_snapshots WHERE business_date = ? ORDER BY observed_at').all(date)
        for (const snapshot of snapshots) {
            if (accountId && snapshot.account_key !== accountId) continue
            let row = rows.find(item => item.runKey === snapshot.run_key && item.accountKey === snapshot.account_key)
            if (!row) {
                row = { runKey: snapshot.run_key, accountKey: snapshot.account_key, startedAt: snapshot.observed_at, endedAt: snapshot.observed_at, tasks: [] }
                rows.push(row)
            }
            if (snapshot.reliability !== 'reliable') continue
            if (snapshot.phase === 'start' && !row.initialObservedAt) {
                row.initialPoints = snapshot.balance
                row.initialObservedAt = snapshot.observed_at
            }
            if (snapshot.phase === 'end') {
                row.finalPoints = snapshot.balance
                row.finalObservedAt = snapshot.observed_at
            }
            if (snapshot.phase === 'live') {
                row.liveBalance = snapshot.balance
                row.liveObservedAt = snapshot.observed_at
            }
        }
        const events = this.db.prepare('SELECT * FROM point_events').all().map(event => ({
            ...(event.evidence_json ? JSON.parse(event.evidence_json) : { legacyUnverified: true }),
            eventKey: event.event_key,
            runKey: event.run_key,
            accountKey: event.account_key,
            points: event.points,
            confirmedAt: event.confirmed_at,
            localDate: event.local_date,
            source: event.source
        }))
        const tasks = rows.flatMap(row =>
            (Array.isArray(row.tasks) ? row.tasks : []).map(task => ({ ...task, runKey: row.runKey, accountKey: row.accountKey }))
        )
        const relevantKeys = new Set(
            rows
                .filter(row => [row.startedAt, row.endedAt, row.initialObservedAt, row.finalObservedAt, row.liveObservedAt].some(at => at && localDate(at) === date))
                .map(row => row.accountKey)
        )
        for (const event of events) {
            if (localDate(event.confirmedAt) === date) relevantKeys.add(event.accountKey)
        }
        const dailyRows = rows.filter(row => relevantKeys.has(row.accountKey))
        const rowAccounts = new Set(dailyRows.map(row => `${row.accountKey}:${row.runKey}`))
        for (const event of events) {
            if (localDate(event.confirmedAt) !== date || rowAccounts.has(`${event.accountKey}:${event.runKey}`)) continue
            dailyRows.push({
                runKey: event.runKey,
                accountKey: event.accountKey,
                accountLabel: '历史账号',
                startedAt: event.confirmedAt,
                endedAt: event.confirmedAt,
                initialPoints: null,
                finalPoints: null,
                tasks: []
            })
            rowAccounts.add(`${event.accountKey}:${event.runKey}`)
        }
        if (accountId) return reconcileAccountDay({ date, accountKey: accountId, runs: dailyRows, pointEvents: events, tasks, currentRunId })
        return reconcileDailyPoints({ date, runs: dailyRows, pointEvents: events, tasks, currentRunId })
    }

    runReconciliation(runKey, accountKey, date) {
        const daily = this.reconciliation(date, accountKey)
        return daily.runs?.find(run => run.runKey === runKey) ?? {
            runGained: null,
            confirmedPoints: 0,
            unattributedPoints: null,
            pendingPoints: null,
            pendingTaskCount: 0,
            balanceDelta: null,
            balanceReconciliation: {
                firstBalance: null,
                lastBalance: null,
                firstObservedAt: null,
                lastObservedAt: null,
                firstSource: null,
                lastSource: null,
                provisional: false,
                status: 'unavailable'
            }
        }
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
            .map(account => {
                let verification = {}
                try {
                    verification = account.verification_json ? JSON.parse(account.verification_json) : {}
                } catch {}
                const reconciliation = this.runReconciliation(run.run_key, account.account_key, run.local_date)
                return {
                    id: account.account_key,
                    label: account.account_label,
                    initialPoints: numberOrNull(account.initial_points),
                    finalPoints: numberOrNull(account.final_points),
                    verification: account.verification_json ? 'tracked' : 'legacy',
                    ...verification,
                    ...reconciliation,
                    collected: account.verification_json ? reconciliation.confirmedPoints : null,
                    legacyCollected: numberOrNull(account.collected),
                    confirmedPoints: account.verification_json ? reconciliation.confirmedPoints : null,
                    success: account.success === null ? null : Boolean(account.success),
                    error: account.error_summary,
                    sources: JSON.parse(account.sources_json || '{}'),
                    tasks: this.normalizedTasks(JSON.parse(account.tasks_json || '[]'))
                }
            })
        const runConfirmed = accounts.reduce(
            (total, account) => total + (numberOrNull(account.confirmedPoints) ?? 0),
            0
        )
        const runPending = accounts.reduce(
            (total, account) => total + (numberOrNull(account.pendingTaskCount) ?? 0),
            0
        )
        const runCollected = !accounts.length || accounts.some(account => account.confirmedPoints === null) ? null : runConfirmed
        const runGains = accounts.map(account => numberOrNull(account.runGained))
        const runUnattributed = accounts
            .map(account => numberOrNull(account.unattributedPoints))
            .filter(value => value !== null)
        const pendingPoints = accounts.map(account => numberOrNull(account.pendingPoints)).filter(value => value !== null)
        return {
            id: run.run_key,
            startedAt: run.started_at,
            endedAt: run.ended_at,
            date: run.local_date,
            version: run.version,
            exit: { code: numberOrNull(run.exit_code), signal: run.exit_signal },
            collected: runCollected,
            legacyCollected: numberOrNull(run.collected),
            runGained: runGains.length && runGains.every(value => value !== null) ? sum(runGains) : null,
            runBalanceDelta: runGains.length && runGains.every(value => value !== null) ? sum(runGains) : null,
            unattributedPoints: runUnattributed.length ? sum(runUnattributed) : null,
            pendingPoints: pendingPoints.length ? sum(pendingPoints) : null,
            verification: run.verification_json ? 'tracked' : 'legacy',
            confirmedPoints: runCollected,
            pendingVerification: run.verification_json ? JSON.parse(run.verification_json).pending : runPending,
            pendingTaskCount: runPending,
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
        return normalizedTasks(tasks).map(task => {
            if (['confirmed', 'confirmed-zero'].includes(task.verification) &&
                !['official-progress', 'official-credit', 'isolated-balance'].includes(task.evidenceSource))
                return { ...task, reportedPoints: task.earnedPoints, earnedPoints: null, verification: 'legacy' }
            return task
        })
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

    summary(currentRunId = null) {
        const row = this.db
            .prepare(
                'SELECT COUNT(*) AS runs, COALESCE(SUM(collected), 0) AS collected, MAX(ended_at) AS last_run FROM runs'
            )
            .get()
        const today = localDate(new Date().toISOString())
        const todayReconciliation = this.reconciliation(today, null, currentRunId)
        const pending = todayReconciliation.pendingTaskCount
        return {
            ...todayReconciliation,
            runs: Number(row?.runs || 0),
            collected: todayReconciliation.confirmedPoints,
            pendingVerification: pending,
            pendingTaskCount: pending,
            pendingPoints: todayReconciliation.pendingPoints,
            confirmedPoints: todayReconciliation.confirmedPoints,
            unattributedPoints: todayReconciliation.unattributedPoints,
            todayGained: todayReconciliation.todayGained,
            todayCollected: todayReconciliation.todayGained,
            balanceReconciliation: todayReconciliation.accounts,
            today,
            lastRunAt: row?.last_run ?? null,
            durable: !todayReconciliation.accounts.some(account => account.runs.some(run => run.persistence === 'provisional'))
        }
    }

    calendar({ start, end, accountId } = {}) {
        const today = localDate(new Date().toISOString())
        const defaultStart = new Date(`${today}T00:00:00Z`)
        defaultStart.setUTCDate(defaultStart.getUTCDate() - 30)
        const safeStart = /^\d{4}-\d{2}-\d{2}$/.test(start || '') ? start : localDate(defaultStart.toISOString())
        const safeEnd = /^\d{4}-\d{2}-\d{2}$/.test(end || '') ? end : today
        if (safeStart > safeEnd) throw new Error('开始日期不能晚于结束日期')

        const rows = this.db
            .prepare(
                `
                SELECT r.local_date, r.run_key, r.status, r.started_at, r.ended_at,
                       ar.account_key, ar.account_label, ar.initial_points, ar.final_points,
                       ar.collected, ar.success, ar.error_summary, ar.sources_json, ar.tasks_json, ar.verification_json
                FROM runs r JOIN account_runs ar ON ar.run_key = r.run_key
                ORDER BY r.ended_at DESC
            `
            )
            .all()
            .filter(row => {
                if (accountId && row.account_key !== String(accountId)) return false
                const started = localDate(row.started_at)
                const ended = localDate(row.ended_at)
                return ended >= safeStart && started <= safeEnd
            })

        const accountMap = new Map()
        const dayMap = new Map()
        for (const account of this.liveStatus?.run?.accounts ?? []) {
            const key = this.identity.keyFor(account.email ?? 'unknown')
            if (!accountId || key === accountId) accountMap.set(key, { id: key, label: this.identity.labelFor(account.email ?? '') })
        }
        const pointRows = this.db.prepare('SELECT * FROM point_events').all()
        for (const row of rows) accountMap.set(row.account_key, { id: row.account_key, label: row.account_label })
        for (const date of dateRange(safeStart, safeEnd)) {
            const dayRows = rows.filter(row => localDate(row.started_at) === date || localDate(row.ended_at) === date)
            const reconciliation = this.reconciliation(date, accountId)
            const reconciledAccounts = reconciliation.accounts ?? [reconciliation]
            if (!dayRows.length && !reconciledAccounts.some(account => account.reportedTaskPoints !== null || account.runs?.length)) continue
            const statuses = dayRows.map(row => row.status)
            const sources = {}
            for (const point of pointRows) {
                if (point.source === 'account-balance' || point.local_date !== date) continue
                if (accountId && point.account_key !== String(accountId)) continue
                const evidence = point.evidence_json ? JSON.parse(point.evidence_json) : {}
                if (!evidence.identityStable || evidence.verificationStatus !== 'confirmed' || !evidence.evidenceSource) continue
                sources[point.source] = (sources[point.source] ?? 0) + point.points
            }
            dayMap.set(date, {
                date,
                ...reconciliation,
                totalGained: reconciliation.todayGained,
                confirmedPoints: reconciliation.confirmedPoints,
                unattributedPoints: reconciliation.unattributedPoints,
                pendingPoints: reconciliation.pendingPoints,
                pendingTaskCount: reconciliation.pendingTaskCount,
                balanceReconciliation: reconciledAccounts,
                status: statuses.includes('interrupted')
                    ? 'interrupted'
                    : statuses.includes('failed')
                      ? reconciliation.todayGained !== null
                          ? 'partial'
                          : 'failed'
                      : statuses.includes('partial')
                        ? 'partial'
                        : statuses.length && statuses.every(status => status === 'completed')
                          ? 'completed'
                          : 'partial',
                records: reconciledAccounts.reduce((count, account) => count + (account.runs?.length ?? 0), 0),
                sources
            })
        }
        const days = [...dayMap.values()]
        const transientRecords = []
        for (const day of days) {
            for (const account of day.balanceReconciliation) {
                if (!accountMap.has(account.accountKey)) accountMap.set(account.accountKey, { id: account.accountKey, label: '历史账号' })
                for (const run of account.runs ?? []) {
                    if (rows.some(row => row.run_key === run.runKey && row.account_key === account.accountKey)) continue
                    transientRecords.push({ ...run, date: day.date, runId: run.runKey, accountId: account.accountKey,
                        accountLabel: accountMap.get(account.accountKey).label, persistence: 'provisional',
                        beforePoints: run.balanceReconciliation.firstBalance, afterPoints: run.balanceReconciliation.lastBalance,
                        startedAt: run.balanceReconciliation.firstObservedAt, endedAt: run.status === 'completed-pending-persist' ? run.observedAt : null, tasks: [], sources: {} })
                }
            }
            const statuses = day.balanceReconciliation.flatMap(account => account.runs ?? []).map(run => run.status)
            if (statuses.some(status => ['starting', 'running', 'stopping'].includes(status))) day.status = 'running'
            else if (statuses.includes('completed-pending-persist')) day.status = 'completed-pending-persist'
            else if (statuses.includes('pending')) day.status = 'pending'
        }
        return {
            accounts: [...accountMap.values()],
            range: { start: safeStart, end: safeEnd },
            summary: {
                totalPoints: days.some(day => day.totalGained !== null)
                    ? sum(days.map(day => day.totalGained))
                    : null,
                confirmedPoints: sum(days.map(day => day.confirmedPoints)),
                unattributedPoints: sum(days.map(day => day.unattributedPoints)),
                pendingPoints: sum(days.map(day => day.pendingPoints)),
                completedDays: days.filter(day => day.totalGained !== null && day.status === 'completed').length,
                failedDays: days.filter(day => ['failed', 'partial', 'interrupted'].includes(day.status)).length,
                highestPointDay: days.reduce(
                    (best, day) =>
                        day.totalGained !== null && (best.points === null || day.totalGained > best.points)
                            ? { date: day.date, points: day.totalGained }
                            : best,
                    { date: '', points: null }
                )
            },
            days,
            records: [...transientRecords, ...rows.map(row => {
                let verification = {}
                try {
                    verification = row.verification_json ? JSON.parse(row.verification_json) : {}
                } catch {}
                const reconciliation = this.runReconciliation(row.run_key, row.account_key, row.local_date)
                return {
                    ...verification,
                    ...reconciliation,
                    collected: reconciliation.confirmedPoints,
                    runId: row.run_key,
                    date: row.local_date,
                    accountId: row.account_key,
                    accountLabel: row.account_label,
                    startedAt: row.started_at,
                    endedAt: row.ended_at,
                    beforePoints: numberOrNull(row.initial_points),
                    afterPoints: numberOrNull(row.final_points),
                    runGained: reconciliation.runGained,
                    confirmedPoints: reconciliation.confirmedPoints,
                    unattributedPoints: reconciliation.unattributedPoints,
                    pendingPoints: reconciliation.pendingPoints,
                    pendingTaskCount: reconciliation.pendingTaskCount,
                    balanceDelta: reconciliation.balanceDelta,
                    balanceReconciliation: reconciliation.balanceReconciliation,
                    verification: row.verification_json || reconciliation.runGained !== null ? 'tracked' : 'legacy',
                    legacyUnverified: !row.verification_json,
                    status: row.status,
                    success: row.success === null ? null : Boolean(row.success),
                    error: row.error_summary,
                    sources: JSON.parse(row.sources_json || '{}'),
                    tasks: this.normalizedTasks(JSON.parse(row.tasks_json || '[]')),
                    legacyCollected: numberOrNull(row.collected)
                }
            })]
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
