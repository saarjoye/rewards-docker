import type { Page } from 'patchright'
import { randomBytes } from 'crypto'
import type { Counters, DashboardData } from '../../../interface/DashboardData'
import type { MissingSearchPoints } from '../../../interface/Points'

import { QueryCore } from '../../QueryEngine'
import { Workers } from '../../Workers'
import { updateSearchTaskProgress, type ProgressTaskKey } from '../../../util/TaskProgressStore'
import {
    abortableWait,
    calculateSearchRoundTimeoutMs,
    calculateSearchTimeoutBudget,
    runSearchStage,
    SEARCH_PRE_SUBMIT_ATTEMPTS,
    SearchOperationError,
    type SearchOperationStage,
    type SearchTimeoutBudget
} from '../../../util/SearchExecution'

/**
 * 必应搜索类，负责执行必应搜索以获取积分
 * 该类继承自Workers，提供了搜索相关的核心功能
 */
export class Search extends Workers {
    /** 必应主页URL */
    private bingHome = 'https://bing.com'
    /** 当前搜索页面URL */
    private searchPageURL = ''
    /** 搜索计数器 */
    private searchCount = 0
    /** 首次滚动标志 */
    private firstScroll: boolean = true

    private counterUnavailable(points: MissingSearchPoints, isMobile: boolean): boolean {
        const status = isMobile ? points.mobileStatus : points.desktopCounter.status
        return ['missing-counter', 'empty-counter', 'invalid-counter'].includes(status)
    }

    private counterStatus(points: MissingSearchPoints, isMobile: boolean): string {
        return isMobile ? points.mobileStatus : points.desktopCounter.status
    }

