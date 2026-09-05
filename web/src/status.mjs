import { sanitizeLog, sanitizeText } from './security.mjs'

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
    LOGIN: '账号登录',
    'LOGIN-RETRY': '重新登录',
    'LOGIN-BING': 'Bing 登录验证',
    'LOGIN-ENTER-EMAIL': '填写登录邮箱',
    'LOGIN-ENTER-PASSWORD': '填写登录密码',
    'LOGIN-PASSWORDLESS': '无密码登录',
    'LOGIN-TOTP': '动态验证码验证',
    'LOGIN-CODE': '邮箱验证码验证',
    'LOGIN-APP': '移动应用登录',
    'HANDLE-STATE': '登录状态识别',
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
    'SEARCH-ON-BING-SEARCH': 'Bing 活动搜索',
    'TASK-SNAPSHOT': '当日任务清单'
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

function tasksView(tasks) {
    if (!Array.isArray(tasks)) return []
    return tasks.slice(0, 500).map(task => ({
        id: sanitizeText(task?.id ?? '', 180),
        title: sanitizeText(task?.title ?? 'Rewards 任务', 180),
        status: ['pending', 'running', 'completed', 'failed', 'skipped', 'locked'].includes(task?.status)
            ? task.status
            : 'pending',
        progress:
            finiteOrNull(task?.progress?.current) !== null && finiteOrNull(task?.progress?.total) !== null
                ? { current: finiteOrNull(task.progress.current), total: finiteOrNull(task.progress.total) }
                : null,
        expectedPoints: finiteOrNull(task?.expectedPoints),
        earnedPoints: finiteOrNull(task?.earnedPoints),
        updatedAt: typeof task?.updatedAt === 'string' ? task.updatedAt : null
    }))
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
            tasks: tasksView(runAccount?.tasks),
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
            latestLogId: finiteOrNull(status.latestLogId),
            runId: typeof status.runId === 'string' ? sanitizeText(status.runId, 100) : null
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
        history: {
            ...historySummary,
            todayCollected:
                Number(historySummary?.todayCollected || 0) +
                (status.state === 'idle' ? 0 : finiteOrNull(points?.collected ?? run.collected) || 0)
        },
        notifications: notificationStatus,
        updatedAt: new Date().toISOString()
    }
}

export function publicLog(entry) {
    const safeEntry = sanitizeLog(entry)
    const titleLabel = TITLE_LABELS[safeEntry.title] ?? '运行步骤'
    return {
        ...safeEntry,
        levelLabel: LEVEL_LABELS[safeEntry.level] ?? safeEntry.level,
        platformLabel: PLATFORM_LABELS[safeEntry.platform] ?? safeEntry.platform ?? '系统',
        titleLabel,
        displayMessage: translateLogMessage(safeEntry, titleLabel)
    }
}

function numeric(message, key) {
    const match = String(message).match(new RegExp(`(?:^| \\| )${key}=(-?\\d+(?:\\.\\d+)?)(?= \\| |$)`))
    return match ? Number(match[1]) : null
}

function loginFailureReason(value) {
    const reason = String(value ?? '').trim()
    if (!reason || /^Unknown Error$/i.test(reason) || reason === '登录页面未返回可识别的错误原因') {
        return '登录页面未返回可识别的错误原因'
    }
    return sanitizeText(reason, 500)
}

