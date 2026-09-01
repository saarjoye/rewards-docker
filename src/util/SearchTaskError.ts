export type SearchTaskKind = 'mobile' | 'desktop'
export type SearchFailureStage = 'mobile-search' | 'desktop-login' | 'desktop-search' | 'dashboard-search-counter'

type ErrorWithLoginState = Error & { loginState?: unknown; loginStage?: unknown }

export class SearchTaskError extends Error {
    constructor(
        public readonly stage: SearchFailureStage,
        public readonly task: SearchTaskKind,
        message: string,
        public readonly completed: number,
        public readonly total: number,
        public readonly loginState?: string
    ) {
        super(message)
        this.name = 'SearchTaskError'
    }
}

export function toSearchTaskError(
    error: unknown,
    stage: SearchFailureStage,
    task: SearchTaskKind,
    completed: number,
    total: number
): SearchTaskError {
    if (error instanceof SearchTaskError) return error
    const source = error instanceof Error ? (error as ErrorWithLoginState) : null
    const sourceMessage = source?.message ?? String(error)
    const loginState = typeof source?.loginState === 'string' ? source.loginState : undefined
    const diagnostic = loginState ? `，登录状态 ${loginState}` : ''
    return new SearchTaskError(
        stage,
        task,
        `搜索任务失败（阶段 ${stage}${diagnostic}）：${sourceMessage}`,
        Math.max(0, completed),
        Math.max(0, total),
        loginState
    )
}
