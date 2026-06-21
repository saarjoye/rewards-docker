import type { BrowserContext } from 'patchright'
import type { BrowserFingerprintWithHeaders } from 'fingerprint-generator'
import { MicrosoftRewardsBot, executionContext } from '../index'
import type { DashboardData } from '../interface/DashboardData'
import type { Account } from '../interface/Account'
import { updateAccountRunState, updateSearchTaskProgress, updateTaskDetail, updateTaskProgress } from '../util/TaskProgressStore'

interface BrowserSession {
    context: BrowserContext
    fingerprint: BrowserFingerprintWithHeaders
}

interface MissingSearchPoints {
    mobilePoints: number
    desktopPoints: number
}

interface SearchResults {
    mobilePoints: number
    desktopPoints: number
}

interface SearchCounterProgress {
    completed: number
    total: number
    remaining: number
}

export class SearchManager {
    constructor(private bot: MicrosoftRewardsBot) {}

    private async readCurrentPoints(): Promise<number | null> {
        try {
            return await this.bot.browser.func.getCurrentPoints()
        } catch {
            return null
        }
    }

    private searchCounterProgress(data: DashboardData, task: 'mobile' | 'desktop'): SearchCounterProgress {
        const counters = task === 'mobile' ? data.userStatus.counters.mobileSearch : data.userStatus.counters.pcSearch
        const completed = counters?.reduce((sum, item) => sum + Math.max(0, Number(item.pointProgress ?? 0)), 0) ?? 0
        const total = counters?.reduce((sum, item) => sum + Math.max(0, Number(item.pointProgressMax ?? 0)), 0) ?? 0
        return {
            completed,
            total,
            remaining: Math.max(0, total - completed)
        }
    }

