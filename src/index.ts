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

import { Login, LoginStateError } from './browser/auth/Login'
import { Workers } from './functions/Workers'
import Activities from './functions/Activities'
import { SearchManager } from './functions/SearchManager'

import type { Account } from './interface/Account'
import AxiosClient from './util/Axios'
import { sendDiscord, flushDiscordQueue } from './logging/Discord'
import { sendNtfy, flushNtfyQueue } from './logging/Ntfy'
import { sendPushPlus, flushPushPlusQueue } from './logging/PushPlus'
import { sendWeCom, flushWeComQueue } from './logging/WeCom'
import type { DashboardData, DashboardFieldAvailability } from './interface/DashboardData'
import type { AppDashboardData } from './interface/AppDashBoardData'
import { PanelFlyoutData } from './interface/PanelFlyoutData'
import {
    recordTaskDetailGain,
    resetAccountRunProgress,
    taskDetailKey,
    updateAccountPointTotals,
    updateAccountRunFailure,
    updateAccountRunState,
    updateAccountTaskProgress,
    updateSearchTaskFailure,
    updateTaskDetail,
    updateTaskProgress
} from './util/TaskProgressStore'
import {
    ensurePointRunCategoryMinimum,
    finishPointRun,
    pointCategoryFor,
    recordPointFailure,
    recordPointRunGain,
    startPointRun,
    type PointRunStatus
} from './util/PointsHistoryStore'
import { updateAccountStatus } from './util/AccountStatusStore'
import {
    markRunningCheckpointsInterrupted,
    selectAccountsForRun,
    selectAccountsWithoutCheckpoint,
    syncRunCheckpointFromAccountCheck,
    updateRunCheckpoint,
    type RunAccountMode
} from './util/RunCheckpointStore'
import { monitorGiftCards } from './util/GiftCardMonitor'
import type { ServerActionName } from './util/ServerActions'
import type { AppEarnablePoints, BrowserEarnablePoints, MissingSearchPoints } from './interface/Points'
import { DashboardFetchError, dashboardFailureDetails, isDashboardFetchError } from './util/DashboardError'
import { SearchTaskError } from './util/SearchTaskError'
import { ensureSuccessfulLogin } from './util/AuthenticatedFlow'
import {
    calculateKnownPointTotals,
    buildWeComAccountMessage,
    dashboardAccountFailure,
    formatAccountError,
    formatAccountPoints,
    genericAccountFailure,
    resolveRunExitCode,
    type AccountStats,
    type AccountTaskSummary
} from './util/RunSummary'
interface ExecutionContext {
    isMobile: boolean
    account: Account
}

interface BrowserSession {
    context: BrowserContext
    fingerprint: BrowserFingerprintWithHeaders
}

interface RunOptions {
    accountMode: RunAccountMode
    targetAccountIndex?: number
    source: string
    manualTask?: 'claim-bonus-points'
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

function parseRunAccountMode(value: string | undefined): RunAccountMode {
    switch ((value ?? '').trim().toLowerCase()) {
        case 'failed':
            return 'failed'
        case 'all':
            return 'all'
        case 'account':
            return 'account'
        case 'continue':
        case '':
            return 'continue'
        default:
            return 'continue'
    }
}

function parseInteger(value: string | undefined): number | undefined {
    const parsed = Number(value)
    return Number.isInteger(parsed) ? parsed : undefined
}

function maskAccountEmail(email: string): string {
    const [name = '', domain = ''] = email.split('@')
    if (!domain) return email ? `${email.slice(0, 2)}***` : ''
    const left = name.length <= 2 ? `${name[0] ?? ''}***` : `${name.slice(0, 2)}***${name.slice(-1)}`
    return `${left}@${domain}`
}

function isAccountStatusCheckOnly(): boolean {
    return process.env.ACCOUNT_STATUS_CHECK_ONLY === 'true'
}

function currentManualTask(): RunOptions['manualTask'] {
    return process.env.MANUAL_TASK === 'claim-bonus-points' ? 'claim-bonus-points' : undefined
}

function currentRunOptions(): RunOptions {
    const statusCheckOnly = isAccountStatusCheckOnly()
    const manualTask = currentManualTask()
    return {
        accountMode: statusCheckOnly
            ? 'all'
            : manualTask && parseRunAccountMode(process.env.RUN_ACCOUNT_MODE) !== 'account'
              ? 'all'
              : parseRunAccountMode(process.env.RUN_ACCOUNT_MODE),
        targetAccountIndex: parseInteger(process.env.RUN_ACCOUNT_INDEX),
        source: process.env.RUN_SOURCE || 'local',
        manualTask
    }
}

function markFormalRunInterrupted(message: string): void {
    if (isFormalRunCheckpointEnabled()) {
        markRunningCheckpointsInterrupted(message)
    }
}

function isFormalRunCheckpointEnabled(): boolean {
    return !isAccountStatusCheckOnly() && !currentManualTask()
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
    public currentDetailTask: {
        key: string
        label: string
        group: 'daily' | 'mobile' | 'desktop' | 'activity'
    } | null = null
    private currentPointRunId: string | null = null
    private dashboardPointsKnown = false

    // 新版 UI（modern dashboard）使用 Next.js Server Actions 而非 REST API。
    // next-action hash 在编译时生成，绑定到具体部署版本（dpl）。
    // 这里记录当前抓取到的部署 ID 和 action hash，用于调用当前 dashboard 部署。
    public serverActions: {
        deploymentId: string | null // 从 dashboard HTML 提取的 dpl（如 "20260612-3"）
        hashes: Partial<Record<ServerActionName, string>>
    } = { deploymentId: null, hashes: {} }

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

    private formatDurationSeconds(value: number): string {
        const totalSeconds = Math.max(0, Math.round(Number.isFinite(value) ? value : 0))
        const hours = Math.floor(totalSeconds / 3600)
        const minutes = Math.floor((totalSeconds % 3600) / 60)
        const seconds = totalSeconds % 60
        const parts: string[] = []
        if (hours > 0) parts.push(`${hours}小时`)
        if (minutes > 0) parts.push(`${minutes}分钟`)
        if (seconds > 0 || parts.length === 0) parts.push(`${seconds}秒`)
        return parts.join('')
    }

    private buildSummaryMessage(accountStats: AccountStats[], runStartTime: number, hadWorkerFailure: boolean): string {
        const totals = calculateKnownPointTotals(accountStats)
        const totalDuration = this.formatDurationSeconds((Date.now() - runStartTime) / 1000)
        const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19)
        const statusFailed = resolveRunExitCode(accountStats, hadWorkerFailure) === 1

        const lines: string[] = [
            `每日积分摘要 | ${timestamp}`,
            `状态: ${statusFailed ? '异常' : '完成'}`,
            `账户数: ${accountStats.length}`,
            `已知账户总收集积分: +${totals.collectedPoints}`,
            `已知账户积分总计: ${totals.initialPoints} → ${totals.finalPoints}`,
            `积分未知账户: ${totals.unknownAccounts}`,
            `总运行时间: ${totalDuration}`
        ]

        if (accountStats.length > 0) {
            lines.push('')
            lines.push('账户明细:')
            for (const stat of accountStats) {
                const status = stat.success ? '成功' : '失败'
                const duration = this.formatDurationSeconds(stat.duration)
                const errorText = formatAccountError(stat.error)
                const error = errorText ? ` | ${errorText}` : ''
                lines.push(`${stat.email} | ${formatAccountPoints(stat).compact} | ${duration} | ${status}${error}`)
            }
        }

        return lines.join('\n')
    }

