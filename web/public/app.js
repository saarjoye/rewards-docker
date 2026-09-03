const authShell = document.querySelector('#authShell')
const appShell = document.querySelector('#app')
const content = document.querySelector('#content')
const notice = document.querySelector('#notice')
const pageTitle = document.querySelector('#pageTitle')
const pageMeta = document.querySelector('#pageMeta')
const connectionDot = document.querySelector('#connectionDot')
const connectionText = document.querySelector('#connectionText')

const titles = {
    dashboard: '仪表盘',
    accounts: '账号状态',
    tasks: '任务状态',
    calendar: '积分日历',
    history: '运行历史',
    logs: '运行日志',
    wecom: '企业微信',
    system: '系统状态'
}

let csrfToken = null
let currentView = 'dashboard'
let state = null
let events = null
let liveLogs = []

function esc(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;')
}

function formatTime(value) {
    if (!value) return '-'
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? esc(value) : date.toLocaleString('zh-CN', { hour12: false })
}

function valueOrUnknown(value, suffix = '') {
    return value === null || value === undefined ? '未识别/待确认' : `${Number(value)}${suffix}`
}

function statusPill(status) {
    return `<span class="status ${esc(status?.state || 'unknown')}">${esc(status?.label || '待确认')}</span>`
}

async function api(path, options = {}) {
    const headers = { Accept: 'application/json', ...(options.headers || {}) }
    if (options.body !== undefined) headers['Content-Type'] = 'application/json'
    if (options.method && options.method !== 'GET' && csrfToken) headers['X-CSRF-Token'] = csrfToken
    const response = await fetch(path, { ...options, headers })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) {
        if (response.status === 401) await showAuth(false)
        throw new Error(data.error || `请求失败（HTTP ${response.status}）`)
    }
    return data
}

async function bootstrap() {
    const data = await api('/api/bootstrap')
    csrfToken = data.csrfToken
    if (!data.authenticated) return showAuth(data.setupRequired)
    authShell.hidden = true
    appShell.hidden = false
    await loadState()
    connectEvents()
}

async function showAuth(setupRequired) {
    if (events) events.close()
    events = null
    appShell.hidden = true
    authShell.hidden = false
    document.querySelector('#authTitle').textContent = setupRequired ? '初始化管理账号' : '管理登录'
    const password = document.querySelector('#authPassword')
    password.autocomplete = setupRequired ? 'new-password' : 'current-password'
    password.minLength = setupRequired ? 12 : 1
    authShell.dataset.setup = setupRequired ? 'true' : 'false'
}

document.querySelector('#authForm').addEventListener('submit', async event => {
    event.preventDefault()
    const error = document.querySelector('#authError')
    error.textContent = ''
    const setup = authShell.dataset.setup === 'true'
    try {
        const data = await api(setup ? '/api/setup' : '/api/login', {
            method: 'POST',
            body: JSON.stringify({
                username: document.querySelector('#authUser').value,
                password: document.querySelector('#authPassword').value
            })
        })
        csrfToken = data.csrfToken
        authShell.hidden = true
        appShell.hidden = false
        await loadState()
        connectEvents()
    } catch (requestError) {
        error.textContent = requestError.message
    }
})

document.querySelector('#logoutBtn').addEventListener('click', async () => {
    try {
        await api('/api/logout', { method: 'POST', body: '{}' })
    } finally {
        csrfToken = null
        await showAuth(false)
    }
})

document.querySelector('#refreshBtn').addEventListener('click', () => refreshCurrent())
document.querySelector('#nav').addEventListener('click', event => {
    const button = event.target.closest('button[data-view]')
    if (!button) return
    currentView = button.dataset.view
    document.querySelectorAll('#nav button').forEach(item => item.classList.toggle('active', item === button))
    pageTitle.textContent = titles[currentView]
    renderCurrent()
})

content.addEventListener('click', async event => {
    const action = event.target.closest('[data-action]')?.dataset.action
    if (!action) return
    try {
        if (action === 'start') {
            const value = document.querySelector('#runAccount')?.value || ''
            const body = value ? { accountIndex: Number(value) } : {}
            await api('/api/run', { method: 'POST', body: JSON.stringify(body) })
            await loadState()
        } else if (action === 'stop') {
            if (!window.confirm('确认停止当前任务？核心会先执行正常终止。')) return
            await api('/api/stop', { method: 'POST', body: '{}' })
            await loadState()
        } else if (action === 'load-calendar') {
            await renderCalendar(true)
        } else if (action === 'load-logs') {
            await renderLogs(true)
        }
    } catch (error) {
        showNotice(error.message)
    }
})

