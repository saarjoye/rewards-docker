import type { Config } from '../interface/Config'
import type { BasePromotion } from '../interface/DashboardData'
import type { ParsedOffer, QuestChild } from '../browser/ReactFunc'
import type { Promotion } from '../interface/AppDashBoardData'
import { finitePoints } from './TaskTelemetry'

export interface TaskEligibility {
    eligibility: 'eligible' | 'excluded' | 'unknown'
    eligibilityReason: string
}
const allowed: TaskEligibility = { eligibility: 'eligible', eligibilityReason: '' }
const excluded = (reason: string): TaskEligibility => ({ eligibility: 'excluded', eligibilityReason: reason })
const unknown = (reason: string): TaskEligibility => ({ eligibility: 'unknown', eligibilityReason: reason })
const truthy = (value: unknown): boolean => value === true || String(value).toLowerCase() === 'true'

// Use execution metadata, never translated titles, to decide whether a task can run.
export function promotionEligibility(
    promotion: BasePromotion,
    config: Config,
    group: 'daily' | 'more'
): TaskEligibility {
    if (!(group === 'daily' ? config.workers.doDailySet : config.workers.doMorePromotions))
        return excluded('任务开关已关闭')
    if (promotion.exclusiveLockedFeatureStatus === 'locked') return excluded('活动尚未解锁')
    if (group === 'more') {
        if (promotion.priority < 0 && promotion.exclusiveLockedFeatureStatus !== 'unlocked')
            return excluded('活动尚未开放')
        if (truthy((promotion.attributes as Record<string, unknown> | undefined)?.promotional))
            return excluded('推广卡片不属于此执行器支持的任务')
    }
    const type = promotion.promotionType?.toLowerCase()
    if (!type) return unknown('任务类型缺失，无法确定执行方式')
    if (type !== 'urlreward') return excluded('当前版本没有此类任务执行器')
    const search = promotion.name?.toLowerCase().includes('exploreonbing')
    if (!(search ? config.activities.searchOnBing : config.activities.urlReward)) return excluded('活动执行开关已关闭')
    const points = finitePoints(promotion.pointProgressMax)
    if (points === 0 && config.skipNonPointTasks) return excluded('按配置排除无积分活动')
    if (points === null) return unknown('活动积分数据缺失，等待核对')
    return allowed
}

export function offerEligibility(offer: ParsedOffer, config: Config, today: string): TaskEligibility {
    if (offer.isLocked || offer.isDisabled) return excluded('活动尚未解锁或已禁用')
    if (offer.date && offer.date > today) return excluded('活动尚未开放')
    const id = offer.offerId.toLowerCase()
    if (id.includes('pcchild') || id.includes('pcparent') || id.includes('punchcard')) {
        if (!config.workers.doPunchCards) return excluded('打卡任务开关已关闭')
        if (/search/i.test(id) && /(day|streak|\dx)/i.test(id)) return excluded('多日搜索任务不能直接上报完成')
        if (/(redeem|claim|(?<!url)reward)/i.test(id) && !config.autoClaimPunchcardRewards)
            return excluded('此奖励仅允许手动领取')
        return unknown('打卡任务需要读取子任务条件')
    }
    if (/visual.?search/.test(id)) return config.workers.doVisualSearch ? allowed : excluded('视觉搜索开关已关闭')
    if (id === 'edge_flight_1_ww_treatment_eligible' || /edgebrowsing|edge.*brows/.test(id))
        return config.experimental.edgeBrowsing ? allowed : excluded('Edge 浏览任务开关已关闭')
    if (/optin[_-]?\d+x(?:[_-]|$)/.test(id))
        return config.workers.doActivateSearchPerk ? allowed : excluded('搜索加成开关已关闭')
    if (offer.observedPoints === 0 && config.skipNonPointTasks) return excluded('按配置排除无积分活动')
    if (!offer.promotionType) return unknown('任务执行条件待核对')
    if (offer.promotionType.toLowerCase() !== 'urlreward') return excluded('当前版本没有此类任务执行器')
    // A dated offer belongs to the daily set; otherwise it may be in either dashboard pool.
    if (!offer.date && config.workers.doDailySet && !config.workers.doMorePromotions)
        return unknown('等待核对任务所属分组')
    return promotionEligibility(
        {
            ...offer,
            name: offer.name ?? offer.offerId,
            pointProgressMax: offer.observedPoints,
            exclusiveLockedFeatureStatus: offer.isLocked ? 'locked' : '',
            attributes: { promotional: offer.isPromotional }
        } as unknown as BasePromotion,
        config,
        offer.date ? 'daily' : 'more'
    )
}

export function appEligibility(promotion: Promotion, config: Config): TaskEligibility {
    if (!config.workers.doAppPromotions) return excluded('应用活动开关已关闭')
    const attrs = promotion.attributes ?? {}
    if (!attrs.offerid || !attrs.type) return unknown('应用任务元数据缺失')
    if (attrs.type !== 'sapphire') return excluded('当前应用执行器不支持此类型')
    if (!['true', 'false'].includes(attrs.complete?.toLowerCase() ?? '')) return unknown('应用任务完成状态缺失')
    return allowed
}

export function questEligibility(child: QuestChild, config: Config, promotion?: BasePromotion): TaskEligibility {
    if (!config.workers.doPunchCards) return excluded('打卡任务开关已关闭')
    if (child.isLocked || child.isDisabled) return excluded('打卡子任务尚未解锁或已禁用')
    const attrs = promotion?.attributes as Record<string, unknown> | undefined
    if (
        promotion?.promotionType?.toLowerCase() === 'search' ||
        String(attrs?.type ?? '').toLowerCase() === 'search' ||
        Number(promotion?.activityProgressMax ?? 0) > 1 ||
        (/search/i.test(child.offerId) && /(day|streak|\dx)/i.test(child.offerId))
    )
        return excluded('多日搜索任务不能直接上报完成')
    if (isClaimQuestChild(child.offerId, promotion) && !config.autoClaimPunchcardRewards)
        return excluded('此奖励仅允许手动领取')
    if (!child.isCompleted && !child.hash) return unknown('缺少当前活动提交数据，等待核对')
    return allowed
}

export function isClaimQuestChild(offerId: string, promotion?: BasePromotion): boolean {
    return (
        /\/redeem\//.test((promotion?.destinationUrl ?? '').toLowerCase()) ||
        /(redeem|claim|(?<!url)reward)/i.test(offerId)
    )
}
