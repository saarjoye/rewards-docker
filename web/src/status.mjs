import { sanitizeText } from './security.mjs'

const CORE_STATES = {
    idle: '空闲',
    starting: '正在启动',
    running: '运行中',
    stopping: '正在停止'
}

export const LEVEL_LABELS = { debug: '调试', info: '信息', warn: '警告', error: '错误' }
export const PLATFORM_LABELS = { MAIN: '主流程', MOBILE: '移动端', DESKTOP: '桌面端' }
export const TITLE_LABELS = {
    CONTROLLER: '运行控制',
    'RUN-START': '任务启动',
    'RUN-END': '任务结束',
    'ACCOUNT-START': '账号开始',
    'ACCOUNT-END': '账号完成',
    'ACCOUNT-ERROR': '账号失败',
    'ACCOUNT-DELAY': '账号间隔',
    POINTS: '积分额度',
    FLOW: '任务流程',
    'SEARCH-MANAGER': '搜索任务',
    'SEARCH-BING': 'Bing 搜索',
    'SEARCH-BONUS': '奖励搜索',
    'READ-TO-EARN': '阅读任务',
    'DAILY-CHECK-IN': '每日签到',
    'CLAIM-BONUS-POINTS': '领取奖励',
    'CLAIM-REWARD': '领取活动奖励',
    'URL-REWARD': '每日活动',
    'APP-REWARD': '应用任务',
    PUNCHCARD: '打卡任务',
    'SEARCH-ON-BING-SEARCH': 'Bing 活动搜索'
}

const SOURCE_LABELS = {
    search: '搜索',
    bonus: '奖励搜索',
    read: '阅读',
    checkIn: '签到',
    claimBonus: '奖励领取',
    claimReward: '活动奖励',
    urlReward: '每日活动',
    visualSearch: '视觉搜索',
    appReward: '应用任务',
    punchcard: '打卡任务',
    searchOnBing: 'Bing 活动搜索',
    other: '其他'
}

function finiteOrNull(value) {
    if (value === null || value === undefined || value === '') return null
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
}

function publicLastExit(lastExit) {
    if (!lastExit || typeof lastExit !== 'object') return null
    return {
        code: finiteOrNull(lastExit.code),
        signal: typeof lastExit.signal === 'string' ? sanitizeText(lastExit.signal, 40) : null,
        at: typeof lastExit.at === 'string' ? lastExit.at : null,
        error: lastExit.error ? sanitizeText(lastExit.error, 500) : null
    }
}

function accountState({ coreState, account, currentEmail, hasRun }) {
    if (!hasRun) return { state: 'not-run', label: '未运行', message: '暂无运行记录' }
    if (account?.success === true) return { state: 'completed', label: '已完成', message: '本次账号任务已完成' }
    if (account?.success === false) {
        return { state: 'failed', label: '失败', message: sanitizeText(account.error || '账号任务失败', 500) }
    }
    if (coreState !== 'idle' && account?.email && account.email === currentEmail) {
        return { state: 'running', label: '运行中', message: '正在处理此账号' }
    }
    if (coreState !== 'idle') return { state: 'waiting', label: '等待执行', message: '串行队列中等待' }
    return { state: 'unknown', label: '待确认', message: '最近运行未提供最终账号状态' }
}

function pointsView(account) {
    const source = account?.live?.bySource ?? account?.bySource ?? {}
    const bySource = Object.entries(source)
        .filter(([, value]) => finiteOrNull(value) !== null)
        .map(([key, value]) => ({ key, label: SOURCE_LABELS[key] ?? key, points: finiteOrNull(value) }))
    return {
        initial: finiteOrNull(account?.initialPoints),
        balance: finiteOrNull(account?.live?.balance ?? account?.balance ?? account?.finalPoints),
        collected: finiteOrNull(account?.collectedPoints ?? account?.collected ?? account?.live?.gained),
        bySource
    }
}

function earnableView(earnable) {
    return {
        mobile: finiteOrNull(earnable?.mobile),
        desktop: finiteOrNull(earnable?.browser),
        app: finiteOrNull(earnable?.app)
    }
}