    async doSearches(
        data: DashboardData,
        missingSearchPoints: MissingSearchPoints,
        mobileSession: BrowserSession,
        account: Account,
        accountEmail: string
    ): Promise<SearchResults> {
        this.bot.logger.info(
            'main',
            'SEARCH-MANAGER',
            `开始 | 账户=${accountEmail} | 移动端缺失=${missingSearchPoints.mobilePoints} | 桌面端缺失=${missingSearchPoints.desktopPoints}`
        )
        updateSearchTaskProgress(
            accountEmail,
            'mobile',
            0,
            missingSearchPoints.mobilePoints,
            missingSearchPoints.mobilePoints
        )
        updateSearchTaskProgress(
            accountEmail,
            'desktop',
            0,
            missingSearchPoints.desktopPoints,
            missingSearchPoints.desktopPoints
        )
        const mobileCounter = this.searchCounterProgress(data, 'mobile')
        const desktopCounter = this.searchCounterProgress(data, 'desktop')

        const doMobile = this.bot.config.workers.doMobileSearch && missingSearchPoints.mobilePoints > 0
        const doDesktop = this.bot.config.workers.doDesktopSearch && missingSearchPoints.desktopPoints > 0

        const mobileStatus = this.bot.config.workers.doMobileSearch
            ? missingSearchPoints.mobilePoints > 0
                ? 'run'
                : 'skip-no-points'
            : 'skip-disabled'
        const desktopStatus = this.bot.config.workers.doDesktopSearch
            ? missingSearchPoints.desktopPoints > 0
                ? 'run'
                : 'skip-no-points'
            : 'skip-disabled'

        this.bot.logger.info(
            'main',
            'SEARCH-MANAGER',
            `移动端: ${mobileStatus} (启用=${this.bot.config.workers.doMobileSearch}, 缺失=${missingSearchPoints.mobilePoints})`
        )
        this.bot.logger.info(
            'main',
            'SEARCH-MANAGER',
            `桌面端: ${desktopStatus} (启用=${this.bot.config.workers.doDesktopSearch}, 缺失=${missingSearchPoints.desktopPoints})`
        )
        updateTaskProgress(accountEmail, 'mobile', {
            status: doMobile ? '进行中' : this.bot.config.workers.doMobileSearch ? '无剩余积分，已跳过' : '已禁用'
        })
        updateTaskProgress(accountEmail, 'desktop', {
            status: doDesktop ? '进行中' : this.bot.config.workers.doDesktopSearch ? '无剩余积分，已跳过' : '已禁用'
        })
        updateTaskDetail(accountEmail, {
            key: 'mobile-search',
            label: '移动搜索',
            group: 'mobile',
            completed: mobileCounter.completed,
            total: mobileCounter.total,
            gained: 0,
            status: doMobile ? '进行中' : this.bot.config.workers.doMobileSearch ? '无剩余积分，已跳过' : '已禁用',
            message: doMobile
                ? `剩余 ${mobileCounter.remaining}，进度 ${mobileCounter.completed}/${mobileCounter.total}`
                : mobileStatus
        })
        updateTaskDetail(accountEmail, {
            key: 'desktop-search',
            label: 'PC搜索',
            group: 'desktop',
            completed: desktopCounter.completed,
            total: desktopCounter.total,
            gained: 0,
            status: doDesktop ? '进行中' : this.bot.config.workers.doDesktopSearch ? '无剩余积分，已跳过' : '已禁用',
            message: doDesktop
                ? `剩余 ${desktopCounter.remaining}，进度 ${desktopCounter.completed}/${desktopCounter.total}`
                : desktopStatus
        })

        if (!doMobile && !doDesktop) {
            const bothWorkersEnabled = this.bot.config.workers.doMobileSearch && this.bot.config.workers.doDesktopSearch
            const bothNoPoints = missingSearchPoints.mobilePoints <= 0 && missingSearchPoints.desktopPoints <= 0

            if (bothWorkersEnabled && bothNoPoints) {
                this.bot.logger.info(
                    'main',
                    'SEARCH-MANAGER',
                    '所有搜索已跳过：移动端或桌面端没有剩余积分。'
                )
            } else {
                this.bot.logger.info('main', 'SEARCH-MANAGER', '没有安排搜索（已禁用或没有积分）。')
            }

            this.bot.logger.info('main', 'SEARCH-MANAGER', '正在关闭移动端会话')
            try {
                await executionContext.run({ isMobile: true, account }, async () => {
                    await this.bot.browser.func.closeBrowser(mobileSession.context, accountEmail)
                })
                this.bot.logger.info('main', 'SEARCH-MANAGER', '移动端会话已关闭')
            } catch (error) {
                this.bot.logger.warn(
                    'main',
                    'SEARCH-MANAGER',
                    `关闭移动端会话失败: ${error instanceof Error ? error.message : String(error)}`
                )
                if (error instanceof Error && error.stack) {
                    this.bot.logger.debug('main', 'SEARCH-MANAGER', `移动端关闭堆栈: ${error.stack}`)
                }
            }
            return { mobilePoints: 0, desktopPoints: 0 }
        }

        const useParallel = this.bot.config.searchSettings.parallelSearching
        this.bot.logger.info('main', 'SEARCH-MANAGER', `模式: ${useParallel ? '并行' : '串行'}`)
        this.bot.logger.debug('main', 'SEARCH-MANAGER', `parallelSearching=${useParallel} | 账户=${accountEmail}`)

        if (useParallel) {
            return await this.doParallelSearches(
                data,
                missingSearchPoints,
                mobileSession,
                account,
                accountEmail,
                executionContext
            )
        } else {
            return await this.doSequentialSearches(
                data,
                missingSearchPoints,
                mobileSession,
                account,
                accountEmail,
                executionContext
            )
        }
    }

