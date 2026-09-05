import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomUUID } from 'node:crypto'

export type TaskStatus =
    | 'pending'
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
    creditedPoints?: number | null
    balance: number | null
    current: number | null
    total: number | null
    completed: boolean | null
    unit: 'points' | 'items'
    observedAt: string
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
    return `${spec.source}:${spec.platform}:${spec.offerId || spec.key}`
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
export function errorCategory(error: unknown): string {
    const status =
        (error as { status?: number; response?: { status?: number } })?.status ??
        (error as { response?: { status?: number } })?.response?.status
    if (status === 401 || status === 403) return 'authentication'
    if (status === 429) return 'rate-limit'
    return 'unavailable'
}

export class TaskTelemetry {
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
                        expectedPoints: before.total,
                        remainingPoints:
                            before.total !== null && before.current !== null
                                ? Math.max(0, before.total - before.current)
                                : null,
                        progress:
                            before.current !== null && before.total !== null
                                ? { current: before.current, total: before.total, unit: before.unit }
                                : null
                    })
                if (before?.completed === true) {
                    publish({
                        status: 'completed',
                        action: '运行前已完成，本轮未提交活动',
                        terminal: true,
                        verification: 'confirmed',
                        earnedPoints: 0,
                        confirmedAt: before.observedAt
                    })
                    parent?.children.push('completed')
                    return (spec.counter ? 0 : undefined) as T
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
            if (!after && !spec.group && !['skipped', 'locked', 'interrupted'].includes(context.explicitStatus ?? '')) {
                for (const [index, delay] of [0, 2000, 10000].entries()) {
                    publish({
                        status: 'verifying',
                        action: `正在核对${spec.title}，第 ${index + 1}/3 次`,
                        waitUntil: delay ? new Date(Date.now() + delay).toISOString() : null
                    })
                    if (delay) await confirmationContext.run(true, () => this.options.wait(delay))
                    try {
                        after = await confirmationContext.run(true, () => this.options.observe(spec))
                        if (
                            after.completed === true ||
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
            const earned =
                finitePoints(after?.creditedPoints) ??
                (before?.unit === 'points' &&
                after?.unit === 'points' &&
                before.current !== null &&
                after.current !== null &&
                after.current >= before.current
                    ? after.current - before.current
                    : null)
            const verified = earned !== null
            let status: TaskStatus = context.failed ? 'failed' : (context.explicitStatus ?? 'verifying')
            if (spec.group) {
                status =
                    context.failed || context.children.includes('failed')
                        ? 'partial'
                        : context.explicitStatus
                          ? context.explicitStatus
                          : context.children.length === 0
                            ? 'skipped'
                            : context.children.every(item => ['completed', 'skipped', 'locked'].includes(item))
                              ? 'completed'
                              : 'partial'
            } else if (!context.failed && !['skipped', 'locked', 'interrupted'].includes(status)) {
                status =
                    after?.completed === true
                        ? 'completed'
                        : earned !== null && earned > 0
                          ? 'partial'
                          : earned === 0
                            ? 'stopped'
                            : context.explicitStatus &&
                                ['partial', 'stopped', 'interrupted'].includes(context.explicitStatus)
                              ? context.explicitStatus
                              : 'verifying'
            }
            const actions: Record<TaskStatus, string> = {
                pending: '等待执行',
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
                    context.explicitAction && status !== 'completed'
                        ? `${spec.title}：${actions[status]}；${context.explicitAction}`
                        : `${spec.title}：${actions[status]}`,
                waitUntil: null,
                verification: spec.group
                    ? 'not-applicable'
                    : verified
                      ? 'confirmed'
                      : ['skipped', 'locked'].includes(status)
                        ? 'not-applicable'
                        : 'pending',
                earnedPoints: earned,
                confirmedAt: verified ? after?.observedAt : null,
                progress:
                    after?.current !== null && after?.current !== undefined && after.total !== null
                        ? { current: after.current, total: after.total, unit: after.unit }
                        : latest.progress,
                remainingPoints:
                    after?.current !== null && after?.current !== undefined && after.total !== null
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
            parent?.children.push(status)
            if (failure) throw failure
            return value
        })
    }
}
