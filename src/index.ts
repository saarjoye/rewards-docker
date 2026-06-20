import { AsyncLocalStorage } from 'node:async_hooks'
import cluster, { Worker } from 'cluster'
import type { BrowserContext, Cookie, Page } from 'patchright'
import pkg from '../package.json'

import type { BrowserFingerprintWithHeaders } from 'fingerprint-generator'

import Browser from './browser/Browser'
import BrowserFunc from './browser/BrowserFunc'
import BrowserUtils from './browser/BrowserUtils'

import { IpcLog, Logger } from './logging/Logger'
import Utils from './util/Utils'
import { loadAccounts, loadConfig } from './util/Load'
import { checkNodeVersion } from './util/Validator'

import { Login } from './browser/auth/Login'
import { Workers } from './functions/Workers'
import Activities from './functions/Activities'
import { SearchManager } from './functions/SearchManager'

import type { Account } from './interface/Account'
import AxiosClient from './util/Axios'
import { sendDiscord, flushDiscordQueue } from './logging/Discord'
import { sendNtfy, flushNtfyQueue } from './logging/Ntfy'
import { sendPushPlus, flushPushPlusQueue } from './logging/PushPlus'
import { sendWeCom, flushWeComQueue } from './logging/WeCom'
import type { DashboardData } from './interface/DashboardData'
import type { AppDashboardData } from './interface/AppDashBoardData'
import { PanelFlyoutData } from './interface/PanelFlyoutData'
import { updateAccountPointTotals, updateAccountTaskProgress, updateTaskProgress } from './util/TaskProgressStore'
import { updateAccountStatus } from './util/AccountStatusStore'
interface ExecutionContext {
    isMobile: boolean
    account: Account
}

interface BrowserSession {
    context: BrowserContext
    fingerprint: BrowserFingerprintWithHeaders
}

interface AccountStats {
    email: string
    initialPoints: number
    finalPoints: number
    collectedPoints: number
    taskSummary: AccountTaskSummary[]
    duration: number
    success: boolean
    error?: string
}

interface AccountTaskSummary {
    key: 'daily' | 'mobile' | 'desktop' | 'other'
    label: string
    completed?: number
    total?: number
    gained: number
    status: string
}

const executionContext = new AsyncLocalStorage<ExecutionContext>()

export function getCurrentContext(): ExecutionContext {
    const context = executionContext.getStore()
    if (!context) {
        return { isMobile: false, account: {} as Account }
    }
    return context
}

async function flushAllWebhooks(timeoutMs = 5000): Promise<void> {
    await Promise.allSettled([
        flushDiscordQueue(timeoutMs),
        flushNtfyQueue(timeoutMs),
        flushPushPlusQueue(timeoutMs),
        flushWeComQueue(timeoutMs)
    ])
}

interface UserData {
    userName: string
    accountEmail: string
    geoLocale: string
    langCode: string
    timezoneOffset: string
    initialPoints: number
    currentPoints: number
    gainedPoints: number
}

// 主要的微软奖励机器人类，负责协调整个积分收集过程
export class MicrosoftRewardsBot {
    public logger: Logger // 日志记录器
    public config // 配置对象
    public utils: Utils // 工具类实例
    public activities: Activities = new Activities(this) // 活动管理器
    public browser: { func: BrowserFunc; utils: BrowserUtils } // 浏览器功能和工具

    public mainMobilePage!: Page // 主要的移动端页面
    public mainDesktopPage!: Page // 主要的桌面端页面

    public userData: UserData // 用户数据
    public panelData!: PanelFlyoutData

    public rewardsVersion: 'legacy' | 'modern' = 'legacy'

    public accessToken = '' // 访问令牌
    public requestToken = '' // 请求令牌
    public cookies: { mobile: Cookie[]; desktop: Cookie[] } // 移动端和桌面端的cookies
    public fingerprint!: BrowserFingerprintWithHeaders // 浏览器指纹

    // 新版 UI（modern dashboard）使用 Next.js Server Actions 而非 REST API。
    // next-action hash 在编译时生成，绑定到具体部署版本（dpl）。
    // 这里记录当前抓取到的部署 ID，用于在调用前做版本守卫。
    public serverActions: {
        deploymentId: string | null // 从 dashboard HTML 提取的 dpl（如 "20260612-3"）
    } = { deploymentId: null }

    private pointsCanCollect = 0 // 可收集的积分