    private async doParallelSearches(
        data: DashboardData,
        missingSearchPoints: MissingSearchPoints,
        mobileSession: BrowserSession,
        account: Account,
        accountEmail: string,
        executionContext: any
    ): Promise<SearchResults> {
        this.bot.logger.info('main', 'SEARCH-MANAGER', '并行开始')
        this.bot.logger.debug(
            'main',
            'SEARCH-MANAGER',
            `并行配置 | 账户=${accountEmail} | 移动端缺失=${missingSearchPoints.mobilePoints} | 桌面端缺失=${missingSearchPoints.desktopPoints}`
        )

        const shouldDoMobile = this.bot.config.workers.doMobileSearch && missingSearchPoints.mobilePoints > 0
        const shouldDoDesktop = this.bot.config.workers.doDesktopSearch && missingSearchPoints.desktopPoints > 0

        this.bot.logger.debug(
            'main',
            'SEARCH-MANAGER',
            `并行标志 | 移动端=${shouldDoMobile} | 桌面端=${shouldDoDesktop}`
        )

        let desktopSession: BrowserSession | null = null
        let mobileContextClosed = false

        try {
            const promises: Promise<number>[] = []
            const searchTypes: string[] = []
            if (shouldDoMobile && shouldDoDesktop) {
                updateAccountRunState(accountEmail, {
                    currentTask: '并行搜索',
                    currentStage: 'search',
                    currentMessage: `移动剩余 ${missingSearchPoints.mobilePoints}，PC剩余 ${missingSearchPoints.desktopPoints}`
                })
            }

            if (shouldDoMobile) {
                if (!shouldDoDesktop) {
                    updateAccountRunState(accountEmail, {
                        currentTask: '移动搜索',
                        currentStage: 'mobile-search',
                        currentMessage: `正在执行移动搜索，目标 ${missingSearchPoints.mobilePoints}`
                    })
                }
                this.bot.logger.debug(
                    'main',
                    'SEARCH-MANAGER',
                    `安排移动端 | 目标=${missingSearchPoints.mobilePoints}`
                )
                searchTypes.push('Mobile')
                promises.push(
                    this.doMobileSearch(data, missingSearchPoints, mobileSession, accountEmail, executionContext).then(
                        points => {
                            mobileContextClosed = true
                            updateSearchTaskProgress(
                                accountEmail,
                                'mobile',
                                points,
                                Math.max(0, missingSearchPoints.mobilePoints - points),
                                missingSearchPoints.mobilePoints
                            )
                            this.bot.logger.info(
                                'main',
                                'SEARCH-MANAGER',
                                `移动端完成 | 账户=${accountEmail} | 获得=${points}`
                            )
                            return points
                        }
                    )
                )
            } else {
                const reason = !this.bot.config.workers.doMobileSearch ? 'disabled' : 'no-points'
                this.bot.logger.info('main', 'SEARCH-MANAGER', `跳过移动端 (${reason})；正在关闭移动端会话`)
                await this.bot.browser.func.closeBrowser(mobileSession.context, accountEmail)
                mobileContextClosed = true
                this.bot.logger.info('main', 'SEARCH-MANAGER', '移动端会话已关闭（无移动端搜索）')
            }

            if (shouldDoDesktop) {
                if (!shouldDoMobile) {
                    updateAccountRunState(accountEmail, {
                        currentTask: 'PC搜索',
                        currentStage: 'desktop-search',
                        currentMessage: `正在执行PC搜索，目标 ${missingSearchPoints.desktopPoints}`
                    })
                }
                this.bot.logger.info('main', 'SEARCH-MANAGER', '桌面端登录开始')
                this.bot.logger.debug(
                    'main',
                    'SEARCH-MANAGER',
                    `桌面端登录 | 账户=${accountEmail} | 代理=${account.proxy ?? 'none'}`
                )
                desktopSession = await executionContext.run({ isMobile: false, accountEmail }, async () =>
                    this.createDesktopSession(account, accountEmail)
                )
                this.bot.logger.info('main', 'SEARCH-MANAGER', '桌面端登录完成')
            } else {
                const reason = !this.bot.config.workers.doDesktopSearch ? 'disabled' : 'no-points'
                this.bot.logger.info('main', 'SEARCH-MANAGER', `跳过桌面端登录 (${reason})`)
            }

            if (shouldDoDesktop && desktopSession) {
                this.bot.logger.debug(
                    'main',
                    'SEARCH-MANAGER',
                    `安排桌面端 | 目标=${missingSearchPoints.desktopPoints}`
                )
                searchTypes.push('Desktop')
                promises.push(
                    this.doDesktopSearch(
                        data,
                        missingSearchPoints,
                        desktopSession,
                        accountEmail,
                        executionContext
                    ).then(points => {
                        updateSearchTaskProgress(
                            accountEmail,
                            'desktop',
                            points,
                            Math.max(0, missingSearchPoints.desktopPoints - points),
                            missingSearchPoints.desktopPoints
                        )
                        this.bot.logger.info(
                            'main',
                            'SEARCH-MANAGER',
                            `桌面端完成 | 账户=${accountEmail} | 获得=${points}`
                        )
                        return points
                    })
                )
            }

            this.bot.logger.info('main', 'SEARCH-MANAGER', `运行并行: ${searchTypes.join(' + ') || 'none'}`)

            const results = await Promise.all(promises)

            this.bot.logger.debug(
                'main',
                'SEARCH-MANAGER',
                `并行结果 | 账户=${accountEmail} | 结果=${JSON.stringify(results)}`
            )

            const mobilePoints = shouldDoMobile ? (results[0] ?? 0) : 0
            const desktopPoints = shouldDoDesktop ? (results[shouldDoMobile ? 1 : 0] ?? 0) : 0

            this.bot.logger.info(
                'main',
                'SEARCH-MANAGER',
                `并行摘要 | 账户=${accountEmail} | 移动端=${mobilePoints} | 桌面端=${desktopPoints} | 总计=${
                    mobilePoints + desktopPoints
                }`
            )

            return { mobilePoints, desktopPoints }
        } catch (error) {
            this.bot.logger.error(
                'main',
                'SEARCH-MANAGER',
                `并行失败: ${error instanceof Error ? error.message : String(error)}`
            )
            if (error instanceof Error && error.stack) {
                this.bot.logger.debug('main', 'SEARCH-MANAGER', `并行堆栈: ${error.stack}`)
            }
            throw error
        } finally {
            if (!mobileContextClosed && mobileSession) {
                this.bot.logger.info('main', 'SEARCH-MANAGER', '清理：正在关闭移动端会话')
                this.bot.logger.debug('main', 'SEARCH-MANAGER', `清理移动端 | 账户=${accountEmail}`)
                try {
                    await executionContext.run({ isMobile: true, accountEmail }, async () => {
                        await this.bot.browser.func.closeBrowser(mobileSession.context, accountEmail)
                    })
                    this.bot.logger.info('main', 'SEARCH-MANAGER', '清理：移动端会话已关闭')
                } catch (error) {
                    this.bot.logger.warn(
                        'main',
                        'SEARCH-MANAGER',
                        `清理：移动端关闭失败: ${error instanceof Error ? error.message : String(error)}`
                    )
                    if (error instanceof Error && error.stack) {
                        this.bot.logger.debug('main', 'SEARCH-MANAGER', `清理移动端堆栈: ${error.stack}`)
                    }
                }
            }
        }
    }

