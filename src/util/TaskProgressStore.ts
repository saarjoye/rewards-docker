import crypto from 'crypto'
import fs from 'fs'
import path from 'path'

export interface StoredTaskProgressItem {
    completed: number
    total: number
    gained: number
    status: string
}

export interface StoredAccountTaskProgress {
    accountHash: string
    updatedAt: string
    desktop: StoredTaskProgressItem
    mobile: StoredTaskProgressItem
    daily: StoredTaskProgressItem
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
        desktop: emptyItem(),
        mobile: emptyItem(),
        daily: emptyItem()
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

export function readTaskProgressFile(): StoredTaskProgressFile {
    return readProgressFile()
}

export function updateTaskProgress(
    email: string,
    task: ProgressTaskKey,
    patch: Partial<StoredTaskProgressItem>
): void {
    const data = readProgressFile()
    const accountHash = accountProgressHash(email)
    let account = data.accounts.find(item => item.accountHash === accountHash)
    if (!account) {
        account = emptyAccount(accountHash)
        data.accounts.push(account)
    }

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