    private activeWorkers: number // 活跃的工作进程数
    private exitedWorkers: number[] // 已退出的工作进程PID数组
    private browserFactory: Browser = new Browser(this) // 浏览器工厂实例
    private accounts: Account[] // 账户数组
    private workers: Workers // 工作进程管理器
    private login = new Login(this) // 登录管理器
    private searchManager: SearchManager // 搜索管理器

    public axios!: AxiosClient // HTTP客户端

    constructor() {
        // 初始化用户数据
        this.userData = {
            userName: '', // 用户名
            accountEmail: '', // 当前账号邮箱
            geoLocale: 'CN', // 地理区域
            langCode: 'zh', // 语言代码
            timezoneOffset: '480', // 时区偏移（分钟）
            initialPoints: 0, // 初始积分
            currentPoints: 0, // 当前积分
            gainedPoints: 0 // 已获得积分
        }
        this.logger = new Logger(this) // 初始化日志记录器
        this.accounts = [] // 初始化账户数组
        this.cookies = { mobile: [], desktop: [] } // 初始化cookies对象
        this.utils = new Utils() // 初始化工具类
        this.workers = new Workers(this) // 初始化工作进程管理器
        this.searchManager = new SearchManager(this) // 初始化搜索管理器
        this.browser = {
            func: new BrowserFunc(this), // 初始化浏览器功能
            utils: new BrowserUtils(this) // 初始化浏览器工具
        }
        this.config = loadConfig() // 加载配置
        this.activeWorkers = this.config.clusters // 设置活跃工作进程数
        this.exitedWorkers = [] // 初始化已退出工作进程数组
    }

    private buildSummaryMessage(accountStats: AccountStats[], runStartTime: number, hadWorkerFailure: boolean): string {
        const totalCollectedPoints = accountStats.reduce((sum, s) => sum + s.collectedPoints, 0)
        const totalInitialPoints = accountStats.reduce((sum, s) => sum + s.initialPoints, 0)
        const totalFinalPoints = accountStats.reduce((sum, s) => sum + s.finalPoints, 0)
        const totalDurationMinutes = ((Date.now() - runStartTime) / 1000 / 60).toFixed(1)
        const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19)

        const lines: string[] = [
            `每日积分摘要 | ${timestamp}`,
            `状态: ${hadWorkerFailure ? '异常' : '完成'}`,
            `账户数: ${accountStats.length}`,
            `总收集积分: +${totalCollectedPoints}`,
            `原始总计: ${totalInitialPoints} → 新总计: ${totalFinalPoints}`,
            `总运行时间: ${totalDurationMinutes}分钟`
        ]

        if (accountStats.length > 0) {
            lines.push('')
            lines.push('账户明细:')
            for (const stat of accountStats) {
                const status = stat.success ? '成功' : '失败'
                const duration = Number.isFinite(stat.duration) ? stat.duration.toFixed(1) : String(stat.duration)
                const error = stat.error ? ` | ${stat.error}` : ''
                lines.push(
                    `${stat.email} | +${stat.collectedPoints} | ${stat.initialPoints}→${stat.finalPoints} | ${duration}秒 | ${status}${error}`
                )
            }
        }

