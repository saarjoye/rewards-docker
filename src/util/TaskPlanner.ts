import type { Config } from '../interface/Config'
import {
    capabilityForPromotion,
    normalizePromotion,
    type TaskCapabilityState
} from './TaskCapabilityRegistry'

export type TaskEligibilityState =
    | 'eligible'
    | 'completed'
    | 'locked'
    | 'disabled'
    | 'manual-required'
    | 'not-applicable'
    | 'data-missing'
    | 'unknown'

export interface TaskPlanRecord {
    id: string
    taskType: string
    title: string
    source: string
    platform: 'mobile' | 'desktop' | 'app' | 'both'
    offerId?: string
    parentOfferId?: string
    capability: { state: TaskCapabilityState; adapter?: string; reason?: string }
    eligibility: { state: TaskEligibilityState; reason?: string }
    execution: { planned: boolean; status: 'not-planned' | 'planned'; order?: number }
    verification: {
        state: 'not-applicable' | 'pending' | 'confirmed' | 'confirmed-zero' | 'unavailable'
        earnedPoints: number | null
        expectedPoints: number | null
        balanceBefore: number | null
        balanceAfter: number | null
        balanceDelta: number | null
        evidenceSource?: string
    }
    progress?: { current: number | null; total: number | null; unit: 'points' | 'items' }
    dataStatus: 'available' | 'partial' | 'unavailable'
    reason?: string
}

export function planPromotion(
    raw: Record<string, unknown>,
    config: Config,
    options: { source: string; platform: TaskPlanRecord['platform']; order?: number; parentOfferId?: string }
): TaskPlanRecord {
    const promotion = normalizePromotion(raw, options.source)
    const capability = capabilityForPromotion(promotion)
    let eligibility: TaskPlanRecord['eligibility']
    let reason: string | undefined
    if (promotion.locked) eligibility = { state: 'locked', reason: '任务尚未解锁' }
    else if (promotion.completed === true) eligibility = { state: 'completed', reason: '读取时任务已完成，本轮未提交' }
    else if (capability.state === 'unknown') {
        eligibility = { state: 'data-missing', reason: capability.reason }
        reason = capability.reason
    } else if (capability.state === 'unsupported') {
        eligibility = { state: 'unknown', reason: capability.reason }
        reason = capability.reason
    } else if (
        (promotion.type === 'urlreward' && !config.activities.urlReward) ||
        (promotion.type === 'searchonbing' && !config.activities.searchOnBing) ||
        (promotion.type === 'visual-search' && !config.workers.doVisualSearch)
    ) eligibility = { state: 'disabled', reason: '对应任务开关已关闭' }
    else if ((promotion.type === 'claim' || promotion.type === 'redeem') && !config.autoClaimPunchcardRewards)
        eligibility = { state: 'manual-required', reason: '需要人工领取，未自动提交' }
    else eligibility = { state: 'eligible' }
    const planned = capability.state === 'supported' && eligibility.state === 'eligible'
    const current = promotion.currentPoints
    const total = promotion.expectedPoints
    return {
        id: promotion.offerId || options.source + ':' + (options.order ?? 0),
        taskType: promotion.rawType || promotion.type,
        title: promotion.title,
        source: options.source,
        platform: options.platform,
        offerId: promotion.offerId || undefined,
        parentOfferId: options.parentOfferId,
        capability,
        eligibility,
        execution: { planned, status: planned ? 'planned' : 'not-planned', order: options.order },
        verification: {
            state: planned ? 'pending' : 'not-applicable',
            earnedPoints: null,
            expectedPoints: total,
            balanceBefore: null,
            balanceAfter: null,
            balanceDelta: null,
            evidenceSource: current !== null || total !== null ? 'task-snapshot' : undefined
        },
        progress: current !== null || total !== null ? { current, total, unit: 'points' } : undefined,
        dataStatus: promotion.offerId ? 'available' : 'partial',
        reason
    }
}
