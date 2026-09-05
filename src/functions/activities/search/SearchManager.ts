import { MicrosoftRewardsBot, executionContext } from '../../../index'
import { randomUUID } from 'node:crypto'
import type { Account } from '../../../interface/Account'
import { URLs } from '../../../constants/urls'
import { SearchProgress, type SearchQuota } from './SearchProgress'

interface SearchPlan {
    doMobile: boolean
    doDesktop: boolean
    mobileMissing: number | null
    desktopMissing: number | null
}

export class SearchManager {
    private readonly progress: SearchProgress

    constructor(private bot: MicrosoftRewardsBot) {
        this.progress = new SearchProgress(bot)
    }

    async getSearchPoints(): Promise<SearchPlan> {
        const workers = this.bot.config.workers
        const quotas = await this.progress.resolveQuotas([
            ...(workers.doMobileSearch ? ['mobile' as const] : []),
            ...(workers.doDesktopSearch ? ['desktop' as const] : [])
        ])
        const mobileMissing = quotas.mobile.known ? quotas.mobile.remaining : null
        const desktopQuota = this.progress.desktopQuota(quotas)
        const desktopMissing = desktopQuota.known ? desktopQuota.remaining : null

        const doMobile = workers.doMobileSearch && mobileMissing !== null && mobileMissing > 0
        const doDesktop = workers.doDesktopSearch && desktopMissing !== null && desktopMissing > 0
        for (const platform of ['mobile', 'desktop'] as const) {
            const enabled = platform === 'mobile' ? workers.doMobileSearch : workers.doDesktopSearch
            const missing = platform === 'mobile' ? mobileMissing : desktopMissing
            if (!enabled || missing !== null) continue
            const source = this.bot.browser.func.taskDashboardSource()
            this.bot.activities.telemetry.publish({
                invocationId: randomUUID(),
                kind: 'task',
                id: `${source}:${platform}:search`,
                key: 'search',
                source,
                platform,
                title: platform === 'mobile' ? '移动搜索' : '桌面搜索',
                status: 'verifying',
                verification: 'pending',
                earnedPoints: null,
                expectedPoints: null,
                remainingPoints: null,
                progress: null,
                terminal: true,
                action: '搜索额度复核失败，未提交搜索；不是已完成',
                dataStatus: 'unavailable'
            })
        }

        this.bot.logger.info(
            'main',
            'SEARCH-MANAGER',
            `Mobile: ${this.describeQuota(this.bot.config.workers.doMobileSearch, quotas.mobile)}` +
                ` | Desktop: ${this.describeQuota(this.bot.config.workers.doDesktopSearch, desktopQuota)}` +
                `${quotas.edge.max > 0 ? ` | Edge: ${quotas.edge.earned}/${quotas.edge.max}` : ''}`
        )

        return { doMobile, doDesktop, mobileMissing, desktopMissing }
    }

    private describeQuota(enabled: boolean, quota: SearchQuota): string {
        if (!enabled) return '开关已关闭'
        if (!quota.known) return '额度数据无法确认，未执行'
        if (quota.remaining <= 0) return `无需执行（${quota.earned}/${quota.max} 分）`
        return `准备执行（${quota.earned}/${quota.max} 分，剩余 ${quota.remaining} 分）`
    }

    searchMobile(account: Account): Promise<number> {
        return this.search(account, true)
    }

    searchDesktop(account: Account): Promise<number> {
        return this.search(account, false)
    }

    private search(account: Account, isMobile: boolean): Promise<number> {
        const platform = isMobile ? 'Mobile' : 'Desktop'
        const page = isMobile ? this.bot.mainMobilePage : this.bot.mainDesktopPage

        return executionContext.run({ isMobile, account }, async () => {
            try {
                return await this.bot.activities.doSearch(page, isMobile)
            } catch (error) {
                this.bot.logger.error(
                    'main',
                    'SEARCH-MANAGER',
                    `${platform} search failed | ${error instanceof Error ? error.message : String(error)}`
                )
                return 0
            }
        })
    }

    async bonusMobile(account: Account): Promise<number> {
        this.bot.logger.info('main', 'SEARCH-MANAGER', 'Starting bonus search farming')

        const gained = await executionContext.run({ isMobile: true, account }, async () => {
            try {
                return await this.bot.activities.doBonusSearches(this.bot.mainMobilePage)
            } catch (error) {
                this.bot.logger.error(
                    'main',
                    'SEARCH-MANAGER',
                    `Bonus search failed | ${error instanceof Error ? error.message : String(error)}`
                )
                return 0
            } finally {
                if (!this.bot.mainMobilePage.isClosed()) {
                    await this.bot.mainMobilePage.goto(URLs.bing.origin).catch(() => {})
                }
            }
        })

        this.bot.logger.info(
            'main',
            'SEARCH-MANAGER',
            `Bonus search summary | pointsGained=${gained} | currentBalance=${this.bot.userData.currentPoints}`
        )
        return gained
    }
}
