import type { APIRequestContext, BrowserContext, Cookie, Page, Response } from 'patchright'
import type { AxiosRequestConfig } from 'axios'

import type { MicrosoftRewardsBot } from '../index'
import { saveSessionData } from '../util/Load'

import type { Counters, DashboardData, DashboardFieldAvailability } from './../interface/DashboardData'
import type { AppUserData } from '../interface/AppUserData'
import type { XboxDashboardData } from './../interface/XboxDashboardData'
import type { AppEarnablePoints, BrowserEarnablePoints, MissingSearchPoints } from '../interface/Points'
import type { AppDashboardData } from '../interface/AppDashBoardData'
import { PanelFlyoutData } from '../interface/PanelFlyoutData'
import { calculateMissingSearchPoints } from '../util/SearchCounter'
import {
    axiosFinalUrl,
    axiosRedirected,
    classifyHttpFailure,
    responseContentType,
    responseTopLevelFields,
    safeHttpUrl,
    safeAxiosDiagnostic,
    type SafeHttpDiagnostic
} from '../util/Axios'
import {
    dashboardFromApiPayload,
    dashboardFromFlyoutPayload,
    dashboardFromFlightEntries,
    dashboardFromHtml,
    validateDashboardData
} from '../util/DashboardParser'
import { DashboardFetchError } from '../util/DashboardError'
import {
    extractDeploymentIdFromHtml,
    extractScriptUrls,
    extractServerActionHashResultFromSources,
    FALLBACK_SERVER_ACTION_HASHES,
    isKnownServerActionDeployment,
    type ServerActionName,
    type ServerActionRuntimeInfo
} from '../util/ServerActions'

interface CapturedDashboard {
    data: DashboardData
    path: string
    status: number
    contentType: string | null
    topLevelFields: string[]
}

interface DashboardCaptureState {
    candidate: CapturedDashboard | null
    candidateCount: number
    geoLocale?: string
    pending: Set<Promise<void>>
}

interface BrowserContextHttpResponse {
    status: number
    headers: Record<string, string>
    body: string
    finalUrl: string | null
    redirected: boolean | null
}

export default class BrowserFunc {
    private bot: MicrosoftRewardsBot
    private dashboardCaptures = new WeakMap<Page, DashboardCaptureState>()
    private lastDashboardFieldAvailability: DashboardFieldAvailability | undefined
    private cachedPanelFlyoutData: PanelFlyoutData | null = null

    constructor(bot: MicrosoftRewardsBot) {
        this.bot = bot
    }

    prepareDashboardCapture(page: Page, geoLocale?: string): void {
        const existing = this.dashboardCaptures.get(page)
        if (existing) {
            existing.geoLocale = geoLocale
            return
        }

        const state: DashboardCaptureState = {
            candidate: null,
            candidateCount: 0,
            geoLocale,
            pending: new Set<Promise<void>>()
        }
        this.lastDashboardFieldAvailability = undefined
        this.dashboardCaptures.set(page, state)

        page.on('response', response => {
            const pending = this.captureDashboardResponse(response, state)
            state.pending.add(pending)
            void pending.finally(() => state.pending.delete(pending))
        })
    }