    private async doSequentialSearches(
        data: DashboardData,
        missingSearchPoints: MissingSearchPoints,
        mobileSession: BrowserSession,
        account: Account,
        accountEmail: string,
        executionContext: any
    ): Promise<SearchResults> {
        this.bot.logger.info('main', 'SEARCH-MANAGER', '串行开始')
        this.bot.logger.debug(
            'main',
            'SEARCH-MANAGER',
            `串行配置 | 账户=${accountEmail} | 移动端缺失=${missingSearchPoints.mobilePoints} | 桌面端缺失=${missingSearchPoints.desktopPoints}`
        )

        const shouldDoMobile = this.bot.config.workers.doMobileSearch && missingSearchPoints.mobilePoints > 0
        const shouldDoDesktop = this.bot.config.workers.doDesktopSearch && missingSearchPoints.desktopPoints > 0

        this.bot.logger.debug(
            'main',
            'SEARCH-MANAGER',
            `串行标志 | 移动端=${shouldDoMobile} | 桌面端=${shouldDoDesktop}`
        )

        let mobilePoints = 0
        let desktopPoints = 0

        if (shouldDoMobile) {
            updateAccountRunState(accountEmail, {
                currentTask: '移动搜索',
                currentStage: 'mobile-search',
                currentMessage: `正在执行移动搜索，目标 ${missingSearchPoints.mobilePoints}`
            })
            this.bot.logger.info('main', 'SEARCH-MANAGER', '步骤 1: 移动端')
            this.bot.logger.debug(
                'main',
                'SEARCH-MANAGER',
                `串行移动端 | 目标=${missingSearchPoints.mobilePoints}`
            )
            const beforePoints = Number(this.bot.userData.currentPoints ?? 0)
            const reportedPoints = await this.doMobileSearch(
                data,
                missingSearchPoints,
                mobileSession,
                accountEmail,
                executionContext
            )
            const afterPoints = await this.readCurrentPoints()
            if (afterPoints !== null) {
                mobilePoints = Math.max(reportedPoints, Math.max(0, afterPoints - beforePoints))
                this.bot.userData.currentPoints = Math.max(Number(this.bot.userData.currentPoints ?? 0), afterPoints)
            } else {
                mobilePoints = reportedPoints
            }
            updateSearchTaskProgress(
                accountEmail,
                'mobile',
                mobilePoints,
                Math.max(0, missingSearchPoints.mobilePoints - mobilePoints),
                missingSearchPoints.mobilePoints
            )
            this.bot.logger.info(
                'main',
                'SEARCH-MANAGER',
                `步骤 1: 移动端完成 | 账户=${accountEmail} | 获得=${mobilePoints}`
            )
        } else {
            const reason = !this.bot.config.workers.doMobileSearch ? 'disabled' : 'no-points'
            this.bot.logger.info('main', 'SEARCH-MANAGER', `步骤 1: 跳过移动端 (${reason})；正在关闭移动端会话`)
            this.bot.logger.debug('main', 'SEARCH-MANAGER', '正在关闭未使用的移动端上下文')
            try {
                await executionContext.run({ isMobile: true, accountEmail }, async () => {
                    await this.bot.browser.func.closeBrowser(mobileSession.context, accountEmail)
                })
                this.bot.logger.info('main', 'SEARCH-MANAGER', '未使用的移动端会话已关闭')
            } catch (error) {
                this.bot.logger.warn(
                    'main',
                    'SEARCH-MANAGER',
                    `未使用的移动端关闭失败: ${error instanceof Error ? error.message : String(error)}`
                )
                if (error instanceof Error && error.stack) {
                    this.bot.logger.debug('main', 'SEARCH-MANAGER', `未使用的移动端堆栈: ${error.stack}`)
                }
            }
        }

        if (shouldDoDesktop) {
            updateAccountRunState(accountEmail, {
                currentTask: 'PC搜索',
                currentStage: 'desktop-search',
                currentMessage: `正在执行PC搜索，目标 ${missingSearchPoints.desktopPoints}`
            })
            this.bot.logger.info('main', 'SEARCH-MANAGER', '步骤 2: 桌面端')
            this.bot.logger.debug(
                'main',
                'SEARCH-MANAGER',
                `串行桌面端 | 目标=${missingSearchPoints.desktopPoints}`
            )
            const beforePoints = Number(this.bot.userData.currentPoints ?? 0)
            const reportedPoints = await this.doDesktopSearchSequential(
                data,
                missingSearchPoints,
                account,
                accountEmail,
                executionContext
            )
            const afterPoints = await this.readCurrentPoints()
            if (afterPoints !== null) {
                desktopPoints = Math.max(reportedPoints, Math.max(0, afterPoints - beforePoints))
                this.bot.userData.currentPoints = Math.max(Number(this.bot.userData.currentPoints ?? 0), afterPoints)
            } else {
                desktopPoints = reportedPoints
            }
            updateSearchTaskProgress(
                accountEmail,
                'desktop',
                desktopPoints,
                Math.max(0, missingSearchPoints.desktopPoints - desktopPoints),
                missingSearchPoints.desktopPoints
            )
            this.bot.logger.info(
                'main',
                'SEARCH-MANAGER',
                `步骤 2: 桌面端完成 | 账户=${accountEmail} | 获得=${desktopPoints}`
            )
        } else {
            const reason = !this.bot.config.workers.doDesktopSearch ? 'disabled' : 'no-points'
            this.bot.logger.info('main', 'SEARCH-MANAGER', `步骤 2: 跳过桌面端 (${reason})`)
        }

        this.bot.logger.info(
            'main',
            'SEARCH-MANAGER',
            `串行摘要 | 账户=${accountEmail} | 移动端=${mobilePoints} | 桌面端=${desktopPoints} | 总计=${
                mobilePoints + desktopPoints
            }`
        )
        this.bot.logger.debug('main', 'SEARCH-MANAGER', `串行完成 | 账户=${accountEmail}`)

        return { mobilePoints, desktopPoints }
    }

