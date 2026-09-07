import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'

const CRON_FIELD_RANGES = [
    { min: 0, max: 59 }, // minute
    { min: 0, max: 23 }, // hour
    { min: 1, max: 31 }, // day of month
    { min: 1, max: 12 }, // month
    { min: 0, max: 7 } // day of week (7 == Sunday)
]

function validateField(expr, { min, max }) {
    if (expr === '*') return true
    for (const part of expr.split(',')) {
        if (!/^(?:\*|\d+|\d+-\d+)(?:\/\d+)?$/.test(part)) return false

        const stepSplit = part.split('/')
        if (stepSplit.length > 2) return false

        const step = stepSplit.length === 2 ? Number(stepSplit[1]) : 1
        if (!Number.isInteger(step) || step < 1) return false

        const range = stepSplit[0]
        let lo
        let hi
        if (range === '*') {
            lo = min
            hi = max
        } else if (range.includes('-')) {
            const [a, b] = range.split('-')
            lo = Number(a)
            hi = Number(b)
        } else {
            lo = Number(range)
            hi = Number(range)
        }
        if (!Number.isInteger(lo) || !Number.isInteger(hi)) return false
        if (lo < min || hi > max || lo > hi) return false
    }
    return true
}

export function isValidCron(expr) {
    if (typeof expr !== 'string') return false
    const parts = expr.trim().split(/\s+/)
    if (parts.length !== 5) return false
    return parts.every((part, i) => validateField(part, CRON_FIELD_RANGES[i]))
}

export function scheduleFilePath(projectRoot) {
    return (
        process.env.SCHEDULE_FILE ||
        path.join(
            process.env.CONFIG_FILE
                ? path.dirname(path.resolve(projectRoot, process.env.CONFIG_FILE))
                : path.join(projectRoot, 'dist', 'config'),
            'schedule.json'
        )
    )
}

export function readSchedule(projectRoot) {
    const file = scheduleFilePath(projectRoot)
    if (fs.existsSync(file)) {
        let saved
        try {
            saved = JSON.parse(fs.readFileSync(file, 'utf8'))
        } catch (err) {
            throw Object.assign(new Error(`schedule.json is corrupt: ${err.message}`), { code: 'CORRUPT_SCHEDULE' })
        }
        const cron = saved.cron ?? saved.schedule ?? null
        const enabled = saved.enabled === undefined ? Boolean(cron) : saved.enabled
        const skipIfRunning = saved.skipIfRunning === undefined ? true : saved.skipIfRunning
        const excludedAccountIndexes = saved.excludedAccountIndexes ?? []

        if (typeof enabled !== 'boolean') {
            throw Object.assign(new Error('schedule.json has a non-boolean `enabled` value.'), {
                code: 'CORRUPT_SCHEDULE'
            })
        }
        if (cron !== null && (typeof cron !== 'string' || !isValidCron(cron))) {
            throw Object.assign(new Error('schedule.json has an invalid `cron` expression.'), {
                code: 'CORRUPT_SCHEDULE'
            })
        }
        if (typeof skipIfRunning !== 'boolean') {
            throw Object.assign(new Error('schedule.json has a non-boolean `skipIfRunning` value.'), {
                code: 'CORRUPT_SCHEDULE'
            })
        }
        if (
            !Array.isArray(excludedAccountIndexes) ||
            excludedAccountIndexes.some(index => !Number.isSafeInteger(index) || index < 1)
        ) {
            throw Object.assign(new Error('schedule.json has invalid `excludedAccountIndexes`.'), {
                code: 'CORRUPT_SCHEDULE'
            })
        }
        if (enabled && !cron) {
            throw Object.assign(new Error('schedule.json enables scheduling without a cron expression.'), {
                code: 'CORRUPT_SCHEDULE'
            })
        }

        return {
            enabled,
            cron: cron?.trim() ?? null,
            skipIfRunning,
            excludedAccountIndexes: [...new Set(excludedAccountIndexes)].sort((a, b) => a - b),
            updatedAt: saved.updatedAt || null,
            timezone: 'Asia/Shanghai',
            source: 'override'
        }
    }
    return {
        enabled: Boolean(process.env.CRON_SCHEDULE),
        cron: process.env.CRON_SCHEDULE || null,
        skipIfRunning: true,
        excludedAccountIndexes: [],
        updatedAt: null,
        timezone: 'Asia/Shanghai',
        source: 'env'
    }
}

