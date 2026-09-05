import { BaseActivity } from '../BaseActivity'
import type { AppDashboardData } from '../../../interface/AppDashBoardData'
import { appEligibility } from '../../../util/TaskEligibility'
import { markTaskStatus } from '../../../util/TaskTelemetry'

export class AppPromotions extends BaseActivity {
    public async run(data: AppDashboardData): Promise<void> {
        const pending = (data.response?.promotions ?? []).filter(promotion => {
            const attributes = promotion.attributes
            return (
                attributes['complete']?.toLowerCase() === 'false' &&
                appEligibility(promotion, this.bot.config).eligibility === 'eligible'
            )
        })

        if (!pending.length) {
            markTaskStatus('skipped', '没有可自动执行的应用活动')
            this.bot.logger.info(
                this.bot.isMobile,
                'APP-PROMOTIONS',
                '没有可自动执行的应用活动；已完成或不满足执行条件'
            )
            return
        }

        this.bot.logger.info(
            this.bot.isMobile,
            'APP-PROMOTIONS',
            `Started solving "App Promotions" items | remaining=${pending.length}`
        )
        for (const [index, promotion] of pending.entries()) {
            await this.bot.activities.doAppReward(promotion)
            if (index < pending.length - 1) {
                await this.bot.utils.wait(this.bot.utils.randomDelay(5000, 15000))
            }
        }
        this.bot.logger.info(this.bot.isMobile, 'APP-PROMOTIONS', 'Finished processing "App Promotions" items')
    }
}