    private async createDesktopSession(account: Account, accountEmail: string): Promise<BrowserSession> {
        this.bot.logger.info('main', 'SEARCH-DESKTOP-LOGIN', '初始化桌面端会话')
        this.bot.logger.debug(
            'main',
            'SEARCH-DESKTOP-LOGIN',
            `初始化 | 账户=${accountEmail} | 代理=${account.proxy ?? 'none'}`
        )

        const session = await this.bot['browserFactory'].createBrowser(account)
        this.bot.logger.debug('main', 'SEARCH-DESKTOP-LOGIN', '浏览器已创建，新建页面')

        this.bot.mainDesktopPage = await session.context.newPage()

        this.bot.logger.info('main', 'SEARCH-DESKTOP-LOGIN', `浏览器就绪 | 账户=${accountEmail}`)
        this.bot.logger.info('main', 'SEARCH-DESKTOP-LOGIN', '登录开始')
        this.bot.logger.debug('main', 'SEARCH-DESKTOP-LOGIN', '调用登录处理器')

        await this.bot['login'].login(this.bot.mainDesktopPage, account)

        this.bot.logger.info('main', 'SEARCH-DESKTOP-LOGIN', '登录通过，正在验证')
        this.bot.logger.debug('main', 'SEARCH-DESKTOP-LOGIN', 'verifyBingSession')

        await this.bot['login'].verifyBingSession(this.bot.mainDesktopPage)
        this.bot.cookies.desktop = await session.context.cookies()

        this.bot.logger.debug('main', 'SEARCH-DESKTOP-LOGIN', 'Cookie已存储')
        this.bot.logger.info('main', 'SEARCH-DESKTOP-LOGIN', '桌面端会话就绪')

        return session
    }