function showNotice(message) {
    notice.textContent = message
    notice.hidden = !message
}

async function loadState() {
    state = await api('/api/state')
    renderConnection()
    renderCurrent()
}

function renderConnection() {
    const available = Boolean(state?.core?.available)
    connectionDot.className = `dot ${available ? 'online' : 'offline'}`
    connectionText.textContent = available ? `${state.core.label} · v${state.core.version || '-'}` : '核心离线'
    pageMeta.textContent = `状态更新：${formatTime(state?.updatedAt)}`
    showNotice(available ? state?.core?.error || '' : '核心接口不可用；离线期间若核心重启，该时段运行历史可能缺失。')
}

function metric(label, value, detail) {
    return `<div class="metric"><span>${esc(label)}</span><strong>${esc(value)}</strong><small>${esc(detail)}</small></div>`
}

function accountRows(accounts = []) {
    if (!accounts.length) return '<tr><td colspan="6" class="empty">没有可显示的账号</td></tr>'
    return accounts
        .map(
            account => `<tr>
                <td>${esc(account.index)}</td><td>${esc(account.label)}</td>
                <td>${statusPill(account.status)}<div class="subtle">${esc(account.status.message)}</div></td>
                <td>${valueOrUnknown(account.points.balance)}</td><td>${valueOrUnknown(account.points.collected, ' 分')}</td>
                <td>${esc(account.geoLocale)} / ${esc(account.langCode)}</td>
            </tr>`
        )
        .join('')
}

function renderDashboard() {
    const core = state?.core || {}
    const run = state?.run || {}
    const accounts = state?.accounts || []
    const options = accounts
        .map(account => `<option value="${account.index}">${esc(account.index)} · ${esc(account.label)}</option>`)
        .join('')
    content.innerHTML = `
        <section class="metrics">
            ${metric('核心状态', core.label || '核心离线', core.version ? `版本 ${core.version}` : '等待连接')}
            ${metric('本次积分', valueOrUnknown(run.collected, ' 分'), run.currentAccount || '当前无执行账号')}
            ${metric('执行进度', run.accountsTotal === null || run.accountsTotal === undefined ? '待确认' : `${run.accountsSeen || 0}/${run.accountsTotal}`, run.running ? '任务正在运行' : '当前未运行')}
            ${metric('历史累计', `+${state?.history?.collected || 0}`, `${state?.history?.runs || 0} 次持久记录`)}
        </section>
        <section class="section">
            <div class="section-head"><div><h2>运行控制</h2><p>Control API 只接受全部账号或单个账号启动。</p></div></div>
            <div class="panel run-bar">
                <select id="runAccount" ${run.running || !core.available ? 'disabled' : ''}><option value="">全部账号</option>${options}</select>
                <div class="run-actions">
                    <button class="primary" data-action="start" ${run.running || !core.available ? 'disabled' : ''}>开始运行</button>
                    <button class="danger" data-action="stop" ${!run.running ? 'disabled' : ''}>停止任务</button>
                </div>
            </div>
        </section>
        <section class="section">
            <div class="section-head"><div><h2>账号概览</h2></div></div>
            <div class="panel table-wrap"><table><thead><tr><th>序号</th><th>账号</th><th>状态</th><th>当前积分</th><th>本次增加</th><th>地区 / 语言</th></tr></thead><tbody>${accountRows(accounts)}</tbody></table></div>
        </section>`
}

function renderAccounts() {
    content.innerHTML = `<section class="section"><div class="section-head"><div><h2>账号状态</h2><p>账号凭证和配置只在 NAS 环境文件中维护。</p></div></div><div class="panel table-wrap"><table><thead><tr><th>序号</th><th>账号</th><th>状态</th><th>当前积分</th><th>本次增加</th><th>地区 / 语言</th></tr></thead><tbody>${accountRows(state?.accounts)}</tbody></table></div></section>`
}