    /**
     * 获取用户桌面仪表板数据
     * @returns {DashboardData} 用户必应奖励仪表板数据对象
     */
    async getDashboardData(geoLocale?: string): Promise<DashboardData> {
        this.cachedPanelFlyoutData = null
        geoLocale ??= this.bot.userData?.geoLocale
        const apiPath = '/api/getuserinfo'
        const page = this.bot.mainMobilePage
        const dashboardOrigin = this.dashboardOrigin(page)
        const apiUrl = `${dashboardOrigin}${apiPath}?type=1`
        let apiFailure: SafeHttpDiagnostic
        let apiReason: string

        try {
            const browserResponse = await this.requestWithBrowserContext(page, apiUrl, {
                Referer: `${dashboardOrigin}/`,
                Origin: dashboardOrigin
            })
            let status: number
            let headers: unknown
            let data: unknown
            let finalUrl: string | null
            let redirected: boolean | null

            if (browserResponse) {
                status = browserResponse.status
                headers = browserResponse.headers
                finalUrl = browserResponse.finalUrl
                redirected = browserResponse.redirected
                try {
                    data = JSON.parse(browserResponse.body)
                } catch {
                    data = browserResponse.body
                }
            } else {
                const response = await this.bot.axios.request({
                    url: apiUrl,
                    method: 'GET',
                    headers: {
                        ...this.fingerprintHeadersWithoutCookie(),
                        Cookie: this.buildCookieHeaderForUrl(this.bot.cookies.mobile, apiUrl),
                        Referer: `${dashboardOrigin}/`,
                        Origin: dashboardOrigin
                    }
                })
                status = response.status
                headers = response.headers
                data = response.data
                finalUrl = axiosFinalUrl(response)
                redirected = axiosRedirected(response, apiUrl)
            }

            const contentType = responseContentType(headers)
            const topLevelFields = responseTopLevelFields(data)
            const parsed = dashboardFromApiPayload(data, { geoLocale })
            const successfulStatus = status >= 200 && status < 300
            const failureCategory = successfulStatus ? 'invalid-response' : classifyHttpFailure(status)
            const diagnosticReason = successfulStatus
                ? parsed.reason
                : this.describeDashboardFailure({
                      status,
                      code: null,
                      contentType,
                      topLevelFields,
                      category: failureCategory,
                      finalUrl,
                      redirected
                  })
            this.logDashboardDiagnostic('api', {
                path: apiPath,
                status,
                code: null,
                contentType,
                topLevelFields,
                htmlLength: null,
                pageUrl: null,
                pageTitle: null,
                parserReason: diagnosticReason,
                finalUrl,
                redirected,
                flightEntryCount: null,
                captureCount: null
            })

            if (successfulStatus && parsed.data) return parsed.data
            apiFailure = {
                status,
                code: null,
                contentType,
                topLevelFields,
                category: failureCategory,
                finalUrl,
                redirected
            }
            apiReason = diagnosticReason
        } catch (error) {
            apiFailure = safeAxiosDiagnostic(error)
            apiReason = this.describeDashboardFailure(apiFailure)
            this.logDashboardDiagnostic('api', {
                path: apiPath,
                status: apiFailure.status,
                code: apiFailure.code,
                contentType: apiFailure.contentType,
                topLevelFields: apiFailure.topLevelFields,
                htmlLength: null,
                pageUrl: null,
                pageTitle: null,
                parserReason: apiReason,
                finalUrl: apiFailure.finalUrl,
                redirected: apiFailure.redirected,
                flightEntryCount: null,
                captureCount: null
            })
        }

        this.bot.logger.warn(
            this.bot.isMobile,
            'GET-DASHBOARD-DATA',
            `API dashboard 不可用，尝试页面回退 | kind=${apiFailure.category} | reason=${apiReason}`
        )

        const fallbackReasons: string[] = []
        if (page && !page.isClosed()) {
            this.prepareDashboardCapture(page, geoLocale)

            const captured = await this.getCapturedDashboard(page)
            if (captured) {
                this.logCapturedDashboard(captured, page)
                return captured.data
            }

            const parsePage = async (label: string): Promise<DashboardData | null> => {
                try {
                    const [html, title, flightEntries] = await Promise.all([
                        page.content(),
                        page.title().catch(() => ''),
                        page.evaluate(() => Reflect.get(globalThis, '__next_f') ?? []).catch(() => [])
                    ])
                    this.logDashboardDiagnostic('page', {
                        path: '/dashboard',
                        status: null,
                        code: null,
                        contentType: 'text/html',
                        topLevelFields: [],
                        htmlLength: html.length,
                        pageUrl: this.safePageUrl(page.url()),
                        pageTitle: this.safePageTitle(title),
                        parserReason: null,
                        finalUrl: null,
                        redirected: null,
                        flightEntryCount: Array.isArray(flightEntries) ? flightEntries.length : 0,
                        captureCount: this.dashboardCaptures.get(page)?.candidateCount ?? 0
                    })

                    const flight = dashboardFromFlightEntries(flightEntries, { geoLocale })
                    if (flight.data) return flight.data
                    const htmlResult = dashboardFromHtml(html, { geoLocale })
                    if (htmlResult.data) return htmlResult.data
                    fallbackReasons.push(`${label}：${flight.reason}；${htmlResult.reason}`)
                } catch {
                    fallbackReasons.push(`${label}内容读取失败`)
                }
                return null
            }

            const currentPageData = await parsePage('当前页面')
            if (currentPageData) return currentPageData

            if (apiFailure.status === 404) {
                await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => null)
                await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => null)
                const reloadedCapture = await this.getCapturedDashboard(page)
                if (reloadedCapture) {
                    this.logCapturedDashboard(reloadedCapture, page)
                    return reloadedCapture.data
                }
                const reloadedPageData = await parsePage('页面重载')
                if (reloadedPageData) return reloadedPageData
            }
        }

        try {
            const dashboardUrl = `${dashboardOrigin}/dashboard`
            const browserResponse = await this.requestWithBrowserContext(page, dashboardUrl, {
                Referer: `${dashboardOrigin}/`
            })
            let status: number
            let headers: unknown
            let html: string
            let finalUrl: string | null
            let redirected: boolean | null

            if (browserResponse) {
                status = browserResponse.status
                headers = browserResponse.headers
                html = browserResponse.body
                finalUrl = browserResponse.finalUrl
                redirected = browserResponse.redirected
            } else {
                const response = await this.bot.axios.request({
                    url: dashboardUrl,
                    method: 'GET',
                    headers: {
                        ...this.fingerprintHeadersWithoutCookie(),
                        Cookie: this.buildCookieHeaderForUrl(this.bot.cookies.mobile, dashboardUrl),
                        Referer: `${dashboardOrigin}/`
                    },
                    responseType: 'text',
                    transformResponse: data => data
                })
                status = response.status
                headers = response.headers
                html = typeof response.data === 'string' ? response.data : ''
                finalUrl = axiosFinalUrl(response)
                redirected = axiosRedirected(response, dashboardUrl)
            }
            this.logDashboardDiagnostic('html', {
                path: '/dashboard',
                status,
                code: null,
                contentType: responseContentType(headers),
                topLevelFields: [],
                htmlLength: html.length,
                pageUrl: page && !page.isClosed() ? this.safePageUrl(page.url()) : null,
                pageTitle: null,
                parserReason: null,
                finalUrl,
                redirected,
                flightEntryCount: null,
                captureCount: null
            })
            const parsed = dashboardFromHtml(html, { geoLocale })
            if (parsed.data) return parsed.data
            fallbackReasons.push(`HTML 请求：${parsed.reason}`)
        } catch (error) {
            const diagnostic = safeAxiosDiagnostic(error)
            this.logDashboardDiagnostic('html', {
                path: '/dashboard',
                status: diagnostic.status,
                code: diagnostic.code,
                contentType: diagnostic.contentType,
                topLevelFields: diagnostic.topLevelFields,
                htmlLength: null,
                pageUrl: page && !page.isClosed() ? this.safePageUrl(page.url()) : null,
                pageTitle: null,
                parserReason: null,
                finalUrl: diagnostic.finalUrl,
                redirected: diagnostic.redirected,
                flightEntryCount: null,
                captureCount: null
            })
            fallbackReasons.push(`HTML 请求：${this.describeDashboardFailure(diagnostic)}`)
        }

        if (apiFailure.category === 'endpoint-unavailable' || apiFailure.category === 'invalid-response') {
            const flyoutReasons: string[] = []
            for (const targetUrl of this.panelFlyoutFallbackUrls(geoLocale)) {
                const target = new URL(targetUrl)
                try {
                    const functionalHeaders = {
                        Accept: 'application/json',
                        Referer: `${target.origin}/`,
                        Origin: target.origin
                    }
                    const browserResponse = await this.requestWithBrowserContext(page, targetUrl, functionalHeaders)
                    let status: number
                    let headers: unknown
                    let payload: unknown
                    let finalUrl: string | null
                    let redirected: boolean | null
                    if (browserResponse) {
                        status = browserResponse.status
                        headers = browserResponse.headers
                        payload = browserResponse.body
                        finalUrl = browserResponse.finalUrl
                        redirected = browserResponse.redirected
                    } else {
                        const response = await this.bot.axios.request({
                            url: targetUrl,
                            method: 'GET',
                            headers: {
                                ...this.fingerprintHeadersWithoutCookie(),
                                ...functionalHeaders,
                                Cookie: this.buildCookieHeaderForUrl(this.bot.cookies.mobile, targetUrl)
                            },
                            maxRedirects: 0,
                            validateStatus: () => true
                        })
                        status = response.status
                        headers = response.headers
                        payload = response.data
                        finalUrl = axiosFinalUrl(response)
                        redirected = axiosRedirected(response, targetUrl)
                    }
                    if (typeof payload === 'string') {
                        try {
                            payload = JSON.parse(payload)
                        } catch {
                            // The parser below reports a safe structural reason.
                        }
                    }
                    const successfulStatus = status >= 200 && status < 300
                    const parsed = dashboardFromFlyoutPayload(payload, { geoLocale })
                    const parserReason = successfulStatus
                        ? parsed.reason
                        : this.describeDashboardFailure({
                              status,
                              code: null,
                              contentType: responseContentType(headers),
                              topLevelFields: responseTopLevelFields(payload),
                              category: classifyHttpFailure(status),
                              finalUrl,
                              redirected
                          })
                    this.logDashboardDiagnostic('flyout', {
                        path: target.pathname,
                        status,
                        code: null,
                        contentType: responseContentType(headers),
                        topLevelFields: responseTopLevelFields(payload),
                        htmlLength: null,
                        pageUrl: null,
                        pageTitle: null,
                        parserReason,
                        finalUrl,
                        redirected,
                        flightEntryCount: null,
                        captureCount: null
                    })

                    if (successfulStatus && parsed.data) {
                        this.cachedPanelFlyoutData = payload as PanelFlyoutData
                        const unavailableFields = Object.entries(parsed.data.dashboardFieldAvailability)
                            .filter(([, availability]) => availability !== 'available')
                            .map(([field, availability]) => `${field}=${availability}`)
                            .join(',')
                        this.bot.logger.warn(
                            this.bot.isMobile,
                            'GET-DASHBOARD-DATA',
                            `使用 Bing flyout dashboard 降级 | host=${target.hostname} | unavailableFields=${unavailableFields || 'none'}`
                        )
                        return parsed.data
                    }
                    flyoutReasons.push(`${target.hostname}：${parserReason}`)
                } catch (error) {
                    const diagnostic = safeAxiosDiagnostic(error)
                    const reason = this.describeDashboardFailure(diagnostic)
                    this.logDashboardDiagnostic('flyout', {
                        path: target.pathname,
                        status: diagnostic.status,
                        code: diagnostic.code,
                        contentType: diagnostic.contentType,
                        topLevelFields: diagnostic.topLevelFields,
                        htmlLength: null,
                        pageUrl: null,
                        pageTitle: null,
                        parserReason: reason,
                        finalUrl: diagnostic.finalUrl,
                        redirected: diagnostic.redirected,
                        flightEntryCount: null,
                        captureCount: null
                    })
                    flyoutReasons.push(`${target.hostname}：${reason}`)
                }
            }
            fallbackReasons.push(`Bing flyout：${flyoutReasons.join('；') || '未返回可校验数据'}`)
        }

        const fallbackReason = fallbackReasons.join(' | ').slice(0, 800) || '页面回退未返回可校验的 dashboard'
        this.bot.logger.error(
            this.bot.isMobile,
            'GET-DASHBOARD-DATA',
            `dashboard 获取失败 | apiKind=${apiFailure.category} | apiStatus=${apiFailure.status ?? 'n/a'} | fallback=${fallbackReason}`
        )
        throw new DashboardFetchError({
            apiStatus: apiFailure.status,
            apiFailureKind: apiFailure.category,
            apiReason,
            fallbackReason
        })
    }

    private dashboardOrigin(page: Page | undefined): string {
        const candidates = [page && !page.isClosed() ? page.url() : null, this.bot.config.baseURL]
        for (const candidate of candidates) {
            if (typeof candidate !== 'string') continue
            try {
                const url = new URL(candidate)
                const host = url.hostname.toLowerCase()
                const trustedHost = host === 'rewards.bing.com' || host === 'rewards.microsoft.com'
                const trustedPath =
                    (host.endsWith('.bing.com') || host.endsWith('.microsoft.com')) &&
                    (url.pathname.includes('/dashboard') || url.pathname.includes('/rewards'))
                if (url.protocol === 'https:' && (trustedHost || trustedPath)) return url.origin
            } catch {
                // Try the next trusted local candidate.
            }
        }
        return 'https://rewards.bing.com'
    }

    private panelFlyoutFallbackUrls(geoLocale?: string): string[] {
        const path = '/rewards/panelflyout/getuserinfo?channel=BingFlyout&partnerId=BingRewards'
        const normalizedLocale = geoLocale?.trim().toLowerCase()
        const cookieDomains = this.bot.cookies.mobile.map(cookie => cookie.domain.replace(/^\./, '').toLowerCase())
        const preferChina =
            normalizedLocale === 'cn' ||
            ((normalizedLocale === undefined || normalizedLocale === '' || normalizedLocale === 'auto') &&
                cookieDomains.includes('cn.bing.com') &&
                !cookieDomains.includes('www.bing.com'))
        const hosts = preferChina ? ['cn.bing.com', 'www.bing.com'] : ['www.bing.com', 'cn.bing.com']
        return hosts.map(host => `https://${host}${path}`)
    }

    private dashboardRequestContext(page: Page | undefined): APIRequestContext | null {
        if (!page || page.isClosed()) return null
        try {
            const request = page.context().request
            return request && typeof request.get === 'function' ? request : null
        } catch {
            return null
        }
    }

    private async requestWithBrowserContext(
        page: Page | undefined,
        targetUrl: string,
        headers: Record<string, string>
    ): Promise<BrowserContextHttpResponse | null> {
        const request = this.dashboardRequestContext(page)
        if (!request) return null

        const response = await request.get(targetUrl, {
            headers,
            failOnStatusCode: false
        })
        try {
            const finalUrl = safeHttpUrl(response.url())
            return {
                status: response.status(),
                headers: response.headers(),
                body: await response.text(),
                finalUrl,
                redirected: finalUrl === null ? null : finalUrl !== safeHttpUrl(targetUrl)
            }
        } finally {
            await response.dispose()
        }
    }

    private fingerprintHeadersWithoutCookie(): Record<string, string> {
        return Object.fromEntries(
            Object.entries(this.bot.fingerprint?.headers ?? {}).filter(([name]) => name.toLowerCase() !== 'cookie')
        )
    }

    private async captureDashboardResponse(response: Response, state: DashboardCaptureState): Promise<void> {
        try {
            const request = response.request()
            const resourceType = request.resourceType()
            if (resourceType !== 'xhr' && resourceType !== 'fetch') return

            const url = new URL(response.url())
            const expectedOrigin = new URL(this.bot.config.baseURL).origin
            const frameOrigin = (() => {
                try {
                    return new URL(request.frame().url()).origin
                } catch {
                    return null
                }
            })()
            if (url.protocol !== 'https:' || (url.origin !== expectedOrigin && url.origin !== frameOrigin)) return
            if (response.status() < 200 || response.status() >= 300) return

            const headers = response.headers()
            const contentLength = Number(headers['content-length'] ?? 0)
            if (Number.isFinite(contentLength) && contentLength > 2_000_000) return

            const body = await response.body()
            if (body.length === 0 || body.length > 2_000_000) return

            let payload: unknown
            try {
                payload = JSON.parse(body.toString('utf8')) as unknown
            } catch {
                return
            }

            state.candidateCount += 1
            const wrapped = dashboardFromApiPayload(payload, { geoLocale: state.geoLocale })
            const direct = wrapped.data ? null : validateDashboardData(payload, { geoLocale: state.geoLocale })
            const data = wrapped.data ?? (direct?.valid ? direct.data : null)
            if (!data) return

            state.candidate = {
                data,
                path: url.pathname.slice(0, 300),
                status: response.status(),
                contentType: responseContentType(headers),
                topLevelFields: responseTopLevelFields(payload)
            }
        } catch {
            // Browser response capture is opportunistic; the normal fallback chain reports failures.
        }
    }

    private async getCapturedDashboard(page: Page): Promise<CapturedDashboard | null> {
        const state = this.dashboardCaptures.get(page)
        if (!state) return null
        for (let pass = 0; pass < 2 && state.pending.size > 0; pass += 1) {
            await Promise.allSettled([...state.pending])
        }
        return state.candidate
    }

    private logCapturedDashboard(captured: CapturedDashboard, page: Page): void {
        this.logDashboardDiagnostic('capture', {
            path: captured.path,
            status: captured.status,
            code: null,
            contentType: captured.contentType,
            topLevelFields: captured.topLevelFields,
            htmlLength: null,
            pageUrl: this.safePageUrl(page.url()),
            pageTitle: null,
            parserReason: 'ok',
            finalUrl: null,
            redirected: null,
            flightEntryCount: null,
            captureCount: this.dashboardCaptures.get(page)?.candidateCount ?? 0
        })
    }

    private describeDashboardFailure(diagnostic: SafeHttpDiagnostic): string {
        switch (diagnostic.category) {
            case 'auth':
                return `API 鉴权失败 (${diagnostic.status})`
            case 'rate-limit':
                return 'API 请求受限 (429)'
            case 'server':
                return `API 服务端错误 (${diagnostic.status})`
            case 'endpoint-unavailable':
                return 'dashboard endpoint unavailable'
            case 'network':
                return `API 网络错误 (${diagnostic.code ?? 'unknown'})`
            case 'invalid-response':
                return `API 响应格式错误 (${diagnostic.status ?? 'unknown'})`
        }
    }

    private logDashboardDiagnostic(
        source: 'api' | 'page' | 'html' | 'capture' | 'flyout',
        diagnostic: {
            path: string
            status: number | null
            code: string | null
            contentType: string | null
            topLevelFields: string[]
            htmlLength: number | null
            pageUrl: string | null
            pageTitle: string | null
            parserReason: string | null
            finalUrl: string | null
            redirected: boolean | null
            flightEntryCount: number | null
            captureCount: number | null
        }
    ): void {
        this.bot.logger.debug(
            this.bot.isMobile,
            'GET-DASHBOARD-DATA',
            `source=${source} | path=${diagnostic.path} | status=${diagnostic.status ?? 'n/a'} | axiosCode=${diagnostic.code ?? 'n/a'} | contentType=${diagnostic.contentType ?? 'n/a'} | topLevelFields=${diagnostic.topLevelFields.join(',') || 'none'} | parserReason=${diagnostic.parserReason ?? 'n/a'} | htmlLength=${diagnostic.htmlLength ?? 'n/a'} | flightEntries=${diagnostic.flightEntryCount ?? 'n/a'} | capturedCandidates=${diagnostic.captureCount ?? 'n/a'} | finalUrl=${diagnostic.finalUrl ?? 'n/a'} | redirected=${diagnostic.redirected ?? 'n/a'} | pageUrl=${diagnostic.pageUrl ?? 'n/a'} | pageTitle=${diagnostic.pageTitle ?? 'n/a'}`
        )
    }

    private safePageUrl(rawUrl: string): string {
        try {
            const url = new URL(rawUrl)
            return `${url.origin === 'null' ? `${url.protocol}//` : url.origin}${url.pathname}`.slice(0, 300)
        } catch {
            return 'unavailable'
        }
    }

    private safePageTitle(title: string): string {
        return title
            .replace(/[\r\n\t]+/g, ' ')
            .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '<redacted-email>')
            .replace(/\b(token|code|authorization|cookie)\s*[:=]\s*\S+/gi, '$1=<redacted>')
            .trim()
            .slice(0, 160)
    }

    /**
     * Fetch user panel flyout data
     * @returns {PanelFlyoutData} Object of user bing rewards dashboard data
     */
    async getPanelFlyoutData(): Promise<PanelFlyoutData> {
        if (this.cachedPanelFlyoutData) {
            const cached = this.cachedPanelFlyoutData
            this.cachedPanelFlyoutData = null
            return cached
        }

        try {
            const targetUrl =
                'https://cn.bing.com/rewards/panelflyout/getuserinfo?channel=BingFlyout&partnerId=BingRewards'
            const request: AxiosRequestConfig = {
                url: targetUrl,
                method: 'GET',
                headers: {
                    ...this.fingerprintHeadersWithoutCookie(),
                    Cookie: this.buildCookieHeaderForUrl(this.bot.cookies.mobile, targetUrl),
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
        this.lastDashboardFieldAvailability = dashboardData.dashboardFieldAvailability
        return dashboardData.userStatus.counters
    }

    missingSearchPoints(
        counters: Counters,
        isMobile: boolean,
        availability = this.lastDashboardFieldAvailability
    ): MissingSearchPoints {
        return calculateMissingSearchPoints(counters, isMobile, 'dashboard', availability)
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
        const targetUrl = this.bot.config.baseURL
        const browserResponse = await this.requestWithBrowserContext(this.bot.mainMobilePage, targetUrl, {
            Referer: 'https://rewards.bing.com/',
            Origin: 'https://rewards.bing.com'
        })
        let html: string
        if (browserResponse) {
            html = browserResponse.body
        } else {
            const request: AxiosRequestConfig = {
                url: targetUrl,
                method: 'GET',
                headers: {
                    ...this.fingerprintHeadersWithoutCookie(),
                    Cookie: this.buildCookieHeaderForUrl(this.bot.cookies.mobile, targetUrl),
                    Referer: 'https://rewards.bing.com/',
                    Origin: 'https://rewards.bing.com'
                }
            }
            const response = await this.bot.axios.request(request)
            html = typeof response.data === 'string' ? response.data : ''
        }
        const parsed = dashboardFromHtml(html)
        if (!parsed.data) return null
        return calculateMissingSearchPoints(
            parsed.data.userStatus.counters,
            isMobile,
            'dashboard-html',
            parsed.data.dashboardFieldAvailability
        )
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
    async getBrowserEarnablePoints(dashboardData?: DashboardData): Promise<BrowserEarnablePoints> {
        try {
            const data = dashboardData ?? (await this.getDashboardData())

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

            // DOM 没拿到时优先复用 BrowserContext Cookie jar，请求 API 不可用时再降级到 axios。
            if (!html) {
                const dashboardUrl = 'https://rewards.bing.com/dashboard'
                const browserResponse = await this.requestWithBrowserContext(page, dashboardUrl, {
                    Referer: 'https://rewards.bing.com/'
                })
                if (browserResponse) {
                    html = browserResponse.body
                } else {
                    const request: AxiosRequestConfig = {
                        url: dashboardUrl,
                        method: 'GET',
                        headers: {
                            ...this.fingerprintHeadersWithoutCookie(),
                            Cookie: this.buildCookieHeaderForUrl(this.bot.cookies.mobile, dashboardUrl),
                            Referer: 'https://rewards.bing.com/'
                        }
                    }
                    const response = await this.bot.axios.request(request)
                    html = typeof response.data === 'string' ? response.data : String(response.data)
                }
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
                            ...this.fingerprintHeadersWithoutCookie(),
                            Cookie: this.buildCookieHeaderForUrl(this.bot.cookies.mobile, scriptUrl),
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
            const hashes = isKnownServerActionDeployment(deploymentId)
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
    async callServerAction(actionName: ServerActionName, args: unknown[], tag: string): Promise<boolean> {
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
            const targetUrl = 'https://rewards.bing.com/dashboard'
            const request: AxiosRequestConfig = {
                url: targetUrl,
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
                    Cookie: this.buildCookieHeaderForUrl(this.bot.cookies.mobile, targetUrl)
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
            await page
                .goto('https://rewards.bing.com/dashboard', { waitUntil: 'domcontentloaded', timeout: 15000 })
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
                    document.querySelectorAll(
                        '[role="dialog"],[aria-modal="true"],[class*="modal" i],[class*="dialog" i],[class*="drawer" i]'
                    )
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
                    const dialogText = dialogRoots
                        .map(root => normalizeText(root.textContent).slice(0, 160))
                        .join(' | ')
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
        const rootBrowser = browser.browser?.() ?? null

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
            } catch {
                this.bot.logger.warn(this.bot.isMobile, 'CLOSE-BROWSER', '关闭时遇到错误，但进程正在退出。')
            }
        }
    }

    buildCookieHeaderForUrl(cookies: Cookie[], targetUrl: string): string {
        let url: URL
        try {
            url = new URL(targetUrl)
        } catch {
            throw new TypeError('Cookie Header target must be a valid HTTP(S) URL')
        }
        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
            throw new TypeError(`Cookie Header target must use HTTP(S): ${url.protocol}`)
        }

        const hostname = url.hostname.toLowerCase()
        const requestPath = url.pathname || '/'
        const now = Date.now() / 1000

        return cookies
            .map((cookie, index) => ({ cookie, index }))
            .filter(({ cookie }) => {
                const rawDomain = cookie.domain.toLowerCase()
                const domainCookie = rawDomain.startsWith('.')
                const cookieDomain = domainCookie ? rawDomain.slice(1) : rawDomain
                const domainMatches = domainCookie
                    ? hostname === cookieDomain || hostname.endsWith(`.${cookieDomain}`)
                    : hostname === cookieDomain
                if (!domainMatches) return false

                const cookiePath = cookie.path
                const pathMatches =
                    requestPath === cookiePath ||
                    (requestPath.startsWith(cookiePath) &&
                        (cookiePath.endsWith('/') || requestPath.charAt(cookiePath.length) === '/'))
                if (!pathMatches) return false
                if (cookie.secure && url.protocol !== 'https:') return false
                return cookie.expires === -1 || cookie.expires > now
            })
            .sort((left, right) => right.cookie.path.length - left.cookie.path.length || left.index - right.index)
            .map(({ cookie }) => `${cookie.name}=${cookie.value}`)
            .join('; ')
    }
}