export function translateLogMessage(entry, titleLabel = TITLE_LABELS[entry?.title] ?? '运行任务') {
    const message = sanitizeText(entry?.message ?? '', 8000)
    if (entry?.title === 'LOGIN-RETRY') return message
    if (entry?.title === 'TASK-SNAPSHOT') {
        try {
            const count = JSON.parse(message)?.tasks?.length
            return Number.isSafeInteger(count) ? `已读取当日任务列表，共 ${count} 项` : '已读取当日任务列表'
        } catch {
            return '当日任务列表读取完成'
        }
    }
    if (entry?.title === 'RUN-START') {
        const accounts = message.match(/Accounts: (\d+)/)?.[1]
        return accounts ? `任务已启动，共 ${accounts} 个账号` : '任务已启动'
    }
    if (entry?.title === 'RUN-END') {
        const points = numeric(message, 'pointsGained')
        return points === null ? '全部账号处理结束' : `全部账号处理结束，本次获得 ${points} 分`
    }
    if (entry?.title === 'ACCOUNT-START')
        return `开始处理 ${message.match(/^Starting account: ([^|]+)/)?.[1]?.trim() || '当前账号'}`
    if (entry?.title === 'ACCOUNT-END') {
        const points = numeric(message, 'pointsGained')
        return points === null ? '当前账号处理完成' : `当前账号处理完成，本次获得 ${points} 分`
    }
    if (entry?.title === 'ACCOUNT-DELAY') {
        const seconds = message.match(/^Waiting ([\d.]+) seconds/)?.[1]
        return seconds ? `等待 ${seconds} 秒后处理下一个账号` : '正在等待下一个账号'
    }
    if (entry?.title === 'POINTS') {
        const match = message.match(/Mobile: (\d+) \| Browser: (\d+) \| App: (\d+)/)
        return match
            ? `今日可得：移动搜索 ${match[1]} 分，桌面搜索 ${match[2]} 分，应用任务 ${match[3]} 分`
            : '已读取今日积分额度'
    }
    if (entry?.title === 'CONTROLLER') {
        if (message.startsWith('Starting run:')) return '正在启动任务进程'
        if (message.startsWith('Run started')) return '任务进程已启动'
        if (message.startsWith('Run finished')) return '任务进程已结束'
        if (message.startsWith('Stopping run')) return '正在停止任务进程'
        if (message.startsWith('Force-stopping run')) return '正在强制停止任务进程'
    }
    if (entry?.title === 'LOGIN') {
        const accountError = message.match(/^Account error:\s*(.*)$/i)
        if (accountError) return `账号登录失败：${loginFailureReason(accountError[1])}`
        const fatalError = message.match(/^Fatal error:\s*(?:Microsoft login error:\s*)?(.*)$/i)
        if (fatalError) return `账号登录失败：${loginFailureReason(fatalError[1])}`
    }
    if (entry?.title === 'FLOW') {
        const flowError = message.match(
            /^(Mobile|Desktop) flow failed for [^:]+:\s*(?:Microsoft login error:\s*)?(.*)$/i
        )
        if (flowError) {
            return `${flowError[1].toLowerCase() === 'mobile' ? '移动端' : '桌面端'}账号流程失败：${loginFailureReason(flowError[2])}`
        }
    }

    const points = numeric(message, 'pointsGained')
    const suffix = points === null ? '' : `，获得 ${points} 分`
    if (
        /^(Completed|Finished|Reward claimed|Nothing claimed)|already (?:been )?completed|already complete/i.test(
            message
        )
    ) {
        return `${titleLabel}已完成${suffix}`
    }
    if (/^(Starting|Started)/i.test(message)) return `正在执行${titleLabel}`
    if (/^(Skipping|Skip )/i.test(message)) return `${titleLabel}已跳过`
    if (entry?.level === 'error' || /failed|failure/i.test(message)) return `${titleLabel}执行失败，请展开诊断详情`
    if (entry?.level === 'warn') return `${titleLabel}出现警告，请展开诊断详情`
    if (points !== null) return `${titleLabel}进度已更新${suffix}`
    return `${titleLabel}正在处理`
}

export function publicErrorMessage(error) {
    const codes = {
        ALREADY_RUNNING: '已有任务正在运行',
        NOT_RUNNING: '当前没有正在运行的任务',
        CONTROL_TIMEOUT: '核心接口请求超时',
        CONTROL_UNAVAILABLE: '核心接口不可用',
        CONTROL_HTTP_ERROR: '核心接口请求失败',
        RUN_ACTIVE: '任务运行期间不能修改账号',
        ACCOUNT_NOT_FOUND: '账号不存在',
        DUPLICATE_ACCOUNT: '该账号已存在',
        MIGRATION_REQUIRED: '请先迁移环境变量中的旧账号',
        ALREADY_MIGRATED: '账号已经迁移到加密账号库',
        NO_ENV_ACCOUNTS: '没有可迁移的环境账号',
        NO_ACCOUNTS: '尚未配置账号'
    }
    return codes[error?.code] ?? sanitizeText(error?.message || '请求失败', 500)
}
