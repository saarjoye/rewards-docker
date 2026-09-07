import { URLs } from '../../../constants/urls'
import type { HttpRequestConfig } from '../../../util/Http'
import { randomUUID } from 'crypto'
import { BaseActivity } from '../BaseActivity'
import { finitePoints, markTaskStatus, reportTaskSubmission } from '../../../util/TaskTelemetry'

export class DailyCheckIn extends BaseActivity {
    private gainedPoints: number = 0

    private oldBalance: number = this.bot.userData.currentPoints

    public async doDailyCheckIn() {
        if (!this.bot.accessToken) {
            markTaskStatus('skipped', '缺少 App 登录状态，跳过签到')
            this.bot.logger.warn(
                this.bot.isMobile,
                'DAILY-CHECK-IN',
                'Skipping: App access token not available, this activity requires it!'
            )
            return
        }

        this.oldBalance = this.bot.userData.currentPoints

        this.bot.logger.info(
            this.bot.isMobile,
            'DAILY-CHECK-IN',
            `Starting Daily Check-In | geo=${this.bot.userData.geoLocale} | currentBalance=${this.oldBalance}`
        )

        try {
            const response = await this.submitDaily()

            this.bot.logger.debug(
                this.bot.isMobile,
                'DAILY-CHECK-IN',
                `Received Daily Check-In response | status=${response?.status ?? 'unknown'}`
            )

            const newBalance = finitePoints(response?.data?.response?.balance)
            reportTaskSubmission(newBalance, response?.data?.response?.creditedPoints)
            if (newBalance === null) {
                markTaskStatus('submitted', '签到已提交，余额缺失，等待积分确认')
                return
            }
            this.gainedPoints = newBalance - this.oldBalance
            this.bot.userData.currentPoints = newBalance

            this.bot.logger.debug(
                this.bot.isMobile,
                'DAILY-CHECK-IN',
                `Balance delta after Daily Check-In | type=103 | previousBalance=${this.oldBalance} | currentBalance=${newBalance} | balanceChange=${this.gainedPoints}`
            )

            if (this.gainedPoints > 0) {
                this.bot.userData.currentPoints = newBalance

                this.bot.logger.info(
                    this.bot.isMobile,
                    'DAILY-CHECK-IN',
                    `签到已提交，余额变化不等于任务得分 | type=103 | balanceChange=${this.gainedPoints} | currentBalance=${newBalance}`,
                    'green'
                )
            } else {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'DAILY-CHECK-IN',
                    `Daily Check-In completed but no points gained | type=103 | balanceChange=0 | currentBalance=${newBalance}`
                )
            }
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'DAILY-CHECK-IN',
                `Error during Daily Check-In | message=${error instanceof Error ? error.message : String(error)}`
            )
            throw error
        }
    }

    private async submitDaily() {
        try {
            const jsonData = {
                risk_context: {},
                type: 103,
                channel: 'SAIOS',
                attributes: {},
                id: randomUUID(),
                amount: 1,
                country: this.bot.userData.geoLocale
            }

            this.bot.logger.debug(
                this.bot.isMobile,
                'DAILY-CHECK-IN',
                `Preparing Daily Check-In payload | type=${jsonData.type} | id=${jsonData.id} | amount=${jsonData.amount} | country=${jsonData.country}`
            )

            const request: HttpRequestConfig = {
                url: URLs.platform.activities,
                method: 'POST',
                retries: 0,
                headers: {
                    Authorization: `Bearer ${this.bot.accessToken}`,
                    'Content-Type': 'application/json',
                    Accept: '*/*',
                    'User-Agent':
                        'Mozilla/5.0 (iPad; CPU iPad OS 26_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5 Mobile/15E148 Safari/605.1.15 BingSapphire/33.4.440603001',
                    'X-Rewards-AppId': 'SAIOS/33.4.440603001',
                    'X-Rewards-PartnerId': 'startapp',
                    'X-Rewards-Country': this.bot.userData.geoLocale,
                    'X-Rewards-Language': this.bot.userData.langCode,
                    'X-Rewards-Flights': 'rwgobig',
                    'X-Rewards-IsMobile': 'true'
                },
                data: JSON.stringify(jsonData)
            }

            this.bot.logger.debug(
                this.bot.isMobile,
                'DAILY-CHECK-IN',
                `Sending Daily Check-In request | type=${jsonData.type} | url=${request.url}`
            )

            return this.bot.http.request<{ response?: { balance?: number; creditedPoints?: number } }>(request)
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'DAILY-CHECK-IN',
                `Error in submitDaily | message=${error instanceof Error ? error.message : String(error)}`
            )
            throw error
        }
    }
}
