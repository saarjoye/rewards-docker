import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomUUID } from 'node:crypto'
import { CHECK_IN_OFFER } from './CheckIn'

export type TaskStatus =
    | 'pending'
    | 'eligible'
    | 'submitted'
    | 'unsupported'
    | 'unavailable'
    | 'running'
    | 'verifying'
    | 'completed'
    | 'partial'
    | 'stopped'
    | 'failed'
    | 'skipped'
    | 'locked'
    | 'interrupted'
export type TaskSource = 'rsc' | 'flyout' | 'app' | 'dashboard' | 'group'
export interface TaskSpec {
    key: string
    title: string
    source: TaskSource
    platform: 'mobile' | 'desktop' | 'main'
    offerId?: string
    parentOfferId?: string
    channel?: string
    counter?: string
    group?: boolean
}
export interface TaskEvidence {
    officialCreditId?: string
    creditedPoints?: number | null
    balance: number | null
    current: number | null
    total: number | null
    completed: boolean | null
    unit: 'points' | 'items'
    observedAt: string
    source?: string
    reason?: string
    attempt?: number
    elapsedMs?: number
}
interface TaskContext {
    publish: (patch: Record<string, unknown>) => void
    failed: boolean
    children: TaskStatus[]
    id: string
    stopped: boolean
    explicitStatus?: TaskStatus
    explicitAction?: string
    evidence?: TaskEvidence
}
export const taskContext = new AsyncLocalStorage<TaskContext>()
export const confirmationContext = new AsyncLocalStorage<boolean>()

export function finitePoints(value: unknown): number | null {
    if (typeof value !== 'number' && typeof value !== 'string') return null
    if (typeof value === 'string' && !value.trim()) return null
    const number = Number(value)
    return Number.isFinite(number) && number >= 0 ? number : null
}
export function accountReference(email: string): string {
    return createHash('sha256').update(email.trim().toLowerCase()).digest('hex')
}
export function taskId(spec: TaskSpec): string {
    return `${spec.source}:${spec.source === 'rsc' && spec.offerId ? 'main' : spec.platform}:${spec.offerId || spec.key}`
}
export function reportTaskProgress(action: string, current?: number, total?: number, waitMs?: number): void {
    taskContext.getStore()?.publish({
        action,
        ...(current !== undefined && total !== undefined ? { attemptProgress: { current, total, unit: 'items' } } : {}),
        waitUntil: waitMs ? new Date(Date.now() + waitMs).toISOString() : null
    })
}
export function markTaskStatus(status: TaskStatus, action: string): void {
    const context = taskContext.getStore()
    if (!context) return
    context.explicitStatus = status
    context.explicitAction = action
    if (status === 'stopped') context.stopped = true
    if (status === 'failed') context.failed = true
    context.publish({ status, action })
}
export function recordTaskError(): void {
    if (confirmationContext.getStore()) return
    const context = taskContext.getStore()
    if (context) context.failed = true
}
export function reportTaskEvidence(evidence: Omit<TaskEvidence, 'observedAt'>): void {
    const context = taskContext.getStore()
    if (context) context.evidence = { ...evidence, observedAt: new Date().toISOString() }
}
export function reportTaskSubmission(balance?: unknown, creditedPoints?: unknown): void {
    markTaskStatus('submitted', '已提交，等待积分确认')
    taskContext.getStore()?.publish({ submitted: true })
    reportTaskEvidence({
        creditedPoints: finitePoints(creditedPoints),
        balance: finitePoints(balance),
        current: null,
        total: null,
        completed: null,
        unit: 'points'
    })
}
export function errorCategory(error: unknown): string {
    const status =
        (error as { status?: number; response?: { status?: number } })?.status ??
        (error as { response?: { status?: number } })?.response?.status
    if (status === 401 || status === 403) return 'authentication'
    if (status === 429) return 'rate-limit'
    return 'unavailable'
}

export class TaskTelemetry {
    private attemptedOffers = new Set<string>()
    private sequence = 0
    private session = randomUUID()
    constructor(
        private options: {
            account: () => string
            emit: (event: Record<string, unknown>) => void
            observe: (spec: TaskSpec) => Promise<TaskEvidence>
            wait: (ms: number) => Promise<unknown>
        }
    ) {}

    publish(payload: Record<string, unknown>): void {
        const sequence = ++this.sequence
        this.options.emit({
            version: 2,
            eventId: `${this.session}:${sequence}`,
            sequence,
            accountRef: accountReference(this.options.account()),
            at: new Date().toISOString(),
            ...payload
        })
    }

