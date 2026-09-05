import type { MicrosoftRewardsBot } from '../index'

import { DailySet } from './activities/rewards/DailySet'
import { MorePromotions } from './activities/rewards/MorePromotions'
import { PunchCards } from './activities/rewards/PunchCards'

import { DailyCheckIn } from './activities/app/DailyCheckIn'
import { ReadToEarn } from './activities/app/ReadToEarn'
import { AppReward } from './activities/app/AppReward'
import { AppPromotions } from './activities/app/AppPromotions'

import { UrlReward } from './activities/api/UrlReward'
import { ClaimBonusPoints } from './activities/api/ClaimBonusPoints'
import { EnsureStreakProtection } from './activities/api/EnsureStreakProtection'
import { ClaimReward } from './activities/api/ClaimReward'
import { ActivateSearchPerk } from './activities/api/ActivateSearchPerk'
import { VisualSearch } from './activities/visualSearch/VisualSearch'

import { Search as BrowserSearch } from './activities/search/BrowserSearch'
import { SearchOnBing as BrowserSearchOnBing } from './activities/search/BrowserSearchOnBing'

import { ApiSearch } from './activities/experimental/ApiSearch'
import { ApiSearchOnBing } from './activities/experimental/ApiSearchOnBing'
import { EdgeBrowsing } from './activities/experimental/EdgeBrowsing'

import type { Page } from 'patchright'
import type { BasePromotion, DashboardData } from '../interface/DashboardData'
import type { AppDashboardData, Promotion } from '../interface/AppDashBoardData'
import type { QuestChild } from '../browser/ReactFunc'
import { TaskTelemetry, accountReference, type TaskSpec, type TaskSource } from '../util/TaskTelemetry'
import { evidenceFromPayload } from '../util/TaskEvidence'
import { promotionEligibility } from '../util/TaskEligibility'

export default class Activities {
    private bot: MicrosoftRewardsBot
    readonly telemetry: TaskTelemetry

    constructor(bot: MicrosoftRewardsBot) {
        this.bot = bot
        this.telemetry = new TaskTelemetry({
            account: () => this.bot.currentAccountEmail ?? '',
            emit: event => this.bot.logger.info('main', 'TASK-EVENT', JSON.stringify(event)),
            observe: spec => this.bot.browser.func.observeTask(spec),
            wait: ms => this.bot.utils.wait(ms)
        })
    }

    private run<T>(
        key: string,
        title: string,
        source: TaskSource,
        action: () => Promise<T>,
        options: Partial<TaskSpec> = {}
    ): Promise<T> {
        return this.telemetry.run(
            { key, title, source, platform: this.bot.isMobile ? 'mobile' : 'desktop', ...options },
            action
        )
    }

    publishPlan(data: DashboardData, appAvailable: boolean): void {
        const emit = (source: TaskSource, platform: string, dataStatus: string, tasks: unknown[]) =>
            this.bot.logger.info(
                'main',
                'TASK-SNAPSHOT',
                JSON.stringify({
                    version: 2,
                    accountRef: accountReference(this.bot.currentAccountEmail ?? ''),
                    source,
                    platform,
                    dataStatus,
                    planned: true,
                    tasks
                })
            )
        const workers = this.bot.config.workers
        const today = this.bot.utils.getFormattedDate()
        const promotions = new Map<string, { promotion: BasePromotion; group: 'daily' | 'more' }>()
        for (const promotion of [
            ...(data.dashboard.morePromotions ?? []),
            ...(data.dashboard.morePromotionsWithoutPromotionalItems ?? [])
        ])
            promotions.set(promotion.offerId, { promotion, group: 'more' })
        for (const promotion of data.dashboard.dailySetPromotions?.[today] ?? [])
            promotions.set(promotion.offerId, { promotion, group: 'daily' })
        emit(
            'rsc',
            this.bot.isMobile ? 'mobile' : 'desktop',
            'available',
            [...promotions.values()].map(({ promotion, group }) => ({
                id: promotion.offerId,
                title: promotion.title,
                points: promotion.pointProgressMax,
                current: promotion.pointProgress,
                completed: promotion.complete,
                ...promotionEligibility(promotion, this.bot.config, group)
            }))
        )
        for (const platform of ['mobile', 'desktop'] as const) {
            if (!(platform === 'mobile' ? workers.doMobileSearch : workers.doDesktopSearch)) continue
            const evidence = evidenceFromPayload(
                {
                    key: 'search',
                    title: '搜索',
                    source: 'dashboard',
                    platform,
                    counter: platform === 'mobile' ? 'mobileSearch' : 'pcSearch'
                },
                data
            )
            emit(
                this.bot.browser.func.taskDashboardSource(),
                platform,
                evidence.total === null ? 'unavailable' : 'available',
                [
                    {
                        id: 'search',
                        title: platform === 'mobile' ? '移动搜索' : '桌面搜索',
                        points: evidence.total,
                        current: evidence.current,
                        completed: evidence.completed === true
                    }
                ]
            )
        }
        const tasks = [
            ...(workers.doReadToEarn ? [{ id: 'ENUS_readarticle3_30points', title: '阅读文章' }] : []),
            ...(workers.doDailyCheckIn ? [{ id: 'Gamification_Sapphire_DailyCheckIn', title: '每日签到' }] : [])
        ]
        if (tasks.length)
            emit(
                'app',
                'mobile',
                appAvailable ? 'pending' : 'unavailable',
                tasks.map(task => ({ ...task, unavailable: !appAvailable }))
            )
    }

