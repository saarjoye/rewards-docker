import type { AxiosRequestConfig } from 'axios'
import { randomUUID } from 'crypto'
import { Workers } from '../../Workers'

export class DailyCheckIn extends Workers {
    private gainedPoints: number = 0

    private oldBalance: number = this.bot.userData.currentPoints

    public async doDailyCheckIn() {
        if (!this.bot.accessToken) {
            this.bot.logger.warn(
                this.bot.isMobile,
                'DAILY-CHECK-IN',
                '跳过：应用访问令牌不可用，此活动需要它！'
            )
            return
        }

        this.oldBalance = Number(this.bot.userData.currentPoints ?? 0)

        this.bot.logger.info(
            this.bot.isMobile,
            'DAILY-CHECK-IN',
            `开始每日签到 | 地理位置=${this.bot.userData.geoLocale} | 当前积分=${this.oldBalance}`
        )

        try {
            // 首先尝试类型 101
            this.bot.logger.debug(this.bot.isMobile, 'DAILY-CHECK-IN', '尝试每日签到 | 类型=101')

            let response = await this.submitDaily(101) // 尝试使用 101 (欧盟版本？)
            this.bot.logger.debug(
                this.bot.isMobile,
                'DAILY-CHECK-IN',
                `收到每日签到响应 | 类型=101 | 状态=${response?.status ?? '未知'}`
            )

            let newBalance = Number(response?.data?.response?.balance ?? this.oldBalance)
            this.gainedPoints = newBalance - this.oldBalance

            this.bot.logger.debug(
                this.bot.isMobile,
                'DAILY-CHECK-IN',
                `每日签到后余额变化 | 类型=101 | 原始余额=${this.oldBalance} | 新余额=${newBalance} | 获得积分=${this.gainedPoints}`
            )

            if (this.gainedPoints > 0) {
                this.bot.userData.currentPoints = newBalance
                this.bot.userData.gainedPoints = (this.bot.userData.gainedPoints ?? 0) + this.gainedPoints

                this.bot.logger.info(
                    this.bot.isMobile,
                    'DAILY-CHECK-IN',
                    `完成每日签到 | 类型=101 | 获得积分=${this.gainedPoints} | 原始余额=${this.oldBalance} | 新余额=${newBalance}`,
                    'green'
                )
                return
            }

            this.bot.logger.debug(
                this.bot.isMobile,
                'DAILY-CHECK-IN',
                `使用类型101未获得积分 | 原始余额=${this.oldBalance} | 新余额=${newBalance} | 重试类型=103`
            )

            // 退回到类型 103
            this.bot.logger.debug(this.bot.isMobile, 'DAILY-CHECK-IN', '尝试每日签到 | 类型=103')

            response = await this.submitDaily(103) // 尝试使用 103 (美国版本？)
            this.bot.logger.debug(
                this.bot.isMobile,
                'DAILY-CHECK-IN',
                `收到每日签到响应 | 类型=103 | 状态=${response?.status ?? '未知'}`
            )

            newBalance = Number(response?.data?.response?.balance ?? this.oldBalance)
            this.gainedPoints = newBalance - this.oldBalance

            this.bot.logger.debug(
                this.bot.isMobile,
                'DAILY-CHECK-IN',
                `每日签到后余额变化 | 类型=103 | 原始余额=${this.oldBalance} | 新余额=${newBalance} | 获得积分=${this.gainedPoints}`
            )

            if (this.gainedPoints > 0) {
                this.bot.userData.currentPoints = newBalance
                this.bot.userData.gainedPoints = (this.bot.userData.gainedPoints ?? 0) + this.gainedPoints

                this.bot.logger.info(
                    this.bot.isMobile,
                    'DAILY-CHECK-IN',
                    `完成每日签到 | 类型=103 | 获得积分=${this.gainedPoints} | 原始余额=${this.oldBalance} | 新余额=${newBalance}`,
                    'green'
                )
            } else {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'DAILY-CHECK-IN',
                    `每日签到已完成但未获得积分 | 尝试类型=101,103 | 原始余额=${this.oldBalance} | 最终余额=${newBalance}`
                )
            }
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'DAILY-CHECK-IN',
                `每日签到期间发生错误 | 消息=${error instanceof Error ? error.message : String(error)}`
            )
        }
    }

    private async submitDaily(type: number) {
        try {
            const jsonData = {
                id: randomUUID(),
                amount: 1,
                type: type,
                attributes: {
                    offerid: 'Gamification_Sapphire_DailyCheckIn'
                },
                country: this.bot.userData.geoLocale
            }

            this.bot.logger.debug(
                this.bot.isMobile,
                'DAILY-CHECK-IN',
                `准备每日签到载荷 | 类型=${type} | id=${jsonData.id} | 数量=${jsonData.amount} | 国家=${jsonData.country}`
            )

            const request: AxiosRequestConfig = {
                url: 'https://prod.rewardsplatform.microsoft.com/dapi/me/activities',
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${this.bot.accessToken}`,
                    'User-Agent':
                        'Bing/32.5.431027001 (com.microsoft.bing; build:431027001; iOS 17.6.1) Alamofire/5.10.2',
                    'Content-Type': 'application/json',
                    'X-Rewards-Country': this.bot.userData.geoLocale,
                    'X-Rewards-Language': 'zh-CN',
                    'X-Rewards-ismobile': 'true'
                },
                data: JSON.stringify(jsonData)
            }

            this.bot.logger.debug(
                this.bot.isMobile,
                'DAILY-CHECK-IN',
                `发送每日签到请求 | 类型=${type} | url=${request.url}`
            )

            return this.bot.axios.request(request)
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'DAILY-CHECK-IN',
                `submitDaily中出现错误 | 类型=${type} | 消息=${error instanceof Error ? error.message : String(error)}`
            )
            throw error
        }
    }
}
