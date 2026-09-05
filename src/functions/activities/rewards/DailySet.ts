import { BaseActivity } from '../BaseActivity'
import type { DashboardData } from '../../../interface/DashboardData'
import { PromotionActivityRunner } from './PromotionActivityRunner'
import { promotionEligibility } from '../../../util/TaskEligibility'
import { markTaskStatus } from '../../../util/TaskTelemetry'

export class DailySet extends BaseActivity {
    public async run(data: DashboardData): Promise<void> {
        const today = this.bot.utils.getFormattedDate()
        const promotions = data.dashboard.dailySetPromotions?.[today]
        if (!promotions) {
            markTaskStatus('verifying', '未读取到当日任务数据，不能判定为已完成')
            this.bot.logger.warn(this.bot.isMobile, 'DAILY-SET', '未读取到当日任务数据，不能判定为已完成')
            return
        }
        const pending = promotions.filter(
            item => !item.complete && promotionEligibility(item, this.bot.config, 'daily').eligibility === 'eligible'
        )

        if (!pending.length) {
            markTaskStatus('skipped', '没有可自动执行的每日任务')
            this.bot.logger.info(this.bot.isMobile, 'DAILY-SET', '没有可自动执行的每日任务；已完成或不满足执行条件')
            return
        }

        this.bot.logger.info(
            this.bot.isMobile,
            'DAILY-SET',
            `Started solving "Daily Set" items | remaining=${pending.length}`
        )
        await new PromotionActivityRunner(this.bot).run(pending)
        this.bot.logger.info(this.bot.isMobile, 'DAILY-SET', 'Finished processing "Daily Set" items')
    }
}
