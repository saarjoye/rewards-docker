export type DashboardFailureKind = 'network' | 'auth' | 'rate-limit' | 'server' | 'invalid-response'

export interface DashboardFailureDetails {
    stage: 'dashboard'
    message: string
    apiStatus: number | null
    apiReason: string
    fallbackReason: string
    apiFailureKind: DashboardFailureKind
}

export class DashboardFetchError extends Error implements DashboardFailureDetails {
    readonly stage = 'dashboard' as const
    readonly apiStatus: number | null
    readonly apiReason: string
    readonly fallbackReason: string
    readonly apiFailureKind: DashboardFailureKind

    constructor(options: {
        apiStatus?: number | null
        apiReason: string
        fallbackReason: string
        apiFailureKind: DashboardFailureKind
    }) {
        super(`dashboard 获取失败：API ${options.apiReason}；页面回退 ${options.fallbackReason}`)
        this.name = 'DashboardFetchError'
        this.apiStatus = options.apiStatus ?? null
        this.apiReason = options.apiReason
        this.fallbackReason = options.fallbackReason
        this.apiFailureKind = options.apiFailureKind
    }

    toJSON(): DashboardFailureDetails {
        return dashboardFailureDetails(this)
    }
}

export function dashboardFailureDetails(error: unknown): DashboardFailureDetails {
    if (error instanceof DashboardFetchError) {
        return {
            stage: error.stage,
            message: error.message,
            apiStatus: error.apiStatus,
            apiReason: error.apiReason,
            fallbackReason: error.fallbackReason,
            apiFailureKind: error.apiFailureKind
        }
    }

    const message = error instanceof Error ? error.message : String(error)
    return {
        stage: 'dashboard',
        message,
        apiStatus: null,
        apiReason: '未确认',
        fallbackReason: message,
        apiFailureKind: 'invalid-response'
    }
}

export function isDashboardFetchError(error: unknown): error is DashboardFetchError {
    return error instanceof DashboardFetchError
}
