import { BaseActivity } from '../BaseActivity'
import { markTaskStatus, finitePoints, reportTaskSubmission } from '../../../util/TaskTelemetry'

export class ClaimBonusPoints extends BaseActivity {
    public async claimBonusPoints() {
        const actionId = this.bot.nextActions.reportClaimAllPoints
        if (!actionId) {
            markTaskStatus('skipped', '未发现奖励领取入口')
            this.bot.logger.warn(
                this.bot.isMobile,
                'CLAIM-BONUS-POINTS',
                'Skipping: "reportClaimAllPoints" action id not discovered in bundle'
            )
            return
        }

        const oldBalance = this.bot.userData.currentPoints

        this.bot.logger.info(
            this.bot.isMobile,
            'CLAIM-BONUS-POINTS',
            `Starting ClaimBonusPoints | geo=${this.bot.userData.geoLocale} | currentBalance=${oldBalance}`
        )

        try {
            const { status, acknowledged, availablePoints } = await this.bot.browser.func.reportServerAction(
                actionId,
                []
            )

            const newBalance = finitePoints(availablePoints)
            reportTaskSubmission(newBalance)
            if (newBalance === null) {
                markTaskStatus('submitted', '奖励已提交领取，等待积分确认')
                return
            }
            const gainedPoints = newBalance - oldBalance
            this.bot.userData.currentPoints = newBalance

            this.bot.logger.debug(
                this.bot.isMobile,
                'CLAIM-BONUS-POINTS',
                `Response | status=${status} | acknowledged=${acknowledged} | previousBalance=${oldBalance} | currentBalance=${newBalance} | balanceChange=${gainedPoints}`
            )

            if (acknowledged) {
                if (gainedPoints > 0) {
                    this.bot.userData.currentPoints = newBalance
                }

                this.bot.logger.info(
                    this.bot.isMobile,
                    'CLAIM-BONUS-POINTS',
                    `奖励已提交，余额变化不等于任务得分 | acknowledged=true | balanceChange=${gainedPoints} | currentBalance=${newBalance}`,
                    'green'
                )
            } else {
                this.bot.logger.info(
                    this.bot.isMobile,
                    'CLAIM-BONUS-POINTS',
                    `Nothing claimed | status=${status} | balanceChange=0 | currentBalance=${newBalance}`
                )
            }

            await this.bot.utils.wait(this.bot.utils.randomDelay(5000, 10000))
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'CLAIM-BONUS-POINTS',
                `Error in claimBonusPoints | message=${error instanceof Error ? error.message : String(error)}`
            )
            throw error
        }
    }
}
