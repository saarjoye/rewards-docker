import type { MicrosoftRewardsBot } from '../../../index'
import type { Counters, DashboardImpression } from '../../../interface/DashboardData'
import type { MissingSearchPoints } from '../../../interface/Points'
import { finitePoints, errorCategory, type TaskEvidence } from '../../../util/TaskTelemetry'

export interface SearchQuota {
    earned: number
    max: number
    remaining: number
    known: boolean
    source: 'dashboard-counter' | 'flyout-counter' | 'react-snapshot' | 'html' | 'network-response' | 'unknown'
    reason: 'valid' | 'missing' | 'invalid'
    observedAt: string
    attempt: number
    elapsedMs: number
}

export interface SearchQuotas {
    mobile: SearchQuota
    desktop: SearchQuota
    edge: SearchQuota
}

export class SearchProgress {
    constructor(private readonly bot: MicrosoftRewardsBot) {}

    public async getCounters(): Promise<Counters> {
        const dashboard = await this.bot.browser.func.getDashboardData()
        return dashboard.dashboard?.userStatus?.counters ?? ({} as Counters)
    }

    public async getMissing(isMobile: boolean): Promise<MissingSearchPoints> {
        return this.missingFromQuotas(await this.resolveQuotas([isMobile ? 'mobile' : 'desktop']), isMobile)
    }

    public calculateMissing(counters: Counters, isMobile: boolean): MissingSearchPoints {
        return this.missingFromQuotas(this.calculateQuotas(counters), isMobile)
    }

    private missingFromQuotas(quotas: SearchQuotas, isMobile: boolean): MissingSearchPoints {
        const relevant = isMobile ? quotas.mobile : this.desktopQuota(quotas)
        if (!relevant.known) throw new Error('搜索额度数据缺失或无效，不能判定已完成')
        const mobilePoints = quotas.mobile.remaining
        const desktopPoints = quotas.desktop.remaining
        const edgePoints = quotas.edge.remaining

        return {
            mobilePoints,
            desktopPoints,
            edgePoints,
            totalPoints: isMobile ? mobilePoints : desktopPoints + edgePoints
        }
    }

    public calculateQuotas(counters: Counters): SearchQuotas {
        const pcCounters = Array.isArray(counters?.pcSearch)
            ? counters.pcSearch
            : Array.isArray((counters as Counters & { PCSearch?: DashboardImpression[] })?.PCSearch)
              ? (counters as Counters & { PCSearch?: DashboardImpression[] }).PCSearch!
              : []
        const explicitEdgeCounters = pcCounters.filter(counter => this.isEdgeCounter(counter))
        const desktopCounters = explicitEdgeCounters.length
            ? pcCounters.filter(counter => !this.isEdgeCounter(counter))
            : pcCounters

        return {
            mobile: this.summarize(
                Array.isArray(counters?.mobileSearch)
                    ? counters.mobileSearch
                    : (counters as Counters & { MobileSearch?: DashboardImpression[] })?.MobileSearch,
                'dashboard-counter'
            ),
            desktop:
                explicitEdgeCounters.length && !desktopCounters.length
                    ? this.empty(true, 'dashboard-counter')
                    : this.summarize(desktopCounters, 'dashboard-counter'),
            edge: explicitEdgeCounters.length
                ? this.summarize(explicitEdgeCounters, 'dashboard-counter')
                : this.empty(true, 'dashboard-counter')
        }
    }

    public desktopQuota(quotas: SearchQuotas): SearchQuota {
        return {
            earned: quotas.desktop.earned + quotas.edge.earned,
            max: quotas.desktop.max + quotas.edge.max,
            remaining: quotas.desktop.remaining + quotas.edge.remaining,
            known: quotas.desktop.known && quotas.edge.known,
            source: quotas.desktop.source === quotas.edge.source ? quotas.desktop.source : 'unknown',
            reason: quotas.desktop.known && quotas.edge.known ? 'valid' : 'missing',
            observedAt: quotas.desktop.observedAt > quotas.edge.observedAt ? quotas.desktop.observedAt : quotas.edge.observedAt,
            attempt: Math.max(quotas.desktop.attempt, quotas.edge.attempt),
            elapsedMs: Math.max(quotas.desktop.elapsedMs, quotas.edge.elapsedMs)
        }
    }