    public async doSearch(
        data: DashboardData,
        page: Page,
        isMobile: boolean,
        initialMissingPoints?: MissingSearchPoints
    ): Promise<number> {
        const startBalance = Number(this.bot.userData.currentPoints ?? 0)
        const accountEmail = this.bot.userData.accountEmail
        const taskKey: ProgressTaskKey = isMobile ? 'mobile' : 'desktop'

        this.bot.logger.info(isMobile, 'SEARCH-BING', `开始必应搜索 | currentPoints=${startBalance}`)

        let totalGainedPoints = 0
        const roundStartedAt = Date.now()

        try {
            let searchCounters: Counters = await this.bot.browser.func.getSearchPoints()
            const missingPoints =
                initialMissingPoints ?? this.bot.browser.func.missingSearchPoints(searchCounters, isMobile)
            let missingPointsTotal = missingPoints.totalPoints
            const initialMissingPointsTotal = missingPointsTotal
            let latestMissingPointsTotal = missingPointsTotal

            if (this.counterUnavailable(missingPoints, isMobile)) {
                const device = isMobile ? '移动' : 'PC'
                throw new Error(
                    `${device}搜索额度未确认 | reason=${this.counterStatus(missingPoints, isMobile)} | source=${missingPoints.source}`
                )
            }

            this.bot.logger.debug(
                isMobile,
                'SEARCH-BING',
                `初始搜索计数器 | mobile=${missingPoints.mobilePoints} | desktop=${missingPoints.desktopPoints} | edge=${missingPoints.edgePoints}`
            )

            this.bot.logger.info(
                isMobile,
                'SEARCH-BING',
                `剩余搜索积分 | Edge=${missingPoints.edgePoints} | Desktop=${missingPoints.desktopPoints} | Mobile=${missingPoints.mobilePoints}`
            )

            const queryCore = new QueryCore(this.bot)
            const locale = (this.bot.userData.geoLocale ?? 'US').toUpperCase()
            const langCode = (this.bot.userData.langCode ?? 'en').toLowerCase()

            this.bot.logger.debug(
                isMobile,
                'SEARCH-BING',
                `通过QueryCore解析搜索查询 | locale=${locale} | lang=${langCode} | related=true`
            )

            // 根据地区选择查询方式，如果是CN地区则使用中国热搜
            let queries = await queryCore.queryManager({
                shuffle: true,
                related: true,
                langCode,
                geoLocale: locale,
                // sourceOrder: ['google', 'wikipedia', 'reddit', 'local']
                sourceOrder: ['china', 'local']
            })

            queries = [...new Set(queries.map(q => q.trim()).filter(Boolean))]

            const timeoutBudget = calculateSearchTimeoutBudget({
                searchDelayMax: this.bot.config.searchSettings.searchDelay.max,
                searchResultVisitTime: this.bot.config.searchSettings.searchResultVisitTime,
                scrollRandomResults: this.bot.config.searchSettings.scrollRandomResults,
                clickRandomResults: this.bot.config.searchSettings.clickRandomResults
            })
            const roundTimeoutMs = calculateSearchRoundTimeoutMs(
                timeoutBudget.queryTimeoutMs,
                initialMissingPointsTotal,
                queries.length
            )
            const roundDeadline = roundStartedAt + roundTimeoutMs

            this.bot.logger.info(isMobile, 'SEARCH-BING', `搜索查询池准备就绪 | count=${queries.length}`)
            this.bot.logger.debug(
                isMobile,
                'SEARCH-BING',
                `搜索超时预算 | queryTimeoutMs=${timeoutBudget.queryTimeoutMs} | roundTimeoutMs=${roundTimeoutMs} | searchDelayMaxMs=${timeoutBudget.stageTimeouts['search-delay']} | dashboardRefreshMs=${timeoutBudget.stageTimeouts['dashboard-refresh']}`
            )

            // 跳转到bing
            const targetUrl = this.searchPageURL ? this.searchPageURL : this.bingHome
            const target = new URL(targetUrl)
            this.bot.logger.debug(
                isMobile,
                'SEARCH-BING',
                `导航到搜索页面 | host=${target.hostname} | path=${target.pathname}`
            )

            await page.goto(targetUrl, {
                waitUntil: 'domcontentloaded',
                timeout: timeoutBudget.navigationMs
            })
            await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {})
            await this.bot.browser.utils.tryDismissAllMessages(page)

            let stagnantLoop = 0
            const stagnantLoopMax = 10

            for (let i = 0; i < queries.length; i++) {
                if (Date.now() >= roundDeadline) {
                    throw new Error(`搜索整轮超时: ${roundTimeoutMs}ms`)
                }
                const query = queries[i] as string

                searchCounters = await this.bingSearch(page, query, isMobile, timeoutBudget)
                const newMissingPoints = this.bot.browser.func.missingSearchPoints(searchCounters, isMobile)
                if (this.counterUnavailable(newMissingPoints, isMobile)) {
                    const device = isMobile ? '移动' : 'PC'
                    throw new Error(
                        `搜索后${device}搜索额度未确认 | reason=${this.counterStatus(newMissingPoints, isMobile)} | source=${newMissingPoints.source}`
                    )
                }
                const newMissingPointsTotal = newMissingPoints.totalPoints

                const rawGained = missingPointsTotal - newMissingPointsTotal
                const gainedPoints = Math.max(0, rawGained)

                if (gainedPoints === 0) {
                    stagnantLoop++
                    this.bot.logger.info(
                        isMobile,
                        'SEARCH-BING',
                        `未获得积分 ${stagnantLoop}/${stagnantLoopMax} | queryLength=${query.length} | remaining=${newMissingPointsTotal}`
                    )
                } else {
                    stagnantLoop = 0

                    const newBalance = Number(this.bot.userData.currentPoints ?? 0) + gainedPoints
                    this.bot.recordPointGain(isMobile ? '移动搜索' : 'PC搜索', gainedPoints, newBalance, taskKey)

                    totalGainedPoints += gainedPoints
                    if (accountEmail) {
                        updateSearchTaskProgress(
                            accountEmail,
                            taskKey,
                            totalGainedPoints,
                            newMissingPointsTotal,
                            initialMissingPointsTotal
                        )
                    }

                    this.bot.logger.info(
                        isMobile,
                        'SEARCH-BING',
                        `获得积分=${gainedPoints} points | queryLength=${query.length} | remaining=${newMissingPointsTotal}`,
                        'green'
                    )
                }

                missingPointsTotal = newMissingPointsTotal
                latestMissingPointsTotal = newMissingPointsTotal

                if (missingPointsTotal === 0) {
                    this.bot.logger.info(isMobile, 'SEARCH-BING', '已获得所有必需的搜索积分，停止主搜索循环')
                    break
                }

                if (stagnantLoop > stagnantLoopMax) {
                    this.bot.logger.warn(
                        isMobile,
                        'SEARCH-BING',
                        `搜索在 ${stagnantLoopMax} 次迭代中未获得积分，中止主搜索循环`
                    )
                    stagnantLoop = 0
                    break
                }

                const remainingQueries = queries.length - (i + 1)
                const minBuffer = 20
                if (missingPointsTotal > 0 && remainingQueries < minBuffer) {
                    this.bot.logger.warn(
                        isMobile,
                        'SEARCH-BING',
                        `在仍有积分缺失的情况下查询缓冲区过低，重新生成 | remainingQueries=${remainingQueries} | missing=${missingPointsTotal}`
                    )

                    const extra = await queryCore.queryManager({
                        shuffle: true,
                        related: true,
                        langCode,
                        geoLocale: locale,
                        sourceOrder: this.bot.config.searchSettings.queryEngines
                    })

                    const merged = [...queries, ...extra].map(q => q.trim()).filter(Boolean)
                    queries = [...new Set(merged)]
                    queries = this.bot.utils.shuffleArray(queries)

                    this.bot.logger.debug(isMobile, 'SEARCH-BING', `查询池已重新生成 | count=${queries.length}`)
                }
            }

            if (missingPointsTotal > 0) {
                this.bot.logger.info(
                    isMobile,
                    'SEARCH-BING',
                    `搜索完成但仍有积分缺失，继续使用重新生成的查询 | remaining=${missingPointsTotal}`
                )

                let stagnantLoop = 0
                const stagnantLoopMax = 5

                while (missingPointsTotal > 0) {
                    const extra = await queryCore.queryManager({
                        shuffle: true,
                        related: true,
                        langCode,
                        geoLocale: locale,
                        sourceOrder: this.bot.config.searchSettings.queryEngines
                    })

                    const merged = [...queries, ...extra].map(q => q.trim()).filter(Boolean)
                    const newPool = [...new Set(merged)]
                    queries = this.bot.utils.shuffleArray(newPool)

                    this.bot.logger.info(isMobile, 'SEARCH-BING-EXTRA', `新搜索查询池已生成 | count=${queries.length}`)

                    for (const query of queries) {
                        if (Date.now() >= roundDeadline) {
                            throw new Error(`搜索整轮超时: ${roundTimeoutMs}ms`)
                        }
                        this.bot.logger.info(
                            isMobile,
                            'SEARCH-BING-EXTRA',
                            `额外搜索 | remaining=${missingPointsTotal} | queryLength=${query.length}`
                        )

                        searchCounters = await this.bingSearch(page, query, isMobile, timeoutBudget)
                        const newMissingPoints = this.bot.browser.func.missingSearchPoints(searchCounters, isMobile)
                        if (this.counterUnavailable(newMissingPoints, isMobile)) {
                            const device = isMobile ? '移动' : 'PC'
                            throw new Error(
                                `额外搜索后${device}搜索额度未确认 | reason=${this.counterStatus(newMissingPoints, isMobile)} | source=${newMissingPoints.source}`
                            )
                        }
                        const newMissingPointsTotal = newMissingPoints.totalPoints

                        const rawGained = missingPointsTotal - newMissingPointsTotal
                        const gainedPoints = Math.max(0, rawGained)

                        if (gainedPoints === 0) {
                            stagnantLoop++
                            this.bot.logger.info(
                                isMobile,
                                'SEARCH-BING-EXTRA',
                                `未获得积分 ${stagnantLoop}/${stagnantLoopMax} | queryLength=${query.length} | remaining=${newMissingPointsTotal}`
                            )
                        } else {
                            stagnantLoop = 0

                            const newBalance = Number(this.bot.userData.currentPoints ?? 0) + gainedPoints
                            this.bot.recordPointGain(
                                isMobile ? '移动搜索' : 'PC搜索',
                                gainedPoints,
                                newBalance,
                                taskKey
                            )

                            totalGainedPoints += gainedPoints
                            if (accountEmail) {
                                updateSearchTaskProgress(
                                    accountEmail,
                                    taskKey,
                                    totalGainedPoints,
                                    newMissingPointsTotal,
                                    initialMissingPointsTotal
                                )
                            }

                            this.bot.logger.info(
                                isMobile,
                                'SEARCH-BING-EXTRA',
                                `获得积分=${gainedPoints} points | queryLength=${query.length} | remaining=${newMissingPointsTotal}`,
                                'green'
                            )
                        }

                        missingPointsTotal = newMissingPointsTotal
                        latestMissingPointsTotal = newMissingPointsTotal

                        if (missingPointsTotal === 0) {
                            this.bot.logger.info(
                                isMobile,
                                'SEARCH-BING-EXTRA',
                                '在额外搜索期间已获得所有必需的搜索积分'
                            )
                            break
                        }

                        if (stagnantLoop > stagnantLoopMax) {
                            this.bot.logger.warn(
                                isMobile,
                                'SEARCH-BING-EXTRA',
                                `搜索在 ${stagnantLoopMax} 次迭代中未获得积分，中止额外搜索`
                            )
                            const finalBalance = Number(this.bot.userData.currentPoints ?? startBalance)
                            this.bot.logger.info(
                                isMobile,
                                'SEARCH-BING',
                                `中止额外搜索 | startBalance=${startBalance} | finalBalance=${finalBalance}`
                            )
                            throw new Error(
                                `搜索停滞，保留部分进度: gained=${totalGainedPoints}, remaining=${missingPointsTotal}`
                            )
                        }
                    }
                }
            }

            const finalBalance = Number(this.bot.userData.currentPoints ?? startBalance)
            if (accountEmail) {
                updateSearchTaskProgress(
                    accountEmail,
                    taskKey,
                    totalGainedPoints,
                    latestMissingPointsTotal,
                    initialMissingPointsTotal
                )
            }

            this.bot.logger.info(
                isMobile,
                'SEARCH-BING',
                `完成必应搜索 | startBalance=${startBalance} | newBalance=${finalBalance}`
            )

            return totalGainedPoints
        } catch (error) {
            this.bot.logger.error(
                isMobile,
                'SEARCH-BING',
                `doSearch中出现错误 | message=${error instanceof Error ? error.message : String(error)}`
            )
            throw error
        }
    }

    private async bingSearch(
        searchPage: Page,
        query: string,
        isMobile: boolean,
        timeoutBudget: SearchTimeoutBudget
    ): Promise<Counters> {
        const controller = new AbortController()
        const queryDeadline = Date.now() + timeoutBudget.queryTimeoutMs
        return this.performBingSearch(searchPage, query, isMobile, timeoutBudget, controller, queryDeadline)
    }

    private async executeStage<T>(
        searchPage: Page,
        isMobile: boolean,
        controller: AbortController,
        queryDeadline: number,
        stage: SearchOperationStage,
        stageTimeoutMs: number,
        operation: (signal: AbortSignal) => Promise<T>
    ): Promise<T> {
        const remainingMs = Math.max(1, queryDeadline - Date.now())
        const timeoutMs = Math.min(stageTimeoutMs, remainingMs)
        const startedAt = Date.now()
        this.bot.logger.debug(isMobile, 'SEARCH-QUERY', `阶段开始 | stage=${stage} | timeoutMs=${timeoutMs}`)
        try {
            const result = await runSearchStage({
                page: searchPage,
                controller,
                stage,
                timeoutMs,
                operation
            })
            this.bot.logger.debug(
                isMobile,
                'SEARCH-QUERY',
                `阶段完成 | stage=${stage} | elapsedMs=${Date.now() - startedAt}`
            )
            return result
        } catch (error) {
            const operationError =
                error instanceof SearchOperationError
                    ? error
                    : new SearchOperationError(
                          stage,
                          `搜索阶段失败 | stage=${stage}`,
                          timeoutMs,
                          Date.now() - startedAt,
                          false,
                          { cause: error }
                      )
            this.bot.logger.error(
                isMobile,
                'SEARCH-QUERY',
                `阶段失败 | stage=${operationError.operationStage} | elapsedMs=${operationError.elapsedMs} | timeoutMs=${operationError.timeoutMs} | timedOut=${operationError.timedOut} | message=${operationError.message}`
            )
            throw operationError
        }
    }

    private async performBingSearch(
        searchPage: Page,
        query: string,
        isMobile: boolean,
        timeoutBudget: SearchTimeoutBudget,
        controller: AbortController,
        queryDeadline: number
    ): Promise<Counters> {
        const maxAttempts = SEARCH_PRE_SUBMIT_ATTEMPTS
        const refreshThreshold = 10 // 页面在x次搜索后变得缓慢？

        this.searchCount++

        if (this.searchCount % refreshThreshold === 0) {
            this.bot.logger.info(
                isMobile,
                'SEARCH-BING',
                `返回主页以清除累积的页面上下文 | count=${this.searchCount} | threshold=${refreshThreshold}`
            )

            this.bot.logger.debug(isMobile, 'SEARCH-BING', `返回主页以刷新状态 | url=${this.bingHome}`)

            const cvid = randomBytes(16).toString('hex')
            const url = `${this.bingHome}/search?q=${encodeURIComponent(query)}&PC=U531&FORM=ANNTA1&cvid=${cvid}`

            await this.executeStage(
                searchPage,
                isMobile,
                controller,
                queryDeadline,
                'search-box',
                timeoutBudget.navigationMs,
                async signal => {
                    signal.throwIfAborted()
                    await searchPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 })
                    signal.throwIfAborted()
                    await searchPage.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {})
                    signal.throwIfAborted()
                    await this.bot.browser.utils.tryDismissAllMessages(searchPage)
                }
            )
        }

        // 每次搜索重置首次滚动标志，确保有初始向下滚动
        this.firstScroll = true

        this.bot.logger.debug(
            isMobile,
            'SEARCH-BING',
            `开始bingSearch | queryLength=${query.length} | maxAttempts=${maxAttempts} | searchCount=${this.searchCount} | refreshEvery=${refreshThreshold} | scrollRandomResults=${this.bot.config.searchSettings.scrollRandomResults} | clickRandomResults=${this.bot.config.searchSettings.clickRandomResults}`
        )

        let submitted = false
        for (let i = 0; i < maxAttempts && !submitted; i++) {
            try {
                const searchBar = '#sb_form_q'
                const searchBox = searchPage.locator(searchBar)

                await this.executeStage(
                    searchPage,
                    isMobile,
                    controller,
                    queryDeadline,
                    'search-box',
                    timeoutBudget.stageTimeouts['search-box'],
                    async signal => {
                        signal.throwIfAborted()
                        await searchPage.evaluate(() => {
                            window.scrollTo({ left: 0, top: 0, behavior: 'auto' })
                        })
                        await searchPage.keyboard.press('Home')
                        await searchBox.waitFor({ state: 'visible', timeout: 15000 })
                    }
                )

                await this.executeStage(
                    searchPage,
                    isMobile,
                    controller,
                    queryDeadline,
                    'submit',
                    timeoutBudget.stageTimeouts.submit,
                    async signal => {
                        await abortableWait(1000, signal)
                        await searchBox.click({ clickCount: 3, timeout: 5000 })
                        signal.throwIfAborted()
                        await searchBox.fill('')
                        await searchPage.keyboard.type(query, { delay: 50 })
                        signal.throwIfAborted()
                        await searchPage.keyboard.press('Enter')
                    }
                )
                submitted = true

                this.bot.logger.debug(
                    isMobile,
                    'SEARCH-BING',
                    `提交查询到必应 | attempt=${i + 1}/${maxAttempts} | queryLength=${query.length}`
                )
            } catch (error) {
                if (error instanceof SearchOperationError && error.timedOut) throw error
                if (i >= maxAttempts - 1 || searchPage.isClosed()) {
                    this.bot.logger.error(
                        isMobile,
                        'SEARCH-BING',
                        `提交前重试耗尽 | attempts=${maxAttempts} | queryLength=${query.length} | message=${error instanceof Error ? error.message : String(error)}`
                    )
                    throw error
                }

                this.bot.logger.error(
                    isMobile,
                    'SEARCH-BING',
                    `提交前搜索尝试失败 | attempt=${i + 1}/${maxAttempts} | queryLength=${query.length} | message=${error instanceof Error ? error.message : String(error)}`
                )

                this.bot.logger.warn(
                    isMobile,
                    'SEARCH-BING',
                    `重试搜索 | attempt=${i + 1}/${maxAttempts} | queryLength=${query.length}`
                )

                await abortableWait(timeoutBudget.retryDelayMs, controller.signal)
            }
        }

        if (!submitted) throw new Error(`搜索查询提交失败 | queryLength=${query.length}`)

        await this.executeStage(
            searchPage,
            isMobile,
            controller,
            queryDeadline,
            'post-submit-wait',
            timeoutBudget.stageTimeouts['post-submit-wait'],
            signal => abortableWait(3000, signal)
        )

        if (this.bot.config.searchSettings.scrollRandomResults) {
            await this.executeStage(
                searchPage,
                isMobile,
                controller,
                queryDeadline,
                'scroll',
                timeoutBudget.stageTimeouts.scroll,
                async signal => {
                    await abortableWait(2000, signal)
                    await this.randomScroll(searchPage, isMobile, signal)
                }
            )
        }

        if (this.bot.config.searchSettings.clickRandomResults) {
            await this.executeStage(
                searchPage,
                isMobile,
                controller,
                queryDeadline,
                'click',
                timeoutBudget.stageTimeouts.click,
                async signal => {
                    await abortableWait(2000, signal)
                    await this.clickRandomLink(
                        searchPage,
                        isMobile,
                        signal,
                        Math.max(0, timeoutBudget.stageTimeouts.click - 17_000)
                    )
                }
            )
        }

        const searchDelayMs = this.bot.utils.randomDelay(
            this.bot.config.searchSettings.searchDelay.min,
            this.bot.config.searchSettings.searchDelay.max
        )
        await this.executeStage(
            searchPage,
            isMobile,
            controller,
            queryDeadline,
            'search-delay',
            timeoutBudget.stageTimeouts['search-delay'],
            signal => abortableWait(searchDelayMs, signal)
        )

        const counters = await this.executeStage(
            searchPage,
            isMobile,
            controller,
            queryDeadline,
            'dashboard-refresh',
            timeoutBudget.stageTimeouts['dashboard-refresh'],
            () => this.bot.browser.func.getSearchPoints()
        )

        this.bot.logger.debug(
            isMobile,
            'SEARCH-BING',
            `查询后的搜索计数器 | queryLength=${query.length} | searchCount=${this.searchCount}`
        )
        return counters
    }
    private async randomScroll(page: Page, isMobile: boolean, signal: AbortSignal) {
        try {
            signal.throwIfAborted()
            const viewportHeight = await page.evaluate(() => window.innerHeight)
            const totalHeight = await page.evaluate(() => document.body.scrollHeight)
            const randomScrollPosition = Math.floor(Math.random() * (totalHeight - viewportHeight))

            this.bot.logger.debug(
                isMobile,
                'SEARCH-RANDOM-SCROLL',
                `随机滚动 | 视口高度=${viewportHeight} | 总高度=${totalHeight} | 滚动位置=${randomScrollPosition}`
            )

            await page.evaluate((scrollPos: number) => {
                window.scrollTo({ left: 0, top: scrollPos, behavior: 'auto' })
            }, randomScrollPosition)
            signal.throwIfAborted()
        } catch (error) {
            if (signal.aborted) throw signal.reason ?? error
            this.bot.logger.error(
                isMobile,
                'SEARCH-RANDOM-SCROLL',
                `随机滚动过程中出现错误 | message=${error instanceof Error ? error.message : String(error)}`
            )
        }
    }

    private async clickRandomLink(page: Page, isMobile: boolean, signal: AbortSignal, visitTimeMs: number) {
        try {
            this.bot.logger.debug(isMobile, 'SEARCH-RANDOM-CLICK', '尝试点击随机搜索结果链接')

            const searchPageUrl = page.url()

            signal.throwIfAborted()
            await this.bot.browser.utils.ghostClick(page, '#b_results .b_algo h2')
            await abortableWait(visitTimeMs, signal)

            if (isMobile) {
                await page.goto(searchPageUrl)
                this.bot.logger.debug(isMobile, 'SEARCH-RANDOM-CLICK', '已返回搜索页面')
            } else {
                const newTab = await this.bot.browser.utils.getLatestTab(page)
                const newTabUrl = newTab.url()

                this.bot.logger.debug(isMobile, 'SEARCH-RANDOM-CLICK', `已访问结果标签页 | url=${newTabUrl}`)

                await this.bot.browser.utils.closeTabs(newTab)
                this.bot.logger.debug(isMobile, 'SEARCH-RANDOM-CLICK', '已关闭结果标签页')
            }
            signal.throwIfAborted()
        } catch (error) {
            if (signal.aborted) throw signal.reason ?? error
            this.bot.logger.error(
                isMobile,
                'SEARCH-RANDOM-CLICK',
                `随机点击过程中出现错误 | message=${error instanceof Error ? error.message : String(error)}`
            )
        }
    }
}
