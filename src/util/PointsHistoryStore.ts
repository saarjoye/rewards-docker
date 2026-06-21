import crypto from 'crypto'
import fs from 'fs'
import path from 'path'

import { accountProgressHash } from './TaskProgressStore'

export type PointCategoryKey =
    | 'pcSearch'
    | 'mobileSearch'
    | 'dailyActivity'
    | 'appActivity'
    | 'checkIn'
    | 'readToEarn'
    | 'bonus'
    | 'streak'
    | 'other'

export type PointRunStatus = 'completed' | 'partial' | 'failed' | 'skipped' | 'notRun'
export type PointsRangePreset = 'week' | 'month' | 'quarter' | 'year' | 'custom'

export type PointCategoryTotals = Record<PointCategoryKey, number>

export interface PointTaskSummaryLike {
    label: string
    key?: string
    gained: number
    status?: string
}

export interface PointRunRecord {
    id: string
    date: string
    accountHash: string
    accountLabel: string
    source: string
    pid: number
    startedAt: string
    finishedAt: string
    beforePoints: number
    afterPoints: number
    runGained: number
    todayGained: number
    categories: PointCategoryTotals
    status: PointRunStatus
    taskSummary: PointTaskSummaryLike[]
    error?: string
}

export interface PointDayRecord {
    date: string
    accountHash: string
    accountLabel: string
    beforePoints: number
    afterPoints: number
    todayGained: number
    runGained: number
    categories: PointCategoryTotals
    status: PointRunStatus
    updatedAt: string
    runs: PointRunRecord[]
}

export interface PointsHistoryFile {
    version: 1
    updatedAt: string
    days: PointDayRecord[]
}

export interface PointsCalendarAccount {
    id: string
    accountHash: string
    label: string
}

export interface PointsCalendarRecord {
    accountId: string
    accountLabel: string
    date: string
    beforePoints: number
    afterPoints: number
    todayGained: number
    runGained: number
    categories: PointCategoryTotals
    status: PointRunStatus
    updatedAt: string
    runs: Array<Omit<PointRunRecord, 'accountHash'>>
}

export interface PointsCalendarDay {
    date: string
    totalGained: number
    categories: PointCategoryTotals
    status: PointRunStatus
    records: number
}

export interface PointsCalendarSummary {
    totalPoints: number
    averageDailyPoints: number
    completedDays: number
    failedDays: number
    highestPointDay: {
        date: string
        points: number
    }
}

export interface PointsCalendarResponse {
    accounts: Array<{ id: string; label: string }>
    range: {
        preset: PointsRangePreset
        start: string
        end: string
    }
    summary: PointsCalendarSummary
    days: PointsCalendarDay[]
    records: PointsCalendarRecord[]
}

const CATEGORY_KEYS: PointCategoryKey[] = [
    'pcSearch',
    'mobileSearch',
    'dailyActivity',
    'appActivity',
    'checkIn',
    'readToEarn',
    'bonus',
    'streak',
    'other'
]

const historyFile = path.join(process.cwd(), 'logs', 'points-history.json')
const lockFile = `${historyFile}.lock`

function emptyCategories(): PointCategoryTotals {
    return {
        pcSearch: 0,
        mobileSearch: 0,
        dailyActivity: 0,
        appActivity: 0,
        checkIn: 0,
        readToEarn: 0,
        bonus: 0,
        streak: 0,
        other: 0
    }
}

function normalizeCategories(input: Partial<PointCategoryTotals> | undefined): PointCategoryTotals {
    const next = emptyCategories()
    for (const key of CATEGORY_KEYS) {
        next[key] = Math.max(0, Math.floor(Number(input?.[key] ?? 0)))
    }
    return next
}

function sumCategories(categories: PointCategoryTotals): number {
    return CATEGORY_KEYS.reduce((sum, key) => sum + Math.max(0, Number(categories[key] ?? 0)), 0)
}

