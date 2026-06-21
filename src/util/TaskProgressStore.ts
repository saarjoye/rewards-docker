import crypto from 'crypto'
import fs from 'fs'
import path from 'path'

export interface StoredTaskProgressItem {
    completed: number
    total: number
    gained: number
    status: string
}

export interface StoredTaskProgressDetail extends StoredTaskProgressItem {
    key: string
    label: string
    group: ProgressTaskKey | 'activity'
    message: string
    updatedAt: string
}

export interface StoredAccountTaskProgress {
    accountHash: string
    updatedAt: string
    initialPoints: number
    currentPoints: number
    finalPoints: number
    currentTask: string
    currentStage: string
    currentMessage: string
    desktop: StoredTaskProgressItem
    mobile: StoredTaskProgressItem
    daily: StoredTaskProgressItem
    details: StoredTaskProgressDetail[]
}

interface StoredTaskProgressFile {
    date: string
    accounts: StoredAccountTaskProgress[]
}

export type ProgressTaskKey = 'desktop' | 'mobile' | 'daily'

const progressFile = path.join(process.cwd(), 'logs', 'task-progress.json')

function todayKey(): string {
    return new Date().toISOString().slice(0, 10)
}

function emptyItem(status = '等待运行'): StoredTaskProgressItem {
    return { completed: 0, total: 0, gained: 0, status }
}

function emptyAccount(accountHash: string): StoredAccountTaskProgress {
    return {
        accountHash,
        updatedAt: new Date().toISOString(),
        initialPoints: 0,
        currentPoints: 0,
        finalPoints: 0,
        currentTask: '等待运行',
        currentStage: 'idle',
        currentMessage: '等待运行',
        desktop: emptyItem(),
        mobile: emptyItem(),
        daily: emptyItem(),
        details: []
    }
}

function readProgressFile(): StoredTaskProgressFile {
    try {
        if (!fs.existsSync(progressFile)) {
            return { date: todayKey(), accounts: [] }
        }
        const parsed = JSON.parse(fs.readFileSync(progressFile, 'utf8')) as Partial<StoredTaskProgressFile>
        if (parsed.date !== todayKey() || !Array.isArray(parsed.accounts)) {
            return { date: todayKey(), accounts: [] }
        }
        return { date: parsed.date, accounts: parsed.accounts }
    } catch {
        return { date: todayKey(), accounts: [] }
    }
}