    // Only read the affected platform again; missing mobile data must not suppress desktop work.
    public async resolveQuotas(platforms: Array<'mobile' | 'desktop'>): Promise<SearchQuotas> {
        let quotas: SearchQuotas
        const startedAt = Date.now()
        try {
            quotas = this.calculateQuotas(await this.getCounters())
        } catch (error) {
            quotas = this.calculateQuotas({} as Counters)
            if (['authentication', 'rate-limit'].includes(errorCategory(error))) {
                for (const quota of [quotas.mobile, quotas.desktop, quotas.edge]) quota.elapsedMs = Date.now() - startedAt
                return quotas
            }
        }
        for (const quota of [quotas.mobile, quotas.desktop, quotas.edge]) quota.elapsedMs = Date.now() - startedAt
        const stopped = new Set<string>()
        for (const delay of [2000, 10000]) {
            const pending = platforms.filter(
                platform =>
                    !stopped.has(platform) && !(platform === 'mobile' ? quotas.mobile : this.desktopQuota(quotas)).known
            )
            if (!pending.length) break
            this.bot.logger.warn('main', 'SEARCH-MANAGER', `搜索额度缺失，${delay / 1000} 秒后只读复核；不会提交搜索`)
            await this.bot.utils.wait(delay)
            for (const platform of pending) {
                try {
                    const evidence = await this.bot.browser.func.observeTask({
                        key: 'search',
                        title: '搜索',
                        platform,
                        source:
                            platform === 'mobile'
                                ? delay === 2000
                                    ? 'rsc'
                                    : 'flyout'
                                : this.bot.browser.func.taskDashboardSource(),
                        counter: platform === 'mobile' ? 'mobileSearch' : 'pcSearch'
                    })
                    const quota = this.fromEvidence(evidence, delay === 2000 ? 1 : 2)
                    quota.elapsedMs = Date.now() - startedAt
                    if (platform === 'mobile') quotas.mobile = quota
                    else {
                        quotas.desktop = quota
                        quotas.edge = this.empty(true, quota.source)
                    }
                } catch (error) {
                    if (['authentication', 'rate-limit'].includes(errorCategory(error))) stopped.add(platform)
                }
            }
        }
        return quotas
    }

    private fromEvidence(evidence: TaskEvidence, attempt: number): SearchQuota {
        return this.summarize([
            { pointProgress: evidence.current, pointProgressMax: evidence.total }
        ] as DashboardImpression[], (evidence.source as SearchQuota['source']) ?? 'unknown', attempt)
    }

    private empty(known: boolean, source: SearchQuota['source']): SearchQuota {
        return {
            earned: 0,
            max: 0,
            remaining: 0,
            known,
            source,
            reason: known ? 'valid' : 'missing',
            observedAt: new Date().toISOString(),
            attempt: 0,
            elapsedMs: 0
        }
    }

    private summarize(
        counters: DashboardImpression[] | undefined,
        source: SearchQuota['source'] = 'unknown',
        attempt = 0
    ): SearchQuota {
        const observedAt = new Date().toISOString()
        if (!Array.isArray(counters) || !counters.length)
            return { ...this.empty(false, source), observedAt, attempt, reason: 'missing' }
        if (
            counters.some(counter => {
                const max = finitePoints(counter?.pointProgressMax)
                const earned = finitePoints(counter?.pointProgress)
                return max === null || earned === null || earned > max
            })
        )
            return { ...this.empty(false, source), observedAt, attempt, reason: 'invalid' }
        return counters.reduce<SearchQuota>(
            (quota, counter) => {
                const max = Number(counter.pointProgressMax)
                const earned = Number(counter.pointProgress)
                quota.earned += earned
                quota.max += max
                quota.remaining += max - earned
                return quota
            },
            { ...this.empty(true, source), observedAt, attempt, elapsedMs: 0 }
        )
    }

    private isEdgeCounter(counter: DashboardImpression): boolean {
        if (!counter || typeof counter !== 'object') return false
        return [counter.offerId, counter.name, counter.title, counter.promotionSubtype].some(
            value => typeof value === 'string' && /(^|[_\s-])edge([_\s-]|$)/i.test(value)
        )
    }
}