function addCategories(a: PointCategoryTotals, b: PointCategoryTotals): PointCategoryTotals {
    const next = emptyCategories()
    for (const key of CATEGORY_KEYS) {
        next[key] = Math.max(0, Number(a[key] ?? 0)) + Math.max(0, Number(b[key] ?? 0))
    }
    return next
}

function addCategory(categories: PointCategoryTotals, category: PointCategoryKey, points: number): void {
    categories[category] = Math.max(0, Number(categories[category] ?? 0)) + Math.max(0, Math.floor(points))
}

function numberValue(value: unknown, fallback = 0): number {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : fallback
}

export function localDateKey(date = new Date()): string {
    return [
        date.getFullYear(),
        String(date.getMonth() + 1).padStart(2, '0'),
        String(date.getDate()).padStart(2, '0')
    ].join('-')
}

function parseDateKey(value: string): Date | null {
    const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/)
    if (!match) return null
    const year = Number(match[1])
    const month = Number(match[2])
    const day = Number(match[3])
    const date = new Date(year, month - 1, day)
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null
    return date
}

function addDays(date: Date, days: number): Date {
    const next = new Date(date.getFullYear(), date.getMonth(), date.getDate())
    next.setDate(next.getDate() + days)
    return next
}

function eachDate(start: string, end: string): string[] {
    const startDate = parseDateKey(start)
    const endDate = parseDateKey(end)
    if (!startDate || !endDate) return []
    const dates: string[] = []
    for (let cursor = startDate; cursor.getTime() <= endDate.getTime(); cursor = addDays(cursor, 1)) {
        dates.push(localDateKey(cursor))
    }
    return dates
}

function rangeForPreset(
    preset: PointsRangePreset,
    start?: string,
    end?: string,
    now = new Date()
): { preset: PointsRangePreset; start: string; end: string } {
    const customStart = start ? parseDateKey(start) : null
    const customEnd = end ? parseDateKey(end) : null
    if ((preset === 'custom' || customStart || customEnd) && customStart && customEnd) {
        const first = customStart.getTime() <= customEnd.getTime() ? customStart : customEnd
        const last = customStart.getTime() <= customEnd.getTime() ? customEnd : customStart
        return { preset: 'custom', start: localDateKey(first), end: localDateKey(last) }
    }

    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    if (preset === 'week') {
        const offset = (today.getDay() + 6) % 7
        const weekStart = addDays(today, -offset)
        return { preset, start: localDateKey(weekStart), end: localDateKey(addDays(weekStart, 6)) }
    }
    if (preset === 'quarter') {
        const quarterStartMonth = Math.floor(today.getMonth() / 3) * 3
        const quarterStart = new Date(today.getFullYear(), quarterStartMonth, 1)
        const quarterEnd = new Date(today.getFullYear(), quarterStartMonth + 3, 0)
        return { preset, start: localDateKey(quarterStart), end: localDateKey(quarterEnd) }
    }
    if (preset === 'year') {
        return {
            preset,
            start: localDateKey(new Date(today.getFullYear(), 0, 1)),
            end: localDateKey(new Date(today.getFullYear(), 11, 31))
        }
    }

    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1)
    const monthEnd = new Date(today.getFullYear(), today.getMonth() + 1, 0)
    return { preset: 'month', start: localDateKey(monthStart), end: localDateKey(monthEnd) }
}

function emptyHistoryFile(): PointsHistoryFile {
    return { version: 1, updatedAt: new Date().toISOString(), days: [] }
}

function sanitizeText(value: string): string {
    return value
        .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, maskEmail)
        .replace(
            /\b(password|passwd|pwd|token|secret|cookie|authorization|corpsecret)(\s*[:=]\s*)([^\s|]+)/gi,
            '$1$2[REDACTED]'
        )
        .slice(0, 500)
}

function maskEmail(email: string): string {
    const [name = '', domain = ''] = email.split('@')
    if (!domain) return email ? `${email.slice(0, 2)}***` : ''
    const left = name.length <= 2 ? `${name[0] ?? ''}***` : `${name.slice(0, 2)}***${name.slice(-1)}`
    return `${left}@${domain}`
}

function accountLabel(email: string): string {
    return maskEmail(email.trim().toLowerCase())
}

