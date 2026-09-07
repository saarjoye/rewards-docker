import { sanitizeText } from './security.mjs'

export const TASK_STATUSES = [
    'pending',
    'eligible',
    'submitted',
    'unsupported',
    'unavailable',
    'running',
    'verifying',
    'completed',
    'partial',
    'stopped',
    'failed',
    'skipped',
    'locked',
    'interrupted'
]
export function nullableNumber(value) {
    if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null
    const number = Number(value)
    return Number.isFinite(number) ? number : null
}
const date = value => (typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null)
export function normalizedTasks(tasks, now = Date.now()) {
    if (!Array.isArray(tasks)) return []
    return tasks.slice(0, 500).map(task => {
        const startedAt = date(task?.startedAt)
        const lastProgressAt = date(task?.lastProgressAt ?? task?.updatedAt)
        const waitUntil = date(task?.waitUntil)
        const active = !task?.terminal && ['running', 'verifying'].includes(task?.status)
        const staleAt = waitUntil
            ? Date.parse(waitUntil) + 30000
            : lastProgressAt
              ? Date.parse(lastProgressAt) + 120000
              : null
        return {
            id: sanitizeText(task?.id ?? '', 180),
            title: sanitizeText(task?.title ?? 'Rewards 任务', 180),
            taskType: sanitizeText(task?.taskType ?? '', 60),
            source: sanitizeText(task?.source ?? '', 30),
            platform: sanitizeText(task?.platform ?? '', 20),
            capability: sanitizeText(task?.capability ?? '', 30),
            adapter: sanitizeText(task?.adapter ?? '', 80),
            eligibility: sanitizeText(task?.eligibility ?? '', 40),
            eligibilityReason: sanitizeText(task?.eligibilityReason ?? '', 240),
            planned: Boolean(task?.planned),
            executionOrder: Number.isInteger(task?.executionOrder) ? task.executionOrder : null,
            dataStatus: sanitizeText(task?.dataStatus ?? '', 30),
            evidenceSource: sanitizeText(task?.evidenceSource ?? '', 80),
            group: Boolean(task?.group),
            status: TASK_STATUSES.includes(task?.status) ? task.status : 'pending',
            verification:
                task?.telemetryVersion === 2
                    ? ['confirmed', 'confirmed-zero', 'pending', 'not-applicable', 'unavailable'].includes(task.verification)
                        ? task.verification
                        : 'pending'
                    : 'legacy',
            action: sanitizeText(task?.action ?? '', 500),
            progress:
                nullableNumber(task?.progress?.current) !== null && nullableNumber(task?.progress?.total) !== null
                    ? {
                          current: nullableNumber(task.progress.current),
                          total: nullableNumber(task.progress.total),
                          unit: task.progress.unit === 'items' ? 'items' : 'points'
                      }
                    : null,
            attemptProgress:
                nullableNumber(task?.attemptProgress?.current) !== null &&
                nullableNumber(task?.attemptProgress?.total) !== null
                    ? {
                          current: nullableNumber(task.attemptProgress.current),
                          total: nullableNumber(task.attemptProgress.total),
                          unit: 'items'
                      }
                    : null,
            expectedPoints: nullableNumber(task?.expectedPoints),
            remainingPoints: nullableNumber(task?.remainingPoints),
            earnedPoints: nullableNumber(task?.earnedPoints),
            balance: nullableNumber(task?.balance),
            balanceChange: nullableNumber(task?.balanceChange),
            previouslyCompleted: Boolean(task?.previouslyCompleted),
            confirmedAt: date(task?.confirmedAt),
            startedAt,
            lastProgressAt,
            waitUntil,
            updatedAt: date(task?.updatedAt),
            elapsedSeconds: startedAt
                ? Math.max(
                      0,
                      Math.floor(((active ? now : Date.parse(task.updatedAt) || now) - Date.parse(startedAt)) / 1000)
                  )
                : null,
            stale: Boolean(active && staleAt !== null && now > staleAt),
            terminal: Boolean(task?.terminal),
            telemetryVersion: task?.telemetryVersion === 2 ? 2 : null,
            errorCategory: sanitizeText(task?.errorCategory ?? '', 40) || null
        }
    })
}

export function currentTasks(tasks) {
    if (!Array.isArray(tasks)) return []
    return tasks.filter(
        task =>
            (task?.eligibility === 'eligible' && task?.planned && !task?.previouslyCompleted) ||
            (task?.invocationId &&
                !task?.previouslyCompleted &&
                (!['skipped', 'locked', 'unsupported', 'unavailable'].includes(task?.status) || task?.submitted)) ||
            ['running', 'verifying', 'partial', 'stopped', 'failed', 'interrupted'].includes(task?.status)
    )
}
