import type { APIRequestContext, APIResponse, BrowserContext, Cookie, Page, Response } from 'patchright'
import type { AxiosRequestConfig, AxiosResponse } from 'axios'

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
    availablePointsFromApiPayload,
    dashboardFromApiPayload,
    dashboardFromFlyoutPayload,
    dashboardFromFlightEntries,
    dashboardFromHtml,
    validateDashboardData
} from '../util/DashboardParser'
import { DashboardFetchError, dashboardFailureDetails, type DashboardFailureDetails } from '../util/DashboardError'
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
    pointsCandidate: { points: number; path: string; observedAt: string } | null
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

export interface CurrentPointsSnapshot {
    points: number | null
    source: string | null
    confidence: 'confirmed' | 'cached' | 'unknown'
    observedAt: string | null
    error: DashboardFailureDetails | null
}

interface TrustedPointsCache {
    scope: string
    points: number
    source: string
    observedAt: string
    sequence: number
}

type ClaimButtonSearchMode = 'confirm' | 'entry-or-confirm'

interface ClaimButtonClickResult {
    clicked: boolean
    phase?: 'entry' | 'confirm'
    reason?: string
    score?: number
}

const DASHBOARD_REQUEST_TIMEOUT_MS = 8000
const DASHBOARD_TOTAL_TIMEOUT_MS = 55000
const DASHBOARD_API_ATTEMPTS = 3
const DASHBOARD_RETRY_BASE_DELAY_MS = 500
const DASHBOARD_RETRY_JITTER_MS = 250
const CLAIM_ENTRY_TIMEOUT_MS = 15000
const CLAIM_CONFIRM_TIMEOUT_MS = 10000
const CLAIM_POLL_INTERVAL_MS = 250

