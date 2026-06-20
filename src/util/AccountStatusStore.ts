import fs from 'fs'
import path from 'path'

import { accountProgressHash } from './TaskProgressStore'

export type AccountStatusState = 'unknown' | 'checking' | 'valid' | 'running' | 'success' | 'error'

export interface StoredAccountStatus {
    accountHash: string
    state: AccountStatusState
    stage: string
    lastMessage: string
    updatedAt: string
    lastCheckedAt?: string
    lastSuccessAt?: string
    lastFailureAt?: string
    error?: string
}

interface StoredAccountStatusFile {
    version: 1
    accounts: StoredAccountStatus[]
}

const statusFile = path.join(process.cwd(), 'logs', 'account-status.json')

function emptyStatusFile(): StoredAccountStatusFile {
    return { version: 1, accounts: [] }
}

function readStatusFile(): StoredAccountStatusFile {
    try {
        if (!fs.existsSync(statusFile)) return emptyStatusFile()
        const parsed = JSON.parse(fs.readFileSync(statusFile, 'utf8')) as Partial<StoredAccountStatusFile>
        if (!Array.isArray(parsed.accounts)) return emptyStatusFile()
        return {
            version: 1,
            accounts: parsed.accounts.filter(
                (item): item is StoredAccountStatus =>
                    typeof item.accountHash === 'string' &&
                    typeof item.state === 'string' &&
                    typeof item.stage === 'string' &&
                    typeof item.lastMessage === 'string' &&
                    typeof item.updatedAt === 'string'
            )
        }
    } catch {
        return emptyStatusFile()
    }
}

function writeStatusFile(data: StoredAccountStatusFile): void {
    fs.mkdirSync(path.dirname(statusFile), { recursive: true })
    fs.writeFileSync(statusFile, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
}

function defaultAccountStatus(accountHash: string): StoredAccountStatus {
    return {
        accountHash,
        state: 'unknown',
        stage: 'created',
        lastMessage: '尚未检测',
        updatedAt: new Date().toISOString()
    }
}

function sanitizeStatusText(value: string): string {
    return value
        .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[REDACTED_EMAIL]')
        .replace(
            /\b(password|passwd|pwd|token|secret|cookie|authorization)(\s*[:=]\s*)([^\s|]+)/gi,
            '$1$2[REDACTED]'
        )
}

export function readAccountStatusFile(): StoredAccountStatusFile {
    return readStatusFile()
}

export function updateAccountStatus(
    email: string,
    patch: Partial<Omit<StoredAccountStatus, 'accountHash' | 'updatedAt'>>
): void {
    const data = readStatusFile()
    const accountHash = accountProgressHash(email)
    const now = new Date().toISOString()
    let account = data.accounts.find(item => item.accountHash === accountHash)
    if (!account) {
        account = defaultAccountStatus(accountHash)
        data.accounts.push(account)
    }

    account.state = patch.state ?? account.state
    account.stage = patch.stage ? sanitizeStatusText(patch.stage) : account.stage
    account.lastMessage = patch.lastMessage ? sanitizeStatusText(patch.lastMessage) : account.lastMessage
    account.updatedAt = now

    if (patch.state === 'checking') {
        account.lastCheckedAt = now
    }
    if (patch.state === 'valid' || patch.state === 'running' || patch.state === 'success') {
        account.lastSuccessAt = now
        delete account.error
    }
    if (patch.state === 'error') {
        account.lastFailureAt = now
        const error = patch.error ?? patch.lastMessage ?? account.error
        account.error = error ? sanitizeStatusText(error) : error
    }

    writeStatusFile(data)
}