    private async doMobileSearch(
        data: DashboardData,
        missingSearchPoints: MissingSearchPoints,
        mobileSession: BrowserSession,
        accountEmail: string,
        executionContext: any
    ): Promise<number> {
        this.bot.logger.debug(
            'main',
            'SEARCH-MOBILE-SEARCH',
            `开始 | 账户=${accountEmail} | 目标=${missingSearchPoints.mobilePoints}`
        )

        return await executionContext.run({ isMobile: true, accountEmail }, async () => {
            try {
                if (!this.bot.config.workers.doMobileSearch) {
                    this.bot.logger.info('main', 'SEARCH-MOBILE-SEARCH', '跳过：配置中禁用了工作进程')
                    return 0
                }

                if (missingSearchPoints.mobilePoints === 0) {
                    this.bot.logger.info('main', 'SEARCH-MOBILE-SEARCH', '跳过：没有剩余积分')
                    return 0
                }

                this.bot.logger.info(
                    'main',
                    'SEARCH-MOBILE-SEARCH',
                    `搜索开始 | 目标=${missingSearchPoints.mobilePoints}`
                )
                this.bot.logger.debug('main', 'SEARCH-MOBILE-SEARCH', 'activities.doSearch (mobile)')

                const pointsEarned = await this.bot.activities.doSearch(data, this.bot.mainMobilePage, true)
                updateSearchTaskProgress(
                    accountEmail,
                    'mobile',
                    pointsEarned,
                    Math.max(0, missingSearchPoints.mobilePoints - pointsEarned),
                    missingSearchPoints.mobilePoints
                )

                this.bot.logger.info(
                    'main',
                    'SEARCH-MOBILE-SEARCH',
                    `搜索完成 | 账户=${accountEmail} | 获得=${pointsEarned}/${missingSearchPoints.mobilePoints}`
                )
                this.bot.logger.debug(
                    'main',
                    'SEARCH-MOBILE-SEARCH',
                    `结果 | 账户=${accountEmail} | 获得=${pointsEarned}`
                )

                return pointsEarned
            } catch (error) {
                this.bot.logger.error(
                    'main',
                    'SEARCH-MOBILE-SEARCH',
                    `失败: ${error instanceof Error ? error.message : String(error)}`
                )
                if (error instanceof Error && error.stack) {
                    this.bot.logger.debug('main', 'SEARCH-MOBILE-SEARCH', `堆栈: ${error.stack}`)
                }
                return 0
            } finally {
                this.bot.logger.info('main', 'SEARCH-MOBILE-SEARCH', '正在关闭移动端会话')
                this.bot.logger.debug('main', 'SEARCH-MOBILE-SEARCH', `正在关闭上下文 | 账户=${accountEmail}`)
                try {
                    await this.bot.browser.func.closeBrowser(mobileSession.context, accountEmail)
                    this.bot.logger.info('main', 'SEARCH-MOBILE-SEARCH', '移动端浏览器已关闭')
                } catch (error) {
                    this.bot.logger.warn(
                        'main',
                        'SEARCH-MOBILE-SEARCH',
                        `关闭失败: ${error instanceof Error ? error.message : String(error)}`
                    )
                    if (error instanceof Error && error.stack) {
                        this.bot.logger.debug('main', 'SEARCH-MOBILE-SEARCH', `关闭堆栈: ${error.stack}`)
                    }
                }
            }
        })
    }