function renderTasks() {
    const accounts = state?.accounts || []
    const body = accounts.length
        ? accounts
              .map(account => {
                  const sources = account.points.bySource.length
                      ? account.points.bySource
                            .map(
                                source =>
                                    `<div class="progress-line"><span>${esc(source.label)}</span><strong>+${source.points}</strong></div>`
                            )
                            .join('')
                      : '<div class="progress-line"><span>任务积分</span><strong>待确认</strong></div>'
                  return `<article class="task-account"><h3>${esc(account.label)}</h3><p>${esc(account.status.label)} · ${esc(account.status.message)}</p>
                    <div class="progress-line"><span>移动搜索额度</span><strong>${valueOrUnknown(account.earnable.mobile, ' 分')}</strong></div>
                    <div class="progress-line"><span>桌面搜索额度</span><strong>${valueOrUnknown(account.earnable.desktop, ' 分')}</strong></div>
                    <div class="progress-line"><span>应用任务额度</span><strong>${valueOrUnknown(account.earnable.app, ' 分')}</strong></div>${sources}</article>`
              })
              .join('')
        : '<div class="empty">暂无结构化任务状态</div>'
    content.innerHTML = `<section class="section"><div class="section-head"><div><h2>结构化任务状态</h2><p>未知额度保持“未识别/待确认”，不按零分处理。</p></div></div><div class="task-grid">${body}</div></section>`
}

async function renderCalendar(load = false) {
    content.innerHTML = '<div class="panel empty">正在读取积分日历...</div>'
    try {
        const start = load ? document.querySelector('#calendarStart')?.value : ''
        const end = load ? document.querySelector('#calendarEnd')?.value : ''
        const accountId = load ? document.querySelector('#calendarAccount')?.value : ''
        const params = new URLSearchParams()
        if (start) params.set('start', start)
        if (end) params.set('end', end)
        if (accountId) params.set('accountId', accountId)
        const data = await api(`/api/points-calendar?${params}`)
        const options = data.accounts
            .map(
                account =>
                    `<option value="${esc(account.id)}" ${account.id === accountId ? 'selected' : ''}>${esc(account.label)}</option>`
            )
            .join('')
        const days = data.days.length
            ? data.days
                  .map(
                      day =>
                          `<div class="calendar-day"><strong>${esc(day.date)}</strong><b>+${day.totalGained}</b><span>${day.records} 条账号记录 · ${esc(day.status)}</span></div>`
                  )
                  .join('')
            : '<div class="panel empty">所选范围没有积分记录</div>'
        content.innerHTML = `<section class="section"><div class="filter-row">
            <label>开始日期<input id="calendarStart" type="date" value="${esc(data.range.start)}"></label>
            <label>结束日期<input id="calendarEnd" type="date" value="${esc(data.range.end)}"></label>
            <label>账号<select id="calendarAccount"><option value="">全部账号</option>${options}</select></label>
            <button class="ghost" data-action="load-calendar">查询</button></div>
            <section class="metrics">${metric('范围积分', `+${data.summary.totalPoints}`, `${data.range.start} 至 ${data.range.end}`)}${metric('完成天数', data.summary.completedDays, '有完成记录的日期')}${metric('异常天数', data.summary.failedDays, '失败或部分完成')}${metric('最高单日', `+${data.summary.highestPointDay.points}`, data.summary.highestPointDay.date || '-')}</section>
            <section class="section"><div class="calendar-grid">${days}</div></section></section>`
    } catch (error) {
        content.innerHTML = `<div class="panel empty">${esc(error.message)}</div>`
    }
}

async function renderHistory() {
    content.innerHTML = '<div class="panel empty">正在读取运行历史...</div>'
    try {
        const data = await api('/api/history?limit=100')
        const rows = data.runs.length
            ? data.runs
                  .map(
                      run =>
                          `<tr><td>${formatTime(run.startedAt)}</td><td>${formatTime(run.endedAt)}</td><td><span class="status ${esc(run.status)}">${esc(run.status)}</span></td><td>+${run.collected}</td><td>${run.accounts.length}</td><td>${run.imported ? '旧版导入' : esc(run.version || '-')}</td></tr>`
                  )
                  .join('')
            : '<tr><td colspan="6" class="empty">暂无持久化运行记录</td></tr>'
        content.innerHTML = `<section class="section"><div class="section-head"><div><h2>运行历史</h2><p>历史用于展示，不参与实时状态或续跑判断。Web 与核心同时离线且核心重启时，该时段历史可能缺失。</p></div></div><div class="panel table-wrap"><table><thead><tr><th>开始</th><th>结束</th><th>状态</th><th>积分</th><th>账号数</th><th>来源</th></tr></thead><tbody>${rows}</tbody></table></div></section>`
    } catch (error) {
        content.innerHTML = `<div class="panel empty">${esc(error.message)}</div>`
    }
}