    private buildWeComAccountMessage(stat: AccountStats): string {
        const timestamp = new Date().toLocaleString()
        const duration = this.formatDurationSeconds(stat.duration)
        return buildWeComAccountMessage(stat, timestamp, duration)
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

    public recordPointGain(
        label: string,
        gained: number,
        newBalance: number,
        task: 'daily' | 'mobile' | 'desktop' = 'daily'
    ): void {
        const accountEmail = this.userData.accountEmail
        const safeGained = Math.max(0, Number.isFinite(Number(gained)) ? Number(gained) : 0)
        const safeBalance = Math.max(
            0,
            Number.isFinite(Number(newBalance)) ? Number(newBalance) : Number(this.userData.currentPoints ?? 0)
        )

        this.userData.currentPoints = safeBalance
        if (safeGained > 0) {
            this.userData.gainedPoints = Math.max(0, Number(this.userData.gainedPoints ?? 0)) + safeGained
        }

        if (!accountEmail) return

        updateAccountPointTotals(accountEmail, { currentPoints: safeBalance, finalPoints: safeBalance })

        const detail =
            this.currentDetailTask ??
            (task === 'daily'
                ? { key: taskDetailKey(label), label, group: 'activity' as const }
                : { key: task === 'desktop' ? 'desktop-search' : 'mobile-search', label, group: task })
        recordTaskDetailGain(accountEmail, detail, safeGained, safeGained > 0 ? `${label} +${safeGained}` : label)
        if (!isAccountStatusCheckOnly()) {
            try {
                recordPointRunGain(
                    accountEmail,
                    this.currentPointRunId,
                    label,
                    pointCategoryFor(label, task, detail.label),
                    safeGained,
                    safeBalance
                )
            } catch (error) {
                this.logger.warn(
                    'main',
                    'POINTS-HISTORY',
                    `积分历史实时写入失败: ${error instanceof Error ? error.message : String(error)}`
                )
            }
        }

        if (task !== 'daily') return

        const initialPoints = Math.max(0, Number(this.userData.initialPoints ?? 0))
        const dailyGained =
            initialPoints > 0
                ? Math.max(0, safeBalance - initialPoints)
                : Math.max(0, Number(this.userData.gainedPoints ?? 0))
        updateTaskProgress(accountEmail, 'daily', {
            completed: dailyGained,
            total: dailyGained,
            gained: dailyGained,
            status: safeGained > 0 ? `${label} +${safeGained}` : '进行中'
        })
    }

    private updateFormalRunCheckpoint(email: string, patch: Parameters<typeof updateRunCheckpoint>[1]): void {
        if (isFormalRunCheckpointEnabled()) {
            updateRunCheckpoint(email, patch)
        }
    }

    private syncAccountCheckRunCheckpoint(
        email: string,
        data: DashboardData,
        browserEarnable: BrowserEarnablePoints,
        appEarnable: AppEarnablePoints,
        searchCounters: MissingSearchPoints
    ): { hasPendingTasks: boolean; message: string } {
        const pending: string[] = []
        const workers = this.config.workers
        const addPoints = (enabled: boolean, label: string, points: number): void => {
            const safePoints = Math.max(0, Number(points || 0))
            if (enabled && safePoints > 0) {
                pending.push(`${label} ${safePoints}分`)
            }
        }

        addPoints(Boolean(workers.doDesktopSearch), 'PC搜索', browserEarnable.desktopSearchPoints)
        addPoints(Boolean(workers.doMobileSearch), '移动搜索', browserEarnable.mobileSearchPoints)
        addPoints(Boolean(workers.doDailySet), '每日任务', browserEarnable.dailySetPoints)
        addPoints(Boolean(workers.doMorePromotions), '更多推广', browserEarnable.morePromotionsPoints)
        addPoints(Boolean(workers.doDailyCheckIn), '每日签到', appEarnable.checkIn)
        addPoints(Boolean(workers.doReadToEarn), '阅读赚取', appEarnable.readToEarn)
        const addUnavailable = (
            enabled: boolean,
            label: string,
            fields: (keyof DashboardFieldAvailability)[]
        ): void => {
            if (enabled && fields.some(field => data.dashboardFieldAvailability[field] !== 'available')) {
                pending.push(`${label}数据未确认`)
            }
        }
        addUnavailable(Boolean(workers.doDesktopSearch), 'PC搜索', ['pcSearch'])
        addUnavailable(Boolean(workers.doDailySet), '每日任务', ['dailySetPromotions'])
        addUnavailable(Boolean(workers.doMorePromotions), '更多推广', [
            'morePromotions',
            'morePromotionsWithoutPromotionalItems'
        ])

        const pointClaim = data.pointClaimBannerPromotion
        const claimablePoints = Math.max(
            0,
            Number(pointClaim?.attributes?.claimable_points ?? 0) ||
                Number(pointClaim?.pointProgressMax ?? 0) - Number(pointClaim?.pointProgress ?? 0)
        )
        if (workers.doClaimBonusPoints && pointClaim && !pointClaim.complete && claimablePoints > 0) {
            pending.push(`奖励积分 ${claimablePoints}分`)
        }

        if (
            workers.doMobileSearch &&
            ['missing-counter', 'empty-counter', 'invalid-counter'].includes(searchCounters.mobileStatus)
        ) {
            pending.push('移动搜索额度未确认')
        }

        const hasPendingTasks = pending.length > 0
        const preview = pending.slice(0, 4).join('、')
        const more = pending.length > 4 ? ` 等${pending.length}项` : ''
        const message = hasPendingTasks
            ? `账号刷新：检测到未完成任务（${preview}${more}），等待继续执行`
            : '账号刷新：dashboard 已无可执行任务，今日已完成'

        syncRunCheckpointFromAccountCheck(email, {
            hasPendingTasks,
            message,
            runSource: process.env.RUN_SOURCE || 'local',
            pid: process.pid
        })

        return { hasPendingTasks, message }
    }

    private async runGiftCardMonitor(accountEmail: string, currentPoints: number): Promise<void> {
        if (!this.config.giftCardMonitor?.enabled) return

        try {
            const result = await monitorGiftCards(this, accountEmail, currentPoints)
            if (!result.checked) {
                this.logger.info('main', 'GIFT-CARD-MONITOR', result.message)
                return
            }

            this.logger.info(
                'main',
                'GIFT-CARD-MONITOR',
                `${result.message} | 目标=${this.config.giftCardMonitor.keywords.join(',') || '未设置'}`
            )
        } catch (error) {
            this.logger.warn(
                'main',
                'GIFT-CARD-MONITOR',
                `礼品卡库存监控失败: ${error instanceof Error ? error.message : String(error)}`
            )
        }
    }

    private safeStartPointRun(email: string, beforePoints: number): string | null {
        try {
            return startPointRun(email, beforePoints, {
                source: process.env.RUN_SOURCE || 'local',
                pid: process.pid
            })
        } catch (error) {
            this.logger.warn(
                'main',
                'POINTS-HISTORY',
                `积分历史 run 创建失败: ${error instanceof Error ? error.message : String(error)}`
            )
            return null
        }
    }

    private safeEnsurePointRunCategoryMinimum(
        email: string,
        label: string,
        category: Parameters<typeof ensurePointRunCategoryMinimum>[3],
        minimumGained: number,
        balance?: number
    ): void {
        try {
            ensurePointRunCategoryMinimum(email, this.currentPointRunId, label, category, minimumGained, balance)
        } catch (error) {
            this.logger.warn(
                'main',
                'POINTS-HISTORY',
                `积分历史分类补齐失败: ${error instanceof Error ? error.message : String(error)}`
            )
        }
    }

    private finishCurrentPointRun(
        email: string,
        status: PointRunStatus,
        patch: {
            beforePoints?: number
            afterPoints?: number
            runGained?: number
            taskSummary?: AccountTaskSummary[]
            error?: string
            failureStage?: string
            balanceUnconfirmed?: boolean
        } = {}
    ): void {
        if (isAccountStatusCheckOnly() || !this.currentPointRunId) return

        try {
            finishPointRun(email, this.currentPointRunId, {
                status,
                beforePoints: patch.beforePoints,
                afterPoints: patch.afterPoints,
                runGained: patch.runGained,
                taskSummary: patch.taskSummary,
                failureStage: patch.failureStage,
                balanceUnconfirmed: patch.balanceUnconfirmed,
                error: patch.error
            })
        } catch (error) {
            this.logger.warn(
                'main',
                'POINTS-HISTORY',
                `积分历史 run 收口失败: ${error instanceof Error ? error.message : String(error)}`
            )
        }
        this.currentPointRunId = null
    }

    // 初始化账户数据
    async initialize(): Promise<void> {
        this.accounts = loadAccounts()
    }

    // 运行主要的积分收集流程
    async run(): Promise<void> {
        const runStartTime = Date.now()

        if (this.config.clusters > 1 && !cluster.isPrimary && !currentManualTask()) {
            this.runWorker(runStartTime)
            return
        }

        const options = currentRunOptions()
        const selection =
            isAccountStatusCheckOnly() || options.manualTask
                ? selectAccountsWithoutCheckpoint(this.accounts, {
                      mode: options.accountMode,
                      targetAccountIndex: options.targetAccountIndex
                  })
                : selectAccountsForRun(this.accounts, {
                      mode: options.accountMode,
                      targetAccountIndex: options.targetAccountIndex,
                      runSource: options.source,
                      pid: process.pid
                  })
        const accountsToRun = selection.selected
        const totalAccounts = accountsToRun.length
        const selectedAccountSummary = accountsToRun
            .map(account => {
                const runAccountIndex = this.accounts.findIndex(item => item.email === account.email) + 1
                return `#${runAccountIndex} ${maskAccountEmail(account.email)}`
            })
            .join(', ')

        this.logger.info(
            'main',
            'RUN-START',
            `启动微软奖励脚本 | v${pkg.version} | 运行模式: ${selection.mode}${
                selection.targetAccountIndex ? `#${selection.targetAccountIndex}` : ''
            }${
                options.manualTask === 'claim-bonus-points' ? ' | 手动任务: 立即领取奖励积分' : ''
            } | 待执行账户: ${totalAccounts}/${this.accounts.length} | 已跳过: ${selection.skipped.length} | 上次中断: ${
                selection.interrupted
            } | 实际选择: ${selectedAccountSummary || 'none'} | 集群数: ${this.config.clusters}`
        )

        if (totalAccounts === 0) {
            this.logger.info(
                'main',
                'RUN-END',
                `没有需要执行的账户 | 运行模式: ${selection.mode} | 已跳过: ${selection.skipped.length}`,
                'green'
            )
            await flushAllWebhooks()
            return
        }

        // 如果集群数大于1，则使用多进程模式
        if (this.config.clusters > 1 && !options.manualTask) {
            // 主进程逻辑
            await this.runMaster(accountsToRun, runStartTime)
        } else {
            // 单进程模式，直接运行任务
            await this.runTasks(accountsToRun, runStartTime)
        }
    }

    private async runMaster(accounts: Account[], runStartTime: number): Promise<void> {
        void this.logger.info('main', 'CLUSTER-PRIMARY', `主进程已启动 | PID: ${process.pid}`)

        const rawChunks = this.utils.chunkArray(accounts, this.config.clusters)
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
                    if (msg.__stats.some(stat => !stat.success)) hadWorkerFailure = true
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
                const totals = calculateKnownPointTotals(allAccountStats)
                const totalDurationMinutes = ((Date.now() - runStartTime) / 1000 / 60).toFixed(1)

                this.logger.info(
                    'main',
                    'RUN-END',
                    `已完成所有账户 | 已处理账户: ${allAccountStats.length} | 已知账户总收集积分: +${totals.collectedPoints} | 已知账户积分: ${totals.initialPoints} → ${totals.finalPoints} | 积分未知账户: ${totals.unknownAccounts} | 总运行时间: ${totalDurationMinutes}分钟`,
                    resolveRunExitCode(allAccountStats, hadWorkerFailure) === 1 ? 'yellow' : 'green'
                )

                await this.sendPushPlusSummary(allAccountStats, runStartTime, hadWorkerFailure)
                await flushAllWebhooks()

                process.exit(resolveRunExitCode(allAccountStats, hadWorkerFailure))
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
            this.currentPointRunId = null
            this.dashboardPointsKnown = false
            this.userData.userName = this.utils.getEmailUsername(accountEmail)
            this.userData.accountEmail = accountEmail
            this.browser.func.resetCurrentPointsCache()
            this.userData.timezoneOffset = String(-new Date().getTimezoneOffset())
            this.userData.initialPoints = 0
            this.userData.currentPoints = 0
            this.userData.gainedPoints = 0
            try {
                updateAccountStatus(accountEmail, {
                    state: 'checking',
                    stage: 'account-start',
                    lastMessage: isAccountStatusCheckOnly() ? '开始检测账号登录状态' : '任务前置登录验证'
                })
                this.updateFormalRunCheckpoint(accountEmail, {
                    state: 'running',
                    currentTask: isAccountStatusCheckOnly() ? '账号状态检测' : '任务前置登录验证',
                    currentStep: 'account-start',
                    lastMessage: isAccountStatusCheckOnly()
                        ? '开始检测账号登录状态'
                        : '正式任务开始前登录并读取 dashboard',
                    runSource: process.env.RUN_SOURCE || 'local',
                    runMode: currentRunOptions().accountMode,
                    pid: process.pid
                })
                if (!isAccountStatusCheckOnly()) {
                    updateAccountRunState(accountEmail, {
                        currentTask: '任务前置登录验证',
                        currentStage: 'account-start',
                        currentMessage: '正式任务开始前登录并读取 dashboard'
                    })
                }
                this.logger.info(
                    'main',
                    'ACCOUNT-START',
                    `开始处理账户: ${maskAccountEmail(accountEmail)} | 地理位置: ${account.geoLocale}`
                )

                this.axios = new AxiosClient(account.proxy)

                const result = await this.Main(account)

                const durationSeconds = ((Date.now() - accountStartTime) / 1000).toFixed(1)
                const collectedPoints = result.collectedPoints
                const accountInitialPoints = result.initialPoints
                const accountFinalPoints = result.finalPoints
                const statusMessage = isAccountStatusCheckOnly()
                    ? '账号状态检测通过'
                    : result.partial
                      ? result.partialReason || '任务动作已完成，积分待复核'
                      : `任务已完成，本次增加 ${collectedPoints} 分`
                updateAccountStatus(accountEmail, {
                    state: 'success',
                    stage: isAccountStatusCheckOnly()
                        ? 'status-check'
                        : result.partial
                          ? 'account-partial'
                          : 'account-end',
                    lastMessage: statusMessage
                })
                this.updateFormalRunCheckpoint(accountEmail, {
                    state: 'completed',
                    currentTask: isAccountStatusCheckOnly() ? '账号状态检测完成' : '账号任务完成',
                    currentStep: isAccountStatusCheckOnly() ? 'status-check' : 'account-end',
                    lastMessage: statusMessage,
                    runSource: process.env.RUN_SOURCE || 'local',
                    runMode: currentRunOptions().accountMode,
                    pid: process.pid
                })
                this.finishCurrentPointRun(accountEmail, result.partial ? 'partial' : 'completed', {
                    beforePoints: accountInitialPoints,
                    afterPoints: accountFinalPoints ?? undefined,
                    runGained: collectedPoints ?? undefined,
                    taskSummary: result.taskSummary,
                    balanceUnconfirmed: result.balanceUnconfirmed
                })

                const stat: AccountStats = {
                    email: accountEmail,
                    initialPoints: accountInitialPoints,
                    finalPoints: accountFinalPoints,
                    collectedPoints,
                    taskSummary: result.taskSummary,
                    duration: parseFloat(durationSeconds),
                    success: true
                }
                accountStats.push(stat)

                this.logger.info(
                    'main',
                    'ACCOUNT-END',
                    `${result.partial ? '部分完成' : '已完成'}账户: ${maskAccountEmail(accountEmail)} | 总计: ${collectedPoints === null ? '待复核' : `+${collectedPoints}`} | 原始: ${accountInitialPoints} → 新值: ${accountFinalPoints ?? '未知'} | 持续时间: ${durationSeconds}秒`,
                    result.partial ? 'yellow' : 'green'
                )
                await this.sendWeComAccountSummary(stat)
            } catch (error) {
                const durationSeconds = ((Date.now() - accountStartTime) / 1000).toFixed(1)
                const message =
                    error instanceof LoginStateError
                        ? `登录失败 | 状态=${error.loginState} | 阶段=${error.loginStage} | 位置=${
                              error.url || `${error.host}${error.path}` || 'unknown'
                          } | 原因=${error.errorMessage}`
                        : error instanceof Error
                          ? error.message
                          : String(error)
                const failure = isDashboardFetchError(error)
                    ? dashboardAccountFailure(dashboardFailureDetails(error))
                    : error instanceof SearchTaskError
                      ? genericAccountFailure(error.stage, message)
                      : error instanceof LoginStateError
                        ? genericAccountFailure(error.loginStage, message)
                        : genericAccountFailure('account-error', message)
                const failedTaskSummary: AccountTaskSummary[] =
                    error instanceof SearchTaskError
                        ? [
                              {
                                  key: error.task,
                                  label: error.task === 'desktop' ? 'PC搜索' : '移动搜索',
                                  completed: error.completed,
                                  total: error.total,
                                  gained: 0,
                                  status: '失败'
                              }
                          ]
                        : []
                const initialPoints = this.dashboardPointsKnown ? this.userData.initialPoints : null
                const finalPoints = this.dashboardPointsKnown ? this.userData.currentPoints : null
                const collectedPoints =
                    initialPoints === null || finalPoints === null ? null : Math.max(0, finalPoints - initialPoints)
                updateAccountStatus(accountEmail, {
                    state: 'error',
                    stage: failure.stage,
                    lastMessage: message,
                    error: message
                })
                updateAccountRunFailure(accountEmail, failure.stage, message)
                this.updateFormalRunCheckpoint(accountEmail, {
                    state: 'failed',
                    currentTask: error instanceof LoginStateError ? '登录验证失败' : '账号异常',
                    currentStep: failure.stage,
                    lastMessage: message,
                    error: message,
                    runSource: process.env.RUN_SOURCE || 'local',
                    runMode: currentRunOptions().accountMode,
                    pid: process.pid
                })
                if (initialPoints !== null && finalPoints !== null && collectedPoints !== null) {
                    this.finishCurrentPointRun(accountEmail, 'failed', {
                        beforePoints: initialPoints,
                        afterPoints: finalPoints,
                        runGained: collectedPoints,
                        taskSummary: failedTaskSummary,
                        failureStage: failure.stage,
                        error: message
                    })
                } else {
                    try {
                        recordPointFailure(accountEmail, {
                            stage: failure.stage,
                            error: message,
                            source: process.env.RUN_SOURCE || 'local',
                            pid: process.pid
                        })
                    } catch (historyError) {
                        this.logger.warn(
                            'main',
                            'POINTS-HISTORY',
                            `账号失败阶段记录失败: ${
                                historyError instanceof Error ? historyError.message : String(historyError)
                            }`
                        )
                    }
                }
                this.logger.error('main', 'ACCOUNT-ERROR', `${maskAccountEmail(accountEmail)}: ${message}`)

                const stat: AccountStats = {
                    email: accountEmail,
                    initialPoints,
                    finalPoints,
                    collectedPoints,
                    taskSummary: failedTaskSummary,
                    duration: parseFloat(durationSeconds),
                    success: false,
                    error: failure
                }
                accountStats.push(stat)
                await this.sendWeComAccountSummary(stat)
            }
        }

        if (this.config.clusters <= 1 && cluster.isPrimary) {
            const totals = calculateKnownPointTotals(accountStats)
            const totalDurationMinutes = ((Date.now() - runStartTime) / 1000 / 60).toFixed(1)
            const hadWorkerFailure = accountStats.some(s => !s.success)

            const runSummary = isAccountStatusCheckOnly() ? '账号状态检测完成' : '已完成所有账户'
            this.logger.info(
                'main',
                'RUN-END',
                `${runSummary} | 已处理账户: ${accountStats.length} | 已知账户总收集积分: +${totals.collectedPoints} | 已知账户积分: ${totals.initialPoints} → ${totals.finalPoints} | 积分未知账户: ${totals.unknownAccounts} | 总运行时间: ${totalDurationMinutes}分钟`,
                hadWorkerFailure ? 'yellow' : 'green'
            )

            await this.sendPushPlusSummary(accountStats, runStartTime, hadWorkerFailure)
            await flushAllWebhooks()
            process.exit(resolveRunExitCode(accountStats, hadWorkerFailure))
        }

        return accountStats
    }

    async Main(account: Account): Promise<{
        initialPoints: number
        finalPoints: number | null
        collectedPoints: number | null
        taskSummary: AccountTaskSummary[]
        partial?: boolean
        partialReason?: string
        balanceUnconfirmed?: boolean
    }> {
        const accountEmail = account.email
        this.logger.info('main', 'FLOW', `开始为 ${accountEmail} 创建会话`)

        let mobileSession: BrowserSession | null = null
        let mobileContextClosed = false

        try {
            return await executionContext.run({ isMobile: true, account }, async () => {
                this.accessToken = ''
                const activeMobileSession = await this.browserFactory.createBrowser(account)
                mobileSession = activeMobileSession
                const initialContext: BrowserContext = activeMobileSession.context
                this.mainMobilePage = await initialContext.newPage()
                this.browser.func.prepareDashboardCapture(this.mainMobilePage, account.geoLocale)

                this.logger.info('main', 'BROWSER', `移动浏览器已启动 | ${accountEmail}`)

                this.updateFormalRunCheckpoint(accountEmail, {
                    state: 'running',
                    currentTask: isAccountStatusCheckOnly() ? '账号状态检测' : '任务前置登录验证',
                    currentStep: 'login',
                    lastMessage: isAccountStatusCheckOnly() ? '正在验证账号登录' : '正式任务前置登录验证',
                    runSource: process.env.RUN_SOURCE || 'local',
                    runMode: currentRunOptions().accountMode,
                    pid: process.pid
                })
                await ensureSuccessfulLogin(() => this.login.login(this.mainMobilePage, account))
                updateAccountStatus(accountEmail, {
                    state: 'valid',
                    stage: 'login',
                    lastMessage: isAccountStatusCheckOnly() ? '登录验证通过' : '任务前置登录验证通过'
                })
                this.updateFormalRunCheckpoint(accountEmail, {
                    state: 'running',
                    currentTask: isAccountStatusCheckOnly() ? '账号状态检测' : '任务前置登录验证',
                    currentStep: 'dashboard',
                    lastMessage: '登录通过，正在读取 dashboard',
                    runSource: process.env.RUN_SOURCE || 'local',
                    runMode: currentRunOptions().accountMode,
                    pid: process.pid
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
                const hasAppAccessToken = Boolean(this.accessToken)
                if (!hasAppAccessToken) {
                    this.logger.warn(
                        'main',
                        'FLOW',
                        '移动App访问令牌不可用，跳过App活动/每日签到/阅读赚取，继续执行网页任务和移动搜索'
                    )
                }

                this.cookies.mobile = await initialContext.cookies()
                this.fingerprint = activeMobileSession.fingerprint

                const data: DashboardData = await this.browser.func.getDashboardData(account.geoLocale)
                const initialPoints = data.userStatus.availablePoints
                this.userData.initialPoints = initialPoints
                this.userData.currentPoints = initialPoints
                this.dashboardPointsKnown = true
                if (!isAccountStatusCheckOnly()) {
                    this.currentPointRunId = this.safeStartPointRun(accountEmail, initialPoints)
                }
                let appData: AppDashboardData | null = null
                if (hasAppAccessToken) {
                    try {
                        appData = await this.browser.func.getAppDashboardData()
                    } catch (error) {
                        this.logger.warn(
                            'main',
                            'FLOW',
                            `获取App仪表盘失败，跳过App活动并继续搜索: ${error instanceof Error ? error.message : String(error)}`
                        )
                    }
                }
                this.panelData = await this.browser.func.getPanelFlyoutData()

                // 新版 UI 用 Next.js Server Actions；这里只轻量提取部署 ID。
                // action hash 等真正执行连击保护/奖励领取时再懒加载解析，避免影响其他主任务启动。
                this.serverActions = await this.browser.func.extractServerActionRuntimeInfo(this.mainMobilePage, false)
                if (this.serverActions.deploymentId) {
                    this.logger.info(
                        'main',
                        'SERVER-ACTION',
                        `新版仪表板部署 ID: ${this.serverActions.deploymentId} | 可用 Server Action: ${Object.keys(this.serverActions.hashes).join(',') || 'none'}`
                    )
                }
                // 设置地理位置
                this.userData.geoLocale =
                    account.geoLocale === 'auto' ? data.userProfile.attributes.country : account.geoLocale.toLowerCase()
                const hasKnownGeoLocale = this.userData.geoLocale !== 'unknown'
                if (this.userData.geoLocale !== 'unknown' && this.userData.geoLocale.length > 2) {
                    this.logger.warn(
                        'main',
                        'GEO-LOCALE',
                        `提供的地理位置长度超过2位 (${this.userData.geoLocale} | 自动=${account.geoLocale === 'auto'})，这可能是无效的并导致错误！`
                    )
                }

                const taskSummary: AccountTaskSummary[] = []
                let dailyGainedPoints = 0
                if (!isAccountStatusCheckOnly()) {
                    resetAccountRunProgress(accountEmail, {
                        initialPoints,
                        currentPoints: initialPoints,
                        finalPoints: initialPoints
                    })
                }
                updateAccountStatus(accountEmail, {
                    state: 'running',
                    stage: 'dashboard',
                    lastMessage: `账号有效，当前积分 ${initialPoints}`
                })
                this.updateFormalRunCheckpoint(accountEmail, {
                    state: 'running',
                    currentTask: isAccountStatusCheckOnly() ? '账号状态检测' : '任务执行中',
                    currentStep: 'dashboard',
                    lastMessage: `dashboard 已读取，当前积分 ${initialPoints}`,
                    runSource: process.env.RUN_SOURCE || 'local',
                    runMode: currentRunOptions().accountMode,
                    pid: process.pid
                })
                const initialSearchCounters = this.browser.func.missingSearchPoints(
                    data.userStatus.counters,
                    true,
                    data.dashboardFieldAvailability
                )
                const initialMobileSearch = initialSearchCounters.mobileCounter
                const initialDesktopCompleted =
                    initialSearchCounters.desktopCounter.completed + initialSearchCounters.edgeCounter.completed
                const initialDesktopTotal =
                    initialSearchCounters.desktopCounter.total + initialSearchCounters.edgeCounter.total
                const initialMobileUnrecognized = ['missing-counter', 'empty-counter', 'invalid-counter'].includes(
                    initialSearchCounters.mobileStatus
                )
                const initialPcUnrecognized = ['missing-counter', 'empty-counter', 'invalid-counter'].includes(
                    initialSearchCounters.desktopCounter.status
                )
                const initialMobileProgress = initialMobileSearch.completed
                if (!isAccountStatusCheckOnly()) {
                    updateAccountTaskProgress(accountEmail, {
                        mobile: {
                            completed: initialMobileProgress,
                            total: initialMobileSearch.total,
                            gained: 0,
                            status: initialMobileUnrecognized
                                ? '未识别到搜索额度'
                                : initialMobileSearch.remaining > 0
                                  ? '进行中'
                                  : '已完成'
                        },
                        desktop: {
                            completed: initialDesktopCompleted,
                            total: initialDesktopTotal,
                            gained: 0,
                            status: initialPcUnrecognized
                                ? '未识别到搜索额度'
                                : initialSearchCounters.desktopCounter.remaining > 0 ||
                                    initialSearchCounters.edgeCounter.remaining > 0
                                  ? '进行中'
                                  : '已完成'
                        }
                    })
                }

                const browserEarnable = await this.browser.func.getBrowserEarnablePoints(data)
                const appEarnable = hasAppAccessToken
                    ? await this.browser.func.getAppEarnablePoints().catch(error => {
                          this.logger.warn(
                              'main',
                              'POINTS',
                              `获取App可赚积分失败，按0处理并继续搜索: ${
                                  error instanceof Error ? error.message : String(error)
                              }`
                          )
                          return { readToEarn: 0, checkIn: 0, totalEarnablePoints: 0 }
                      })
                    : { readToEarn: 0, checkIn: 0, totalEarnablePoints: 0 }

                this.pointsCanCollect = browserEarnable.mobileSearchPoints + (appEarnable?.totalEarnablePoints ?? 0)

                this.logger.info(
                    'main',
                    'POINTS',
                    `今日可赚取 | 移动端: ${this.pointsCanCollect} | 浏览器: ${
                        browserEarnable.mobileSearchPoints
                    } | 应用: ${appEarnable?.totalEarnablePoints ?? 0} | ${accountEmail} | 区域设置: ${this.userData.geoLocale}`
                )

                if (isAccountStatusCheckOnly()) {
                    this.syncAccountCheckRunCheckpoint(
                        accountEmail,
                        data,
                        browserEarnable,
                        appEarnable,
                        initialSearchCounters
                    )
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
                let claimBalancePending = false
                const runPointTask = async (label: string, fn: () => Promise<void>): Promise<void> => {
                    const detailKey = taskDetailKey(label)
                    this.currentDetailTask = { key: detailKey, label, group: 'activity' }
                    updateAccountRunState(accountEmail, {
                        currentTask: label,
                        currentStage: 'activity',
                        currentMessage: `正在执行：${label}`
                    })
                    updateTaskDetail(accountEmail, {
                        key: detailKey,
                        label,
                        group: 'activity',
                        status: '进行中',
                        message: `正在执行：${label}`
                    })
                    const before = Number(this.userData.currentPoints ?? initialPoints)
                    try {
                        await fn()
                        const after = await getLatestPoints(before)
                        const gained = Math.max(0, after - before)
                        this.userData.currentPoints = after
                        dailyGainedPoints = Math.max(dailyGainedPoints, Math.max(0, after - initialPoints))
                        taskSummary.push({
                            key: 'daily',
                            label,
                            gained,
                            status: '已完成'
                        })
                        updateTaskDetail(accountEmail, {
                            key: detailKey,
                            label,
                            group: 'activity',
                            completed: gained,
                            total: gained,
                            gained,
                            status: '已完成',
                            message: gained > 0 ? `${label} +${gained}` : `${label} 已完成，未新增积分`
                        })
                        updateTaskProgress(accountEmail, 'daily', {
                            completed: dailyGainedPoints,
                            total: dailyGainedPoints,
                            gained: dailyGainedPoints,
                            status: gained > 0 ? `${label} +${gained}` : '进行中'
                        })
                        updateAccountPointTotals(accountEmail, { currentPoints: after, finalPoints: after })
                        this.safeEnsurePointRunCategoryMinimum(
                            accountEmail,
                            label,
                            pointCategoryFor(label),
                            gained,
                            after
                        )
                    } catch (error) {
                        const message = error instanceof Error ? error.message : String(error)
                        updateTaskDetail(accountEmail, {
                            key: detailKey,
                            label,
                            group: 'activity',
                            status: '失败',
                            message
                        })
                        throw error
                    } finally {
                        this.currentDetailTask = null
                    }
                }
                const runClaimBonusTask = async () => {
                    const label = '领取奖励积分'
                    const detailKey = taskDetailKey(label)
                    this.currentDetailTask = { key: detailKey, label, group: 'activity' }
                    updateAccountRunState(accountEmail, {
                        currentTask: label,
                        currentStage: 'activity',
                        currentMessage: `正在执行：${label}`
                    })
                    updateTaskDetail(accountEmail, {
                        key: detailKey,
                        label,
                        group: 'activity',
                        status: '进行中',
                        message: `正在执行：${label}`
                    })
                    try {
                        const outcome = await this.workers.doClaimBonusPoints(data)
                        if (outcome.status === 'verified') {
                            const gained = outcome.gainedPoints
                            this.userData.currentPoints = outcome.newBalance
                            dailyGainedPoints = Math.max(
                                dailyGainedPoints,
                                Math.max(0, outcome.newBalance - initialPoints)
                            )
                            taskSummary.push({ key: 'daily', label, gained, status: '已完成' })
                            updateTaskDetail(accountEmail, {
                                key: detailKey,
                                label,
                                group: 'activity',
                                completed: gained,
                                total: gained,
                                gained,
                                status: '已完成',
                                message: gained > 0 ? `${label} +${gained}` : `${label} 已完成，未新增积分`
                            })
                            updateAccountPointTotals(accountEmail, {
                                currentPoints: outcome.newBalance,
                                finalPoints: outcome.newBalance
                            })
                            this.safeEnsurePointRunCategoryMinimum(
                                accountEmail,
                                label,
                                pointCategoryFor(label),
                                gained,
                                outcome.newBalance
                            )
                        } else if (outcome.status === 'pending-verification') {
                            claimBalancePending = true
                            taskSummary.push({ key: 'daily', label, gained: 0, status: '积分待复核' })
                            updateTaskDetail(accountEmail, {
                                key: detailKey,
                                label,
                                group: 'activity',
                                status: '待复核',
                                message: '领取请求已完成，积分待复核'
                            })
                            updateTaskProgress(accountEmail, 'daily', {
                                completed: dailyGainedPoints,
                                total: dailyGainedPoints,
                                gained: dailyGainedPoints,
                                status: '积分待复核'
                            })
                        } else {
                            taskSummary.push({ key: 'daily', label, gained: 0, status: `已跳过：${outcome.reason}` })
                            updateTaskDetail(accountEmail, {
                                key: detailKey,
                                label,
                                group: 'activity',
                                status: '已跳过',
                                message: outcome.reason
                            })
                        }
                        return outcome
                    } catch (error) {
                        const message = error instanceof Error ? error.message : String(error)
                        updateTaskDetail(accountEmail, {
                            key: detailKey,
                            label,
                            group: 'activity',
                            status: '失败',
                            message
                        })
                        throw error
                    } finally {
                        this.currentDetailTask = null
                    }
                }
                const completeManualClaimBonusTask = async (): Promise<{
                    initialPoints: number
                    finalPoints: number | null
                    collectedPoints: number | null
                    taskSummary: AccountTaskSummary[]
                    partial?: boolean
                    partialReason?: string
                    balanceUnconfirmed?: boolean
                }> => {
                    this.logger.info('main', 'MANUAL-TASK', '手动任务：仅执行领取奖励积分')
                    const outcome = await runClaimBonusTask()
                    if (outcome.status === 'pending-verification') {
                        updateAccountRunState(accountEmail, {
                            currentTask: '立即领取奖励积分动作完成',
                            currentStage: 'balance-pending-verification',
                            currentMessage: '领取请求已完成，积分待复核'
                        })
                        this.logger.warn('main', 'MANUAL-TASK', '立即领取动作已完成，最终积分待复核')
                        return {
                            initialPoints,
                            finalPoints: null,
                            collectedPoints: null,
                            taskSummary,
                            partial: true,
                            partialReason: '领取请求已完成，积分待复核',
                            balanceUnconfirmed: true
                        }
                    }
                    const finalPoints =
                        outcome.status === 'verified'
                            ? outcome.newBalance
                            : await getLatestPoints(Number(this.userData.currentPoints ?? initialPoints))
                    const collectedPoints = Math.max(0, finalPoints - initialPoints)
                    this.userData.currentPoints = finalPoints
                    updateAccountPointTotals(accountEmail, {
                        currentPoints: finalPoints,
                        finalPoints
                    })
                    updateAccountRunState(accountEmail, {
                        currentTask: '立即领取奖励积分完成',
                        currentStage: 'done',
                        currentMessage: `本次运行增加 ${collectedPoints} 分`
                    })
                    updateTaskProgress(accountEmail, 'daily', {
                        completed: collectedPoints,
                        total: collectedPoints,
                        gained: collectedPoints,
                        status: '已完成'
                    })
                    this.logger.info(
                        'main',
                        'MANUAL-TASK',
                        `立即领取奖励积分完成 | 获得积分=${collectedPoints} | 初始=${initialPoints} | 当前=${finalPoints}`,
                        collectedPoints > 0 ? 'green' : 'yellow'
                    )
                    return {
                        initialPoints,
                        finalPoints,
                        collectedPoints,
                        taskSummary
                    }
                }
                const skipAppTask = (label: string, reason: string): void => {
                    const detailKey = taskDetailKey(label)
                    taskSummary.push({
                        key: 'daily',
                        label,
                        gained: 0,
                        status: `已跳过：${reason}`
                    })
                    updateTaskDetail(accountEmail, {
                        key: detailKey,
                        label,
                        group: 'activity',
                        completed: 0,
                        total: 0,
                        gained: 0,
                        status: '已跳过',
                        message: reason
                    })
                    this.logger.warn('main', 'FLOW', `${label}已跳过：${reason}，后续搜索继续执行`)
                }
                const skipDashboardFieldTask = (
                    label: string,
                    fields: (keyof DashboardFieldAvailability)[]
                ): boolean => {
                    const unavailable = fields.filter(field => data.dashboardFieldAvailability[field] !== 'available')
                    if (unavailable.length === 0) return false

                    const reason = unavailable
                        .map(field => `${field}=${data.dashboardFieldAvailability[field]}`)
                        .join(',')
                    const detailKey = taskDetailKey(label)
                    taskSummary.push({
                        key: 'daily',
                        label,
                        gained: 0,
                        status: `已跳过：dashboard 字段不可用（${reason}）`
                    })
                    updateTaskDetail(accountEmail, {
                        key: detailKey,
                        label,
                        group: 'activity',
                        completed: 0,
                        total: 0,
                        gained: 0,
                        status: '已跳过',
                        message: `dashboard 字段不可用（${reason}）`
                    })
                    this.logger.warn('main', 'FLOW', `${label}已跳过：dashboard 字段不可用 | ${reason}`)
                    return true
                }

                if (currentRunOptions().manualTask === 'claim-bonus-points') {
                    return await completeManualClaimBonusTask()
                }

                // Ensure streak protection is true if enabled
                if (this.config.ensureStreakProtection) {
                    await runPointTask('连击保护', async () => this.activities.doStreakProtection())
                }
                if (this.config.workers.doClaimBonusPoints) {
                    await runClaimBonusTask()
                }
                if (this.config.workers.doAppPromotions && appData && hasKnownGeoLocale) {
                    await runPointTask('App 活动', async () => this.workers.doAppPromotions(appData))
                } else if (this.config.workers.doAppPromotions) {
                    skipAppTask(
                        'App 活动',
                        !hasKnownGeoLocale
                            ? 'dashboard 未提供有效地区'
                            : hasAppAccessToken
                              ? 'App仪表盘不可用'
                              : 'App访问令牌不可用'
                    )
                }
                if (this.config.workers.doDailySet) {
                    if (!skipDashboardFieldTask('每日任务', ['dailySetPromotions'])) {
                        await runPointTask('每日任务', async () => this.workers.doDailySet(data, this.mainMobilePage))
                    }
                }
                if (this.config.workers.doSpecialPromotions) {
                    if (!skipDashboardFieldTask('特殊活动', ['promotionalItems'])) {
                        await runPointTask('特殊活动', async () => this.workers.doSpecialPromotions(data))
                    }
                }
                if (this.config.workers.doMorePromotions) {
                    if (
                        !skipDashboardFieldTask('更多推广', ['morePromotions', 'morePromotionsWithoutPromotionalItems'])
                    ) {
                        await runPointTask('更多推广', async () =>
                            this.workers.doMorePromotions(data, this.mainMobilePage)
                        )
                    }
                }
                if (this.config.workers.doDailyCheckIn && hasAppAccessToken && hasKnownGeoLocale) {
                    await runPointTask('每日签到', async () => this.activities.doDailyCheckIn())
                } else if (this.config.workers.doDailyCheckIn) {
                    skipAppTask('每日签到', hasKnownGeoLocale ? 'App访问令牌不可用' : 'dashboard 未提供有效地区')
                }
                if (this.config.workers.doReadToEarn && hasAppAccessToken && hasKnownGeoLocale) {
                    await runPointTask('阅读赚取', async () => this.activities.doReadToEarn())
                } else if (this.config.workers.doReadToEarn) {
                    skipAppTask('阅读赚取', hasKnownGeoLocale ? 'App访问令牌不可用' : 'dashboard 未提供有效地区')
                }
                if (this.config.workers.doPunchCards) {
                    if (!skipDashboardFieldTask('打卡活动', ['punchCards'])) {
                        await runPointTask('打卡活动', async () => this.workers.doPunchCards(data, this.mainMobilePage))
                    }
                }

                const searchPoints = await this.browser.func.getSearchPoints()
                let missingSearchPoints = this.browser.func.missingSearchPoints(searchPoints, true)
                const unrecognizedCounter = (status: string): boolean =>
                    ['missing-counter', 'empty-counter', 'invalid-counter'].includes(status)
                const needsMobileFallback = unrecognizedCounter(missingSearchPoints.mobileStatus)
                const needsDesktopFallback = unrecognizedCounter(missingSearchPoints.desktopCounter.status)
                if (needsMobileFallback || (this.config.workers.doDesktopSearch && needsDesktopFallback)) {
                    this.logger.warn(
                        'main',
                        'SEARCH-COUNTER',
                        `搜索 counter 未确认，尝试 fallback | mobile=${missingSearchPoints.mobileStatus} | desktop=${missingSearchPoints.desktopCounter.status} | keys=${missingSearchPoints.counterKeys.join(',') || 'none'}`
                    )
                    const fallbackSearchPoints = await this.browser.func.getSearchPointsFallback(true)
                    if (fallbackSearchPoints) {
                        const fallbackMobileKnown = !unrecognizedCounter(fallbackSearchPoints.mobileStatus)
                        const fallbackDesktopKnown = !unrecognizedCounter(fallbackSearchPoints.desktopCounter.status)
                        missingSearchPoints = {
                            ...missingSearchPoints,
                            ...(needsMobileFallback && fallbackMobileKnown
                                ? {
                                      mobilePoints: fallbackSearchPoints.mobilePoints,
                                      mobileDetected: fallbackSearchPoints.mobileDetected,
                                      mobileStatus: fallbackSearchPoints.mobileStatus,
                                      mobileMessage: fallbackSearchPoints.mobileMessage,
                                      mobileCounter: fallbackSearchPoints.mobileCounter
                                  }
                                : {}),
                            ...(needsDesktopFallback && fallbackDesktopKnown
                                ? {
                                      desktopPoints: fallbackSearchPoints.desktopPoints,
                                      edgePoints: fallbackSearchPoints.edgePoints,
                                      desktopCounter: fallbackSearchPoints.desktopCounter,
                                      edgeCounter: fallbackSearchPoints.edgeCounter
                                  }
                                : {}),
                            source: fallbackSearchPoints.source,
                            counterKeys:
                                fallbackSearchPoints.counterKeys.length > 0
                                    ? fallbackSearchPoints.counterKeys
                                    : missingSearchPoints.counterKeys
                        }
                        this.logger.info(
                            'main',
                            'SEARCH-COUNTER',
                            `fallback 结果 | source=${fallbackSearchPoints.source} | mobile=${fallbackSearchPoints.mobileStatus} | desktop=${fallbackSearchPoints.desktopCounter.status}`
                        )
                    } else {
                        this.logger.warn('main', 'SEARCH-COUNTER', 'fallback 未找到可用搜索 counter')
                    }
                }
                if (
                    this.config.workers.doDesktopSearch &&
                    unrecognizedCounter(missingSearchPoints.desktopCounter.status)
                ) {
                    const message = `PC搜索额度未确认：${missingSearchPoints.desktopCounter.message}`
                    const progress = updateSearchTaskFailure(accountEmail, 'desktop', {
                        completed: initialDesktopCompleted,
                        total: initialDesktopTotal,
                        message
                    })
                    throw new SearchTaskError(
                        'dashboard-search-counter',
                        'desktop',
                        message,
                        progress.completed,
                        progress.total
                    )
                }
                const searchStartPoints = await getLatestPoints(Number(this.userData.currentPoints ?? initialPoints))
                this.userData.currentPoints = searchStartPoints
                updateAccountPointTotals(accountEmail, {
                    currentPoints: searchStartPoints,
                    finalPoints: searchStartPoints
                })

                this.cookies.mobile = await initialContext.cookies()
                const mobileSearchMessage = ['missing-counter', 'empty-counter', 'invalid-counter'].includes(
                    missingSearchPoints.mobileStatus
                )
                    ? `移动搜索额度未识别：${missingSearchPoints.mobileMessage}`
                    : `移动剩余 ${missingSearchPoints.mobilePoints}`

                updateAccountRunState(accountEmail, {
                    currentTask: '搜索任务',
                    currentStage: 'search',
                    currentMessage: `准备搜索：${mobileSearchMessage}，PC剩余 ${
                        missingSearchPoints.desktopPoints + missingSearchPoints.edgePoints
                    }`
                })
                const { mobilePoints, desktopPoints } = await this.searchManager.doSearches(
                    data,
                    missingSearchPoints,
                    activeMobileSession,
                    account,
                    accountEmail
                )

                mobileContextClosed = true

                const finalPointsSnapshot = await this.browser.func.getCurrentPointsSnapshot()
                if (finalPointsSnapshot.confidence !== 'confirmed' || finalPointsSnapshot.points === null) {
                    const details = finalPointsSnapshot.error
                    if (!claimBalancePending) {
                        throw new DashboardFetchError({
                            apiStatus: details?.apiStatus,
                            apiReason: details?.apiReason ?? '最终积分读取未确认',
                            fallbackReason: details?.fallbackReason ?? '账号收口未取得本次确认的积分',
                            apiFailureKind: details?.apiFailureKind ?? 'invalid-response',
                            attempts: details?.attempts,
                            elapsedMs: details?.elapsedMs
                        })
                    }

                    updateAccountRunState(accountEmail, {
                        currentTask: '账号任务动作完成',
                        currentStage: 'balance-pending-verification',
                        currentMessage: '任务动作已完成，最终积分待复核'
                    })
                    updateTaskProgress(accountEmail, 'daily', {
                        completed: dailyGainedPoints,
                        total: dailyGainedPoints,
                        gained: dailyGainedPoints,
                        status: '积分待复核'
                    })
                    this.logger.warn(
                        'main',
                        'FLOW',
                        `账号任务动作已完成，最终积分待复核 | status=${details?.apiStatus ?? 'n/a'} | attempts=${details?.attempts ?? 0}`
                    )
                    return {
                        initialPoints,
                        finalPoints: null,
                        collectedPoints: null,
                        taskSummary,
                        partial: true,
                        partialReason: '任务动作已完成，最终积分待复核',
                        balanceUnconfirmed: true
                    }
                }
                const finalPoints = finalPointsSnapshot.points
                if (claimBalancePending) {
                    const claimSummary = taskSummary.find(item => item.label === '领取奖励积分')
                    if (claimSummary) claimSummary.status = '后续余额已确认'
                    updateTaskDetail(accountEmail, {
                        key: taskDetailKey('领取奖励积分'),
                        label: '领取奖励积分',
                        group: 'activity',
                        status: '已完成',
                        message: '领取动作已完成，账号收口时余额已确认'
                    })
                }
                const collectedPoints = Math.max(0, finalPoints - initialPoints)
                const searchGainedPoints = Math.max(0, finalPoints - searchStartPoints)
                dailyGainedPoints = Math.max(dailyGainedPoints, Math.max(0, searchStartPoints - initialPoints))
                const estimatedSearchPoints = Math.max(0, mobilePoints) + Math.max(0, desktopPoints)
                let mobileGainedPoints = 0
                let desktopGainedPoints = 0
                let otherGainedPoints = 0
                if (searchGainedPoints > 0 && estimatedSearchPoints > 0) {
                    mobileGainedPoints = Math.round(
                        (searchGainedPoints * Math.max(0, mobilePoints)) / estimatedSearchPoints
                    )
                    desktopGainedPoints = searchGainedPoints - mobileGainedPoints
                } else if (searchGainedPoints > 0 && mobilePoints > 0) {
                    mobileGainedPoints = searchGainedPoints
                } else if (searchGainedPoints > 0 && desktopPoints > 0) {
                    desktopGainedPoints = searchGainedPoints
                } else {
                    otherGainedPoints = searchGainedPoints
                }
                this.safeEnsurePointRunCategoryMinimum(
                    accountEmail,
                    '移动搜索',
                    'mobileSearch',
                    mobileGainedPoints,
                    finalPoints
                )
                this.safeEnsurePointRunCategoryMinimum(
                    accountEmail,
                    'PC搜索',
                    'pcSearch',
                    desktopGainedPoints,
                    finalPoints
                )
                this.safeEnsurePointRunCategoryMinimum(
                    accountEmail,
                    '其他积分变化',
                    'other',
                    otherGainedPoints,
                    finalPoints
                )

                const finalSearchPoints = await this.browser.func.getSearchPoints().catch(() => searchPoints)
                const finalSearchCounters = this.browser.func.missingSearchPoints(finalSearchPoints, true)
                const finalMobileSearch = finalSearchCounters.mobileCounter
                const finalMobileUnrecognized = ['missing-counter', 'empty-counter', 'invalid-counter'].includes(
                    finalSearchCounters.mobileStatus
                )
                const finalPcUnrecognized = ['missing-counter', 'empty-counter', 'invalid-counter'].includes(
                    finalSearchCounters.desktopCounter.status
                )
                const finalMobileTotal = finalMobileSearch.total || initialMobileSearch.total || 0
                const finalPcTotal =
                    finalSearchCounters.desktopCounter.total + finalSearchCounters.edgeCounter.total ||
                    initialDesktopTotal
                const finalMobileCompleted = Math.max(
                    finalMobileSearch.completed || initialMobileProgress,
                    finalMobileTotal > 0 ? Math.min(finalMobileTotal, mobileGainedPoints) : mobileGainedPoints
                )
                const finalPcCompleted = Math.max(
                    finalSearchCounters.desktopCounter.completed + finalSearchCounters.edgeCounter.completed ||
                        initialDesktopCompleted,
                    finalPcTotal > 0 ? Math.min(finalPcTotal, desktopGainedPoints) : desktopGainedPoints
                )
                const finalMobileStatus = finalMobileUnrecognized
                    ? '未识别到搜索额度'
                    : finalMobileTotal > 0 && finalMobileCompleted < finalMobileTotal
                      ? '进行中'
                      : '已完成'
                const finalPcStatus = finalPcUnrecognized
                    ? '未识别到搜索额度'
                    : finalPcTotal > 0 && finalPcCompleted < finalPcTotal
                      ? '进行中'
                      : '已完成'
                updateAccountTaskProgress(accountEmail, {
                    mobile: {
                        completed: finalMobileCompleted,
                        total: finalMobileTotal,
                        gained: mobileGainedPoints,
                        status: finalMobileStatus
                    },
                    desktop: {
                        completed: finalPcCompleted,
                        total: finalPcTotal,
                        gained: desktopGainedPoints,
                        status: finalPcStatus
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
                    completed: finalMobileCompleted,
                    total: finalMobileTotal,
                    gained: mobileGainedPoints,
                    status: finalMobileStatus
                })
                taskSummary.push({
                    key: 'desktop',
                    label: 'PC 搜索',
                    completed: finalPcCompleted,
                    total: finalPcTotal,
                    gained: desktopGainedPoints,
                    status: finalPcStatus
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
                updateAccountRunState(accountEmail, {
                    currentTask: '账号任务完成',
                    currentStage: 'done',
                    currentMessage: `本次运行增加 ${collectedPoints} 分`
                })

                this.logger.info(
                    'main',
                    'FLOW',
                    `已收集: +${collectedPoints} | 日常: +${dailyGainedPoints} | 移动端: +${mobileGainedPoints} | 桌面端: +${desktopGainedPoints} | ${accountEmail}`
                )

                await this.runGiftCardMonitor(accountEmail, finalPoints)

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
        markFormalRunInterrupted('收到 SIGINT，任务中断，等待续跑')
        await flushAllWebhooks()
        process.exit(130)
    })
    process.on('SIGTERM', async () => {
        rewardsBot.logger.warn('main', 'PROCESS', '收到 SIGTERM 信号，正在刷新并退出...')
        markFormalRunInterrupted('收到 SIGTERM，任务中断，等待续跑')
        await flushAllWebhooks()
        process.exit(143)
    })
    process.on('uncaughtException', async error => {
        rewardsBot.logger.error('main', 'UNCAUGHT-EXCEPTION', error)
        markFormalRunInterrupted('未捕获异常，任务中断，等待续跑')
        await flushAllWebhooks()
        process.exit(1)
    })
    process.on('unhandledRejection', async reason => {
        rewardsBot.logger.error('main', 'UNHANDLED-REJECTION', reason as Error)
        markFormalRunInterrupted('未处理 Promise 异常，任务中断，等待续跑')
        await flushAllWebhooks()
        process.exit(1)
    })

    try {
        await rewardsBot.initialize()
        await rewardsBot.run()
    } catch (error) {
        rewardsBot.logger.error('main', 'MAIN-ERROR', error as Error)
        markFormalRunInterrupted('主流程异常，任务中断，等待续跑')
    }
}

main().catch(async error => {
    const tmpBot = new MicrosoftRewardsBot()
    tmpBot.logger.error('main', 'MAIN-ERROR', error as Error)
    markFormalRunInterrupted('主流程异常，任务中断，等待续跑')
    await flushAllWebhooks()
    process.exit(1)
})