function normalizeStatus(value: unknown): PointRunStatus {
    if (
        value === 'completed' ||
        value === 'partial' ||
        value === 'failed' ||
        value === 'skipped' ||
        value === 'notRun'
    ) {
        return value
    }
    return 'partial'
}

function normalizeTaskSummary(input: unknown): PointTaskSummaryLike[] {
    if (!Array.isArray(input)) return []
    return input
        .map(item => {
            const raw = item && typeof item === 'object' ? (item as Record<string, unknown>) : {}
            return {
                key: typeof raw.key === 'string' ? sanitizeText(raw.key) : undefined,
                label: sanitizeText(String(raw.label ?? '任务')),
                gained: numberValue(raw.gained),
                status: typeof raw.status === 'string' ? sanitizeText(raw.status) : undefined
            }
        })
        .filter(item => item.label.length > 0)
}

function normalizeRun(input: Partial<PointRunRecord>, day: PointDayRecord): PointRunRecord {
    return {
        id: typeof input.id === 'string' ? input.id : newRunId(day.accountHash, day.date),
        date: typeof input.date === 'string' ? input.date : day.date,
        accountHash: day.accountHash,
        accountLabel: typeof input.accountLabel === 'string' ? sanitizeText(input.accountLabel) : day.accountLabel,
        source: typeof input.source === 'string' ? sanitizeText(input.source) : '',
        pid: numberValue(input.pid),
        startedAt: typeof input.startedAt === 'string' ? input.startedAt : new Date().toISOString(),
        finishedAt: typeof input.finishedAt === 'string' ? input.finishedAt : '',
        beforePoints: numberValue(input.beforePoints),
        afterPoints: numberValue(input.afterPoints),
        runGained: numberValue(input.runGained),
        todayGained: numberValue(input.todayGained),
        categories: normalizeCategories(input.categories),
        status: normalizeStatus(input.status),
        taskSummary: normalizeTaskSummary(input.taskSummary),
        error: typeof input.error === 'string' ? sanitizeText(input.error) : undefined
    }
}

function normalizeDay(input: Partial<PointDayRecord>): PointDayRecord | null {
    if (typeof input.date !== 'string' || typeof input.accountHash !== 'string') return null
    const day: PointDayRecord = {
        date: input.date,
        accountHash: input.accountHash,
        accountLabel: typeof input.accountLabel === 'string' ? sanitizeText(input.accountLabel) : '账号',
        beforePoints: numberValue(input.beforePoints),
        afterPoints: numberValue(input.afterPoints),
        todayGained: numberValue(input.todayGained),
        runGained: numberValue(input.runGained),
        categories: normalizeCategories(input.categories),
        status: normalizeStatus(input.status),
        updatedAt: typeof input.updatedAt === 'string' ? input.updatedAt : new Date().toISOString(),
        runs: []
    }
    day.runs = Array.isArray(input.runs) ? input.runs.map(run => normalizeRun(run, day)) : []
    recomputeDay(day)
    return day
}

function readHistoryFile(): PointsHistoryFile {
    try {
        if (!fs.existsSync(historyFile)) return emptyHistoryFile()
        const parsed = JSON.parse(fs.readFileSync(historyFile, 'utf8')) as Partial<PointsHistoryFile>
        const days = Array.isArray(parsed.days)
            ? parsed.days
                  .map(day => normalizeDay(day))
                  .filter((day): day is PointDayRecord => Boolean(day))
            : []
        return {
            version: 1,
            updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
            days
        }
    } catch {
        return emptyHistoryFile()
    }
}

function writeHistoryFile(data: PointsHistoryFile): void {
    data.updatedAt = new Date().toISOString()
    fs.mkdirSync(path.dirname(historyFile), { recursive: true })
    const tmp = `${historyFile}.${process.pid}.${Date.now()}.tmp`
    fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
    fs.renameSync(tmp, historyFile)
}

