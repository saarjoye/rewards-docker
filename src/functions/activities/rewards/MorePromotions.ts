import { BaseActivity } from '../BaseActivity'
import type { BasePromotion, DashboardData } from '../../../interface/DashboardData'
import { PromotionActivityRunner } from './PromotionActivityRunner'
import { promotionEligibility } from '../../../util/TaskEligibility'
import { markTaskStatus } from '../../../util/TaskTelemetry'

export class MorePromotions extends BaseActivity {
    public async run(data: DashboardData): Promise<void> {
        const promotions = [
            ...new Map(
                [
                    ...(data.dashboard.morePromotions ?? []),
                    ...(data.dashboard.morePromotionsWithoutPromotionalItems ?? [])
                ]
                    .filter(Boolean)
                    .map(promotion => [promotion.offerId, promotion as BasePromotion] as const)
            ).values()
        ]

        const pending = promotions.filter(
            promotion =>
                !promotion.complete &&
                promotionEligibility(promotion, this.bot.config, 'more').eligibility === 'eligible'
        )
        if (!pending.length) {
            markTaskStatus('skipped', '没有可自动执行的推广任务')
            this.bot.logger.info(
                this.bot.isMobile,
                'MORE-PROMOTIONS',
                '没有可自动执行的推广任务；已完成或不满足执行条件'
            )
            return
        }

        this.bot.logger.info(
            this.bot.isMobile,
            'MORE-PROMOTIONS',
            `Started solving "More Promotions" items | remaining=${pending.length}`
        )
        await new PromotionActivityRunner(this.bot).run(pending)
        this.bot.logger.info(this.bot.isMobile, 'MORE-PROMOTIONS', 'Finished processing "More Promotions" items')
    }
}
