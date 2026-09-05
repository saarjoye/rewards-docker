import { finitePoints, type TaskEvidence, type TaskSpec } from './TaskTelemetry'

function object(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}
function array(value: unknown): unknown[] {
    return Array.isArray(value) ? value : []
}

export function evidenceFromPayload(spec: TaskSpec, payload: unknown): TaskEvidence {
    const root = object(payload)
    const data =
        spec.source === 'app'
            ? object(root.response)
            : spec.source === 'flyout'
              ? object(root.flyoutResult)
              : spec.source === 'rsc'
                ? root
                : object(root.dashboard)
    const user = object(data.userStatus)
    const evidence: TaskEvidence = {
        balance: finitePoints(
            spec.source === 'app'
                ? data.balance
                : spec.source === 'rsc'
                  ? object(data.account).availablePoints
                  : (user.availablePoints ?? object(root.userInfo).balance)
        ),
        current: null,
        total: null,
        completed: null,
        unit: 'points',
        observedAt: new Date().toISOString()
    }
    if (spec.counter) {
        const counters = object(user.counters)
        const alias = spec.counter === 'pcSearch' ? 'PCSearch' : 'MobileSearch'
        const items = array(counters[spec.counter] ?? counters[alias])
        if (!items.length) return evidence
        const pairs = items.map(item => [
            finitePoints(object(item).pointProgress),
            finitePoints(object(item).pointProgressMax)
        ])
        if (pairs.some(pair => pair[0] === null || pair[1] === null)) return evidence
        evidence.current = pairs.reduce((sum, pair) => sum + pair[0]!, 0)
        evidence.total = pairs.reduce((sum, pair) => sum + pair[1]!, 0)
        evidence.completed = evidence.current >= evidence.total
        return evidence
    }
    if (spec.source === 'rsc') {
        const offer = array(data.offers)
            .map(object)
            .find(item => item.offerId === spec.offerId)
        if (offer) {
            evidence.completed =
                offer.completionKnown !== false && typeof offer.isCompleted === 'boolean' ? offer.isCompleted : null
            evidence.total = finitePoints(Object.hasOwn(offer, 'observedPoints') ? offer.observedPoints : offer.points)
            evidence.current = finitePoints(offer.pointProgress)
            // Advertised points are not a measured per-task credit.
        }
        return evidence
    }
    const candidates =
        spec.source === 'app'
            ? array(data.promotions)
            : [
                  ...array(data.morePromotions),
                  ...Object.values(object(data.dailySetPromotions)).flatMap(array),
                  ...array(data.highValueActionPromotions),
                  ...array(data.promotionalItems)
              ]
    const offer = candidates
        .map(object)
        .find(item => (spec.source === 'app' ? object(item.attributes).offerid : item.offerId) === spec.offerId)
    if (!offer) return evidence
    const attrs = spec.source === 'app' ? object(offer.attributes) : offer
    evidence.current = finitePoints(attrs.pointprogress ?? attrs.pointProgress)
    evidence.total = finitePoints(attrs.pointmax ?? attrs.pointProgressMax)
    if (evidence.current !== null && evidence.total !== null) evidence.completed = evidence.current >= evidence.total
    else if (typeof attrs.complete === 'boolean') evidence.completed = attrs.complete
    else if (attrs.complete === 'true' || attrs.complete === 'false') evidence.completed = attrs.complete === 'true'
    return evidence
}