function sleepSync(ms: number): void {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function withHistoryLock<T>(fn: () => T): T {
    fs.mkdirSync(path.dirname(historyFile), { recursive: true })
    const started = Date.now()
    let fd: number | null = null
    while (fd === null) {
        try {
            fd = fs.openSync(lockFile, 'wx')
            fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }))
        } catch {
            try {
                const stat = fs.statSync(lockFile)
                if (Date.now() - stat.mtimeMs > 10 * 60 * 1000) {
                    fs.unlinkSync(lockFile)
                    continue
                }
            } catch {}
            if (Date.now() - started > 5000) {
                throw new Error('points-history lock timeout')
            }
            sleepSync(25)
        }
    }

    try {
        return fn()
    } finally {
        if (fd !== null) {
            try {
                fs.closeSync(fd)
            } catch {}
        }
        try {
            fs.unlinkSync(lockFile)
        } catch {}
    }
}

function newRunId(accountHash: string, date = localDateKey()): string {
    return `${date}-${accountHash.slice(0, 10)}-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`
}

function dayFor(data: PointsHistoryFile, email: string, date = localDateKey()): PointDayRecord {
    const accountHash = accountProgressHash(email)
    let day = data.days.find(item => item.accountHash === accountHash && item.date === date)
    if (!day) {
        day = {
            date,
            accountHash,
            accountLabel: accountLabel(email),
            beforePoints: 0,
            afterPoints: 0,
            todayGained: 0,
            runGained: 0,
            categories: emptyCategories(),
            status: 'notRun',
            updatedAt: new Date().toISOString(),
            runs: []
        }
        data.days.push(day)
    }
    if (!day.accountLabel) day.accountLabel = accountLabel(email)
    return day
}

function runFor(day: PointDayRecord, runId: string): PointRunRecord | null {
    return day.runs.find(run => run.id === runId) ?? null
}

function aggregateStatus(runs: PointRunRecord[]): PointRunStatus {
    if (runs.length === 0) return 'notRun'
    const hasCompleted = runs.some(run => run.status === 'completed')
    const hasPartial = runs.some(run => run.status === 'partial')
    const hasFailed = runs.some(run => run.status === 'failed')
    const allSkipped = runs.every(run => run.status === 'skipped')
    const anyGained = runs.some(run => run.runGained > 0 || sumCategories(run.categories) > 0)
    if (hasFailed && (hasCompleted || hasPartial || anyGained)) return 'partial'
    if (hasFailed) return 'failed'
    if (hasPartial) return 'partial'
    if (hasCompleted) return 'completed'
    if (allSkipped) return 'skipped'
    return 'notRun'
}

function recomputeDay(day: PointDayRecord): void {
    const sortedRuns = [...day.runs].sort((a, b) => a.startedAt.localeCompare(b.startedAt))
    const firstWithPoints = sortedRuns.find(run => run.beforePoints > 0)
    const latest = [...sortedRuns].sort((a, b) => {
        const left = a.finishedAt || a.startedAt
        const right = b.finishedAt || b.startedAt
        return right.localeCompare(left)
    })[0]
    const categories = sortedRuns.reduce((total, run) => addCategories(total, run.categories), emptyCategories())
    const runGained = sortedRuns.reduce((sum, run) => sum + Math.max(0, Number(run.runGained ?? 0)), 0)
    const beforePoints = day.beforePoints > 0 ? day.beforePoints : firstWithPoints?.beforePoints ?? sortedRuns[0]?.beforePoints ?? 0
    const afterPoints = latest?.afterPoints ?? day.afterPoints ?? beforePoints
    const totalByBalance = beforePoints > 0 ? Math.max(0, afterPoints - beforePoints) : 0
    const todayGained = Math.max(totalByBalance, runGained, sumCategories(categories))

    day.beforePoints = beforePoints
    day.afterPoints = Math.max(afterPoints, beforePoints)
    day.runGained = runGained
    day.todayGained = todayGained
    day.categories = categories
    day.status = aggregateStatus(sortedRuns)
    day.updatedAt = latest?.finishedAt || latest?.startedAt || day.updatedAt || new Date().toISOString()

    for (const run of day.runs) {
        run.todayGained = todayGained
    }
}

