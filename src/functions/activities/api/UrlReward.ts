import { URLs } from '../../../constants/urls'
import type { BasePromotion } from '../../../interface/DashboardData'
import { BaseActivity } from '../BaseActivity'
import { markTaskStatus, finitePoints, reportTaskSubmission } from '../../../util/TaskTelemetry'

export class UrlReward extends BaseActivity {
    public async doUrlReward(promotion: BasePromotion) {
        await this.runUrlReward(promotion)
    }

    private async runUrlReward(promotion: BasePromotion) {
        const offerId = promotion.offerId

        const actionId = this.bot.nextActions.reportActivity
        if (!actionId) {
            markTaskStatus('unsupported', '未找到活动提交入口，未执行')
            this.bot.logger.warn(
                this.bot.isMobile,
                'URL-REWARD',
                `Skipping ${offerId}: "reportActivity" not discovered in bundle`
            )
            return
        }

        const live = await this.bot.browser.func.ensureOffer(offerId)
        if (!live) {
            markTaskStatus('unavailable', '任务数据源中未找到此活动，未执行')
            this.bot.logger.warn(
                this.bot.isMobile,
                'URL-REWARD',
                `Skipping ${offerId}: not present in page snapshot, even after refetching /earn and /dashboard`
            )
            return
        }
        if (!live.reportable) {
            markTaskStatus(
                live.isCompleted ? 'skipped' : live.isLocked ? 'locked' : 'unavailable',
                '活动已完成、锁定或不可提交'
            )
            this.bot.logger.warn(
                this.bot.isMobile,
                'URL-REWARD',
                `Skipping ${offerId}: not reportable (completed/locked/no-hash/future-dated)`
            )
            return
        }

        if (this.bot.config.skipNonPointTasks && live.points === 0) {
            markTaskStatus('skipped', '按配置跳过无积分活动')
            this.bot.logger.info(
                this.bot.isMobile,
                'URL-REWARD',
                `Skipping ${offerId}: awards no points (points=${live.points}${live.promotionSubtype ? ` subtype=${live.promotionSubtype}` : ''}) - likely a free trial/non-crediting offer. Set skipNonPointTasks=false to attempt anyway.`
            )
            return
        }

        const oldBalance = this.bot.userData.currentPoints
        const expectedPoints = live.points

        const dashboardActivityType = Number(promotion.activityType)
        const activityType =
            live.activityType ??
            (Number.isInteger(dashboardActivityType) && dashboardActivityType > 0 ? dashboardActivityType : 11)

        this.bot.logger.info(
            this.bot.isMobile,
            'URL-REWARD',
            `Starting UrlReward | offerId=${offerId} | geo=${this.bot.userData.geoLocale} | currentBalance=${oldBalance}`
        )

        try {
            const { status, acknowledged, availablePoints } = await this.bot.browser.func.reportServerAction(
                actionId,
                [
                    live.hash,
                    activityType,
                    {
                        offerid: offerId,
                        isPromotional: live.isPromotional ? true : '$undefined',
                        timezoneOffset: this.bot.userData.timezoneOffset
                    }
                ],
                {
                    url: URLs.rewards.dashboard,
                    referer: URLs.rewards.dashboard,
                    routerStateTree: this.bot.browser.react.routerStateTree('dashboard')
                }
            )

            reportTaskSubmission(availablePoints)
            if (!acknowledged) {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'URL-REWARD',
                    `UrlReward request was not acknowledged | offerId=${offerId} | status=${status}`
                )
                markTaskStatus('submitted', '提交未得到确认，仅复核，不重复领取')
                return
            }

            const newBalance = finitePoints(availablePoints)
            if (newBalance === null) {
                markTaskStatus('submitted', '已提交，等待积分确认')
                return
            }
            const gainedPoints = newBalance - oldBalance
            this.bot.userData.currentPoints = newBalance

            this.bot.logger.debug(
                this.bot.isMobile,
                'URL-REWARD',
                `Response | offerId=${offerId} | status=${status} | acknowledged=${acknowledged} | balanceChange=${gainedPoints} | currentBalance=${newBalance}`
            )

            if (gainedPoints > 0) {
                this.bot.userData.currentPoints = newBalance

                const shortfall = expectedPoints > 0 && gainedPoints < expectedPoints
                this.bot.logger.info(
                    this.bot.isMobile,
                    'URL-REWARD',
                    `UrlReward 已提交，余额变化不等于任务得分 | offerId=${offerId} | balanceChange=${gainedPoints} | currentBalance=${newBalance}${shortfall ? ' | WARNING: credited less than advertised' : ''}`,
                    'green'
                )
            } else if (acknowledged && expectedPoints === 0) {
                this.bot.logger.info(
                    this.bot.isMobile,
                    'URL-REWARD',
                    `UrlReward 已提交，余额变化不等于任务得分 (no points by design) | offerId=${offerId} | acknowledged=true | balanceChange=0 | currentBalance=${newBalance}`,
                    'green'
                )
            } else {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'URL-REWARD',
                    `UrlReward credited no points | offerId=${offerId} | acknowledged=${acknowledged} | expected=${expectedPoints} | balanceChange=0 | currentBalance=${newBalance}`
                )
            }
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'URL-REWARD',
                `Error in doUrlReward | offerId=${offerId} | message=${error instanceof Error ? error.message : String(error)}`
            )
            throw error
        }
    }
}