    private async doDesktopSearch(
        data: DashboardData,
        missingSearchPoints: MissingSearchPoints,
        desktopSession: BrowserSession,
        accountEmail: string,
        executionContext: any
    ): Promise<number> {
        this.bot.logger.debug(
            'main',
            'SEARCH-DESKTOP-PARALLEL',
            `开始 | 账户=${accountEmail} | 目标=${missingSearchPoints.desktopPoints}`
        )

        return await executionContext.run({ isMobile: false, accountEmail }, async () => {
            try {
                this.bot.logger.info(
                    'main',
                    'SEARCH-DESKTOP-PARALLEL',
                    `搜索开始 | 目标=${missingSearchPoints.desktopPoints}`
                )
                const pointsEarned = await this.bot.activities.doSearch(data, this.bot.mainDesktopPage, false)
                updateSearchTaskProgress(
                    accountEmail,
                    'desktop',
                    pointsEarned,
                    Math.max(0, missingSearchPoints.desktopPoints - pointsEarned),
                    missingSearchPoints.desktopPoints
                )

                this.bot.logger.info(
                    'main',
                    'SEARCH-DESKTOP-PARALLEL',
                    `搜索完成 | 账户=${accountEmail} | 获得=${pointsEarned}/${missingSearchPoints.desktopPoints}`
                )
                this.bot.logger.debug(
                    'main',
                    'SEARCH-DESKTOP-PARALLEL',
                    `结果 | 账户=${accountEmail} | 获得=${pointsEarned}`
                )

                return pointsEarned
            } catch (error) {
                this.bot.logger.error(
                    'main',
                    'SEARCH-DESKTOP-PARALLEL',
                    `失败: ${error instanceof Error ? error.message : String(error)}`
                )
                if (error instanceof Error && error.stack) {
                    this.bot.logger.debug('main', 'SEARCH-DESKTOP-PARALLEL', `堆栈: ${error.stack}`)
                }
                return 0
            } finally {
                this.bot.logger.info('main', 'SEARCH-DESKTOP-PARALLEL', '正在关闭桌面端会话')
                this.bot.logger.debug('main', 'SEARCH-DESKTOP-PARALLEL', `正在关闭上下文 | 账户=${accountEmail}`)
                try {
                    await this.bot.browser.func.closeBrowser(desktopSession.context, accountEmail)
                    this.bot.logger.info('main', 'SEARCH-DESKTOP-PARALLEL', '桌面端浏览器已关闭')
                } catch (error) {
                    this.bot.logger.warn(
                        'main',
                        'SEARCH-DESKTOP-PARALLEL',
                        `关闭失败: ${error instanceof Error ? error.message : String(error)}`
                    )
                    if (error instanceof Error && error.stack) {
                        this.bot.logger.debug('main', 'SEARCH-DESKTOP-PARALLEL', `关闭堆栈: ${error.stack}`)
                    }
                }
            }
        })
    }