function statusFromTaskSummary(status: PointRunStatus, taskSummary: PointTaskSummaryLike[]): PointRunStatus {
    if (status !== 'completed') return status
    const hasSkippedOrFailed = taskSummary.some(task => /跳过|失败|错误|error|failed|skipped/i.test(task.status ?? ''))
    return hasSkippedOrFailed ? 'partial' : 'completed'
}

function taskKeyToCategory(key: string | undefined): PointCategoryKey | null {
    if (key === 'desktop') return 'pcSearch'
    if (key === 'mobile') return 'mobileSearch'
    return null
}

export function pointCategoryFor(label: string, task: 'daily' | 'mobile' | 'desktop' = 'daily', detailLabel = ''): PointCategoryKey {
    if (task === 'desktop') return 'pcSearch'
    if (task === 'mobile') return 'mobileSearch'

    const text = `${label} ${detailLabel}`.toLowerCase()
    if (/pc|桌面|desktop/.test(text) && /搜索|search/.test(text)) return 'pcSearch'
    if (/移动|mobile/.test(text) && /搜索|search/.test(text)) return 'mobileSearch'
    if (/阅读|read/.test(text)) return 'readToEarn'
    if (/签到|check.?in/.test(text)) return 'checkIn'
    if (/app|应用/.test(text)) return 'appActivity'
    if (/奖励|bonus|claim/.test(text)) return 'bonus'
    if (/连击|streak/.test(text)) return 'streak'
    if (/每日|daily|urlreward|quiz|测验|活动|推广|打卡|punch|findclippy|必应搜索活动/.test(text)) return 'dailyActivity'
    return 'other'
}

export function readPointsHistoryFile(): PointsHistoryFile {
    return readHistoryFile()
}

export function startPointRun(email: string, beforePoints: number, options: { source?: string; pid?: number } = {}): string {
    return withHistoryLock(() => {
        const data = readHistoryFile()
        const date = localDateKey()
        const day = dayFor(data, email, date)
        const runId = newRunId(day.accountHash, date)
        const now = new Date().toISOString()
        const safeBefore = numberValue(beforePoints)
        const run: PointRunRecord = {
            id: runId,
            date,
            accountHash: day.accountHash,
            accountLabel: day.accountLabel,
            source: sanitizeText(options.source ?? ''),
            pid: numberValue(options.pid),
            startedAt: now,
            finishedAt: '',
            beforePoints: safeBefore,
            afterPoints: safeBefore,
            runGained: 0,
            todayGained: day.todayGained,
            categories: emptyCategories(),
            status: 'partial',
            taskSummary: []
        }
        day.runs.push(run)
        if (day.beforePoints === 0 && safeBefore > 0) day.beforePoints = safeBefore
        day.afterPoints = Math.max(day.afterPoints, safeBefore)
        day.updatedAt = now
        recomputeDay(day)
        writeHistoryFile(data)
        return runId
    })
}

export function updatePointRunBaseline(email: string, runId: string | null, beforePoints: number): void {
    if (!runId) return
    withHistoryLock(() => {
        const data = readHistoryFile()
        const day = dayFor(data, email)
        const run = runFor(day, runId)
        if (!run) return
        const safeBefore = numberValue(beforePoints)
        run.beforePoints = safeBefore
        if (run.afterPoints === 0) run.afterPoints = safeBefore
        if (day.beforePoints === 0 || day.beforePoints > safeBefore) day.beforePoints = safeBefore
        day.accountLabel = accountLabel(email)
        run.accountLabel = day.accountLabel
        day.updatedAt = new Date().toISOString()
        recomputeDay(day)
        writeHistoryFile(data)
    })
}

