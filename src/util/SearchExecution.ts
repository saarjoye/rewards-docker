import type { Page } from 'patchright'
import ms, { type StringValue } from 'ms'

export type SearchOperationStage =
    | 'search-box'
    | 'submit'
    | 'post-submit-wait'
    | 'scroll'
    | 'click'
    | 'search-delay'
    | 'dashboard-refresh'

export interface SearchTimeoutBudget {
    navigationMs: number
    retryDelayMs: number
    stageTimeouts: Record<SearchOperationStage, number>
    queryTimeoutMs: number
}

export interface SearchBudgetOptions {
    searchDelayMax: string | number
    searchResultVisitTime: string | number
    interactionTimeout?: string | number
    scrollRandomResults: boolean
    clickRandomResults: boolean
}

const SEARCH_BOX_TIMEOUT_MS = 16_000
const SUBMIT_TIMEOUT_MS = 20_000
const POST_SUBMIT_TIMEOUT_MS = 5_000
const SCROLL_TIMEOUT_MS = 10_000
const DASHBOARD_REFRESH_TIMEOUT_MS = 60_000
const NAVIGATION_TIMEOUT_MS = 25_000
const RETRY_DELAY_MS = 2_000
const SAFETY_MARGIN_MS = 10_000
const CLICK_SAFETY_MARGIN_MS = 5_000
const DEFAULT_INTERACTION_TIMEOUT_MS = 30_000
const PRE_SUBMIT_ATTEMPTS = 3
const MIN_ROUND_TIMEOUT_MS = 10 * 60_000
const MAX_ROUND_TIMEOUT_MS = 60 * 60_000

function durationMs(value: string | number): number {
    const parsed = typeof value === 'number' ? value : ms(value as StringValue)
    if (parsed === undefined || !Number.isFinite(parsed) || parsed < 0) {
        throw new Error(`无效搜索延迟配置: ${String(value)}`)
    }
    return parsed
}

export function calculateSearchTimeoutBudget(options: SearchBudgetOptions): SearchTimeoutBudget {
    const searchDelayMs = durationMs(options.searchDelayMax) + 2_000
    const interactionTimeoutMs =
        options.interactionTimeout === undefined
            ? DEFAULT_INTERACTION_TIMEOUT_MS
            : durationMs(options.interactionTimeout)
    const clickMs = options.clickRandomResults
        ? durationMs(options.searchResultVisitTime) + interactionTimeoutMs + CLICK_SAFETY_MARGIN_MS
        : 0
    const scrollMs = options.scrollRandomResults ? SCROLL_TIMEOUT_MS : 0
    const stageTimeouts: Record<SearchOperationStage, number> = {
        'search-box': SEARCH_BOX_TIMEOUT_MS,
        submit: SUBMIT_TIMEOUT_MS,
        'post-submit-wait': POST_SUBMIT_TIMEOUT_MS,
        scroll: scrollMs,
        click: clickMs,
        'search-delay': searchDelayMs,
        'dashboard-refresh': DASHBOARD_REFRESH_TIMEOUT_MS
    }
    const retryAllowanceMs = (PRE_SUBMIT_ATTEMPTS - 1) * RETRY_DELAY_MS
    const queryTimeoutMs =
        NAVIGATION_TIMEOUT_MS +
        PRE_SUBMIT_ATTEMPTS * (SEARCH_BOX_TIMEOUT_MS + SUBMIT_TIMEOUT_MS) +
        retryAllowanceMs +
        POST_SUBMIT_TIMEOUT_MS +
        scrollMs +
        clickMs +
        searchDelayMs +
        DASHBOARD_REFRESH_TIMEOUT_MS +
        SAFETY_MARGIN_MS

    return {
        navigationMs: NAVIGATION_TIMEOUT_MS,
        retryDelayMs: RETRY_DELAY_MS,
        stageTimeouts,
        queryTimeoutMs
    }
}

export function calculateSearchRoundTimeoutMs(
    queryTimeoutMs: number,
    remainingPoints: number,
    queryCount: number
): number {
    const plannedQueries = Math.max(1, Math.min(Math.max(1, Math.ceil(remainingPoints)), Math.max(1, queryCount)))
    return Math.min(MAX_ROUND_TIMEOUT_MS, Math.max(MIN_ROUND_TIMEOUT_MS, queryTimeoutMs * plannedQueries))
}

export class SearchOperationError extends Error {
    readonly cause?: unknown

    constructor(
        public readonly operationStage: SearchOperationStage,
        message: string,
        public readonly timeoutMs: number,
        public readonly elapsedMs: number,
        public readonly timedOut: boolean,
        options?: { cause?: unknown }
    ) {
        super(message)
        this.name = 'SearchOperationError'
        this.cause = options?.cause
    }
}

export function abortableWait(delayMs: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(signal.reason ?? new Error('搜索操作已终止'))

    return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
            () => {
                signal.removeEventListener('abort', onAbort)
                resolve()
            },
            Math.max(0, delayMs)
        )
        const onAbort = () => {
            clearTimeout(timer)
            reject(signal.reason ?? new Error('搜索操作已终止'))
        }
        signal.addEventListener('abort', onAbort, { once: true })
    })
}

export async function runSearchStage<T>(options: {
    page: Pick<Page, 'close' | 'isClosed'>
    controller: AbortController
    stage: SearchOperationStage
    timeoutMs: number
    operation: (signal: AbortSignal) => Promise<T>
}): Promise<T> {
    const { page, controller, stage } = options
    const timeoutMs = Math.max(1, Math.floor(options.timeoutMs))
    const startedAt = Date.now()
    let timer: NodeJS.Timeout | undefined
    let timedOut = false
    let timeoutError: SearchOperationError | undefined
    const operationPromise = Promise.resolve().then(() => options.operation(controller.signal))

    const timeoutPromise = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
            timedOut = true
            const elapsedMs = Date.now() - startedAt
            timeoutError = new SearchOperationError(
                stage,
                `搜索阶段超时 | stage=${stage} | timeoutMs=${timeoutMs}`,
                timeoutMs,
                elapsedMs,
                true
            )
            controller.abort(timeoutError)
            void (async () => {
                if (!page.isClosed()) await page.close({ runBeforeUnload: false }).catch(() => {})
                reject(timeoutError)
            })()
        }, timeoutMs)
    })

    try {
        return await Promise.race([operationPromise, timeoutPromise])
    } catch (error) {
        if (timedOut && timeoutError) {
            await operationPromise.catch(() => undefined)
            throw timeoutError
        }
        if (error instanceof SearchOperationError) throw error
        throw new SearchOperationError(
            stage,
            `搜索阶段失败 | stage=${stage} | message=${error instanceof Error ? error.message : String(error)}`,
            timeoutMs,
            Date.now() - startedAt,
            false,
            { cause: error }
        )
    } finally {
        if (timer) clearTimeout(timer)
    }
}

export const SEARCH_PRE_SUBMIT_ATTEMPTS = PRE_SUBMIT_ATTEMPTS
