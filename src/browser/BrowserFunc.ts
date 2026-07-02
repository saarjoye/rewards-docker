import type { BrowserContext, Cookie, Page } from 'patchright'
import type { AxiosRequestConfig } from 'axios'

import type { MicrosoftRewardsBot } from '../index'
import { saveSessionData } from '../util/Load'

import type { Counters, DashboardData } from './../interface/DashboardData'
import type { AppUserData } from '../interface/AppUserData'
import type { XboxDashboardData } from './../interface/XboxDashboardData'
import type { AppEarnablePoints, BrowserEarnablePoints, MissingSearchPoints } from '../interface/Points'
import type { AppDashboardData } from '../interface/AppDashBoardData'
import { PanelFlyoutData } from '../interface/PanelFlyoutData'
import { calculateMissingSearchPoints } from '../util/SearchCounter'
import {
    extractDeploymentIdFromHtml,
    extractScriptUrls,
    extractServerActionHashResultFromSources,
    FALLBACK_SERVER_ACTION_HASHES,
    isKnownServerActionDeployment,
    type ServerActionName,
    type ServerActionRuntimeInfo
} from '../util/ServerActions'

export default class BrowserFunc {
    private bot: MicrosoftRewardsBot

    constructor(bot: MicrosoftRewardsBot) {
        this.bot = bot
    }

    /**
     * 获取用户桌面仪表板数据
     * @returns {DashboardData} 用户必应奖励仪表板数据对象
     */
    async getDashboardData(): Promise<DashboardData> {
        try {
            const request: AxiosRequestConfig = {
                url: 'https://rewards.bing.com/api/getuserinfo?type=1',
                method: 'GET',
                headers: {
                    ...(this.bot.fingerprint?.headers ?? {}),
                    Cookie: this.buildCookieHeader(this.bot.cookies.mobile, [
                        'bing.com',
                        'live.com',
                        'microsoftonline.com'
                    ]),
                    Referer: 'https://rewards.bing.com/',
                    Origin: 'https://rewards.bing.com'
                }
            }

            const response = await this.bot.axios.request(request)

            if (response.data?.dashboard) {
                return response.data.dashboard as DashboardData
            }
            throw new Error('Dashboard data missing from API response')
        } catch (error) {
            this.bot.logger.warn(this.bot.isMobile, 'GET-DASHBOARD-DATA', 'API失败，尝试HTML回退方案')

            // 尝试使用仪表板页面的脚本
            try {
                const request: AxiosRequestConfig = {
                    url: this.bot.config.baseURL,
                    method: 'GET',
                    headers: {
                        ...(this.bot.fingerprint?.headers ?? {}),
                        Cookie: this.buildCookieHeader(this.bot.cookies.mobile),
                        Referer: 'https://rewards.bing.com/',
                        Origin: 'https://rewards.bing.com'
                    }
                }

                const response = await this.bot.axios.request(request)
                const match = response.data.match(/var\s+dashboard\s*=\s*({.*?});/s)

                if (!match?.[1]) {
                    throw new Error('在HTML中未找到仪表板脚本')
                }

                return JSON.parse(match[1]) as DashboardData
            } catch (fallbackError) {
                // 如果两者都失败
                this.bot.logger.error(this.bot.isMobile, 'GET-DASHBOARD-DATA', '获取仪表板数据失败')
                throw fallbackError
            }
        }
    }