export function recordPointRunGain(
    email: string,
    runId: string | null,
    label: string,
    category: PointCategoryKey,
    gained: number,
    balance?: number
): void {
    if (!runId) return
    const safeGained = numberValue(gained)
    if (safeGained <= 0 && balance === undefined) return

    withHistoryLock(() => {
        const data = readHistoryFile()
        const day = dayFor(data, email)
        const run = runFor(day, runId)
        if (!run) return
        addCategory(run.categories, category, safeGained)
        run.runGained += safeGained
        if (balance !== undefined) {
            run.afterPoints = Math.max(run.afterPoints, numberValue(balance))
        } else {
            run.afterPoints = Math.max(run.afterPoints, run.beforePoints + run.runGained)
        }
        run.taskSummary.push({
            key: category,
            label: sanitizeText(label),
            gained: safeGained,
            status: safeGained > 0 ? '已记录' : '无新增'
        })
        run.status = 'partial'
        day.updatedAt = new Date().toISOString()
        recomputeDay(day)
        writeHistoryFile(data)
    })
}

export function ensurePointRunCategoryMinimum(
    email: string,
    runId: string | null,
    label: string,
    category: PointCategoryKey,
    minimumGained: number,
    balance?: number
): void {
    if (!runId) return
    const minimum = numberValue(minimumGained)
    if (minimum <= 0) return

    withHistoryLock(() => {
        const data = readHistoryFile()
        const day = dayFor(data, email)
        const run = runFor(day, runId)
        if (!run) return
        const current = numberValue(run.categories[category])
        const delta = Math.max(0, minimum - current)
        if (delta > 0) {
            addCategory(run.categories, category, delta)
            run.runGained += delta
            run.taskSummary.push({
                key: category,
                label: sanitizeText(label),
                gained: delta,
                status: '补齐分类'
            })
        }
        if (balance !== undefined) {
            run.afterPoints = Math.max(run.afterPoints, numberValue(balance))
        }
        day.updatedAt = new Date().toISOString()
        recomputeDay(day)
        writeHistoryFile(data)
    })
}

export function finishPointRun(
    email: string,
    runId: string | null,
    patch: {
        status: PointRunStatus
        beforePoints?: number
        afterPoints?: number
        runGained?: number
        taskSummary?: PointTaskSummaryLike[]
        error?: string
    }
): void {
    if (!runId) return
    withHistoryLock(() => {
        const data = readHistoryFile()
        const day = dayFor(data, email)
        const run = runFor(day, runId)
        if (!run) return

        const beforePoints = numberValue(patch.beforePoints, run.beforePoints)
        const afterPoints = numberValue(patch.afterPoints, run.afterPoints)
        const runGained = patch.runGained !== undefined ? numberValue(patch.runGained) : Math.max(0, afterPoints - beforePoints)
        const summary = normalizeTaskSummary(patch.taskSummary)
        const existingCategoryTotal = sumCategories(run.categories)

        run.beforePoints = beforePoints
        run.afterPoints = Math.max(afterPoints, beforePoints)
        run.runGained = Math.max(run.runGained, runGained)
        run.finishedAt = new Date().toISOString()
        run.status = statusFromTaskSummary(patch.status, summary)
        run.taskSummary = [...run.taskSummary, ...summary]
        if (patch.error) run.error = sanitizeText(patch.error)

        if (existingCategoryTotal === 0 && summary.length > 0) {
            for (const item of summary) {
                const category = taskKeyToCategory(item.key) ?? pointCategoryFor(item.label)
                addCategory(run.categories, category, item.gained)
            }
        }

        const missing = Math.max(0, run.runGained - sumCategories(run.categories))
        if (missing > 0) {
            addCategory(run.categories, 'other', missing)
        }

        if (day.beforePoints === 0 || beforePoints < day.beforePoints) day.beforePoints = beforePoints
        day.accountLabel = accountLabel(email)
        run.accountLabel = day.accountLabel
        day.updatedAt = run.finishedAt
        recomputeDay(day)
        writeHistoryFile(data)
    })
}

function emptyCalendarRecord(account: PointsCalendarAccount, date: string): PointsCalendarRecord {
    return {
        accountId: account.id,
        accountLabel: account.label,
        date,
        beforePoints: 0,
        afterPoints: 0,
        todayGained: 0,
        runGained: 0,
        categories: emptyCategories(),
        status: 'notRun',
        updatedAt: '',
        runs: []
    }
}

