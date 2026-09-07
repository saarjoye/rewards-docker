export type TaskCapabilityState = 'supported' | 'unsupported' | 'unknown'

export type NormalizedPromotionType =
    | 'urlreward'
    | 'searchonbing'
    | 'punchcard'
    | 'quest-child'
    | 'sapphire'
    | 'claim'
    | 'redeem'
    | 'visual-search'
    | 'edge-browsing'
    | 'unknown'

export interface NormalizedPromotion {
    type: NormalizedPromotionType
    offerId: string
    title: string
    source: string
    rawType: string | null
    reportable: boolean | null
    locked: boolean
    completed: boolean | null
    expectedPoints: number | null
    currentPoints: number | null
    reason?: string
}

const supported = new Set<NormalizedPromotionType>([
    'urlreward',
    'searchonbing',
    'punchcard',
    'quest-child',
    'sapphire',
    'claim',
    'redeem',
    'visual-search',
    'edge-browsing'
])

function text(value: unknown): string {
    return typeof value === 'string' ? value.trim() : ''
}

function number(value: unknown): number | null {
    if (typeof value !== 'number' && typeof value !== 'string') return null
    const parsed = Number(value)
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

export function normalizePromotionType(promotion: Record<string, unknown>): NormalizedPromotionType {
    const attributes = promotion.attributes && typeof promotion.attributes === 'object'
        ? (promotion.attributes as Record<string, unknown>)
        : {}
    const raw = text(promotion.promotionType || promotion.activityType || promotion.type || attributes.type).toLowerCase()
    const id = text(promotion.offerId || promotion.offerid || attributes.offerid).toLowerCase()
    const destination = text(promotion.destinationUrl).toLowerCase()
    if (raw === 'urlreward' || raw === 'url-reward') return 'urlreward'
    if (raw === 'searchonbing' || raw === 'search' || /searchonbing/.test(id)) return 'searchonbing'
    if (raw === 'punchcard' || /punchcard|pcparent/.test(id)) return 'punchcard'
    if (raw === 'quest-child' || /pcchild/.test(id)) return 'quest-child'
    if (raw === 'sapphire') return 'sapphire'
    if (raw === 'claim' || /claim/.test(id) || /claim/.test(destination)) return 'claim'
    if (raw === 'redeem' || /redeem/.test(id) || /redeem/.test(destination)) return 'redeem'
    if (raw === 'visual-search' || /visual.?search/.test(id)) return 'visual-search'
    if (raw === 'edge-browsing' || /edge.*brows|edge_flight/.test(id)) return 'edge-browsing'
    return 'unknown'
}

export function normalizePromotion(promotion: Record<string, unknown>, source = 'unknown'): NormalizedPromotion {
    const attributes = promotion.attributes && typeof promotion.attributes === 'object'
        ? (promotion.attributes as Record<string, unknown>)
        : {}
    const offerId = text(promotion.offerId || promotion.offerid || attributes.offerid)
    const rawType = text(promotion.promotionType || promotion.activityType || promotion.type || attributes.type) || null
    const type = normalizePromotionType({ ...promotion, attributes })
    const locked =
        promotion.isLocked === true ||
        promotion.exclusiveLockedFeatureStatus === 'locked' ||
        attributes.isLocked === true
    const completed =
        typeof promotion.isCompleted === 'boolean'
            ? promotion.isCompleted
            : typeof promotion.complete === 'boolean'
              ? promotion.complete
              : typeof attributes.complete === 'string' && ['true', 'false'].includes(attributes.complete.toLowerCase())
                ? attributes.complete.toLowerCase() === 'true'
                : null
    const reportable = typeof promotion.reportable === 'boolean' ? promotion.reportable : null
    return {
        type,
        offerId,
        title: text(promotion.title || promotion.name) || offerId || '未命名任务',
        source,
        rawType,
        reportable,
        locked,
        completed,
        expectedPoints: number(promotion.pointProgressMax ?? promotion.points ?? attributes.pointmax),
        currentPoints: number(promotion.pointProgress ?? attributes.pointprogress)
    }
}

export function capabilityForPromotion(promotion: NormalizedPromotion): {
    state: TaskCapabilityState
    adapter?: string
    reason?: string
} {
    if (!promotion.offerId)
        return { state: 'unknown', reason: '任务类型或 offerId 缺失' }
    if (promotion.type === 'unknown')
        return {
            state: 'unsupported',
            adapter: promotion.rawType ? `promotion:${promotion.rawType}` : 'promotion:unknown',
            reason: promotion.rawType
                ? `当前版本不支持 promotionType=${promotion.rawType}`
                : '当前版本不支持未知任务类型'
        }
    if (promotion.offerId === '')
        return { state: 'unknown', reason: '任务类型或 offerId 缺失' }
    if (!supported.has(promotion.type))
        return { state: 'unsupported', reason: '当前版本没有 ' + promotion.type + ' 执行适配器' }
    return { state: 'supported', adapter: promotion.type }
}
