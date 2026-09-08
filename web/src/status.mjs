import { sanitizeLog, sanitizeText } from './security.mjs'
import { normalizedTasks, currentTasks } from './task-view.mjs'

const CORE_STATES = {
    idle: '空闲',
    starting: '正在启动',
    running: '运行中',
    stopping: '正在停止'
}

export const LEVEL_LABELS = { debug: '调试', info: '信息', warn: '警告', error: '错误' }
export const PLATFORM_LABELS = { MAIN: '主流程', MOBILE: '移动端', DESKTOP: '桌面端' }
export const TITLE_LABELS = {
    'COOKIE-SYNC': '同步登录会话',
    'SEARCH-COOKIE-SEED': '准备搜索会话',
    'SEARCH-COOKIE-CAPTURE': '更新搜索会话',
    'SEARCH-CLOSE-TABS': '清理搜索标签页',
    'GHOST-CLICK': '点击页面元素',
    CONTROLLER: '运行控制',
    'TASK-EVENT': '任务进展',
    'DETECT-STATE': '登录状态检测',
    BROWSER: '浏览器操作',
    'GET-DASHBOARD-DATA': '读取任务数据',
    'GET-CURRENT-POINTS': '核对账号余额',
    'REACT-PARSE': '解析网页任务',
    'EDGE-BROWSING': 'Edge 浏览任务',
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
    accountBalance: '余额变化',
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
    if (account?.telemetryVersion === 2 && account?.status) {
        const labels = {
            completed: '已完成',
            partial: '部分完成',
            failed: '失败',
            interrupted: '已中断',
            unknown: '待确认',
            running: '运行中'
        }
        return {
            state: account.status,
            label: labels[account.status] ?? '待确认',
            message: account.pendingVerification
                ? `仍有 ${account.pendingVerification} 项积分待复核`
                : (labels[account.status] ?? '待确认')
        }
    }
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

function pointsView(account, historical = null) {
    const source = account?.live?.bySource ?? account?.bySource ?? {}
    const bySource = Object.entries(source)
        .filter(([, value]) => finiteOrNull(value) !== null)
        .map(([key, value]) => ({ key, label: SOURCE_LABELS[key] ?? key, points: finiteOrNull(value) }))
    return {
        verification: account?.telemetryVersion === 2 ? 'tracked' : 'legacy',
        pendingVerification: account?.pendingVerification ?? null,
        balanceChange: finiteOrNull(account?.balanceChange),
        unattributedBalanceChange: finiteOrNull(account?.unattributedBalanceChange),
        initial: finiteOrNull(account?.initialPoints),
        balance: finiteOrNull(
            Object.hasOwn(account?.live || {}, 'balance')
                ? account.live.balance
                : (account?.balance ?? account?.finalPoints)
        ),
        collected: finiteOrNull(historical?.confirmedPoints),
        runBalanceDelta: finiteOrNull(historical?.runBalanceDelta),
        liveRunBalanceDelta: finiteOrNull(historical?.liveRunBalanceDelta),
        liveDailyBalanceDelta: finiteOrNull(historical?.liveDailyBalanceDelta),
        runBalanceVerification: historical?.runBalanceVerification ?? 'pending',
        balanceVerification: historical?.balanceVerification ?? 'pending',
        observedAt: historical?.observedAt ?? null,
        businessDate: historical?.businessDate ?? null,
        dailyBalanceDelta: finiteOrNull(historical?.dailyBalanceDelta),
        reportedTaskPoints: finiteOrNull(historical?.reportedTaskPoints),
        overreportedPoints: finiteOrNull(historical?.overreportedPoints),
        unattributedBalanceDelta: finiteOrNull(historical?.unattributedBalanceDelta),
        statisticsDate: historical?.date ?? null,
        timeZone: 'Asia/Shanghai',
        legacyUnverified: historical?.legacyUnverified ?? true,
        interrupted: historical?.interrupted ?? false,
        runGained: finiteOrNull(historical?.runGained),
        todayGained: finiteOrNull(historical?.todayGained),
        confirmedPoints: finiteOrNull(historical?.confirmedPoints),
        unattributedPoints: finiteOrNull(historical?.unattributedPoints),
        pendingPoints: finiteOrNull(historical?.pendingPoints),
        pendingTaskCount: finiteOrNull(historical?.pendingTaskCount ?? account?.pendingVerification),
        balanceDelta: finiteOrNull(historical?.balanceDelta),
        balanceReconciliation: historical?.balanceReconciliation ?? null,
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
    return normalizedTasks(currentTasks(tasks))
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
    const runAccounts = new Map((run.accounts ?? []).map(account => [String(account.email).toLowerCase(), account]))
    const historicalAccounts = new Map(
        (historySummary?.balanceReconciliation ?? []).map(account => [String(account.accountKey), account])
    )
    const currentEmail = String(points?.currentAccount ?? run.live?.currentAccount ?? '').toLowerCase()
    const hasRun = Boolean(run.version || run.accountsSeen || run.finished || status.lastExit)

    const accounts = (configuredAccounts?.accounts ?? []).map(configured => {
        const email = String(configured.email ?? '')
        const key = email.toLowerCase()
        const runAccount = runAccounts.get(key) ?? null
        const historical = historicalAccounts.get(identity.keyFor(email)) ?? null
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
            points: pointsView(runAccount, historical),
            earnable: earnableView(runAccount?.earnable),
            tasks: tasksView(runAccount?.tasks),
            excludedTasks: normalizedTasks((runAccount?.tasks || []).filter(task => !currentTasks([task]).length)),
            taskDataStatus: runAccount?.taskDataStatus ?? 'not-read',
            taskSources: runAccount?.taskSources ?? {},
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
            runBalanceVerification: historySummary?.runBalanceVerification ?? 'pending',
            observedAt: historySummary?.observedAt ?? null,
            runBalanceDelta: finiteOrNull(historySummary?.runBalanceDelta),
            runGained: finiteOrNull(historySummary?.runBalanceDelta),
            running: ['starting', 'running', 'stopping'].includes(status.state),
            finished: Boolean(run.finished),
            startedAt: status.startedAt ?? null,
            currentAccount: currentConfigured ? identity.labelFor(currentConfigured.email) : null,
            collected: run.telemetryVersion === 2 ? finiteOrNull(points?.collected ?? run.collected) : null,
            currentBalance: finiteOrNull(points?.balance ?? run.live?.currentBalance),
            accountsTotal: finiteOrNull(run.accountsTotal ?? points?.accountsTotal),
            accountsSeen: finiteOrNull(run.accountsSeen ?? points?.accountsSeen),
            pendingDelaySeconds: finiteOrNull(run.pendingDelay?.seconds),
            updatedAt: points?.updatedAt ?? run.live?.updatedAt ?? null
        },
        accounts,
        history: {
            ...historySummary,
            todayCollected: finiteOrNull(historySummary?.todayCollected),
            todayGained: finiteOrNull(historySummary?.todayGained ?? historySummary?.todayCollected),
            confirmedPoints: finiteOrNull(historySummary?.confirmedPoints),
            unattributedPoints: finiteOrNull(historySummary?.unattributedPoints),
            pendingPoints: finiteOrNull(historySummary?.pendingPoints),
            pendingTaskCount: finiteOrNull(historySummary?.pendingTaskCount),
            pendingVerification:
                (historySummary?.pendingVerification ?? 0) +
                (status.state === 'idle'
                    ? 0
                    : accounts.reduce((sum, account) => sum + (account.points.pendingVerification ?? 0), 0))
        },
        notifications: notificationStatus,
        updatedAt: new Date().toISOString()
    }
}

export function publicLog(entry) {
    if (entry?.title === 'TASK-SNAPSHOT') {
        entry = { ...entry, message: translateLogMessage(entry) }
    }
    if (entry?.title === 'TASK-EVENT') {
        try {
            const event = JSON.parse(entry.message)
            entry = {
                ...entry,
                platform: { mobile: 'MOBILE', desktop: 'DESKTOP', main: 'MAIN' }[event.platform] ?? entry.platform
            }
            entry = {
                ...entry,
                level:
                    event.status === 'failed'
                        ? 'error'
                        : ['partial', 'stopped', 'verifying', 'interrupted'].includes(event.status)
                          ? 'warn'
                          : 'info'
            }
            entry = {
                ...entry,
                title: 'TASK-EVENT',
                message: `${sanitizeText(event.title || '任务状态', 180)}：${sanitizeText(event.action || (event.kind === 'balance' ? '已读取账号余额' : '状态已更新'), 500)}`
            }
        } catch {
            entry = { ...entry, message: '结构化任务消息无效，未据此更新状态' }
        }
    }
    const safeEntry = sanitizeLog(entry)
    const titleLabel = TITLE_LABELS[safeEntry.title] ?? sanitizeText(safeEntry.title || '系统消息', 100)
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
    const common = {
        'Starting login process': '开始登录',
        'Entering email': '正在填写登录邮箱',
        'Email entered successfully': '登录邮箱已提交',
        'Entering password': '正在填写登录密码',
        'Password entered successfully': '登录密码已提交',
        'Successfully logged in': '登录状态已确认',
        'Finalizing login': '正在验证并保存登录会话',
        'Login completed, session saved': '登录完成，会话已保存',
        'Accepting KMSI prompt': '正在确认保持登录提示',
        'KMSI prompt accepted': '已确认保持登录',
        'Skipping Passkey prompt': '正在跳过通行密钥提示',
        'Passkey prompt skipped': '已跳过通行密钥提示',
        'Starting Bing session verification': '开始验证 Bing 会话',
        'Verifying Bing session': '正在验证 Bing 会话',
        'Bing session verified successfully': 'Bing 会话验证通过',
        'Acquiring rewards context': '正在读取 Rewards 任务上下文',
        'Bootstrapping rewards context': '正在初始化 Rewards 任务上下文',
        'No matching states found': '当前页面未识别到登录状态',
        'Alternative sign-in methods are available': '页面提供其他登录方式',
        'Account locked selector found': '页面提示账号被锁定',
        'Detected chromewebdata error page': '浏览器显示页面加载错误'
    }
    if (common[message]) return common[message]
    const cookies = message.match(/^Applied (\d+) response cookie\(s\) and persisted the updated session$/)
    if (cookies) return `已同步 ${cookies[1]} 条会话更新，并保存登录状态`
    const cache = message.match(/^Refreshed cookie cache \| previous=(\d+) \| current=(\d+)$/)
    if (cache) return `已刷新会话缓存：更新前 ${cache[1]} 条，更新后 ${cache[2]} 条`
    const tabs = message.match(/^Found (\d+) tab\(s\) open \(min: (\d+), max: (\d+)\)$/)
    if (tabs) return `当前打开 ${tabs[1]} 个标签页，保留范围 ${tabs[2]}～${tabs[3]} 个`
    const closed = message.match(/^Closed (\d+)\/(\d+) excess tab\(s\) to reach max of (\d+)$/)
    if (closed) return `已关闭 ${closed[1]}/${closed[2]} 个多余标签页，最多保留 ${closed[3]} 个`
    if (entry?.title === 'GHOST-CLICK' && message.startsWith('Trying to click selector:')) {
        if (message.includes('#sb_form_q')) return '正在点击搜索输入框'
        if (message.includes('#b_results .b_algo h2')) return '正在打开搜索结果页面'
        return '正在点击页面目标元素'
    }
    const states = {
        EMAIL: '填写邮箱',
        PASSWORD: '填写密码',
        KMSI: '保持登录',
        PASSKEY: '通行密钥提示',
        TOTP: '动态验证码',
        OTP: '一次性验证码',
        PASSWORDLESS: '无密码验证',
        LOGGED_IN: '已登录',
        UNKNOWN: '尚未识别',
        ERROR_ALERT: '页面错误提示',
        ACCOUNT_LOCKED: '账号锁定'
    }
    const stateMessage = message.match(
        /^(Current state|Processing state|Selected state by priority|Returning first found state): ([A-Z_]+)$/
    )
    if (stateMessage)
        return `${stateMessage[1] === 'Processing state' ? '正在处理' : '检测到登录状态'}：${states[stateMessage[2]] ?? stateMessage[2]}`
    const iteration = message.match(/^State check iteration (\d+)\/(\d+)$/)
    if (iteration) return `第 ${iteration[1]}/${iteration[2]} 次检查登录页面`
    const flightChunks = message.match(
        /^Concatenated flight chunks \| pages=(\d+) \| chunks=(\d+) \| length=(\d+) \| perSource=\[(.*)\]$/
    )
    if (flightChunks)
        return `已合并页面数据块：页面 ${flightChunks[1]} 个，数据块 ${flightChunks[2]} 个，长度 ${flightChunks[3]}，来源分布 ${flightChunks[4] || '无'}`
    if (/^Skipped undecodable flight chunk \|/.test(message)) return '有页面数据块无法解码，已跳过该数据块'
    if (/^No __next_f flight chunks found/.test(message)) return '未找到页面任务数据块，页面结构可能已变化'
    if (/^Failed concatenating flight chunks \|/.test(message)) return '合并页面数据块失败，任务数据可能不完整'
    const objectFailures = message.match(/^extractObjects\("[^"]+"\) had (\d+) unparseable matches$/)
    if (objectFailures) return `解析页面对象时有 ${objectFailures[1]} 个匹配项无法读取`
    const parsedOffers = message.match(/^Parsed offers \| total=(\d+) \| reportable=(\d+)$/)
    if (parsedOffers) return `已解析任务：共 ${parsedOffers[1]} 项，可执行 ${parsedOffers[2]} 项`
    const parsedOfferIds = message.match(/^Parsed offer ids \| (.*)$/)
    if (parsedOfferIds) {
        const ids = parsedOfferIds[1] === 'none' ? '无' : parsedOfferIds[1].replaceAll('(skip)', '（跳过）')
        return `已解析任务标识：${ids}`
    }
    const parsedStreaks = message.match(/^Parsed streaks \| (.*)$/)
    if (parsedStreaks) return `已解析连续任务：${parsedStreaks[1] === 'none' ? '无' : parsedStreaks[1]}`
    const parsedProtection = message.match(
        /^Parsed streak protection \| enabled=(true|false) \| remainingDays=([^|]+) \| streakCounter=([^|]+)$/
    )
    if (parsedProtection) {
        const enabled = parsedProtection[1] === 'true' ? '是' : '否'
        const remaining = parsedProtection[2].trim() === 'null' ? '未读取' : parsedProtection[2].trim()
        const counter = parsedProtection[3].trim() === 'null' ? '未读取' : parsedProtection[3].trim()
        return `已解析连续签到保护：已启用 ${enabled}，剩余天数 ${remaining}，连续签到 ${counter} 天`
    }
    if (/^Failed parsing (offers|streaks|streak protection|account) \|/.test(message)) {
        const section = message.match(/^Failed parsing ([^| ]+)/)?.[1]
        const labels = { offers: '任务', streaks: '连续任务', 'streak': '连续签到保护', 'streak protection': '连续签到保护', account: '账号' }
        return `解析${labels[section] ?? '任务数据'}失败，数据可能不完整`
    }
    const parsedAccount = message.match(
        /^Parsed account \| level=([^|]+) \| available=([^|]+) \| toGo=([^|]+) \| lifetime=([^|]+)$/
    )
    if (parsedAccount) {
        const value = item => item.trim() === 'null' ? '未读取' : item.trim()
        return `已解析账号数据：等级 ${value(parsedAccount[1])}，可用积分 ${value(parsedAccount[2])}，距离下一等级 ${value(parsedAccount[3])}，累计积分 ${value(parsedAccount[4])}`
    }
    if (message === 'Account state empty - membership/header objects not found in payload')
        return '账号状态为空：响应中未找到会员或页头对象'
    if (/^Primary dashboard unavailable after one retry; using Bing flyout fallback \|/.test(message))
        return '主任务面板重试后仍不可用，正在使用 Bing 浮层任务数据'
    const partialFlyout = message.match(
        /^Using partial Bing flyout dashboard \| suspectedLimited=(true|false) \| botMarkers=(true|false) \| activitiesCollapsed=(true|false)$/
    )
    if (partialFlyout) {
        const yesNo = value => value === 'true' ? '是' : '否'
        return `使用不完整的 Bing 浮层任务数据：疑似受限 ${yesNo(partialFlyout[1])}，检测到机器人标记 ${yesNo(partialFlyout[2])}，任务列表折叠 ${yesNo(partialFlyout[3])}`
    }
    if (/^Primary dashboard and Bing flyout fallback failed \|/.test(message))
        return '主任务面板和 Bing 浮层备用数据均不可用'
    if (entry?.title === 'LOGIN-RETRY' || entry?.title === 'TASK-EVENT') return message
    if (entry?.title === 'TASK-SNAPSHOT') {
        if (!message.startsWith('{')) return message
        try {
            const snapshot = JSON.parse(message)
            if (snapshot.dataStatus === 'unavailable') return '任务数据源不可用，清单尚未确认'
            if (snapshot.dataStatus === 'pending') return '已生成待执行清单，正在等待读取任务数据'
            const count = snapshot?.tasks?.length
            return Number.isSafeInteger(count) ? `已读取当日任务列表，共 ${count} 项` : '已读取当日任务列表'
        } catch {
            return '任务列表消息无效，读取结果待确认'
        }
    }
    if (entry?.title === 'RUN-START') {
        const accounts = message.match(/Accounts: (\d+)/)?.[1]
        return accounts ? `任务已启动，共 ${accounts} 个账号` : '任务已启动'
    }
    if (entry?.title === 'RUN-END') {
        const points = numeric(message, 'pointsGained')
        return points === null ? '全部账号处理结束' : `全部账号处理结束，余额变化 ${points} 分，任务得分以确认记录为准`
    }
    if (entry?.title === 'ACCOUNT-START')
        return `开始处理 ${message.match(/^Starting account: ([^|]+)/)?.[1]?.trim() || '当前账号'}`
    if (entry?.title === 'ACCOUNT-END') {
        const points = numeric(message, 'pointsGained')
        return points === null ? '当前账号处理结束' : `当前账号处理结束，余额变化 ${points} 分，任务得分以确认记录为准`
    }
    if (entry?.title === 'ACCOUNT-DELAY') {
        const seconds = message.match(/^Waiting ([\d.]+) seconds/)?.[1]
        return seconds ? `等待 ${seconds} 秒后处理下一个账号` : '正在等待下一个账号'
    }
    if (entry?.title === 'POINTS') {
        const match = message.match(/Mobile: (\d+) \| Browser: (\d+) \| App: (\d+)/)
        return match
            ? `旧格式额度报告：移动 ${match[1]}、桌面 ${match[2]}、应用 ${match[3]} 分；以任务清单的确认状态为准`
            : message
    }
    if (entry?.title === 'FLOW') {
        if (/^Starting session for /i.test(message)) return '正在初始化当前账号任务流程'
        if (/^Points collected \|/i.test(message)) {
            const points = numeric(message, 'pointsGained')
            return points === null ? '账号余额已读取，正在更新任务结果' : `账号流程结束，本轮余额增加 ${points} 分`
        }
        if (/^Foreground activities finished/i.test(message)) return '前台任务已完成，正在等待后台任务收尾'
        if (/执行失败，继续后续任务 \| message=/i.test(message)) return '当前任务执行失败，已继续后续任务'
    }
    if (entry?.title === 'BROWSER') {
        if (/^(Mobile|Desktop) Browser started/i.test(message))
            return message.startsWith('Mobile') ? '移动端浏览器已启动' : '桌面端浏览器已启动'
        if (/^Browser started/i.test(message)) return '浏览器已启动'
    }
    if (entry?.title === 'SEARCH-MANAGER') {
        const searchStart = message.match(/^Starting Bing searches \| currentBalance=(\d+)$/i)
        if (searchStart) return `开始 Bing 搜索，当前余额 ${searchStart[1]} 分`
        const searchSummary = message.match(/^Search summary \| mobile=(-?\d+) \| desktop=(-?\d+) \| bonus=(-?\d+) \| total=(-?\d+)/i)
        if (searchSummary)
            return `搜索任务结束：移动端 ${searchSummary[1]} 分，桌面端 ${searchSummary[2]} 分，奖励搜索 ${searchSummary[3]} 分，共 ${searchSummary[4]} 分`
        if (/^Starting bonus search farming/i.test(message)) return '开始执行奖励搜索'
        const bonusSummary = message.match(/^Bonus search summary \| pointsGained=(-?\d+)/i)
        if (bonusSummary) return `奖励搜索结束，本轮增加 ${bonusSummary[1]} 分`
    }
    if (entry?.title === 'SEARCH-BING' || entry?.title === 'SEARCH-BONUS') {
        const queryReady = message.match(/^Query queue ready \| mainTopics=(\d+) \| clusterSearch=(true|false)$/i)
        if (queryReady) return `搜索词准备完成：${queryReady[1]} 个主题，${queryReady[2] === 'true' ? '启用' : '未启用'}分组搜索`
        if (/^No main search topics available/i.test(message)) return '没有可用的搜索主题，本轮搜索未执行'
        if (/^Query queue exhausted/i.test(message)) return '搜索词已用尽，本轮搜索停止'
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
    const suffix = points === null ? '' : `，日志报告增量 ${points} 分，尚未归因`
    if (
        /^(Completed|Finished|Reward claimed|Nothing claimed)|already (?:been )?completed|already complete/i.test(
            message
        )
    ) {
        return `${titleLabel}流程结束${suffix ? '，日志报告值仅供核对' : ''}`
    }
    const knownTitle = Object.hasOwn(TITLE_LABELS, entry?.title)
    if (knownTitle && /^(Starting|Started)/i.test(message)) return `正在执行${titleLabel}`
    if (knownTitle && /^(Skipping|Skip )/i.test(message)) return `${titleLabel}已跳过`
    if (entry?.level === 'error' || /failed|failure/i.test(message))
        return Object.hasOwn(TITLE_LABELS, entry?.title) ? `${titleLabel}执行失败，已记录原因` : `${titleLabel}执行失败：${message}`
    if (entry?.level === 'warn')
        return Object.hasOwn(TITLE_LABELS, entry?.title) ? `${titleLabel}：请关注当前警告` : `${titleLabel}：${message}`
    if (points !== null) return `${titleLabel}进度已更新${suffix}`
    if (message && Object.hasOwn(TITLE_LABELS, entry?.title)) return `${titleLabel}：任务信息已更新`
    return message || `${titleLabel}：未提供具体消息`
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