export function buildPublicState({ status, points, configuredAccounts, identity, historySummary, notificationStatus }) {
    if (!status) {
        return {
            core: { available: false, state: 'offline', label: '核心离线', version: null, lastExit: null },
            run: null,
            accounts: [],
            history: historySummary,
            notifications: notificationStatus,
            updatedAt: new Date().toISOString()
        }
    }

    const coreState = CORE_STATES[status.state] ? status.state : 'unknown'
    const run = status.run ?? {}
    const pointAccounts = new Map(
        (points?.accounts ?? []).map(account => [String(account.email).toLowerCase(), account])
    )
    const runAccounts = new Map((run.accounts ?? []).map(account => [String(account.email).toLowerCase(), account]))
    const currentEmail = String(points?.currentAccount ?? run.live?.currentAccount ?? '').toLowerCase()
    const hasRun = Boolean(run.version || run.accountsSeen || run.finished || status.lastExit)

    const accounts = (configuredAccounts?.accounts ?? []).map(configured => {
        const email = String(configured.email ?? '')
        const key = email.toLowerCase()
        const runAccount = runAccounts.get(key) ?? pointAccounts.get(key) ?? null
        return {
            id: identity.keyFor(email),
            index: Number(configured.index),
            label: identity.labelFor(email),
            geoLocale: sanitizeText(runAccount?.geoLocale ?? configured.geoLocale ?? 'auto', 20),
            langCode: sanitizeText(runAccount?.locale ?? configured.langCode ?? '-', 30),
            hasRecoveryEmail: Boolean(configured.hasRecoveryEmail),
            hasTotp: Boolean(configured.hasTotp),
            hasProxy: Boolean(configured.proxy?.url),
            status: accountState({ coreState: status.state, account: runAccount, currentEmail, hasRun }),
            points: pointsView(runAccount),
            earnable: earnableView(runAccount?.earnable),
            error: runAccount?.error ? sanitizeText(runAccount.error, 500) : null
        }
    })

    const currentConfigured = (configuredAccounts?.accounts ?? []).find(
        account => String(account.email).toLowerCase() === currentEmail
    )
    return {
        core: {
            available: true,
            state: coreState,
            label: CORE_STATES[coreState] ?? `未知状态（${sanitizeText(status.state, 40)}）`,
            version: sanitizeText(status.version ?? '', 40) || null,
            startedAt: status.startedAt ?? null,
            lastExit: publicLastExit(status.lastExit),
            logCount: finiteOrNull(status.logCount),
            latestLogId: finiteOrNull(status.latestLogId)
        },
        run: {
            running: ['starting', 'running', 'stopping'].includes(status.state),
            finished: Boolean(run.finished),
            startedAt: status.startedAt ?? null,
            currentAccount: currentConfigured ? identity.labelFor(currentConfigured.email) : null,
            collected: finiteOrNull(points?.collected ?? run.collected),
            currentBalance: finiteOrNull(points?.balance ?? run.live?.currentBalance),
            accountsTotal: finiteOrNull(run.accountsTotal ?? points?.accountsTotal),
            accountsSeen: finiteOrNull(run.accountsSeen ?? points?.accountsSeen),
            pendingDelaySeconds: finiteOrNull(run.pendingDelay?.seconds),
            updatedAt: points?.updatedAt ?? run.live?.updatedAt ?? null
        },
        accounts,
        history: historySummary,
        notifications: notificationStatus,
        updatedAt: new Date().toISOString()
    }
}

export function publicLog(entry) {
    return {
        ...entry,
        levelLabel: LEVEL_LABELS[entry.level] ?? entry.level,
        platformLabel: PLATFORM_LABELS[entry.platform] ?? entry.platform ?? '系统',
        titleLabel: TITLE_LABELS[entry.title] ?? entry.title ?? '运行日志'
    }
}

export function publicErrorMessage(error) {
    const codes = {
        ALREADY_RUNNING: '已有任务正在运行',
        NOT_RUNNING: '当前没有正在运行的任务',
        CONTROL_TIMEOUT: '核心接口请求超时',
        CONTROL_UNAVAILABLE: '核心接口不可用',
        CONTROL_HTTP_ERROR: '核心接口请求失败'
    }
    return codes[error?.code] ?? sanitizeText(error?.message || '请求失败', 500)
}