export function writeSchedule(projectRoot, patch, { apply = applyCrontab } = {}) {
    const current = readSchedule(projectRoot)
    const next = { ...current }
    if (
        Object.keys(patch).some(
            key => !['cron', 'enabled', 'skipIfRunning', 'excludedAccountIndexes', 'timezone'].includes(key)
        )
    )
        throw Object.assign(new Error('未知调度字段'), { code: 'BAD_REQUEST' })
    if ('timezone' in patch && patch.timezone !== 'Asia/Shanghai')
        throw Object.assign(new Error('时区必须为 Asia/Shanghai'), { code: 'BAD_REQUEST' })

    if ('cron' in patch) {
        if (typeof patch.cron !== 'string' || !isValidCron(patch.cron)) {
            throw Object.assign(new Error('Invalid cron expression (5 fields, e.g. "0 9 * * *").'), {
                code: 'BAD_REQUEST'
            })
        }
        next.cron = patch.cron.trim()
    }
    if ('enabled' in patch) {
        if (typeof patch.enabled !== 'boolean') {
            throw Object.assign(new Error('enabled must be a boolean.'), { code: 'BAD_REQUEST' })
        }
        next.enabled = patch.enabled
    }
    if ('skipIfRunning' in patch) {
        if (typeof patch.skipIfRunning !== 'boolean') {
            throw Object.assign(new Error('skipIfRunning must be a boolean.'), { code: 'BAD_REQUEST' })
        }
        next.skipIfRunning = patch.skipIfRunning
    }
    if ('excludedAccountIndexes' in patch) {
        if (!Array.isArray(patch.excludedAccountIndexes)) {
            throw Object.assign(new Error('excludedAccountIndexes must be an array.'), { code: 'BAD_REQUEST' })
        }
        const indexes = [...new Set(patch.excludedAccountIndexes.map(Number))]
        if (indexes.some(i => !Number.isSafeInteger(i) || i < 1)) {
            throw Object.assign(new Error('excludedAccountIndexes must contain only positive integers.'), {
                code: 'BAD_REQUEST'
            })
        }
        next.excludedAccountIndexes = indexes.sort((a, b) => a - b)
    }
    if (next.enabled && !next.cron) {
        throw Object.assign(new Error('Cannot enable the schedule without a cron expression.'), { code: 'BAD_REQUEST' })
    }

    next.updatedAt = new Date().toISOString()
    next.timezone = 'Asia/Shanghai'
    delete next.source

    const file = scheduleFilePath(projectRoot)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const previous = fs.existsSync(file) ? fs.readFileSync(file) : null
    const tmp = `${file}.${crypto.randomUUID()}.tmp`
    try {
        fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600, flag: 'wx' })
        apply(next)
        fs.renameSync(tmp, file)
    } catch {
        try {
            apply(current)
        } catch {
            throw Object.assign(new Error('调度应用及恢复失败，请检查容器调度器'), { code: 'SCHEDULE_ROLLBACK_FAILED' })
        }
        // The persistent configuration has not been replaced until application succeeds.
        if (previous && !fs.existsSync(file)) fs.writeFileSync(file, previous, { mode: 0o600 })
        throw Object.assign(new Error('调度未保存，已恢复原调度'), { code: 'SCHEDULE_APPLY_FAILED' })
    } finally {
        if (fs.existsSync(tmp)) fs.unlinkSync(tmp)
    }

    return { ...next, source: 'override' }
}

const CRON_FILE = '/etc/cron.d/microsoft-rewards-cron'
const CRON_TEMPLATE = '/etc/cron.d/microsoft-rewards-cron.template'

export function applyCrontab({ enabled, cron }) {
    if (enabled && !isValidCron(cron)) throw Object.assign(new Error('调度表达式无效，未应用'), { code: 'BAD_REQUEST' })
    // Retire only this application's legacy user-crontab entry, preserving other jobs.
    let legacy = ''
    try {
        legacy = execFileSync('crontab', ['-l'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    } catch {}
    const filtered = legacy
        .split('\n')
        .filter(line => !line.includes('/usr/src/microsoft-rewards-script/scripts/docker/run_daily.sh'))
        .join('\n')
    if (filtered !== legacy) execFileSync('crontab', ['-'], { input: filtered, stdio: ['pipe', 'ignore', 'ignore'] })
    if (!enabled || !cron) {
        try {
            fs.unlinkSync(CRON_FILE)
        } catch (error) {
            if (error.code !== 'ENOENT') throw error
        }
        return
    }

    if (!fs.existsSync(CRON_TEMPLATE)) {
        throw Object.assign(new Error(`Cron template not found at ${CRON_TEMPLATE} - image may be corrupt.`), {
            code: 'TEMPLATE_MISSING'
        })
    }

    const tz = 'Asia/Shanghai'
    const rendered = fs
        .readFileSync(CRON_TEMPLATE, 'utf8')
        .replace(/\$\{CRON_SCHEDULE\}/g, cron)
        .replace(/\$\{TZ\}/g, tz)

    fs.writeFileSync(CRON_FILE + '.tmp', rendered, { mode: 0o644 })
    fs.renameSync(CRON_FILE + '.tmp', CRON_FILE)
}