        return lines.join('\n')
    }

    private buildWeComAccountMessage(stat: AccountStats): string {
        const timestamp = new Date().toLocaleString()
        const status = stat.success ? '完成' : '失败'
        const duration = Number.isFinite(stat.duration) ? stat.duration.toFixed(1) : String(stat.duration)
        const lines: string[] = [
            `Microsoft Rewards 账号任务${status}`,
            `时间：${timestamp}`,
            `账号：${stat.email}`,
            `任务前总积分：${stat.initialPoints}`,
            `任务后总积分：${stat.finalPoints}`,
            `本次总增加：${stat.collectedPoints}`,
            `耗时：${duration} 秒`
        ]

        if (stat.taskSummary.length > 0) {
            lines.push('')
            lines.push('任务明细：')
            for (const task of stat.taskSummary) {
                const progress =
                    task.total !== undefined && task.completed !== undefined ? ` | 进度 ${task.completed}/${task.total}` : ''
                lines.push(`- ${task.label}：+${task.gained} 分${progress} | ${task.status}`)
            }
        }

        if (stat.error) {
            lines.push('')
            lines.push(`错误：${stat.error}`)
        }

        return lines.join('\n')
    }

    private async sendWeComAccountSummary(stat: AccountStats): Promise<void> {
        const wecom = this.config?.webhook?.wecom
        if (!wecom?.enabled) return

        await sendWeCom(wecom, this.buildWeComAccountMessage(stat))
    }

    private async sendPushPlusSummary(
        accountStats: AccountStats[],
        runStartTime: number,
        hadWorkerFailure: boolean
    ): Promise<void> {
        const pushplus = this.config?.webhook?.pushplus
        if (!pushplus?.enabled || !pushplus.token) {
            return
        }

        const content = this.buildSummaryMessage(accountStats, runStartTime, hadWorkerFailure)
        await sendPushPlus(pushplus, content)
    }

    // 获取当前是否为移动端的上下文
    get isMobile(): boolean {
        return getCurrentContext().isMobile
    }

    // 初始化账户数据
    async initialize(): Promise<void> {
        this.accounts = loadAccounts()
    }

    // 运行主要的积分收集流程
    async run(): Promise<void> {
        const totalAccounts = this.accounts.length
        const runStartTime = Date.now()

        this.logger.info(
            'main',
            'RUN-START',
            `启动微软奖励脚本 | v${pkg.version} | 账户数: ${totalAccounts} | 集群数: ${this.config.clusters}`
        )

        // 如果集群数大于1，则使用多进程模式
        if (this.config.clusters > 1) {
            if (cluster.isPrimary) {
                // 主进程逻辑
                await this.runMaster(runStartTime)
            } else {
                // 工作进程逻辑
                this.runWorker(runStartTime)
            }
        } else {
            // 单进程模式，直接运行任务
            await this.runTasks(this.accounts, runStartTime)
        }
    }

    private async runMaster(runStartTime: number): Promise<void> {
        void this.logger.info('main', 'CLUSTER-PRIMARY', `主进程已启动 | PID: ${process.pid}`)

        const rawChunks = this.utils.chunkArray(this.accounts, this.config.clusters)
        const accountChunks = rawChunks.filter(c => c && c.length > 0)
        this.activeWorkers = accountChunks.length

        const allAccountStats: AccountStats[] = []
        let hadWorkerFailure = false

        for (const chunk of accountChunks) {
            const worker = cluster.fork()
            worker.send?.({ chunk, runStartTime })

            worker.on('message', (msg: { __ipcLog?: IpcLog; __stats?: AccountStats[] }) => {
                if (msg.__stats) {
                    allAccountStats.push(...msg.__stats)
                }

                const log = msg.__ipcLog
                if (log && typeof log.content === 'string') {
                    const { webhook } = this.config
                    const { content, level } = log

                    // Webhooks, for later expansion?
                    if (webhook.discord?.enabled && webhook.discord.url) {
                        sendDiscord(webhook.discord.url, content, level)
                    }
                    if (webhook.ntfy?.enabled && webhook.ntfy.url) {
                        sendNtfy(webhook.ntfy, content, level)
                    }
                }
            })

            // Startup delay for clusters due to resource usage
            if (accountChunks.indexOf(chunk) !== accountChunks.length - 1) {
                await this.utils.wait(5000)
            }
        }

        const onWorkerExit = async (worker: Worker, code?: number, signal?: string): Promise<void> => {
            const { pid } = worker.process

            if (!pid || this.exitedWorkers.includes(pid)) {
                return
            }

            this.exitedWorkers.push(pid)
            this.activeWorkers -= 1

            // exit 0 = good, exit 1 = crash
            const failed = (code ?? 0) !== 0 || Boolean(signal)
            if (failed) {
                hadWorkerFailure = true
            }

            this.logger.warn(
                'main',
                'CLUSTER-WORKER-EXIT',
                `工作进程 ${pid} exit | Code: ${code ?? 'n/a'} | Signal: ${signal ?? 'n/a'} | Active workers: ${this.activeWorkers}`
            )

            if (this.activeWorkers <= 0) {
                const totalCollectedPoints = allAccountStats.reduce((sum, s) => sum + s.collectedPoints, 0)
                const totalInitialPoints = allAccountStats.reduce((sum, s) => sum + s.initialPoints, 0)
                const totalFinalPoints = allAccountStats.reduce((sum, s) => sum + s.finalPoints, 0)
                const totalDurationMinutes = ((Date.now() - runStartTime) / 1000 / 60).toFixed(1)

                this.logger.info(
                    'main',
                    'RUN-END',
                    `已完成所有账户 | 已处理账户: ${allAccountStats.length} | 总收集积分: +${totalCollectedPoints} | 原始总计: ${totalInitialPoints} → 新总计: ${totalFinalPoints} | 总运行时间: ${totalDurationMinutes}分钟`,
                    'green'
                )

                await this.sendPushPlusSummary(allAccountStats, runStartTime, hadWorkerFailure)
                await flushAllWebhooks()

                process.exit(hadWorkerFailure ? 1 : 0)
            }
        }

        cluster.on('exit', (worker, code, signal) => {
            void onWorkerExit(worker, code ?? undefined, signal ?? undefined)
        })

        cluster.on('disconnect', worker => {
            const pid = worker.process?.pid
            this.logger.warn('main', 'CLUSTER-WORKER-DISCONNECT', `Worker ${pid ?? '?'} disconnected`) // <-- Warning only
        })
    }

    private runWorker(runStartTimeFromMaster?: number): void {
        void this.logger.info('main', 'CLUSTER-WORKER-START', `工作进程已生成 | PID: ${process.pid}`)
        process.on('message', async ({ chunk, runStartTime }: { chunk: Account[]; runStartTime: number }) => {
            void this.logger.info(
                'main',
                'CLUSTER-WORKER-TASK',
                `工作进程 ${process.pid} 接收到 ${chunk.length} 个账户。`
            )

            try {
                const stats = await this.runTasks(chunk, runStartTime ?? runStartTimeFromMaster ?? Date.now())

                // Send and flush before exit
                if (process.send) {
                    process.send({ __stats: stats })
                }

                await flushAllWebhooks()
                process.exit(0)
            } catch (error) {
                this.logger.error(
                    'main',
                    'CLUSTER-WORKER-ERROR',
                    `工作进程任务崩溃: ${error instanceof Error ? error.message : String(error)}`
                )

                await flushAllWebhooks()
                process.exit(1)
            }
        })
    }

    private async runTasks(accounts: Account[], runStartTime: number): Promise<AccountStats[]> {
        const accountStats: AccountStats[] = []

        for (const account of accounts) {
            const accountStartTime = Date.now()
            const accountEmail = account.email
            this.userData.userName = this.utils.getEmailUsername(accountEmail)
            this.userData.accountEmail = accountEmail
            this.userData.timezoneOffset = String(-new Date().getTimezoneOffset())

            try {
                updateAccountStatus(accountEmail, {
                    state: 'checking',
                    stage: 'account-start',
                    lastMessage: '开始检测账号登录状态'
                })
                this.logger.info(
                    'main',
                    'ACCOUNT-START',
                    `开始处理账户: ${accountEmail} | 地理位置: ${account.geoLocale}`
                )

                this.axios = new AxiosClient(account.proxy)

                const result:
                    | {
                          initialPoints: number
                          finalPoints: number
                          collectedPoints: number
                          taskSummary: AccountTaskSummary[]
                      }
                    | undefined = await this.Main(account).catch(error => {
                    void this.logger.error(
                        true,
                        'FLOW',
                        `${accountEmail} 的移动流程失败: ${error instanceof Error ? error.message : String(error)}`
                    )
                    return undefined
                })

                const durationSeconds = ((Date.now() - accountStartTime) / 1000).toFixed(1)

                if (result) {
                    const collectedPoints = result.collectedPoints ?? 0
                    const accountInitialPoints = result.initialPoints ?? 0
                    const accountFinalPoints = result.finalPoints ?? accountInitialPoints + collectedPoints
                    const statusMessage =
                        process.env.ACCOUNT_STATUS_CHECK_ONLY === 'true'
                            ? '账号状态检测通过'
                            : `任务已完成，今日增加 ${collectedPoints} 分`
                    updateAccountStatus(accountEmail, {
                        state: 'success',
                        stage: process.env.ACCOUNT_STATUS_CHECK_ONLY === 'true' ? 'status-check' : 'account-end',
                        lastMessage: statusMessage
                    })

                    const stat: AccountStats = {
                        email: accountEmail,
                        initialPoints: accountInitialPoints,
                        finalPoints: accountFinalPoints,
                        collectedPoints: collectedPoints,
                        taskSummary: result.taskSummary,
                        duration: parseFloat(durationSeconds),
                        success: true
                    }
                    accountStats.push(stat)

                    this.logger.info(
                        'main',
                        'ACCOUNT-END',
                        `已完成账户: ${accountEmail} | 总计: +${collectedPoints} | 原始: ${accountInitialPoints} → 新值: ${accountFinalPoints} | 持续时间: ${durationSeconds}秒`,
                        'green'
                    )
                    await this.sendWeComAccountSummary(stat)
                } else {
                    updateAccountStatus(accountEmail, {
                        state: 'error',
                        stage: 'account-flow',
                        lastMessage: '账号流程失败，请查看运行日志',
                        error: '流程失败'
                    })
                    const stat: AccountStats = {
                        email: accountEmail,
                        initialPoints: 0,
                        finalPoints: 0,
                        collectedPoints: 0,
                        taskSummary: [],
                        duration: parseFloat(durationSeconds),
                        success: false,
                        error: '流程失败'
                    }
                    accountStats.push(stat)
                    await this.sendWeComAccountSummary(stat)
                }
            } catch (error) {
                const durationSeconds = ((Date.now() - accountStartTime) / 1000).toFixed(1)
                const message = error instanceof Error ? error.message : String(error)
                updateAccountStatus(accountEmail, {
                    state: 'error',
                    stage: 'account-error',
                    lastMessage: message,
                    error: message
                })
                this.logger.error(
                    'main',
                    'ACCOUNT-ERROR',
                    `${accountEmail}: ${message}`
                )

                const stat: AccountStats = {
                    email: accountEmail,
                    initialPoints: 0,
                    finalPoints: 0,
                    collectedPoints: 0,
                    taskSummary: [],
                    duration: parseFloat(durationSeconds),
                    success: false,
                    error: message
                }
                accountStats.push(stat)
                await this.sendWeComAccountSummary(stat)
            }
        }

        if (this.config.clusters <= 1 && cluster.isPrimary) {
            const totalCollectedPoints = accountStats.reduce((sum, s) => sum + s.collectedPoints, 0)
            const totalInitialPoints = accountStats.reduce((sum, s) => sum + s.initialPoints, 0)
            const totalFinalPoints = accountStats.reduce((sum, s) => sum + s.finalPoints, 0)
            const totalDurationMinutes = ((Date.now() - runStartTime) / 1000 / 60).toFixed(1)
            const hadWorkerFailure = accountStats.some(s => !s.success)

            const runSummary = process.env.ACCOUNT_STATUS_CHECK_ONLY === 'true' ? '账号状态检测完成' : '已完成所有账户'
            this.logger.info(
                'main',
                'RUN-END',
                `${runSummary} | 已处理账户: ${accountStats.length} | 总收集积分: +${totalCollectedPoints} | 原始总计: ${totalInitialPoints} → 新总计: ${totalFinalPoints} | 总运行时间: ${totalDurationMinutes}分钟`,
                hadWorkerFailure ? 'yellow' : 'green'
            )

            await this.sendPushPlusSummary(accountStats, runStartTime, hadWorkerFailure)
            await flushAllWebhooks()
            process.exit(hadWorkerFailure ? 1 : 0)
        }

        return accountStats
    }

    async Main(account: Account): Promise<{
        initialPoints: number
        finalPoints: number
        collectedPoints: number
        taskSummary: AccountTaskSummary[]
    }> {
        const accountEmail = account.email
        this.logger.info('main', 'FLOW', `开始为 ${accountEmail} 创建会话`)

        let mobileSession: BrowserSession | null = null
        let mobileContextClosed = false

        try {
            return await executionContext.run({ isMobile: true, account }, async () => {
                mobileSession = await this.browserFactory.createBrowser(account)
                const initialContext: BrowserContext = mobileSession.context
                this.mainMobilePage = await initialContext.newPage()

                this.logger.info('main', 'BROWSER', `移动浏览器已启动 | ${accountEmail}`)

                await this.login.login(this.mainMobilePage, account)
                updateAccountStatus(accountEmail, {
                    state: 'valid',
                    stage: 'login',
                    lastMessage: '登录验证通过'
                })

                try {
                    this.accessToken = await this.login.getAppAccessToken(this.mainMobilePage, accountEmail)
                } catch (error) {
                    this.logger.error(
                        'main',
                        'FLOW',
                        `获取移动访问令牌失败: ${error instanceof Error ? error.message : String(error)}`
                    )
                }

                this.cookies.mobile = await initialContext.cookies()
                this.fingerprint = mobileSession.fingerprint

                const data: DashboardData = await this.browser.func.getDashboardData()
                const appData: AppDashboardData = await this.browser.func.getAppDashboardData()
                this.panelData = await this.browser.func.getPanelFlyoutData()

                // 新版 UI 用 Next.js Server Actions，需要从 dashboard 页面提取部署 ID
                // 作为版本守卫（hash 跟部署版本绑定，不一致就降级跳过，避免 400）
                this.serverActions.deploymentId = await this.browser.func.extractDeploymentId(this.mainMobilePage)
                if (this.serverActions.deploymentId) {
                    this.logger.info(
                        'main',
                        'SERVER-ACTION',
                        `新版仪表板部署 ID: ${this.serverActions.deploymentId} | Server Action 支持版本: ${BrowserFunc.SUPPORTED_DEPLOYMENT_ID}`
                    )
                }
                // 设置地理位置
                this.userData.geoLocale =
                    account.geoLocale === 'auto' ? data.userProfile.attributes.country : account.geoLocale.toLowerCase()
                if (this.userData.geoLocale.length > 2) {
                    this.logger.warn(
                        'main',
                        'GEO-LOCALE',
                        `提供的地理位置长度超过2位 (${this.userData.geoLocale} | 自动=${account.geoLocale === 'auto'})，这可能是无效的并导致错误！`
                    )
                }

                this.userData.initialPoints = data.userStatus.availablePoints
                this.userData.currentPoints = data.userStatus.availablePoints
                const initialPoints = this.userData.initialPoints ?? 0
                const taskSummary: AccountTaskSummary[] = []
                let dailyGainedPoints = 0
                updateAccountPointTotals(accountEmail, {
                    initialPoints,
                    currentPoints: initialPoints,
                    finalPoints: initialPoints
                })
                updateAccountStatus(accountEmail, {
                    state: 'running',
                    stage: 'dashboard',
                    lastMessage: `账号有效，当前积分 ${initialPoints}`
                })
                const initialMobileSearch = data.userStatus.counters.mobileSearch?.[0]
                const initialPcSearch = data.userStatus.counters.pcSearch?.[0]
                const initialMobileProgress = initialMobileSearch?.pointProgress ?? 0
                const initialPcProgress = initialPcSearch?.pointProgress ?? 0
                updateAccountTaskProgress(accountEmail, {
                    mobile: {
                        completed: initialMobileProgress,
                        total: initialMobileSearch?.pointProgressMax ?? 0,
                        gained: 0,
                        status:
                            initialMobileSearch && initialMobileSearch.pointProgress < initialMobileSearch.pointProgressMax
                                ? '进行中'
                                : '已完成'
                    },
                    desktop: {
                        completed: initialPcProgress,
                        total: initialPcSearch?.pointProgressMax ?? 0,
                        gained: 0,
                        status:
                            initialPcSearch && initialPcSearch.pointProgress < initialPcSearch.pointProgressMax
                                ? '进行中'
                                : '已完成'
                    }
                })

                const browserEarnable = await this.browser.func.getBrowserEarnablePoints()
                const appEarnable = await this.browser.func.getAppEarnablePoints()

                this.pointsCanCollect = browserEarnable.mobileSearchPoints + (appEarnable?.totalEarnablePoints ?? 0)

                this.logger.info(
                    'main',
                    'POINTS',
                    `今日可赚取 | 移动端: ${this.pointsCanCollect} | 浏览器: ${
                        browserEarnable.mobileSearchPoints
                    } | 应用: ${appEarnable?.totalEarnablePoints ?? 0} | ${accountEmail} | 区域设置: ${this.userData.geoLocale}`
                )

                if (process.env.ACCOUNT_STATUS_CHECK_ONLY === 'true') {
                    updateAccountStatus(accountEmail, {
                        state: 'success',
                        stage: 'status-check',
                        lastMessage: `账号状态正常，当前积分 ${initialPoints}`
                    })
                    this.logger.info('main', 'ACCOUNT-CHECK', `账号状态检测通过 | ${accountEmail}`)
                    return {
                        initialPoints,
                        finalPoints: initialPoints,
                        collectedPoints: 0,
                        taskSummary: [
                            {
                                key: 'other',
                                label: '账号状态检测',
                                gained: 0,
                                status: '通过'
                            }
                        ]
                    }
                }

                const getLatestPoints = async (fallback: number): Promise<number> => {
                    try {
                        return await this.browser.func.getCurrentPoints()
                    } catch {
                        return fallback
                    }
                }
                const runPointTask = async (label: string, fn: () => Promise<void>): Promise<void> => {
                    const before = Number(this.userData.currentPoints ?? initialPoints)
                    await fn()
                    const after = await getLatestPoints(before)
                    const gained = Math.max(0, after - before)
                    this.userData.currentPoints = after
                    dailyGainedPoints += gained
                    taskSummary.push({
                        key: 'daily',
                        label,
                        gained,
                        status: '已完成'
                    })
                    updateTaskProgress(accountEmail, 'daily', {
                        completed: dailyGainedPoints,
                        total: dailyGainedPoints,
                        gained: dailyGainedPoints,
                        status: '进行中'
                    })
                    updateAccountPointTotals(accountEmail, { currentPoints: after, finalPoints: after })
                }

                // Ensure streak protection is true if enabled
                if (this.config.ensureStreakProtection) {
                    await runPointTask('连击保护', async () => this.activities.doStreakProtection())
                }
                if (this.config.workers.doClaimBonusPoints) {
                    await runPointTask('领取奖励积分', async () => this.workers.doClaimBonusPoints(data))
                }
                if (this.config.workers.doAppPromotions) {
                    await runPointTask('App 活动', async () => this.workers.doAppPromotions(appData))
                }
                if (this.config.workers.doDailySet) {
                    await runPointTask('每日任务', async () => this.workers.doDailySet(data, this.mainMobilePage))
                }
                if (this.config.workers.doSpecialPromotions) {
                    await runPointTask('特殊活动', async () => this.workers.doSpecialPromotions(data))
                }
                if (this.config.workers.doMorePromotions) {
                    await runPointTask('更多推广', async () =>
                        this.workers.doMorePromotions(data, this.mainMobilePage)
                    )
                }
                if (this.config.workers.doDailyCheckIn) {
                    await runPointTask('每日签到', async () => this.activities.doDailyCheckIn())
                }
                if (this.config.workers.doReadToEarn) {
                    await runPointTask('阅读赚取', async () => this.activities.doReadToEarn())
                }
                if (this.config.workers.doPunchCards) {
                    await runPointTask('打卡活动', async () => this.workers.doPunchCards(data, this.mainMobilePage))
                }

                const searchPoints = await this.browser.func.getSearchPoints()
                const missingSearchPoints = this.browser.func.missingSearchPoints(searchPoints, true)
                const searchStartPoints = await getLatestPoints(Number(this.userData.currentPoints ?? initialPoints))
                this.userData.currentPoints = searchStartPoints
                updateAccountPointTotals(accountEmail, { currentPoints: searchStartPoints, finalPoints: searchStartPoints })

                this.cookies.mobile = await initialContext.cookies()

                const { mobilePoints, desktopPoints } = await this.searchManager.doSearches(
                    data,
                    missingSearchPoints,
                    mobileSession,
                    account,
                    accountEmail
                )

                mobileContextClosed = true

                const finalPoints = await this.browser.func.getCurrentPoints()
                const collectedPoints = Math.max(0, finalPoints - initialPoints)
                const searchGainedPoints = Math.max(0, finalPoints - searchStartPoints)
                const estimatedSearchPoints = Math.max(0, mobilePoints) + Math.max(0, desktopPoints)
                let mobileGainedPoints = 0
                let desktopGainedPoints = 0
                let otherGainedPoints = 0
                if (searchGainedPoints > 0 && estimatedSearchPoints > 0) {
                    mobileGainedPoints = Math.round((searchGainedPoints * Math.max(0, mobilePoints)) / estimatedSearchPoints)
                    desktopGainedPoints = searchGainedPoints - mobileGainedPoints
                } else if (searchGainedPoints > 0 && mobilePoints > 0) {
                    mobileGainedPoints = searchGainedPoints
                } else if (searchGainedPoints > 0 && desktopPoints > 0) {
                    desktopGainedPoints = searchGainedPoints
                } else {
                    otherGainedPoints = searchGainedPoints
                }

                const finalSearchPoints = await this.browser.func.getSearchPoints().catch(() => searchPoints)
                const finalMobileSearch = finalSearchPoints.mobileSearch?.[0]
                const finalPcSearch = finalSearchPoints.pcSearch?.[0]
                updateAccountTaskProgress(accountEmail, {
                    mobile: {
                        completed: finalMobileSearch?.pointProgress ?? initialMobileProgress,
                        total: finalMobileSearch?.pointProgressMax ?? initialMobileSearch?.pointProgressMax ?? 0,
                        gained: mobileGainedPoints,
                        status:
                            finalMobileSearch && finalMobileSearch.pointProgress < finalMobileSearch.pointProgressMax
                                ? '进行中'
                                : '已完成'
                    },
                    desktop: {
                        completed: finalPcSearch?.pointProgress ?? initialPcProgress,
                        total: finalPcSearch?.pointProgressMax ?? initialPcSearch?.pointProgressMax ?? 0,
                        gained: desktopGainedPoints,
                        status:
                            finalPcSearch && finalPcSearch.pointProgress < finalPcSearch.pointProgressMax
                                ? '进行中'
                                : '已完成'
                    },
                    daily: {
                        completed: dailyGainedPoints,
                        total: dailyGainedPoints,
                        gained: dailyGainedPoints,
                        status: '已完成'
                    }
                })
                updateAccountPointTotals(accountEmail, {
                    currentPoints: finalPoints,
                    finalPoints
                })

                taskSummary.push({
                    key: 'mobile',
                    label: '移动搜索',
                    completed: finalMobileSearch?.pointProgress ?? initialMobileProgress,
                    total: finalMobileSearch?.pointProgressMax ?? initialMobileSearch?.pointProgressMax ?? 0,
                    gained: mobileGainedPoints,
                    status: '已完成'
                })
                taskSummary.push({
                    key: 'desktop',
                    label: 'PC 搜索',
                    completed: finalPcSearch?.pointProgress ?? initialPcProgress,
                    total: finalPcSearch?.pointProgressMax ?? initialPcSearch?.pointProgressMax ?? 0,
                    gained: desktopGainedPoints,
                    status: '已完成'
                })
                if (otherGainedPoints > 0) {
                    taskSummary.push({
                        key: 'other',
                        label: '其他积分变化',
                        gained: otherGainedPoints,
                        status: '已记录'
                    })
                }
                updateTaskProgress(accountEmail, 'daily', {
                    completed: dailyGainedPoints,
                    total: dailyGainedPoints,
                    gained: dailyGainedPoints,
                    status: '已完成'
                })

                this.logger.info(
                    'main',
                    'FLOW',
                    `已收集: +${collectedPoints} | 日常: +${dailyGainedPoints} | 移动端: +${mobileGainedPoints} | 桌面端: +${desktopGainedPoints} | ${accountEmail}`
                )

                return {
                    initialPoints,
                    finalPoints,
                    collectedPoints,
                    taskSummary
                }
            })
        } finally {
            if (mobileSession && !mobileContextClosed) {
                try {
                    await executionContext.run({ isMobile: true, account }, async () => {
                        await this.browser.func.closeBrowser(mobileSession!.context, accountEmail)
                    })
                } catch {}
            }
        }
    }
}