    private async doDesktopSearchSequential(
        data: DashboardData,
        missingSearchPoints: MissingSearchPoints,
        account: Account,
        accountEmail: string,
        executionContext: any
    ): Promise<number> {
        this.bot.logger.debug(
            'main',
            'SEARCH-DESKTOP-SEQUENTIAL',
            `开始 | 账户=${accountEmail} | 目标=${missingSearchPoints.desktopPoints}`
        )

        return await executionContext.run({ isMobile: false, accountEmail }, async () => {
            if (!this.bot.config.workers.doDesktopSearch) {
                this.bot.logger.info('main', 'SEARCH-DESKTOP-SEQUENTIAL', '跳过：配置中禁用了工作进程')
                return 0
            }

            if (missingSearchPoints.desktopPoints === 0) {
                this.bot.logger.info('main', 'SEARCH-DESKTOP-SEQUENTIAL', '跳过：没有剩余积分')
                return 0
            }

            let desktopSession: BrowserSession | null = null
            try {
                this.bot.logger.info('main', 'SEARCH-DESKTOP-SEQUENTIAL', '初始化桌面端会话')
                desktopSession = await this.createDesktopSession(account, accountEmail)

                this.bot.logger.info(
                    'main',
                    'SEARCH-DESKTOP-SEQUENTIAL',
                    `搜索开始 | 目标=${missingSearchPoints.desktopPoints}`
                )

                const pointsEarned = await this.bot.activities.doSearch(data, this.bot.mainDesktopPage, false)
                updateSearchTaskProgress(
                    accountEmail,
                    'desktop',
                    pointsEarned,
                    Math.max(0, missingSearchPoints.desktopPoints - pointsEarned),
                    missingSearchPoints.desktopPoints
                )

                this.bot.logger.info(
                    'main',
                    'SEARCH-DESKTOP-SEQUENTIAL',
                    `搜索完成 | 账户=${accountEmail} | 获得=${pointsEarned}/${missingSearchPoints.desktopPoints}`
                )
                this.bot.logger.debug(
                    'main',
                    'SEARCH-DESKTOP-SEQUENTIAL',
                    `结果 | 账户=${accountEmail} | 获得=${pointsEarned}`
                )

                return pointsEarned
            } catch (error) {
                this.bot.logger.error(
                    'main',
                    'SEARCH-DESKTOP-SEQUENTIAL',
                    `失败: ${error instanceof Error ? error.message : String(error)}`
                )
                if (error instanceof Error && error.stack) {
                    this.bot.logger.debug('main', 'SEARCH-DESKTOP-SEQUENTIAL', `堆栈: ${error.stack}`)
                }
                return 0
            } finally {
                if (desktopSession) {
                    this.bot.logger.info('main', 'SEARCH-DESKTOP-SEQUENTIAL', '正在关闭桌面端会话')
                    this.bot.logger.debug(
                        'main',
                        'SEARCH-DESKTOP-SEQUENTIAL',
                        `正在关闭上下文 | 账户=${accountEmail}`
                    )
                    try {
                        await this.bot.browser.func.closeBrowser(desktopSession.context, accountEmail)
                        this.bot.logger.info('main', 'SEARCH-DESKTOP-SEQUENTIAL', '桌面端浏览器已关闭')
                    } catch (error) {
                        this.bot.logger.warn(
                            'main',
                            'SEARCH-DESKTOP-SEQUENTIAL',
                            `关闭失败: ${error instanceof Error ? error.message : String(error)}`
                        )
                        if (error instanceof Error && error.stack) {
                            this.bot.logger.debug('main', 'SEARCH-DESKTOP-SEQUENTIAL', `关闭堆栈: ${error.stack}`)
                        }
                    }
                }
            }
        })
    }
}