function publicRun(run: PointRunRecord): Omit<PointRunRecord, 'accountHash'> {
    const { accountHash, ...rest } = run
    return rest
}

function publicRecord(account: PointsCalendarAccount, date: string, saved?: PointDayRecord): PointsCalendarRecord {
    if (!saved) return emptyCalendarRecord(account, date)
    return {
        accountId: account.id,
        accountLabel: account.label,
        date,
        beforePoints: saved.beforePoints,
        afterPoints: saved.afterPoints,
        todayGained: saved.todayGained,
        runGained: saved.runGained,
        categories: normalizeCategories(saved.categories),
        status: saved.status,
        updatedAt: saved.updatedAt,
        runs: saved.runs
            .map(publicRun)
            .sort((a, b) => String(b.finishedAt || b.startedAt).localeCompare(String(a.finishedAt || a.startedAt)))
    }
}

function aggregateCalendarDay(date: string, records: PointsCalendarRecord[]): PointsCalendarDay {
    const categories = records.reduce((total, record) => addCategories(total, record.categories), emptyCategories())
    const totalGained = records.reduce((sum, record) => sum + Math.max(0, Number(record.todayGained ?? 0)), 0)
    const statuses = records.map(record => record.status)
    const status: PointRunStatus = statuses.includes('failed')
        ? totalGained > 0 || statuses.includes('completed') || statuses.includes('partial')
            ? 'partial'
            : 'failed'
        : statuses.includes('partial')
          ? 'partial'
          : statuses.includes('completed')
            ? 'completed'
            : statuses.every(item => item === 'skipped')
              ? 'skipped'
              : 'notRun'
    return { date, totalGained, categories, status, records: records.length }
}

function normalizeRangePreset(value: string | undefined): PointsRangePreset {
    if (value === 'week' || value === 'month' || value === 'quarter' || value === 'year' || value === 'custom') {
        return value
    }
    return 'month'
}

export function queryPointsCalendar(
    accounts: PointsCalendarAccount[],
    options: {
        account?: string
        range?: string
        start?: string
        end?: string
        now?: Date
    } = {}
): PointsCalendarResponse {
    const preset = normalizeRangePreset(options.range)
    const range = rangeForPreset(preset, options.start, options.end, options.now)
    const history = readHistoryFile()
    const accountFilter = String(options.account ?? 'all')
    const selectedAccounts =
        accountFilter === 'all'
            ? accounts
            : accounts.filter(account => account.id === accountFilter || account.accountHash === accountFilter)
    const finalAccounts = selectedAccounts.length > 0 ? selectedAccounts : accounts
    const dates = eachDate(range.start, range.end)
    const records: PointsCalendarRecord[] = []

    for (const date of dates) {
        for (const account of finalAccounts) {
            const saved = history.days.find(day => day.date === date && day.accountHash === account.accountHash)
            records.push(publicRecord(account, date, saved))
        }
    }

    const days = dates.map(date => aggregateCalendarDay(date, records.filter(record => record.date === date)))
    const totalPoints = days.reduce((sum, day) => sum + day.totalGained, 0)
    const averageDailyPoints = dates.length > 0 ? Math.round((totalPoints / dates.length) * 10) / 10 : 0
    const completedDays = days.filter(day => day.status === 'completed' || day.status === 'partial').length
    const failedDays = days.filter(day => day.status === 'failed' || day.status === 'partial').length
    const highest = days.reduce(
        (best, day) => (day.totalGained > best.points ? { date: day.date, points: day.totalGained } : best),
        { date: '', points: 0 }
    )

    return {
        accounts: finalAccounts.map(account => ({ id: account.id, label: account.label })),
        range,
        summary: {
            totalPoints,
            averageDailyPoints,
            completedDays,
            failedDays,
            highestPointDay: highest
        },
        days,
        records: records.sort((a, b) => {
            const dateOrder = b.date.localeCompare(a.date)
            return dateOrder !== 0 ? dateOrder : a.accountLabel.localeCompare(b.accountLabel)
        })
    }
}
