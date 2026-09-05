import type { QuestChild } from '../../../browser/ReactFunc'
import { BaseActivity } from '../BaseActivity'
import { URLs } from '../../../constants/urls'
import { markTaskStatus, finitePoints } from '../../../util/TaskTelemetry'

export class ClaimReward extends BaseActivity {
    public async claimReward(child: QuestChild, parentId: string) {
        const offerId = child.offerId

        const actionId = this.bot.nextActions.reportActivity
        if (!actionId) {
            markTaskStatus('skipped', '未发现领取入口')
            this.bot.logger.warn(
                this.bot.isMobile,
                'CLAIM-REWARD',
                `Skipping ${offerId}: "reportActivity" not discovered in bundle`
            )
            return
        }

        if (!child.hash) {
            markTaskStatus('skipped', '任务缺少提交信息')
            this.bot.logger.warn(this.bot.isMobile, 'CLAIM-REWARD', `Skipping ${offerId}: no live hash on quest child`)
            return
        }
        if (!child.reportable) {
            markTaskStatus(child.isLocked ? 'locked' : 'skipped', '该任务不可提交')
            this.bot.logger.warn(
                this.bot.isMobile,
                'CLAIM-REWARD',
                `Skipping ${offerId}: not reportable (completed/locked/disabled)`
            )
            return
        }

        const oldBalance = this.bot.userData.currentPoints

        this.bot.logger.info(
            this.bot.isMobile,
            'CLAIM-REWARD',
            `Claiming reward | offerId=${offerId} | geo=${this.bot.userData.geoLocale}`
        )

        try {
            const questUrl = URLs.rewards.quest(parentId)
            const { status, acknowledged, availablePoints } = await this.bot.browser.func.reportServerAction(
                actionId,
                [
                    child.hash,
                    11,
                    { offerid: offerId, isPromotional: '$undefined', timezoneOffset: this.bot.userData.timezoneOffset }
                ],
                {
                    url: questUrl,
                    referer: questUrl,
                    routerStateTree: this.bot.browser.react.questRouterStateTree(parentId)
                }
            )

            const newBalance = finitePoints(availablePoints)
            if (newBalance === null) {
                markTaskStatus('verifying', '领取请求已结束，等待对应任务数据复核')
                return
            }
            const gained = newBalance - oldBalance

            this.bot.logger.debug(
                this.bot.isMobile,
                'CLAIM-REWARD',
                `Claim response | offerId=${offerId} | status=${status} | acknowledged=${acknowledged} | pointsGained=${gained} | currentBalance=${newBalance}`
            )

            if (acknowledged) {
                if (gained > 0) {
                    this.bot.userData.currentPoints = newBalance
                    this.bot.userData.gainedPoints = (this.bot.userData.gainedPoints ?? 0) + gained
                }

                this.bot.logger.info(
                    this.bot.isMobile,
                    'CLAIM-REWARD',
                    `Reward claimed | offerId=${offerId} | status=${status} | pointsGained=${gained} | currentBalance=${newBalance}`,
                    'green'
                )
            } else {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'CLAIM-REWARD',
                    `Claim not acknowledged by server | offerId=${offerId} | status=${status}`
                )
            }
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'CLAIM-REWARD',
                `Error in claimReward | offerId=${offerId} | message=${error instanceof Error ? error.message : String(error)}`
            )
        }
    }
}