export { executionContext }

async function main(): Promise<void> {
    // 在执行任何操作之前进行检查
    checkNodeVersion()
    const rewardsBot = new MicrosoftRewardsBot()

    process.on('beforeExit', () => {
        void flushAllWebhooks()
    })
    process.on('SIGINT', async () => {
        rewardsBot.logger.warn('main', 'PROCESS', '收到 SIGINT 信号，正在刷新并退出...')
        await flushAllWebhooks()
        process.exit(130)
    })
    process.on('SIGTERM', async () => {
        rewardsBot.logger.warn('main', 'PROCESS', '收到 SIGTERM 信号，正在刷新并退出...')
        await flushAllWebhooks()
        process.exit(143)
    })
    process.on('uncaughtException', async error => {
        rewardsBot.logger.error('main', 'UNCAUGHT-EXCEPTION', error)
        await flushAllWebhooks()
        process.exit(1)
    })
    process.on('unhandledRejection', async reason => {
        rewardsBot.logger.error('main', 'UNHANDLED-REJECTION', reason as Error)
        await flushAllWebhooks()
        process.exit(1)
    })

    try {
        await rewardsBot.initialize()
        await rewardsBot.run()
    } catch (error) {
        rewardsBot.logger.error('main', 'MAIN-ERROR', error as Error)
    }
}

main().catch(async error => {
    const tmpBot = new MicrosoftRewardsBot()
    tmpBot.logger.error('main', 'MAIN-ERROR', error as Error)
    await flushAllWebhooks()
    process.exit(1)
})