  /**
     * Fetch user panel flyout data
     * @returns {PanelFlyoutData} Object of user bing rewards dashboard data
     */
    async getPanelFlyoutData(): Promise<PanelFlyoutData> {
        try {
            const request: AxiosRequestConfig = {
                url: 'https://cn.bing.com/rewards/panelflyout/getuserinfo?channel=BingFlyout&partnerId=BingRewards',
                method: 'GET',
                headers: {
                    ...(this.bot.fingerprint?.headers ?? {}),
                    Cookie: this.buildCookieHeader(this.bot.cookies.mobile, [
                        'bing.com',
                        'live.com',
                        'microsoftonline.com'
                    ]),
                    Origin: 'https://cn.bing.com'
                }
            }

            const response = await this.bot.axios.request(request)
            return response.data as PanelFlyoutData
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'GET-PANEL-FLYOUT-DATA',
                `获取面板数据出错: ${error instanceof Error ? error.message : String(error)}`
            )
            throw error
        }
    }

    /**
     * 获取用户应用仪表板数据
     * @returns {AppDashboardData} 用户必应奖励仪表板数据对象
     */
    async getAppDashboardData(): Promise<AppDashboardData> {
        try {
            const request: AxiosRequestConfig = {
                url: 'https://prod.rewardsplatform.microsoft.com/dapi/me?channel=SAIOS&options=613',
                method: 'GET',
                headers: {
                    Authorization: `Bearer ${this.bot.accessToken}`,
                    'User-Agent':
                        'Bing/32.5.431027001 (com.microsoft.bing; build:431027001; iOS 17.6.1) Alamofire/5.10.2'
                }
            }

            const response = await this.bot.axios.request(request)
            return response.data as AppDashboardData
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'GET-APP-DASHBOARD-DATA',
                `获取仪表板数据出错: ${error instanceof Error ? error.message : String(error)}`
            )
            throw error
        }
    }

    /**
     * 获取用户xbox仪表板数据
     * @returns {XboxDashboardData} 用户必应奖励仪表板数据对象
     */
    async getXBoxDashboardData(): Promise<XboxDashboardData> {
        try {
            const request: AxiosRequestConfig = {
                url: 'https://prod.rewardsplatform.microsoft.com/dapi/me?channel=xboxapp&options=6',
                method: 'GET',
                headers: {
                    Authorization: `Bearer ${this.bot.accessToken}`,
                    'User-Agent':
                        'Mozilla/5.0 (Windows NT 10.0; Win64; x64; Xbox; Xbox One X) AppleWebKit/537.36 (KHTML, like Gecko) Edge/18.19041'
                }
            }

            const response = await this.bot.axios.request(request)
            return response.data as XboxDashboardData
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'GET-XBOX-DASHBOARD-DATA',
                `获取仪表板数据出错: ${error instanceof Error ? error.message : String(error)}`
            )
            throw error
        }
    }

    /**
     * 获取搜索积分计数器
     */
    async getSearchPoints(): Promise<Counters> {
        const dashboardData = await this.getDashboardData() // 始终获取最新数据

        return dashboardData.userStatus.counters
    }

    missingSearchPoints(counters: Counters, isMobile: boolean): MissingSearchPoints {
        return calculateMissingSearchPoints(counters, isMobile, 'dashboard')
    }

    async getMobileSearchPointsFallback(isMobile: boolean): Promise<MissingSearchPoints | null> {
        const htmlResult = await this.getDashboardHtmlSearchPoints(isMobile).catch(error => {
            this.bot.logger.debug(
                this.bot.isMobile,
                'SEARCH-COUNTER-FALLBACK',
                `dashboard-html unavailable: ${error instanceof Error ? error.message : String(error)}`
            )
            return null
        })
        if (htmlResult?.mobileDetected) {
            return htmlResult
        }

        const panelResult = this.getPanelFlyoutSearchPoints(isMobile)
        if (panelResult?.mobileDetected) {
            return panelResult
        }

        return null
    }

    private async getDashboardHtmlSearchPoints(isMobile: boolean): Promise<MissingSearchPoints | null> {
        const request: AxiosRequestConfig = {
            url: this.bot.config.baseURL,
            method: 'GET',
            headers: {
                ...(this.bot.fingerprint?.headers ?? {}),
                Cookie: this.buildCookieHeader(this.bot.cookies.mobile),
                Referer: 'https://rewards.bing.com/',
                Origin: 'https://rewards.bing.com'
            }
        }

        const response = await this.bot.axios.request(request)
        const html = typeof response.data === 'string' ? response.data : ''
        const match = html.match(/var\s+dashboard\s*=\s*({.*?});/s)
        if (!match?.[1]) {
            return null
        }

        const dashboard = JSON.parse(match[1]) as DashboardData
        return calculateMissingSearchPoints(dashboard.userStatus?.counters, isMobile, 'dashboard-html')
    }

    private getPanelFlyoutSearchPoints(isMobile: boolean): MissingSearchPoints | null {
        const panelData = this.bot.panelData as unknown
        const counterContainer = this.findCounterContainer(panelData, 'mobileSearch')
        if (!counterContainer) {
            return null
        }

        return calculateMissingSearchPoints(counterContainer, isMobile, 'panel-flyout')
    }

    private findCounterContainer(value: unknown, key: string, depth = 0): Record<string, unknown> | null {
        if (!value || depth > 6) {
            return null
        }

        if (Array.isArray(value)) {
            for (const item of value) {
                const found = this.findCounterContainer(item, key, depth + 1)
                if (found) {
                    return found
                }
            }
            return null
        }

        if (typeof value !== 'object') {
            return null
        }

        const record = value as Record<string, unknown>
        if (Object.prototype.hasOwnProperty.call(record, key)) {
            return record
        }

        for (const child of Object.values(record)) {
            const found = this.findCounterContainer(child, key, depth + 1)
            if (found) {
                return found
            }
        }

        return null
    }

    /**
     * 获取通过网页浏览器可赚取的总积分
     */
    async getBrowserEarnablePoints(): Promise<BrowserEarnablePoints> {
        try {
            const data = await this.getDashboardData()

            const desktopSearchPoints =
                data.userStatus.counters.pcSearch?.reduce(
                    (sum, x) => sum + (x.pointProgressMax - x.pointProgress),
                    0
                ) ?? 0

            const mobileSearchPoints =
                data.userStatus.counters.mobileSearch?.reduce(
                    (sum, x) => sum + (x.pointProgressMax - x.pointProgress),
                    0
                ) ?? 0

            const todayDate = this.bot.utils.getFormattedDate()
            const dailySetPoints =
                data.dailySetPromotions[todayDate]?.reduce(
                    (sum, x) => sum + (x.pointProgressMax - x.pointProgress),
                    0
                ) ?? 0

            const morePromotionsPoints =
                data.morePromotions?.reduce((sum, x) => {
                    if (
                        ['quiz', 'urlreward'].includes(x.promotionType) &&
                        x.exclusiveLockedFeatureStatus !== 'locked'
                    ) {
                        return sum + (x.pointProgressMax - x.pointProgress)
                    }
                    return sum
                }, 0) ?? 0

            const totalEarnablePoints = desktopSearchPoints + mobileSearchPoints + dailySetPoints + morePromotionsPoints

            return {
                dailySetPoints,
                morePromotionsPoints,
                desktopSearchPoints,
                mobileSearchPoints,
                totalEarnablePoints
            }
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'GET-BROWSER-EARNABLE-POINTS',
                `发生错误: ${error instanceof Error ? error.message : String(error)}`
            )
            throw error
        }
    }

    /**
     * 获取通过移动应用可赚取的总积分
     */
    async getAppEarnablePoints(): Promise<AppEarnablePoints> {
        try {
            const eligibleOffers = ['ENUS_readarticle3_30points', 'Gamification_Sapphire_DailyCheckIn']

            const request: AxiosRequestConfig = {
                url: 'https://prod.rewardsplatform.microsoft.com/dapi/me?channel=SAAndroid&options=613',
                method: 'GET',
                headers: {
                    Authorization: `Bearer ${this.bot.accessToken}`,
                    'X-Rewards-Country': this.bot.userData.geoLocale,
                    'X-Rewards-Language': 'zh-CN',
                    'X-Rewards-ismobile': 'true'
                }
            }

            const response = await this.bot.axios.request(request)
            const userData: AppUserData = response.data
            const eligibleActivities = userData.response.promotions.filter(x =>
                eligibleOffers.includes(x.attributes.offerid ?? '')
            )

            let readToEarn = 0
            let checkIn = 0

            for (const item of eligibleActivities) {
                const attrs = item.attributes

                if (attrs.type === 'msnreadearn') {
                    const pointMax = parseInt(attrs.pointmax ?? '0')
                    const pointProgress = parseInt(attrs.pointprogress ?? '0')
                    readToEarn = Math.max(0, pointMax - pointProgress)
                } else if (attrs.type === 'checkin') {
                    const progress = parseInt(attrs.progress ?? '0')
                    const checkInDay = progress % 7
                    const lastUpdated = new Date(attrs.last_updated ?? '')
                    const today = new Date()

                    if (checkInDay < 6 && today.getDate() !== lastUpdated.getDate()) {
                        checkIn = parseInt(attrs[`day_${checkInDay + 1}_points`] ?? '0')
                    }
                }
            }

            const totalEarnablePoints = readToEarn + checkIn

            return {
                readToEarn,
                checkIn,
                totalEarnablePoints
            }
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'GET-APP-EARNABLE-POINTS',
                `发生错误: ${error instanceof Error ? error.message : String(error)}`
            )
            throw error
        }
    }
    /**
     * 获取当前积分金额
     * @returns {number} 当前总积分金额
     */
    async getCurrentPoints(): Promise<number> {
        try {
            const data = await this.getDashboardData()

            return data.userStatus.availablePoints
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'GET-CURRENT-POINTS',
                `发生错误: ${error instanceof Error ? error.message : String(error)}`
            )
            throw error
        }
    }

    /**
     * 从 dashboard 页面和静态脚本提取 Next.js Server Action 运行信息。
     * hash 与 dashboard 部署版本绑定，所以优先动态解析当前页面使用的 hash。
     */
    async extractServerActionRuntimeInfo(page: Page, includeScripts = true): Promise<ServerActionRuntimeInfo> {
        try {
            // 优先用页面 DOM 提取（已加载时）
            let html: string | null = null
            try {
                html = await page.content()
            } catch {
                html = null
            }

            // DOM 没拿到时用 axios 直接请求页面
            if (!html) {
                const request: AxiosRequestConfig = {
                    url: 'https://rewards.bing.com/dashboard',
                    method: 'GET',
                    headers: {
                        ...(this.bot.fingerprint?.headers ?? {}),
                        Cookie: this.buildCookieHeader(this.bot.cookies.mobile, [
                            'bing.com',
                            'live.com',
                            'microsoftonline.com'
                        ]),
                        Referer: 'https://rewards.bing.com/'
                    }
                }
                const response = await this.bot.axios.request(request)
                html = typeof response.data === 'string' ? response.data : String(response.data)
            }

            const deploymentId = extractDeploymentIdFromHtml(html)
            const scriptUrls = extractScriptUrls(html)
            const sources = [{ name: 'dashboard-html', content: html }]

            for (const scriptUrl of includeScripts ? scriptUrls.slice(0, 30) : []) {
                try {
                    const response = await this.bot.axios.request({
                        url: scriptUrl,
                        method: 'GET',
                        headers: {
                            ...(this.bot.fingerprint?.headers ?? {}),
                            Cookie: this.buildCookieHeader(this.bot.cookies.mobile, [
                                'bing.com',
                                'live.com',
                                'microsoftonline.com'
                            ]),
                            Referer: 'https://rewards.bing.com/dashboard'
                        },
                        responseType: 'text',
                        transformResponse: data => data
                    })

                    const content = typeof response.data === 'string' ? response.data : String(response.data ?? '')
                    if (content) sources.push({ name: scriptUrl, content })
                } catch (error) {
                    this.bot.logger.debug(
                        this.bot.isMobile,
                        'SERVER-ACTION',
                        `读取 dashboard 脚本失败，已跳过 | script=${new URL(scriptUrl).pathname} | 错误=${error instanceof Error ? error.message : String(error)}`
                    )
                }
            }

            if (!deploymentId) {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'SERVER-ACTION',
                    '未能从 dashboard 页面提取部署 ID，新版 Server Action 功能将跳过'
                )
                return { deploymentId: null, hashes: {}, diagnostics: {}, scriptUrls }
            }

            const dynamicResult = extractServerActionHashResultFromSources(sources)
            const hashes =
                isKnownServerActionDeployment(deploymentId)
                    ? { ...FALLBACK_SERVER_ACTION_HASHES, ...dynamicResult.hashes }
                    : dynamicResult.hashes

            const detectedActions = Object.keys(hashes)
            if (detectedActions.length > 0) {
                this.bot.logger.info(
                    this.bot.isMobile,
                    'SERVER-ACTION',
                    `新版仪表板部署 ID: ${deploymentId} | 已识别 Server Action: ${detectedActions.join(',')}`
                )
            } else {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'SERVER-ACTION',
                    `新版仪表板部署 ID: ${deploymentId} | 未识别到可用 Server Action hash，相关功能将降级跳过`
                )
            }
            for (const [action, diagnostic] of Object.entries(dynamicResult.diagnostics)) {
                if (!diagnostic.unique) {
                    this.bot.logger.warn(
                        this.bot.isMobile,
                        'SERVER-ACTION',
                        `Server Action hash 未唯一确认，已跳过动态调用 | action=${action} | reason=${diagnostic.reason} | candidates=${diagnostic.candidateCount}`
                    )
                }
            }

            return { deploymentId, hashes, diagnostics: dynamicResult.diagnostics, scriptUrls }
        } catch (error) {
            this.bot.logger.warn(
                this.bot.isMobile,
                'SERVER-ACTION',
                `提取 Server Action 信息失败: ${error instanceof Error ? error.message : String(error)}`
            )
            return { deploymentId: null, hashes: {}, diagnostics: {}, scriptUrls: [] }
        }
    }

    /**
     * 调用新版 dashboard 的 Next.js Server Action。
     * 认证靠 Cookie（无需 requestToken / accessToken），返回的响应是 RSC 流，只看 HTTP 状态码判断成功。
     *
     * @param actionName Server Action 名称
     * @param args Server Action 参数数组（如 [true] 开启连击保护；[] 无参数领积分）
     * @param tag 日志标签
     * @returns 成功返回 true，失败/降级返回 false
     */
    async callServerAction(
        actionName: ServerActionName,
        args: unknown[],
        tag: string
    ): Promise<boolean> {
        if (!this.bot.serverActions.hashes[actionName]) {
            this.bot.serverActions = await this.extractServerActionRuntimeInfo(this.bot.mainMobilePage, true)
        }

        const deploymentId = this.bot.serverActions.deploymentId
        const actionHash = this.bot.serverActions.hashes[actionName]

        if (!deploymentId || !actionHash) {
            this.bot.logger.warn(
                this.bot.isMobile,
                tag,
                `跳过：未识别到当前 dashboard 可用的 Server Action hash | action=${actionName} | deployment=${deploymentId ?? 'null'}`
            )
            return false
        }

        try {
            const request: AxiosRequestConfig = {
                url: 'https://rewards.bing.com/dashboard',
                method: 'POST',
                headers: {
                    Accept: 'text/x-component',
                    'Content-Type': 'text/plain;charset=UTF-8',
                    'next-action': actionHash,
                    // next-router-state-tree 是 Next.js App Router 内部状态，服务端用于路由匹配
                    // 这里传一个最小化的 dashboard 路由树（通过请求分析得到的结构）
                    'next-router-state-tree':
                        '%5B%22%22%2C%7B%22children%22%3A%5B%22(nav)%22%2C%7B%22children%22%3A%5B%22dashboard%22%2C%7B%22children%22%3A%5B%22__PAGE__%22%2C%7B%7D%2Cnull%2Cnull%2C0%5D%7D%2Cnull%2Cnull%2C0%5D%7D%2Cnull%2Cnull%2C0%5D%7D%2Cnull%2Cnull%2C16%5D',
                    'x-deployment-id': deploymentId,
                    Referer: 'https://rewards.bing.com/dashboard',
                    Cookie: this.buildCookieHeader(this.bot.cookies.mobile, [
                        'bing.com',
                        'live.com',
                        'microsoftonline.com'
                    ])
                },
                // Server Action 参数序列化为 JSON 数组字符串
                data: JSON.stringify(args)
            }

            this.bot.logger.debug(
                this.bot.isMobile,
                tag,
                `发送 Server Action 请求 | action=${actionName} | deployment=${deploymentId} | hashPrefix=${actionHash.slice(0, 8)} | args=${JSON.stringify(args)}`
            )

            const response = await this.bot.axios.request(request)

            this.bot.logger.debug(
                this.bot.isMobile,
                tag,
                `收到 Server Action 响应 | action=${actionName} | 状态=${response.status}`
            )

            if (response.status >= 200 && response.status < 300) {
                return true
            }

            this.bot.logger.warn(
                this.bot.isMobile,
                tag,
                `Server Action 失败 | action=${actionName} | 状态=${response.status}`
            )
            return false
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                tag,
                `Server Action 出错 | action=${actionName} | 消息=${error instanceof Error ? error.message : String(error)}`
            )
            return false
        }
    }

    async clickClaimBonusPointsButton(page: Page): Promise<boolean> {
        try {
            await page.goto('https://rewards.bing.com/dashboard', { waitUntil: 'domcontentloaded', timeout: 15000 })
                .catch(() => {})
            await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {})

            const entryResult = await page.evaluate(() => {
                const normalizeText = (value: string | null | undefined) => (value ?? '').replace(/\s+/g, ' ').trim()
                const isVisible = (el: Element) => {
                    const rect = (el as HTMLElement).getBoundingClientRect()
                    const style = window.getComputedStyle(el)
                    return (
                        rect.width > 0 &&
                        rect.height > 0 &&
                        style.visibility !== 'hidden' &&
                        style.display !== 'none' &&
                        style.pointerEvents !== 'none'
                    )
                }
                const isDisabled = (el: Element) =>
                    (el as HTMLButtonElement).disabled === true ||
                    el.getAttribute('aria-disabled') === 'true' ||
                    el.getAttribute('disabled') !== null
                const selector = 'button,a,[role="button"],[data-testid],[aria-label],[title]'
                const candidates = Array.from(document.querySelectorAll(selector))
                    .filter(el => !isDisabled(el) && isVisible(el))
                    .map(el => {
                        const element = el as HTMLElement
                        const text = normalizeText(
                            [
                                element.innerText,
                                element.textContent,
                                el.getAttribute('aria-label'),
                                el.getAttribute('title'),
                                el.getAttribute('data-testid'),
                                el.id,
                                el.className?.toString()
                            ].join(' ')
                        )
                        const context = normalizeText(
                            [
                                text,
                                el.closest('[data-testid], section, article, div')?.textContent,
                                el.closest('[data-testid], section, article, div')?.getAttribute('data-testid'),
                                el.closest('[class], [id]')?.className?.toString(),
                                el.closest('[class], [id]')?.id
                            ].join(' ')
                        )
                        let score = 0
                        if (/可领取/.test(text)) score += 60
                        if (/领取|claim/i.test(text)) score += 40
                        if (/积分|points?|奖励|bonus/i.test(context)) score += 20
                        if (element.tagName.toLowerCase() === 'button') score += 10
                        return { el, text, score }
                    })
                    .filter(candidate => candidate.score >= 80)
                    .sort((a, b) => b.score - a.score)

                const target = candidates[0]
                if (!target) return { clicked: false, reason: 'no-entry-button' }

                target.el.scrollIntoView({ block: 'center', inline: 'center' })
                ;(target.el as HTMLElement).click()
                return { clicked: true, text: target.text.slice(0, 100), score: target.score }
            })

            if (!entryResult.clicked) {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'CLAIM-BONUS-POINTS',
                    `页面点击兜底未找到奖励领取入口 | reason=${entryResult.reason}`
                )
                return false
            }

            this.bot.logger.info(
                this.bot.isMobile,
                'CLAIM-BONUS-POINTS',
                `已点击 dashboard 奖励领取入口 | 文本="${entryResult.text ?? ''}" | score=${entryResult.score ?? 0}`
            )
            await this.bot.utils.wait(this.bot.utils.randomDelay(1500, 3000))

            const confirmResult = await page.evaluate(() => {
                const normalizeText = (value: string | null | undefined) => (value ?? '').replace(/\s+/g, ' ').trim()
                const isVisible = (el: Element) => {
                    const rect = (el as HTMLElement).getBoundingClientRect()
                    const style = window.getComputedStyle(el)
                    return (
                        rect.width > 0 &&
                        rect.height > 0 &&
                        style.visibility !== 'hidden' &&
                        style.display !== 'none' &&
                        style.pointerEvents !== 'none'
                    )
                }
                const isDisabled = (el: Element) =>
                    (el as HTMLButtonElement).disabled === true ||
                    el.getAttribute('aria-disabled') === 'true' ||
                    el.getAttribute('disabled') !== null
                const dialogRoots = Array.from(
                    document.querySelectorAll('[role="dialog"],[aria-modal="true"],[class*="modal" i],[class*="dialog" i],[class*="drawer" i]')
                ).filter(isVisible)
                const roots = dialogRoots.length > 0 ? dialogRoots : [document.body]
                const candidates = roots
                    .flatMap(root =>
                        Array.from(root.querySelectorAll('button,a,[role="button"],[data-testid],[aria-label],[title]'))
                    )
                    .filter(el => !isDisabled(el) && isVisible(el))
                    .map(el => {
                        const element = el as HTMLElement
                        const text = normalizeText(
                            [
                                element.innerText,
                                element.textContent,
                                el.getAttribute('aria-label'),
                                el.getAttribute('title'),
                                el.getAttribute('data-testid'),
                                el.id,
                                el.className?.toString()
                            ].join(' ')
                        )
                        let score = 0
                        if (text === '领取积分') score += 100
                        if (/领取积分|claim points/i.test(text)) score += 80
                        if (/领取|claim/i.test(text)) score += 40
                        if (element.tagName.toLowerCase() === 'button') score += 10
                        return { el, text, score }
                    })
                    .filter(candidate => candidate.score >= 50)
                    .sort((a, b) => b.score - a.score)

                const target = candidates[0]
                if (!target) {
                    const dialogText = dialogRoots.map(root => normalizeText(root.textContent).slice(0, 160)).join(' | ')
                    return { clicked: false, reason: 'no-confirm-button', dialogText }
                }

                target.el.scrollIntoView({ block: 'center', inline: 'center' })
                ;(target.el as HTMLElement).click()
                return { clicked: true, text: target.text.slice(0, 100), score: target.score }
            })

            if (!confirmResult.clicked) {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'CLAIM-BONUS-POINTS',
                    `页面点击兜底未找到抽屉确认按钮 | reason=${confirmResult.reason} | dialog="${confirmResult.dialogText ?? ''}"`
                )
                return false
            }

            this.bot.logger.info(
                this.bot.isMobile,
                'CLAIM-BONUS-POINTS',
                `已点击 dashboard 奖励领取确认按钮 | 文本="${confirmResult.text ?? ''}" | score=${confirmResult.score ?? 0}`
            )
            await this.bot.utils.wait(this.bot.utils.randomDelay(5000, 8000))
            return true
        } catch (error) {
            this.bot.logger.warn(
                this.bot.isMobile,
                'CLAIM-BONUS-POINTS',
                `页面点击兜底领取失败: ${error instanceof Error ? error.message : String(error)}`
            )
            return false
        }
    }

    async closeBrowser(browser: BrowserContext, email: string) {
        const rootBrowser = (browser as any).browser?.() || null

        try {
            // Try to save cookies
            const cookies = await browser.cookies()
            this.bot.logger.debug(this.bot.isMobile, 'CLOSE-BROWSER', `Saving ${cookies.length} cookies.`)
            await saveSessionData(this.bot.config.sessionPath, cookies, email, this.bot.isMobile)

            await this.bot.utils.wait(2000)
        } catch (error) {
            this.bot.logger.error(this.bot.isMobile, 'CLOSE-BROWSER', `保存会话失败: ${error}`)
        } finally {
            try {
                await browser.close()

                if (rootBrowser) {
                    await rootBrowser.close().catch(() => {})
                }

                this.bot.logger.info(this.bot.isMobile, 'CLOSE-BROWSER', '浏览器已干净地关闭！')
            } catch (closeError) {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'CLOSE-BROWSER',
                    '关闭时遇到错误，但进程正在退出。'
                )
            }
        }
    }

    buildCookieHeader(cookies: Cookie[], allowedDomains?: string[]): string {
        return [
            ...new Map(
                cookies
                    .filter(c => {
                        if (!allowedDomains || allowedDomains.length === 0) return true
                        return (
                            typeof c.domain === 'string' &&
                            allowedDomains.some(d => c.domain.toLowerCase().endsWith(d.toLowerCase()))
                        )
                    })
                    .map(c => [c.name, c])
            ).values()
        ]
            .map(c => `${c.name}=${c.value}`)
            .join('; ')
    }
}