function logMarkup(logs) {
    if (!logs.length) return '<div class="empty">暂无可显示的脱敏日志</div>'
    return logs
        .map(
            log =>
                `<div class="log-line"><span>${esc(formatTime(log.receivedAt || log.ts))}</span><span class="${esc(log.level)}">${esc(log.levelLabel)}</span><span>${esc(log.titleLabel)}</span><span>${esc(log.message)}</span></div>`
        )
        .join('')
}

async function renderLogs(load = false) {
    if (!load && liveLogs.length) {
        content.innerHTML = `<section class="section"><div class="section-head"><div><h2>运行日志</h2><p>显示服务端再次脱敏后的核心日志。</p></div><button class="ghost" data-action="load-logs">刷新</button></div><div class="panel log-view">${logMarkup(liveLogs)}</div></section>`
        return
    }
    content.innerHTML = '<div class="panel empty">正在读取脱敏日志...</div>'
    try {
        const data = await api('/api/logs?limit=400')
        liveLogs = data.logs
        content.innerHTML = `<section class="section"><div class="section-head"><div><h2>运行日志</h2><p>显示服务端再次脱敏后的核心日志。</p></div><button class="ghost" data-action="load-logs">刷新</button></div><div class="panel log-view">${logMarkup(liveLogs)}</div></section>`
    } catch (error) {
        content.innerHTML = `<div class="panel empty">${esc(error.message)}</div>`
    }
}

function renderWeCom() {
    const item = state?.notifications || {}
    content.innerHTML = `<section class="section"><div class="section-head"><div><h2>企业微信通知</h2><p>通知配置来自 Web 容器环境，只发送脱敏中文摘要。</p></div></div><div class="panel"><dl class="details-list"><dt>启用状态</dt><dd>${item.enabled ? '已启用' : '未启用'}</dd><dt>配置状态</dt><dd>${item.configured ? '配置完整' : '未配置完整'}</dd><dt>接收范围</dt><dd>${esc(item.recipient || '-')}</dd><dt>最近成功</dt><dd>${formatTime(item.lastSuccessAt)}</dd><dt>最近错误</dt><dd>${esc(item.lastError || '-')}</dd></dl></div></section>`
}

function renderSystem() {
    const core = state?.core || {}
    content.innerHTML = `<section class="section"><div class="section-head"><div><h2>系统状态</h2></div></div><div class="panel"><dl class="details-list"><dt>核心连接</dt><dd>${core.available ? '正常' : '不可用'}</dd><dt>核心状态</dt><dd>${esc(core.label || '-')}</dd><dt>核心版本</dt><dd>${esc(core.version || '-')}</dd><dt>核心启动时间</dt><dd>${formatTime(core.startedAt)}</dd><dt>最近退出</dt><dd>${core.lastExit ? `代码 ${core.lastExit.code ?? '-'} · ${formatTime(core.lastExit.at)}` : '-'}</dd><dt>日志缓冲数量</dt><dd>${valueOrUnknown(core.logCount)}</dd><dt>持久历史</dt><dd>${state?.history?.runs || 0} 次运行</dd><dt>Web 状态更新时间</dt><dd>${formatTime(state?.updatedAt)}</dd></dl></div></section>`
}

function renderCurrent() {
    if (!state) return
    if (currentView === 'dashboard') renderDashboard()
    else if (currentView === 'accounts') renderAccounts()
    else if (currentView === 'tasks') renderTasks()
    else if (currentView === 'calendar') void renderCalendar()
    else if (currentView === 'history') void renderHistory()
    else if (currentView === 'logs') void renderLogs()
    else if (currentView === 'wecom') renderWeCom()
    else renderSystem()
}

async function refreshCurrent() {
    try {
        await loadState()
        if (currentView === 'logs') await renderLogs(true)
        if (currentView === 'history') await renderHistory()
    } catch (error) {
        showNotice(error.message)
    }
}

function connectEvents() {
    if (events) events.close()
    events = new EventSource('/api/events')
    events.addEventListener('state', event => {
        state = JSON.parse(event.data)
        renderConnection()
        if (!['calendar', 'history', 'logs'].includes(currentView)) renderCurrent()
    })
    events.addEventListener('log', event => {
        const log = JSON.parse(event.data)
        liveLogs.push(log)
        liveLogs = liveLogs.slice(-500)
        if (currentView === 'logs') renderLogs()
    })
    events.onerror = () => {
        connectionDot.className = 'dot offline'
        connectionText.textContent = '实时连接中断，等待重连'
    }
}

bootstrap().catch(error => {
    authShell.hidden = false
    document.querySelector('#authError').textContent = error.message
})