function writeProgressFile(data: StoredTaskProgressFile): void {
    fs.mkdirSync(path.dirname(progressFile), { recursive: true })
    fs.writeFileSync(progressFile, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
}

export function accountProgressHash(email: string): string {
    return crypto.createHash('sha256').update(email.trim().toLowerCase()).digest('hex')
}

export function taskDetailKey(label: string): string {
    const ascii = label
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
    return ascii || crypto.createHash('sha1').update(label.trim()).digest('hex').slice(0, 12)
}

export function readTaskProgressFile(): StoredTaskProgressFile {
    return readProgressFile()
}

function getAccount(data: StoredTaskProgressFile, email: string): StoredAccountTaskProgress {
    const accountHash = accountProgressHash(email)
    let account = data.accounts.find(item => item.accountHash === accountHash)
    if (!account) {
        account = emptyAccount(accountHash)
        data.accounts.push(account)
    }

    account.currentTask = account.currentTask ?? '等待运行'
    account.currentStage = account.currentStage ?? 'idle'
    account.currentMessage = account.currentMessage ?? account.currentTask
    account.details = Array.isArray(account.details) ? account.details : []
    return account
}

export function updateTaskProgress(
    email: string,
    task: ProgressTaskKey,
    patch: Partial<StoredTaskProgressItem>
): void {
    const data = readProgressFile()
    const account = getAccount(data, email)

    account[task] = {
        ...account[task],
        ...patch,
        completed: Math.max(0, Number(patch.completed ?? account[task].completed ?? 0)),
        total: Math.max(0, Number(patch.total ?? account[task].total ?? 0)),
        gained: Math.max(0, Number(patch.gained ?? account[task].gained ?? 0)),
        status: patch.status ?? account[task].status
    }
    account.updatedAt = new Date().toISOString()
    writeProgressFile(data)
}

export function updateAccountTaskProgress(
    email: string,
    patch: Partial<Record<ProgressTaskKey, Partial<StoredTaskProgressItem>>>
): void {
    for (const [task, item] of Object.entries(patch) as Array<[ProgressTaskKey, Partial<StoredTaskProgressItem>]>) {
        updateTaskProgress(email, task, item)
    }
}

export function updateAccountPointTotals(
    email: string,
    patch: Partial<Pick<StoredAccountTaskProgress, 'initialPoints' | 'currentPoints' | 'finalPoints'>>
): void {
    const data = readProgressFile()
    const account = getAccount(data, email)

    account.initialPoints = Math.max(0, Number(patch.initialPoints ?? account.initialPoints ?? 0))
    account.currentPoints = Math.max(0, Number(patch.currentPoints ?? account.currentPoints ?? 0))
    account.finalPoints = Math.max(0, Number(patch.finalPoints ?? account.finalPoints ?? 0))
    account.updatedAt = new Date().toISOString()
    writeProgressFile(data)
}

export function resetAccountRunProgress(
    email: string,
    points: Partial<Pick<StoredAccountTaskProgress, 'initialPoints' | 'currentPoints' | 'finalPoints'>>
): void {
    const data = readProgressFile()
    const account = getAccount(data, email)
    account.initialPoints = Math.max(0, Number(points.initialPoints ?? account.initialPoints ?? 0))
    account.currentPoints = Math.max(0, Number(points.currentPoints ?? account.currentPoints ?? 0))
    account.finalPoints = Math.max(0, Number(points.finalPoints ?? account.finalPoints ?? account.currentPoints ?? 0))
    account.currentTask = '准备执行'
    account.currentStage = 'start'
    account.currentMessage = '账号已登录，准备执行任务'
    account.desktop = emptyItem()
    account.mobile = emptyItem()
    account.daily = emptyItem()
    account.details = []
    account.updatedAt = new Date().toISOString()
    writeProgressFile(data)
}

export function updateAccountRunState(
    email: string,
    patch: Partial<Pick<StoredAccountTaskProgress, 'currentTask' | 'currentStage' | 'currentMessage'>>
): void {
    const data = readProgressFile()
    const account = getAccount(data, email)
    account.currentTask = patch.currentTask ?? account.currentTask
    account.currentStage = patch.currentStage ?? account.currentStage
    account.currentMessage = patch.currentMessage ?? account.currentMessage
    account.updatedAt = new Date().toISOString()
    writeProgressFile(data)
}

export function updateTaskDetail(
    email: string,
    detail: Pick<StoredTaskProgressDetail, 'key' | 'label' | 'group'> & Partial<StoredTaskProgressDetail>
): void {
    const data = readProgressFile()
    const account = getAccount(data, email)
    const now = new Date().toISOString()
    let item = account.details.find(entry => entry.key === detail.key)
    if (!item) {
        item = {
            key: detail.key,
            label: detail.label,
            group: detail.group,
            completed: 0,
            total: 0,
            gained: 0,
            status: '等待运行',
            message: '',
            updatedAt: now
        }
        account.details.push(item)
    }

    item.label = detail.label ?? item.label
    item.group = detail.group ?? item.group
    item.completed = Math.max(0, Number(detail.completed ?? item.completed ?? 0))
    item.total = Math.max(0, Number(detail.total ?? item.total ?? 0))
    item.gained = Math.max(0, Number(detail.gained ?? item.gained ?? 0))
    item.status = detail.status ?? item.status
    item.message = detail.message ?? item.message
    item.updatedAt = now
    account.updatedAt = now
    writeProgressFile(data)
}

export function recordTaskDetailGain(
    email: string,
    detail: Pick<StoredTaskProgressDetail, 'key' | 'label' | 'group'>,
    gained: number,
    message = ''
): void {
    const data = readProgressFile()
    const account = getAccount(data, email)
    const now = new Date().toISOString()
    let item = account.details.find(entry => entry.key === detail.key)
    if (!item) {
        item = {
            key: detail.key,
            label: detail.label,
            group: detail.group,
            completed: 0,
            total: 0,
            gained: 0,
            status: '等待运行',
            message: '',
            updatedAt: now
        }
        account.details.push(item)
    }

    const safeGained = Math.max(0, Number.isFinite(Number(gained)) ? Number(gained) : 0)
    item.label = detail.label
    item.group = detail.group
    item.gained = Math.max(0, Number(item.gained ?? 0)) + safeGained
    item.completed = item.gained
    item.total = Math.max(item.total, item.gained)
    item.status = safeGained > 0 ? `+${safeGained}` : item.status
    item.message = message || item.message
    item.updatedAt = now
    account.updatedAt = now
    writeProgressFile(data)
}

export function updateSearchTaskProgress(
    email: string,
    task: Extract<ProgressTaskKey, 'desktop' | 'mobile'>,
    gained: number,
    remaining: number,
    fallbackTotal: number
): void {
    const data = readProgressFile()
    const account = getAccount(data, email)

    const current = account[task]
    const total = current.total > 0 ? current.total : fallbackTotal
    const completedFromRemaining = total > 0 ? Math.max(0, Math.min(total, total - remaining)) : gained
    const completed = Math.max(current.completed ?? 0, completedFromRemaining)
    account[task] = {
        completed,
        total,
        gained: Math.max(current.gained, gained),
        status: remaining > 0 ? '进行中' : '已完成'
    }
    const label = task === 'desktop' ? 'PC搜索' : '移动搜索'
    const detailKey = task === 'desktop' ? 'desktop-search' : 'mobile-search'
    const now = new Date().toISOString()
    let detail = account.details.find(item => item.key === detailKey)
    if (!detail) {
        detail = {
            key: detailKey,
            label,
            group: task,
            completed: 0,
            total: 0,
            gained: 0,
            status: '等待运行',
            message: '',
            updatedAt: now
        }
        account.details.push(detail)
    }
    detail.completed = completed
    detail.total = total
    detail.gained = Math.max(detail.gained, gained)
    detail.status = remaining > 0 ? '进行中' : '已完成'
    detail.message = remaining > 0 ? `剩余 ${remaining}，进度 ${completed}/${total}` : '搜索已完成'
    detail.updatedAt = now
    account.updatedAt = new Date().toISOString()
    writeProgressFile(data)
}