    async run<T>(spec: TaskSpec, action: () => Promise<T>): Promise<T> {
        const parent = taskContext.getStore()
        const id = taskId(spec)
        const attemptKey = `${accountReference(this.options.account())}:${id}`
        if (spec.offerId && !spec.group) {
            if (this.attemptedOffers.has(attemptKey)) {
                parent?.children.push('skipped')
                return (spec.counter ? 0 : undefined) as T
            }
            // Reserve before observing: parallel platforms must not both pass the guard.
            this.attemptedOffers.add(attemptKey)
        }
        const invocationId = randomUUID()
        const startedAt = new Date().toISOString()
        const base = { kind: 'task', id, invocationId, parentId: parent?.id ?? null, ...spec, startedAt }
        let latest: Record<string, unknown> = {
            status: 'running',
            action: `正在执行：${spec.title}`,
            verification: spec.group ? 'not-applicable' : 'pending',
            earnedPoints: null,
            expectedPoints: null,
            remainingPoints: null,
            progress: null
        }
        const publish = (patch: Record<string, unknown>) => {
            latest = { ...latest, ...patch }
            this.publish({ ...base, ...latest })
        }
        const context: TaskContext = { id, publish, failed: false, children: [], stopped: false }
        return taskContext.run(context, async () => {
            publish({})
            let before: TaskEvidence | null = null
            if (!spec.group) {
                try {
                    before = await confirmationContext.run(true, () => this.options.observe(spec))
                } catch {
                    /* Missing baseline cannot prove a gain. */
                }
                if (before)
                    publish({
                        expectedPoints: before.unit === 'points' ? before.total : null,
                        remainingPoints:
                            before.unit === 'points' && before.total !== null && before.current !== null
                                ? Math.max(0, before.total - before.current)
                                : null,
                        progress:
                            before.current !== null && before.total !== null
                                ? { current: before.current, total: before.total, unit: before.unit }
                                : null
                    })
                if (before?.completed === true) {
                    publish({
                        status: 'skipped',
                        action: '运行前已完成，本轮未提交活动',
                        terminal: true,
                        verification: 'not-applicable',
                        earnedPoints: null,
                        confirmedAt: null,
                        previouslyCompleted: true
                    })
                    parent?.children.push('skipped')
                    return (spec.counter ? 0 : undefined) as T
                }
                if (spec.source === 'app' && spec.offerId === CHECK_IN_OFFER && before?.completed !== false) {
                    publish({
                        status: 'unavailable',
                        action: '签到日期状态不可用，本轮未提交签到',
                        terminal: true,
                        verification: 'not-applicable',
                        earnedPoints: null,
                        dataStatus: 'unavailable'
                    })
                    parent?.children.push('unavailable')
                    return undefined as T
                }
            }
            let value!: T
            let failure: unknown
            try {
                value = await action()
            } catch (error) {
                failure = error
                context.failed = true
                publish({
                    status: 'failed',
                    action: `${spec.title}执行失败，核对已执行部分`,
                    errorCategory: errorCategory(error)
                })
            }
            let after: TaskEvidence | null = context.evidence ?? null
            let category: string | null = null
            const excluded = ['skipped', 'locked', 'unsupported', 'unavailable', 'interrupted']
            if (
                finitePoints(after?.creditedPoints) === null &&
                after?.current == null &&
                !spec.group &&
                !excluded.includes(context.explicitStatus ?? '')
            ) {
                const responseEvidence = after
                for (const [index, delay] of [0, 2000, 10000].entries()) {
                    publish({
                        status: 'verifying',
                        action: `正在核对${spec.title}，第 ${index + 1}/3 次`,
                        waitUntil: delay ? new Date(Date.now() + delay).toISOString() : null
                    })
                    if (delay) await confirmationContext.run(true, () => this.options.wait(delay))
                    try {
                        const observed = await confirmationContext.run(true, () => this.options.observe(spec))
                        after = {
                            ...observed,
                            completed: observed.completed ?? responseEvidence?.completed ?? null,
                            balance: observed.balance ?? responseEvidence?.balance ?? null
                        }
                        if (
                            (spec.offerId === CHECK_IN_OFFER && after.completed === true) ||
                            finitePoints(after.creditedPoints) !== null ||
                            (before?.current !== null &&
                                before?.current !== undefined &&
                                after.current !== null &&
                                after.current > before.current)
                        )
                            break
                    } catch (error) {
                        category = errorCategory(error)
                        if (category === 'authentication' || category === 'rate-limit') break
                    }
                }
            }
            const earned = excluded.includes(context.explicitStatus ?? '')
                ? null
                : (finitePoints(after?.creditedPoints) ??
                  (before?.unit === 'points' &&
                  after?.unit === 'points' &&
                  before.current !== null &&
                  after.current !== null &&
                  after.current >= before.current
                      ? after.current - before.current
                      : null))
            const officialCreditKey = after?.officialCreditId && earned !== null
                ? createHash('sha256').update(`${accountReference(this.options.account())}|${spec.source}|${after.officialCreditId}`).digest('hex')
                : null
            const verified = earned !== null && (officialCreditKey !== null || finitePoints(after?.creditedPoints) === null)
            let status: TaskStatus = context.failed ? 'failed' : (context.explicitStatus ?? 'running')
            if (spec.group) {
                status =
                    context.failed || context.children.includes('failed')
                        ? 'partial'
                        : context.explicitStatus
                          ? context.children.length
                              ? 'partial'
                              : context.explicitStatus
                          : context.children.length === 0
                            ? 'skipped'
                            : context.children.every(item => ['completed', 'skipped', 'locked'].includes(item))
                              ? context.children.some(item => item === 'completed')
                                  ? 'completed'
                                  : 'skipped'
                              : 'partial'
            } else if (!context.failed && !excluded.includes(status)) {
                status =
                    after?.completed === true
                        ? 'completed'
                        : earned !== null && earned > 0
                          ? 'partial'
                          : earned === 0
                            ? after?.completed === false
                                ? 'partial'
                                : 'completed'
                            : context.explicitStatus &&
                                ['partial', 'stopped', 'interrupted'].includes(context.explicitStatus)
                              ? context.explicitStatus
                              : context.explicitStatus === 'submitted'
                                ? 'submitted'
                                : 'unavailable'
            }
            const actions: Record<TaskStatus, string> = {
                pending: '等待执行',
                eligible: '可执行',
                submitted: '已提交，等待积分确认',
                unsupported: '当前版本不支持',
                unavailable: '任务数据不可用',
                running: '正在执行',
                verifying: '得分待复核',
                completed: '任务已完成',
                partial: '部分完成',
                stopped: '未得分停止',
                failed: '执行失败',
                skipped: '已跳过',
                locked: '尚未解锁',
                interrupted: '运行中断'
            }
            publish({
                status,
                action:
                    status === 'submitted'
                        ? `${spec.title}：已提交，本轮复核结束，未取得可确认的积分证据`
                        : context.explicitAction && status !== 'completed' && context.explicitAction !== actions[status]
                          ? `${spec.title}：${actions[status]}；${context.explicitAction}`
                          : `${spec.title}：${actions[status]}`,
                waitUntil: null,
                verification: spec.group
                    ? 'not-applicable'
                    : verified
                      ? earned === 0
                          ? 'confirmed-zero'
                          : 'confirmed'
                      : excluded.includes(status)
                        ? 'not-applicable'
                        : 'pending',
                earnedPoints: earned,
                reportedPoints: earned,
                officialCreditKey,
                evidenceSource: officialCreditKey ? 'official-credit' : finitePoints(after?.creditedPoints) !== null ? 'reported-credit' : verified ? 'official-progress' : null,
                progressBefore: before?.unit === 'points' ? before.current : null,
                progressAfter: after?.unit === 'points' ? after.current : null,
                confirmedAt: verified ? after?.observedAt : null,
                progress:
                    after?.current !== null && after?.current !== undefined && after.total !== null
                        ? { current: after.current, total: after.total, unit: after.unit }
                        : latest.progress,
                remainingPoints:
                    after?.unit === 'points' && after.current !== null && after.total !== null
                        ? Math.max(0, after.total - after.current)
                        : latest.remainingPoints,
                balance: after?.balance ?? null,
                balanceChange:
                    before?.balance !== null &&
                    before?.balance !== undefined &&
                    after?.balance !== null &&
                    after?.balance !== undefined
                        ? after.balance - before.balance
                        : null,
                dataStatus: spec.group
                    ? null
                    : after && (after.completed !== null || after.current !== null)
                      ? 'available'
                      : 'unavailable',
                errorCategory: category,
                terminal: true
            })
            if (
                !latest.submitted &&
                ['skipped', 'locked', 'unsupported', 'unavailable'].includes(context.explicitStatus ?? '')
            )
                this.attemptedOffers.delete(attemptKey)
            parent?.children.push(status)
            if (failure) throw failure
            return value
        })
    }
}