export default class BrowserFunc {
    private readonly verifiedSessionContexts = new WeakSet<BrowserContext>()
    private bot: MicrosoftRewardsBot
    private dashboardCaptures = new WeakMap<Page, DashboardCaptureState>()
    private lastDashboardFieldAvailability: DashboardFieldAvailability | undefined
    private cachedPanelFlyoutData: PanelFlyoutData | null = null
    private lastDashboardSource: string | null = null
    private trustedPointsCache: TrustedPointsCache | null = null
    private pointsCacheSequence = 0

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
            pointsCandidate: null,
            candidateCount: 0,
            geoLocale,
            pending: new Set<Promise<void>>()
        }
        this.lastDashboardFieldAvailability = undefined
        this.dashboardCaptures.set(page, state)

        if (typeof page.on !== 'function') return
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
        const result = await this.getDashboardResult(geoLocale, false)
        if (this.isCurrentPointsSnapshot(result)) {
            throw new Error('完整 dashboard 请求意外返回轻量积分结果')
        }
        return result
    }

    private async getDashboardResult(
        geoLocale: string | undefined,
        allowLightweightPoints: boolean
    ): Promise<DashboardData | CurrentPointsSnapshot> {
        const startedAt = Date.now()
        try {
            return await this.getDashboardDataWithinBudget(
                geoLocale,
                startedAt + DASHBOARD_TOTAL_TIMEOUT_MS,
                startedAt,
                allowLightweightPoints
            )
        } finally {
            this.bot.logger.debug(
                this.bot.isMobile,
                'GET-DASHBOARD-DATA',
                `请求结束 | elapsedMs=${Date.now() - startedAt} | totalTimeoutMs=${DASHBOARD_TOTAL_TIMEOUT_MS}`
            )
        }
    }

    private async getDashboardDataWithinBudget(
        geoLocale: string | undefined,
        deadline: number,
        startedAt: number,
        allowLightweightPoints: boolean
    ): Promise<DashboardData | CurrentPointsSnapshot> {
        this.cachedPanelFlyoutData = null
        geoLocale ??= this.bot.userData?.geoLocale
        const apiPath = '/api/getuserinfo'
        const page = this.bot.mainMobilePage
        const dashboardOrigin = this.dashboardOrigin(page)
        const apiUrl = `${dashboardOrigin}${apiPath}?type=1`
        let apiFailure: SafeHttpDiagnostic
        let apiReason: string
        let apiAttempts = 0

        if (page && !page.isClosed()) this.prepareDashboardCapture(page, geoLocale)

        apiFailure = this.networkDashboardFailure()
        apiReason = 'API 尚未请求'
        for (let attempt = 1; attempt <= DASHBOARD_API_ATTEMPTS; attempt += 1) {
            if (this.dashboardRemainingMs(deadline) <= 0) {
                apiReason = `请求总耗时超过 ${DASHBOARD_TOTAL_TIMEOUT_MS}ms`
                break
            }
            apiAttempts = attempt
            try {
                const requestTimeout = this.dashboardRequestTimeout(deadline)
                const browserResponse = await this.requestWithBrowserContext(
                    page,
                    apiUrl,
                    {
                        Referer: `${dashboardOrigin}/`,
                        Origin: dashboardOrigin
                    },
                    requestTimeout
                )
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
                    const response = await this.requestDashboardAxios(
                        {
                            url: apiUrl,
                            method: 'GET',
                            headers: {
                                ...this.fingerprintHeadersWithoutCookie(),
                                Cookie: this.buildCookieHeaderForUrl(this.bot.cookies.mobile, apiUrl),
                                Referer: `${dashboardOrigin}/`,
                                Origin: dashboardOrigin
                            }
                        },
                        requestTimeout
                    )
                    status = response.status
                    headers = response.headers
                    data = response.data
                    finalUrl = axiosFinalUrl(response)
                    redirected = axiosRedirected(response, apiUrl)
                }
                if (typeof data === 'string') {
                    try {
                        data = JSON.parse(data)
                    } catch {
                        // Structural parsing below reports a safe reason for non-JSON text.
                    }
                }

                const contentType = responseContentType(headers)
                const topLevelFields = responseTopLevelFields(data)
                const parsed = dashboardFromApiPayload(data, { geoLocale })
                const successfulStatus = status >= 200 && status < 300
                const availablePoints = successfulStatus ? availablePointsFromApiPayload(data) : null
                if (availablePoints && availablePoints.points !== null) {
                    this.rememberTrustedPoints(availablePoints.points, 'api-points')
                }
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

                if (successfulStatus && parsed.data) return this.acceptDashboard(parsed.data, 'api')
                if (successfulStatus && allowLightweightPoints && availablePoints && availablePoints.points !== null) {
                    this.lastDashboardSource = 'api-points'
                    return this.confirmedPointsSnapshot(availablePoints.points, 'api-points')
                }
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
                apiFailure = this.safeDashboardDiagnostic(error)
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

            if (!this.shouldRetryDashboardApi(apiFailure) || attempt >= DASHBOARD_API_ATTEMPTS) break
            const retryDelay =
                DASHBOARD_RETRY_BASE_DELAY_MS * attempt + Math.floor(Math.random() * (DASHBOARD_RETRY_JITTER_MS + 1))
            this.bot.logger.warn(
                this.bot.isMobile,
                'GET-DASHBOARD-DATA',
                `API dashboard 暂时不可用，准备重试 | attempt=${attempt}/${DASHBOARD_API_ATTEMPTS} | status=${apiFailure.status ?? 'n/a'} | kind=${apiFailure.category} | delayMs=${retryDelay}`
            )
            await this.waitWithinDashboardBudget(retryDelay, deadline)
        }

        this.bot.logger.warn(
            this.bot.isMobile,
            'GET-DASHBOARD-DATA',
            `API dashboard 不可用，尝试页面回退 | attempts=${apiAttempts} | elapsedMs=${Date.now() - startedAt} | kind=${apiFailure.category} | status=${apiFailure.status ?? 'n/a'} | reason=${apiReason}`
        )

        const fallbackReasons: string[] = []
        if (page && !page.isClosed()) {
            this.prepareDashboardCapture(page, geoLocale)

            const captured = await this.getCapturedDashboard(page)
            if (captured) {
                this.logCapturedDashboard(captured, page)
                return this.acceptDashboard(captured.data, 'capture')
            }
            const capturedPoints = this.getCapturedPoints(page)
            if (allowLightweightPoints && capturedPoints) {
                this.rememberTrustedPoints(capturedPoints.points, 'capture-points')
                this.lastDashboardSource = 'capture-points'
                return this.confirmedPointsSnapshot(capturedPoints.points, 'capture-points', capturedPoints.observedAt)
            }

            const parsePage = async (label: string, source: string): Promise<DashboardData | null> => {
                if (this.dashboardRemainingMs(deadline) <= 0) {
                    fallbackReasons.push(`${label}：dashboard 获取总时限已到`)
                    return null
                }
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
                    if (flight.data) return this.acceptDashboard(flight.data, `${source}-flight`)
                    const htmlResult = dashboardFromHtml(html, { geoLocale })
                    if (htmlResult.data) return this.acceptDashboard(htmlResult.data, `${source}-html`)
                    fallbackReasons.push(`${label}：${flight.reason}；${htmlResult.reason}`)
                } catch {
                    fallbackReasons.push(`${label}内容读取失败`)
                }
                return null
            }

            const currentPageData = await parsePage('当前页面', 'current-page')
            if (currentPageData) return currentPageData

            const mayNavigateFallback = apiFailure.category !== 'auth' && apiFailure.category !== 'rate-limit'
            if (mayNavigateFallback && this.dashboardRemainingMs(deadline) > 0) {
                const dashboardUrl = `${dashboardOrigin}/dashboard`
                const navigationTimeout = Math.min(15000, this.dashboardRequestTimeout(deadline, 15000))
                let currentPath = ''
                try {
                    currentPath = new URL(page.url()).pathname
                } catch {
                    // Use goto below when the current URL cannot be parsed.
                }
                try {
                    if (currentPath.startsWith('/dashboard')) {
                        await page.reload({ waitUntil: 'domcontentloaded', timeout: navigationTimeout })
                    } else {
                        await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded', timeout: navigationTimeout })
                    }
                } catch {
                    fallbackReasons.push('Dashboard 页面导航失败')
                }
                const networkIdleTimeout = Math.min(10000, this.dashboardRemainingMs(deadline))
                if (networkIdleTimeout > 0) {
                    try {
                        await page.waitForLoadState('networkidle', { timeout: networkIdleTimeout })
                    } catch {
                        // A bounded networkidle miss does not prevent parsing captured/page data.
                    }
                }
                const reloadedCapture = await this.getCapturedDashboard(page)
                if (reloadedCapture) {
                    this.logCapturedDashboard(reloadedCapture, page)
                    return this.acceptDashboard(reloadedCapture.data, 'reload-capture')
                }
                const reloadedPoints = this.getCapturedPoints(page)
                if (allowLightweightPoints && reloadedPoints) {
                    this.rememberTrustedPoints(reloadedPoints.points, 'reload-capture-points')
                    this.lastDashboardSource = 'reload-capture-points'
                    return this.confirmedPointsSnapshot(
                        reloadedPoints.points,
                        'reload-capture-points',
                        reloadedPoints.observedAt
                    )
                }
                const reloadedPageData = await parsePage('Dashboard 页面重载', 'reload-page')
                if (reloadedPageData) return reloadedPageData
            }
        }

        if (this.dashboardRemainingMs(deadline) > 0) {
            try {
                const dashboardUrl = `${dashboardOrigin}/dashboard`
                const requestTimeout = this.dashboardRequestTimeout(deadline)
                const browserResponse = await this.requestWithBrowserContext(
                    page,
                    dashboardUrl,
                    {
                        Referer: `${dashboardOrigin}/`
                    },
                    requestTimeout
                )
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
                    const response = await this.requestDashboardAxios(
                        {
                            url: dashboardUrl,
                            method: 'GET',
                            headers: {
                                ...this.fingerprintHeadersWithoutCookie(),
                                Cookie: this.buildCookieHeaderForUrl(this.bot.cookies.mobile, dashboardUrl),
                                Referer: `${dashboardOrigin}/`
                            },
                            responseType: 'text',
                            transformResponse: data => data
                        },
                        requestTimeout
                    )
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
                if (parsed.data) return this.acceptDashboard(parsed.data, 'html-request')
                fallbackReasons.push(`HTML 请求：${parsed.reason}`)
            } catch (error) {
                const diagnostic = this.safeDashboardDiagnostic(error)
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
        } else {
            fallbackReasons.push('HTML 请求：dashboard 获取总时限已到')
        }

        if (
            ['endpoint-unavailable', 'invalid-response', 'server', 'network'].includes(apiFailure.category) &&
            this.dashboardRemainingMs(deadline) > 0
        ) {
            const flyoutReasons: string[] = []
            for (const targetUrl of this.panelFlyoutFallbackUrls(geoLocale)) {
                const target = new URL(targetUrl)
                if (this.dashboardRemainingMs(deadline) <= 0) break
                try {
                    const functionalHeaders = {
                        Accept: 'application/json',
                        Referer: `${target.origin}/`,
                        Origin: target.origin
                    }
                    const requestTimeout = this.dashboardRequestTimeout(deadline)
                    const browserResponse = await this.requestWithBrowserContext(
                        page,
                        targetUrl,
                        functionalHeaders,
                        requestTimeout
                    )
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
                        const response = await this.requestDashboardAxios(
                            {
                                url: targetUrl,
                                method: 'GET',
                                headers: {
                                    ...this.fingerprintHeadersWithoutCookie(),
                                    ...functionalHeaders,
                                    Cookie: this.buildCookieHeaderForUrl(this.bot.cookies.mobile, targetUrl)
                                },
                                maxRedirects: 0,
                                validateStatus: () => true
                            },
                            requestTimeout
                        )
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
                        return this.acceptDashboard(parsed.data, 'flyout')
                    }
                    flyoutReasons.push(`${target.hostname}：${parserReason}`)
                } catch (error) {
                    const diagnostic = this.safeDashboardDiagnostic(error)
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
            fallbackReason,
            attempts: apiAttempts,
            elapsedMs: Date.now() - startedAt
        })
    }

    public resetCurrentPointsCache(): void {
        this.trustedPointsCache = null
        this.lastDashboardSource = null
    }

    private isCurrentPointsSnapshot(value: DashboardData | CurrentPointsSnapshot): value is CurrentPointsSnapshot {
        return 'confidence' in value && 'points' in value
    }

    public markSessionVerified(context: BrowserContext): void {
        this.verifiedSessionContexts.add(context)
    }

    private confirmedPointsSnapshot(points: number, source: string, observedAt?: string): CurrentPointsSnapshot {
        return {
            points,
            source,
            confidence: 'confirmed',
            observedAt: observedAt ?? this.trustedPointsCache?.observedAt ?? new Date().toISOString(),
            error: null
        }
    }

    private currentPointsScope(): string {
        return this.bot.userData?.accountEmail?.trim().toLowerCase() || '__unscoped__'
    }

    private acceptDashboard(data: DashboardData, source: string): DashboardData {
        this.lastDashboardSource = source
        const parsed = availablePointsFromApiPayload({ dashboard: data })
        if (parsed.points !== null) {
            this.rememberTrustedPoints(parsed.points, source)
        }
        return data
    }

    private rememberTrustedPoints(points: number, source: string): void {
        this.pointsCacheSequence += 1
        this.trustedPointsCache = {
            scope: this.currentPointsScope(),
            points,
            source,
            observedAt: new Date().toISOString(),
            sequence: this.pointsCacheSequence
        }
    }

    private dashboardRemainingMs(deadline: number): number {
        return Math.max(0, deadline - Date.now())
    }

    private dashboardRequestTimeout(deadline: number, requested = DASHBOARD_REQUEST_TIMEOUT_MS): number {
        const remaining = this.dashboardRemainingMs(deadline)
        if (remaining <= 0) throw new Error('dashboard deadline exceeded')
        return Math.max(1, Math.min(requested, remaining))
    }

    private async waitWithinDashboardBudget(delayMs: number, deadline: number): Promise<void> {
        const remaining = this.dashboardRemainingMs(deadline)
        if (remaining <= 0) return
        await this.bot.utils.wait(Math.min(delayMs, remaining))
    }

    private networkDashboardFailure(): SafeHttpDiagnostic {
        return {
            status: null,
            code: null,
            contentType: null,
            topLevelFields: [],
            category: 'network',
            finalUrl: null,
            redirected: null
        }
    }

    private safeDashboardDiagnostic(error: unknown): SafeHttpDiagnostic {
        const diagnostic = safeAxiosDiagnostic(error)
        if (diagnostic.code || !(error instanceof Error)) return diagnostic
        const code =
            error.name.toLowerCase().includes('timeout') || /timed?\s*out|deadline/i.test(error.message)
                ? 'ETIMEDOUT'
                : error.name.slice(0, 80)
        return { ...diagnostic, code }
    }

    private shouldRetryDashboardApi(diagnostic: SafeHttpDiagnostic): boolean {
        return diagnostic.status === null || [502, 503, 504].includes(diagnostic.status)
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
        headers: Record<string, string>,
        timeoutMs = DASHBOARD_REQUEST_TIMEOUT_MS
    ): Promise<BrowserContextHttpResponse | null> {
        const request = this.dashboardRequestContext(page)
        if (!request) return null

        const startedAt = Date.now()
        let response: APIResponse
        try {
            response = await request.get(targetUrl, {
                headers,
                failOnStatusCode: false,
                timeout: timeoutMs
            })
        } catch (error) {
            this.bot.logger.warn(
                this.bot.isMobile,
                'DASHBOARD-HTTP',
                `BrowserContext 请求失败 | elapsedMs=${Date.now() - startedAt} | timeoutMs=${timeoutMs} | reason=${this.safeDashboardDiagnostic(error).code ?? 'network'}`
            )
            throw error
        }
        try {
            const finalUrl = safeHttpUrl(response.url())
            const status = response.status()
            this.bot.logger.debug(
                this.bot.isMobile,
                'DASHBOARD-HTTP',
                `BrowserContext 请求完成 | elapsedMs=${Date.now() - startedAt} | timeoutMs=${timeoutMs} | status=${status}`
            )
            return {
                status,
                headers: response.headers(),
                body: await response.text(),
                finalUrl,
                redirected: finalUrl === null ? null : finalUrl !== safeHttpUrl(targetUrl)
            }
        } finally {
            await response.dispose()
        }
    }

    private async requestDashboardAxios(config: AxiosRequestConfig, timeoutMs = DASHBOARD_REQUEST_TIMEOUT_MS) {
        const startedAt = Date.now()
        try {
            const client = this.bot.axios as typeof this.bot.axios & {
                requestOnce?: (request: AxiosRequestConfig, timeout?: number) => Promise<AxiosResponse>
            }
            const response = client.requestOnce
                ? await client.requestOnce(config, timeoutMs)
                : await client.request({ ...config, timeout: timeoutMs, 'axios-retry': { retries: 0 } })
            this.bot.logger.debug(
                this.bot.isMobile,
                'DASHBOARD-HTTP',
                `Axios 请求完成 | elapsedMs=${Date.now() - startedAt} | timeoutMs=${timeoutMs} | status=${response.status}`
            )
            return response
        } catch (error) {
            const diagnostic = safeAxiosDiagnostic(error)
            this.bot.logger.warn(
                this.bot.isMobile,
                'DASHBOARD-HTTP',
                `Axios 请求失败 | elapsedMs=${Date.now() - startedAt} | timeoutMs=${timeoutMs} | status=${diagnostic.status ?? 'n/a'} | reason=${diagnostic.category}`
            )
            throw error
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
            const availablePoints = availablePointsFromApiPayload(payload)
            if (availablePoints.points !== null) {
                state.pointsCandidate = {
                    points: availablePoints.points,
                    path: url.pathname.slice(0, 300),
                    observedAt: new Date().toISOString()
                }
            }
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

    private getCapturedPoints(page: Page): DashboardCaptureState['pointsCandidate'] {
        return this.dashboardCaptures.get(page)?.pointsCandidate ?? null
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

            const response = await this.requestDashboardAxios(request)
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
        const result = await this.getSearchPointsFallback(isMobile)
        return result?.mobileDetected ? result : null
    }

    async getSearchPointsFallback(isMobile: boolean): Promise<MissingSearchPoints | null> {
        const htmlResult = await this.getDashboardHtmlSearchPoints(isMobile).catch(error => {
            this.bot.logger.debug(
                this.bot.isMobile,
                'SEARCH-COUNTER-FALLBACK',
                `dashboard-html unavailable: ${error instanceof Error ? error.message : String(error)}`
            )
            return null
        })
        if (htmlResult && (htmlResult.mobileDetected || htmlResult.desktopCounter.detected)) {
            return htmlResult
        }

        const panelResult = this.getPanelFlyoutSearchPoints(isMobile)
        if (panelResult && (panelResult.mobileDetected || panelResult.desktopCounter.detected)) {
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
            const response = await this.requestDashboardAxios(request)
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
        const counterContainer =
            this.findCounterContainer(panelData, 'mobileSearch') ?? this.findCounterContainer(panelData, 'pcSearch')
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
        const snapshot = await this.getCurrentPointsSnapshot()
        if (snapshot.confidence === 'confirmed' && snapshot.points !== null) return snapshot.points

        const details = snapshot.error
        this.bot.logger.error(
            this.bot.isMobile,
            'GET-CURRENT-POINTS',
            `积分读取未确认 | confidence=${snapshot.confidence} | source=${snapshot.source ?? 'none'} | status=${details?.apiStatus ?? 'n/a'} | attempts=${details?.attempts ?? 0} | elapsedMs=${details?.elapsedMs ?? 0}`
        )
        throw new DashboardFetchError({
            apiStatus: details?.apiStatus,
            apiReason: details?.apiReason ?? '积分读取未确认',
            fallbackReason: details?.fallbackReason ?? '没有本次请求确认的积分数据',
            apiFailureKind: details?.apiFailureKind ?? 'invalid-response',
            attempts: details?.attempts,
            elapsedMs: details?.elapsedMs
        })
    }

    async getCurrentPointsSnapshot(): Promise<CurrentPointsSnapshot> {
        const startingSequence = this.pointsCacheSequence
        try {
            const result = await this.getDashboardResult(undefined, true)
            if (this.isCurrentPointsSnapshot(result)) return result
            const data = result
            const points = data.userStatus.availablePoints
            return {
                points,
                source: this.lastDashboardSource ?? 'dashboard',
                confidence: 'confirmed',
                observedAt: this.trustedPointsCache?.observedAt ?? new Date().toISOString(),
                error: null
            }
        } catch (error) {
            const details = dashboardFailureDetails(error)
            const cache = this.trustedPointsCache?.scope === this.currentPointsScope() ? this.trustedPointsCache : null
            if (cache && cache.sequence > startingSequence) {
                return {
                    points: cache.points,
                    source: cache.source,
                    confidence: 'confirmed',
                    observedAt: cache.observedAt,
                    error: details
                }
            }
            if (cache) {
                return {
                    points: cache.points,
                    source: cache.source,
                    confidence: 'cached',
                    observedAt: cache.observedAt,
                    error: details
                }
            }
            return {
                points: null,
                source: null,
                confidence: 'unknown',
                observedAt: null,
                error: details
            }
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

    private async clickVisibleClaimButton(page: Page, mode: ClaimButtonSearchMode): Promise<ClaimButtonClickResult> {
        return page.evaluate(searchMode => {
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
            const dialogSelector =
                '[role="dialog"],[aria-modal="true"],[class*="modal" i],[class*="dialog" i],[class*="drawer" i]'
            const dialogRoots = Array.from(document.querySelectorAll(dialogSelector)).filter(isVisible)
            const confirmCandidates = dialogRoots
                .flatMap(root => Array.from(root.querySelectorAll(selector)))
                .filter(el => !isDisabled(el) && isVisible(el))
                .map(el => {
                    const element = el as HTMLElement
                    const text = normalizeText(
                        element.innerText ||
                            element.textContent ||
                            el.getAttribute('aria-label') ||
                            el.getAttribute('title')
                    )
                    let score = 0
                    if (text === '领取积分') score += 100
                    if (/领取积分|claim points/i.test(text)) score += 80
                    if (/领取|claim/i.test(text)) score += 40
                    if (element.tagName.toLowerCase() === 'button') score += 10
                    return { el, score }
                })
                .filter(candidate => candidate.score >= 50)
                .sort((a, b) => b.score - a.score)

            const confirmTarget = confirmCandidates[0]
            if (confirmTarget) {
                confirmTarget.el.scrollIntoView({ block: 'center', inline: 'center' })
                ;(confirmTarget.el as HTMLElement).click()
                return { clicked: true, phase: 'confirm' as const, score: confirmTarget.score }
            }

            if (searchMode === 'confirm') return { clicked: false, reason: 'no-confirm-button' }

            const entryCandidates = Array.from(document.querySelectorAll(selector))
                .filter(el => !el.closest(dialogSelector) && !isDisabled(el) && isVisible(el))
                .map(el => {
                    const element = el as HTMLElement
                    const text = normalizeText(
                        element.innerText ||
                            element.textContent ||
                            el.getAttribute('aria-label') ||
                            el.getAttribute('title')
                    )
                    const context = normalizeText(
                        [
                            text,
                            el.closest('[data-testid], section, article, div')?.textContent,
                            el.closest('[data-testid], section, article, div')?.getAttribute('data-testid')
                        ].join(' ')
                    )
                    let score = 0
                    if (/可领取/.test(text)) score += 60
                    if (/领取|claim/i.test(text)) score += 40
                    if (/积分|points?|奖励|bonus/i.test(context)) score += 20
                    if (element.tagName.toLowerCase() === 'button') score += 10
                    return { el, score }
                })
                .filter(candidate => candidate.score >= 80)
                .sort((a, b) => b.score - a.score)

            const entryTarget = entryCandidates[0]
            if (!entryTarget) return { clicked: false, reason: 'no-entry-button' }

            entryTarget.el.scrollIntoView({ block: 'center', inline: 'center' })
            ;(entryTarget.el as HTMLElement).click()
            return { clicked: true, phase: 'entry' as const, score: entryTarget.score }
        }, mode)
    }

    private async waitAndClickClaimButton(
        page: Page,
        mode: ClaimButtonSearchMode,
        timeoutMs: number
    ): Promise<ClaimButtonClickResult> {
        const deadline = Date.now() + Math.max(0, timeoutMs)
        let result = await this.clickVisibleClaimButton(page, mode)
        while (!result.clicked && Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, CLAIM_POLL_INTERVAL_MS))
            result = await this.clickVisibleClaimButton(page, mode)
        }
        return result
    }

    async clickClaimBonusPointsButton(page: Page): Promise<boolean> {
        try {
            const openDialogResult = await this.clickVisibleClaimButton(page, 'confirm').catch(
                (): ClaimButtonClickResult => ({
                    clicked: false,
                    reason: 'confirm-precheck-failed'
                })
            )
            if (openDialogResult.clicked) {
                this.bot.logger.info(
                    this.bot.isMobile,
                    'CLAIM-BONUS-POINTS',
                    `已直接点击打开抽屉中的领取确认按钮 | score=${openDialogResult.score ?? 0}`
                )
                await this.bot.utils.wait(this.bot.utils.randomDelay(5000, 8000))
                return true
            }

            await page
                .goto('https://rewards.bing.com/dashboard', { waitUntil: 'domcontentloaded', timeout: 15000 })
                .catch(() => {})
            await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {})

            const entryResult = await this.waitAndClickClaimButton(page, 'entry-or-confirm', CLAIM_ENTRY_TIMEOUT_MS)
            if (!entryResult.clicked) {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'CLAIM-BONUS-POINTS',
                    `页面点击兜底未找到奖励领取入口 | reason=${entryResult.reason ?? 'unknown'} | timeoutMs=${CLAIM_ENTRY_TIMEOUT_MS}`
                )
                return false
            }

            if (entryResult.phase === 'confirm') {
                this.bot.logger.info(
                    this.bot.isMobile,
                    'CLAIM-BONUS-POINTS',
                    `页面加载后直接点击领取确认按钮 | score=${entryResult.score ?? 0}`
                )
                await this.bot.utils.wait(this.bot.utils.randomDelay(5000, 8000))
                return true
            }

            this.bot.logger.info(
                this.bot.isMobile,
                'CLAIM-BONUS-POINTS',
                `已点击 dashboard 奖励领取入口 | score=${entryResult.score ?? 0}`
            )
            await this.bot.utils.wait(this.bot.utils.randomDelay(1500, 3000))

            const confirmResult = await this.waitAndClickClaimButton(page, 'confirm', CLAIM_CONFIRM_TIMEOUT_MS)
            if (!confirmResult.clicked) {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'CLAIM-BONUS-POINTS',
                    `页面点击兜底未找到抽屉确认按钮 | reason=${confirmResult.reason ?? 'unknown'} | timeoutMs=${CLAIM_CONFIRM_TIMEOUT_MS}`
                )
                return false
            }

            this.bot.logger.info(
                this.bot.isMobile,
                'CLAIM-BONUS-POINTS',
                `已点击 dashboard 奖励领取确认按钮 | score=${confirmResult.score ?? 0}`
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
            if (this.verifiedSessionContexts.has(browser)) {
                const cookies = await browser.cookies()
                this.bot.logger.debug(this.bot.isMobile, 'CLOSE-BROWSER', `Saving ${cookies.length} cookies.`)
                await saveSessionData(this.bot.config.sessionPath, cookies, email, this.bot.isMobile)
            } else {
                this.bot.logger.warn(this.bot.isMobile, 'CLOSE-BROWSER', '会话未通过登录验证，跳过 Cookie 保存')
            }

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
