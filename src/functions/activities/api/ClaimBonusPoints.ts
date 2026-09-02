import type { AxiosRequestConfig } from 'axios'

import type { CurrentPointsSnapshot } from '../../../browser/BrowserFunc'
import type { DashboardFailureDetails } from '../../../util/DashboardError'
import { Workers } from '../../Workers'

export type ClaimBonusOutcome =
    | {
          status: 'verified'
          oldBalance: number
          newBalance: number
          gainedPoints: number
          source: string
      }
    | {
          status: 'pending-verification'
          oldBalance: number
          lastKnownPoints: number | null
          source: string | null
          verificationError: DashboardFailureDetails | null
      }
    | {
          status: 'skipped'
          oldBalance: number
          reason: string
      }

export class ClaimBonusPoints extends Workers {
    private readonly oldBalance: number = this.bot.userData.currentPoints

    public async claimBonusPoints(): Promise<ClaimBonusOutcome> {
        this.bot.logger.info(
            this.bot.isMobile,
            'CLAIM-BONUS-POINTS',
            `开始领取奖励积分 | 地区=${this.bot.userData.geoLocale} | 旧余额=${this.oldBalance}`
        )

        const mutation = await this.executeClaimMutation()
        if (!mutation.executed) {
            this.bot.logger.warn(this.bot.isMobile, 'CLAIM-BONUS-POINTS', mutation.reason)
            return { status: 'skipped', oldBalance: this.oldBalance, reason: mutation.reason }
        }

        const firstSnapshot = await this.bot.browser.func.getCurrentPointsSnapshot()
        const firstVerified = this.finishVerified(firstSnapshot, mutation.httpStatus)
        if (firstVerified) return firstVerified

        this.bot.logger.warn(
            this.bot.isMobile,
            'CLAIM-BONUS-POINTS',
            `领取请求已完成，首次积分复核未确认 | confidence=${firstSnapshot.confidence} | source=${firstSnapshot.source ?? 'none'} | status=${firstSnapshot.error?.apiStatus ?? 'n/a'}`
        )
        await this.bot.utils.wait(2000)

        const secondSnapshot = await this.bot.browser.func.getCurrentPointsSnapshot()
        const secondVerified = this.finishVerified(secondSnapshot, mutation.httpStatus)
        if (secondVerified) return secondVerified

        const lastKnown = secondSnapshot.points !== null ? secondSnapshot : firstSnapshot
        const verificationError = secondSnapshot.error ?? firstSnapshot.error
        this.bot.logger.warn(
            this.bot.isMobile,
            'CLAIM-BONUS-POINTS',
            `领取请求已完成，积分待复核 | confidence=${lastKnown.confidence} | source=${lastKnown.source ?? 'none'} | status=${verificationError?.apiStatus ?? 'n/a'} | attempts=${verificationError?.attempts ?? 0}`
        )
        return {
            status: 'pending-verification',
            oldBalance: this.oldBalance,
            lastKnownPoints: lastKnown.points,
            source: lastKnown.source,
            verificationError
        }
    }

    private async executeClaimMutation(): Promise<
        { executed: true; httpStatus: number | null } | { executed: false; reason: string }
    > {
        if (this.bot.rewardsVersion === 'modern' || !this.bot.requestToken) {
            const serverActionOk = await this.bot.browser.func.callServerAction(
                'claimBonusPoints',
                [],
                'CLAIM-BONUS-POINTS'
            )
            if (serverActionOk) return { executed: true, httpStatus: null }

            this.bot.logger.warn(
                this.bot.isMobile,
                'CLAIM-BONUS-POINTS',
                'Server Action 调用未确认，尝试一次页面点击兜底'
            )
            const clicked = await this.bot.browser.func.clickClaimBonusPointsButton(this.bot.mainMobilePage)
            return clicked
                ? { executed: true, httpStatus: null }
                : { executed: false, reason: '未找到可确认执行的奖励领取入口，已跳过' }
        }

        const targetUrl = 'https://rewards.bing.com/api/claimallpointsasync?X-Requested-With=XMLHttpRequest'
        const cookieHeader = this.bot.browser.func.buildCookieHeaderForUrl(
            this.bot.isMobile ? this.bot.cookies.mobile : this.bot.cookies.desktop,
            targetUrl
        )
        const fingerprintHeaders = Object.fromEntries(
            Object.entries(this.bot.fingerprint.headers).filter(([name]) => name.toLowerCase() !== 'cookie')
        )
        const formData = new URLSearchParams({
            timeZone: this.bot.userData.timezoneOffset,
            __RequestVerificationToken: this.bot.requestToken
        })
        const request: AxiosRequestConfig = {
            url: targetUrl,
            method: 'POST',
            headers: {
                ...fingerprintHeaders,
                Cookie: cookieHeader,
                Referer: 'https://rewards.bing.com/',
                Origin: 'https://rewards.bing.com'
            },
            data: formData
        }
        const client = this.bot.axios as typeof this.bot.axios & {
            requestOnce?: (config: AxiosRequestConfig, timeout?: number) => Promise<{ status: number }>
        }
        const response = client.requestOnce
            ? await client.requestOnce(request, 15000)
            : await client.request({ ...request, timeout: 15000, 'axios-retry': { retries: 0 } })
        this.bot.logger.debug(
            this.bot.isMobile,
            'CLAIM-BONUS-POINTS',
            `领取请求完成 | path=/api/claimallpointsasync | status=${response.status}`
        )
        return { executed: true, httpStatus: response.status }
    }

    private finishVerified(snapshot: CurrentPointsSnapshot, httpStatus: number | null): ClaimBonusOutcome | null {
        if (snapshot.confidence !== 'confirmed' || snapshot.points === null) return null

        const newBalance = snapshot.points
        const gainedPoints = Math.max(0, newBalance - this.oldBalance)
        if (gainedPoints > 0) {
            this.bot.recordPointGain('领取奖励积分', gainedPoints, newBalance)
        }
        this.bot.logger.info(
            this.bot.isMobile,
            'CLAIM-BONUS-POINTS',
            `领取奖励积分已复核 | status=${httpStatus ?? 'n/a'} | 获得积分=${gainedPoints} | 新余额=${newBalance} | source=${snapshot.source ?? 'dashboard'}`,
            gainedPoints > 0 ? 'green' : 'yellow'
        )
        return {
            status: 'verified',
            oldBalance: this.oldBalance,
            newBalance,
            gainedPoints,
            source: snapshot.source ?? 'dashboard'
        }
    }
}
