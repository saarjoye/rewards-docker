import type { DashboardFailureDetails } from './DashboardError'

export interface AccountTaskSummary {
    key: 'daily' | 'mobile' | 'desktop' | 'other'
    label: string
    completed?: number
    total?: number
    gained: number
    status: string
}

export interface AccountFailureDetails {
    stage: string
    message: string
    apiStatus: number | null
    fallbackReason: string | null
}

export interface AccountStats {
    email: string
    initialPoints: number | null
    finalPoints: number | null
    collectedPoints: number | null
    taskSummary: AccountTaskSummary[]
    duration: number
    success: boolean
    error?: AccountFailureDetails
}

export interface KnownPointTotals {
    initialPoints: number
    finalPoints: number
    collectedPoints: number
    knownAccounts: number
    unknownAccounts: number
}

export function dashboardAccountFailure(error: DashboardFailureDetails): AccountFailureDetails {
    return {
        stage: error.stage,
        message: error.message,
        apiStatus: error.apiStatus,
        fallbackReason: error.fallbackReason
    }
}

export function genericAccountFailure(stage: string, message: string): AccountFailureDetails {
    return { stage, message, apiStatus: null, fallbackReason: null }
}

export function calculateKnownPointTotals(stats: AccountStats[]): KnownPointTotals {
    let initialPoints = 0
    let finalPoints = 0
    let collectedPoints = 0
    let knownAccounts = 0

    for (const stat of stats) {
        if (stat.initialPoints === null || stat.finalPoints === null || stat.collectedPoints === null) continue
        knownAccounts += 1
        initialPoints += stat.initialPoints
        finalPoints += stat.finalPoints
        collectedPoints += stat.collectedPoints
    }

    return {
        initialPoints,
        finalPoints,
        collectedPoints,
        knownAccounts,
        unknownAccounts: stats.length - knownAccounts
    }
}

export function resolveRunExitCode(stats: AccountStats[], workerFailure = false): 0 | 1 {
    return workerFailure || stats.some(stat => !stat.success) ? 1 : 0
}

export function formatAccountPoints(stat: AccountStats): {
    initial: string
    final: string
    collected: string
    compact: string
} {
    const dashboardUnknown = stat.initialPoints === null && stat.error?.stage === 'dashboard'
    const initial = stat.initialPoints === null ? (dashboardUnknown ? '未知（dashboard 获取失败）' : '未知') : String(stat.initialPoints)
    const final = stat.finalPoints === null ? '未知' : String(stat.finalPoints)
    const collected = stat.collectedPoints === null ? '未计算' : String(stat.collectedPoints)
    const compactCollected = stat.collectedPoints === null ? '未计算' : `+${stat.collectedPoints}`
    return { initial, final, collected, compact: `${compactCollected} | ${initial}→${final}` }
}

export function formatAccountError(error: AccountFailureDetails | undefined): string | null {
    if (!error) return null
    if (error.stage === 'dashboard' && !error.message.startsWith('dashboard 获取失败：')) {
        return `dashboard 获取失败：${error.message}`
    }
    return error.message
}

export function buildWeComAccountMessage(stat: AccountStats, timestamp: string, duration: string): string {
    const status = stat.success ? '完成' : '失败'
    const points = formatAccountPoints(stat)
    const lines = [
        `Microsoft Rewards 账号任务${status}`,
        `时间：${timestamp}`,
        `账号：${stat.email}`,
        `任务前总积分：${points.initial}`,
        `任务后总积分：${points.final}`,
        `本次总增加：${points.collected}`,
        `耗时：${duration}`
    ]

    if (stat.taskSummary.length > 0) {
        lines.push('', '任务明细：')
        for (const task of stat.taskSummary) {
            const progress =
                task.total !== undefined && task.completed !== undefined ? ` | 进度 ${task.completed}/${task.total}` : ''
            lines.push(`- ${task.label}：+${task.gained} 分${progress} | ${task.status}`)
        }
    }

    const errorText = formatAccountError(stat.error)
    if (errorText) lines.push('', `错误：${errorText}`)
    return lines.join('\n')
}
