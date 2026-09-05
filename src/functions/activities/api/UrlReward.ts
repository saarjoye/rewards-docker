import { URLs } from '../../../constants/urls'
import type { BasePromotion } from '../../../interface/DashboardData'
import { BaseActivity } from '../BaseActivity'
import { markTaskStatus, finitePoints } from '../../../util/TaskTelemetry'

export class UrlReward extends BaseActivity {
    public async doUrlReward(promotion: BasePromotion) {
        await this.runUrlReward(promotion)
    }

    private async runUrlReward(promotion: BasePromotion) {
        const offerId = promotion.offerId

        const actionId = this.bot.nextActions.reportActivity
        if (!actionId) {
            markTaskStatus('skipped', '未找到活动提交入口')
            this.bot.logger.warn(
                this.bot.isMobile,
                'URL-REWARD',
                `Skipping ${offerId}: "reportActivity" not discovered in bundle`
            )
            return
        }

        const live = await this.bot.browser.func.ensureOffer(offerId)
        if (!live) {
            markTaskStatus('skipped', '任务数据源中未找到此活动')
            this.bot.logger.warn(
                this.bot.isMobile,
                'URL-REWARD',
                `Skipping ${offerId}: not present in page snapshot, even after refetching /earn and /dashboard`
            )
            return
        }
        if (!live.reportable) {
            markTaskStatus(
                live.isCompleted ? 'completed' : live.isLocked ? 'locked' : 'skipped',
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

            if (!acknowledged) {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'URL-REWARD',
                    `UrlReward request was not acknowledged | offerId=${offerId} | status=${status}`
                )
                markTaskStatus('verifying', '提交未得到确认，仅复核，不重复领取')
                return
            }

            const newBalance = finitePoints(availablePoints)
            if (newBalance === null) {
                markTaskStatus('verifying', '活动请求已结束，等待对应任务数据复核')
                return
            }
            const gainedPoints = newBalance - oldBalance

            this.bot.logger.debug(
                this.bot.isMobile,
                'URL-REWARD',
                `Response | offerId=${offerId} | status=${status} | acknowledged=${acknowledged} | pointsGained=${gainedPoints} | currentBalance=${newBalance}`
            )

            if (gainedPoints > 0) {
                this.bot.userData.currentPoints = newBalance
                this.bot.userData.gainedPoints = (this.bot.userData.gainedPoints ?? 0) + gainedPoints

                const shortfall = expectedPoints > 0 && gainedPoints < expectedPoints
                this.bot.logger.info(
                    this.bot.isMobile,
                    'URL-REWARD',
                    `Completed UrlReward | offerId=${offerId} | pointsGained=${gainedPoints} | currentBalance=${newBalance}${shortfall ? ' | WARNING: credited less than advertised' : ''}`,
                    'green'
                )
            } else if (acknowledged && expectedPoints === 0) {
                this.bot.logger.info(
                    this.bot.isMobile,
                    'URL-REWARD',
                    `Completed UrlReward (no points by design) | offerId=${offerId} | acknowledged=true | pointsGained=0 | currentBalance=${newBalance}`,
                    'green'
                )
            } else {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'URL-REWARD',
                    `UrlReward credited no points | offerId=${offerId} | acknowledged=${acknowledged} | expected=${expectedPoints} | pointsGained=0 | currentBalance=${newBalance}`
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