    doSearch = async (page: Page, isMobile: boolean): Promise<number> => {
        return this.run(
            'search',
            isMobile ? '移动搜索' : '桌面搜索',
            this.bot.browser.func.taskDashboardSource(),
            async () => {
                if (this.bot.config.experimental.apiSearch) return new ApiSearch(this.bot).doSearch(isMobile)
                return new BrowserSearch(this.bot).doSearch(page, isMobile)
            },
            { platform: isMobile ? 'mobile' : 'desktop', counter: isMobile ? 'mobileSearch' : 'pcSearch' }
        )
    }

    doBonusSearches = async (page: Page): Promise<number> => {
        return this.run('bonus-search', '奖励搜索', this.bot.browser.func.taskDashboardSource(), async () => {
            if (this.bot.config.experimental.apiSearch) return new ApiSearch(this.bot).doBonusSearches()
            return new BrowserSearch(this.bot).doBonusSearches(page)
        })
    }

    doSearchOnBing = async (promotion: BasePromotion, page: Page): Promise<void> => {
        await this.run(
            'search-offer',
            promotion.title || '活动搜索',
            'rsc',
            async () => {
                if (this.bot.config.experimental.apiSearchOnBing)
                    return new ApiSearchOnBing(this.bot).doSearchOnBing(promotion)
                return new BrowserSearchOnBing(this.bot).doSearchOnBing(promotion, page)
            },
            { offerId: promotion.offerId }
        )
    }

    doDailySet = async (data: DashboardData): Promise<void> => {
        await this.run('daily-set', '每日任务', 'group', () => new DailySet(this.bot).run(data), { group: true })
    }

    doMorePromotions = async (data: DashboardData): Promise<void> => {
        await this.run('promotions', '更多推广', 'group', () => new MorePromotions(this.bot).run(data), { group: true })
    }

    doPunchCardsMobile = async (data: DashboardData): Promise<void> => {
        await this.run('punchcards', '移动打卡', 'group', () => new PunchCards(this.bot).runMobile(data), {
            group: true
        })
    }

    doPunchCardsDesktop = async (): Promise<void> => {
        await this.run('punchcards', '桌面打卡', 'group', () => new PunchCards(this.bot).runDesktop(), { group: true })
    }

    doUrlReward = async (promotion: BasePromotion): Promise<void> => {
        const urlReward = new UrlReward(this.bot)
        await this.run('url-reward', promotion.title || '每日活动', 'rsc', () => urlReward.doUrlReward(promotion), {
            offerId: promotion.offerId
        })
    }

    doClaimBonusPoints = async (): Promise<void> => {
        const claimBonusPoints = new ClaimBonusPoints(this.bot)
        await this.run('claim-bonus', '领取奖励积分', 'rsc', () => claimBonusPoints.claimBonusPoints())
    }

    doEnsureStreakProtection = async (): Promise<void> => {
        const ensureStreakProtection = new EnsureStreakProtection(this.bot)
        await this.run('streak-protection', '连续签到保护', 'rsc', () =>
            ensureStreakProtection.ensureStreakProtection()
        )
    }

    doClaimReward = async (child: QuestChild, parentId: string): Promise<void> => {
        const claimReward = new ClaimReward(this.bot)
        await this.run('claim-reward', '领取活动奖励', 'rsc', () => claimReward.claimReward(child, parentId), {
            offerId: child.offerId,
            parentOfferId: parentId
        })
    }

    doActivateSearchPerk = async (data: DashboardData): Promise<void> => {
        const activateSearchPerk = new ActivateSearchPerk(this.bot)
        await this.run('activate-perk', '激活搜索加成', 'rsc', () => activateSearchPerk.activate(data))
    }

    doVisualSearch = async (data: DashboardData): Promise<number> => {
        const visualSearch = new VisualSearch(this.bot)
        return this.run('visual-search', '视觉搜索', 'rsc', () => visualSearch.doVisualSearch(data))
    }

    doAppReward = async (promotion: Promotion): Promise<void> => {
        const urlReward = new AppReward(this.bot)
        await this.run('app-reward', '应用任务', 'app', () => urlReward.doAppReward(promotion), {
            offerId: promotion.attributes.offerid
        })
    }

    doReadToEarn = async (): Promise<void> => {
        const readToEarn = new ReadToEarn(this.bot)
        await this.run('read', '阅读文章', 'app', () => readToEarn.doReadToEarn(), {
            offerId: 'ENUS_readarticle3_30points'
        })
    }

    doDailyCheckIn = async (): Promise<void> => {
        const dailyCheckIn = new DailyCheckIn(this.bot)
        await this.run('check-in', '每日签到', 'app', () => dailyCheckIn.doDailyCheckIn(), {
            offerId: 'Gamification_Sapphire_DailyCheckIn',
            channel: 'SAIOS'
        })
    }

    doAppPromotions = async (data: AppDashboardData): Promise<void> => {
        await this.run('app-promotions', '应用活动', 'group', () => new AppPromotions(this.bot).run(data), {
            group: true
        })
    }

    doEdgeBrowsing = async (data: DashboardData, signal?: AbortSignal): Promise<void> => {
        const edgeBrowsing = new EdgeBrowsing(this.bot)
        await this.run('edge-browsing', 'Edge 浏览任务', 'rsc', () => edgeBrowsing.run(data, signal))
    }
}
