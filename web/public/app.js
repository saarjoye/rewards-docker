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
    accounts: '账号管理',
    tasks: '当日任务',
    calendar: '积分日历',
    history: '运行记录',
    wecom: '企业微信',
    system: '系统状态'
}

let csrfToken = null
let currentView = 'dashboard'
let state = null
let events = null
let liveLogs = []
let accountManagement = null
let historyRefreshTimer = null

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
        } else if (action === 'migrate-accounts') {
            if (!window.confirm('确认把当前环境变量中的账号一次性迁移到加密账号库？迁移后加密库将成为唯一账号来源。'))
                return
            await api('/api/accounts/migrate-env', { method: 'POST', body: '{}' })
            accountManagement = null
            await loadState()
            await renderAccounts()
        } else if (action === 'add-account') {
            renderAccountForm()
        } else if (action === 'edit-account') {
            const item = accountManagement?.accounts?.find(
                account => account.id === event.target.closest('[data-id]')?.dataset.id
            )
            if (item) renderAccountForm(item)
        } else if (action === 'cancel-account') {
            await renderAccounts()
        } else if (action === 'delete-account') {
            const id = event.target.closest('[data-id]')?.dataset.id
            if (!id || !window.confirm('确认删除此账号？该账号的桌面端和移动端 Session 也会删除，脱敏运行历史会保留。'))
                return
            await api(`/api/accounts/${encodeURIComponent(id)}`, { method: 'DELETE', body: '{}' })
            accountManagement = null
            await loadState()
            await renderAccounts()
        } else if (action === 'wecom-test') {
            await api('/api/wecom/test', { method: 'POST', body: '{}' })
            showNotice('企业微信测试通知已发送')
            await renderWeCom()
        } else if (action === 'history-detail') {
            await renderRunDetail(event.target.closest('[data-id]')?.dataset.id)
        } else if (action === 'history-back') {
            await renderHistory()
        }
    } catch (error) {
        showNotice(error.message)
    }
})

content.addEventListener('submit', async event => {
    const form = event.target
    if (form.id === 'accountForm') {
        event.preventDefault()
        const data = new FormData(form)
        const id = form.dataset.id || ''
        const body = {
            email: data.get('email'),
            password: data.get('password'),
            totpSecret: data.get('totpSecret'),
            recoveryEmail: data.get('recoveryEmail'),
            geoLocale: data.get('geoLocale'),
            langCode: data.get('langCode'),
            proxy: {
                proxyHttp: data.get('proxyHttp') === 'on',
                url: data.get('proxyUrl'),
                port: Number(data.get('proxyPort') || 0),
                username: data.get('proxyUsername'),
                password: data.get('proxyPassword')
            },
            saveFingerprint: {
                mobile: data.get('fingerprintMobile') === 'on',
                desktop: data.get('fingerprintDesktop') === 'on'
            },
            clearProxy: data.get('clearProxy') === 'on',
            clearSecrets: ['password', 'totpSecret', 'recoveryEmail', 'proxyCredentials'].filter(
                key => data.get(`clear-${key}`) === 'on'
            )
        }
        try {
            await api(id ? `/api/accounts/${encodeURIComponent(id)}` : '/api/accounts', {
                method: id ? 'PATCH' : 'POST',
                body: JSON.stringify(body)
            })
            accountManagement = null
            await loadState()
            await renderAccounts()
        } catch (error) {
            showNotice(error.message)
        }
    } else if (form.id === 'wecomForm') {
        event.preventDefault()
        const data = new FormData(form)
        try {
            await api('/api/wecom', {
                method: 'POST',
                body: JSON.stringify({
                    enabled: data.get('enabled') === 'on',
                    mode: data.get('mode'),
                    baseUrl: data.get('baseUrl'),
                    corpId: data.get('corpId'),
                    agentId: data.get('agentId'),
                    corpSecret: data.get('corpSecret'),
                    toUser: data.get('toUser'),
                    clearSecret: data.get('clearSecret') === 'on'
                })
            })
            showNotice('企业微信配置已加密保存')
            await loadState()
            await renderWeCom()
        } catch (error) {
            showNotice(error.message)
        }
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
    showNotice(available ? state?.core?.error || '' : '核心接口不可用；已完成的持久运行记录仍可查看。')
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
            ${metric('当日得分', `+${state?.history?.todayCollected || 0}`, `${state?.history?.today || '今日'} · 含当前运行`)}
        </section>
        <section class="section">
            <div class="section-head"><div><h2>运行控制</h2><p>Control API 只接受全部账号或单个账号启动。</p></div></div>
            <div class="panel run-bar">
                <select id="runAccount" ${run.running || !core.available ? 'disabled' : ''}><option value="">全部账号</option>${options}</select>
                <div class="run-actions">
                    <button class="primary" data-action="start" ${run.running || !core.available || !accounts.length ? 'disabled' : ''}>开始运行</button>
                    <button class="danger" data-action="stop" ${!run.running ? 'disabled' : ''}>停止任务</button>
                </div>
            </div>
        </section>
        <section class="section">
            <div class="section-head"><div><h2>账号概览</h2></div></div>
            <div class="panel table-wrap"><table><thead><tr><th>序号</th><th>账号</th><th>状态</th><th>当前积分</th><th>本次增加</th><th>地区 / 语言</th></tr></thead><tbody>${accountRows(accounts)}</tbody></table></div>
        </section>`
}

async function renderAccounts() {
    content.innerHTML = '<div class="panel empty">正在读取账号配置...</div>'
    try {
        accountManagement = await api('/api/accounts/manage')
        const coreIdle = !state?.run?.running
        const rows = accountManagement.accounts.length
            ? accountManagement.accounts
                  .map(
                      account => `<tr><td>${account.index}</td><td>${esc(account.label)}</td><td>${esc(account.geoLocale)} / ${esc(account.langCode)}</td>
                        <td>${account.hasPassword ? '密码' : '免密码'} · ${account.hasTotp ? 'TOTP 已配置' : '无 TOTP'} · ${account.proxy.enabled ? '代理已配置' : '直连'}</td>
                        <td><div class="row-actions"><button class="small-button" data-action="edit-account" data-id="${esc(account.id)}" ${!coreIdle || !accountManagement.store.encrypted || !accountManagement.store.writable ? 'disabled' : ''}>编辑</button><button class="small-button danger-outline" data-action="delete-account" data-id="${esc(account.id)}" ${!coreIdle || !accountManagement.store.encrypted || !accountManagement.store.writable ? 'disabled' : ''}>删除</button></div></td></tr>`
                  )
                  .join('')
            : '<tr><td colspan="5" class="empty">尚未配置账号</td></tr>'
        const migration = accountManagement.store.migrationAvailable
            ? `<button class="ghost" data-action="migrate-accounts" ${!coreIdle || !accountManagement.store.writable ? 'disabled' : ''}>迁移环境账号</button>`
            : ''
        content.innerHTML = `<section class="section"><div class="section-head"><div><h2>账号管理</h2><p>${accountManagement.store.encrypted ? '账号已由加密账号库管理，下次运行立即生效。' : '当前仍使用环境账号；存在旧账号时必须先完成一次性迁移。'}</p></div><div class="toolbar">${migration}<button class="primary" data-action="add-account" ${!coreIdle || !accountManagement.store.writable || accountManagement.store.migrationAvailable ? 'disabled' : ''}>新增账号</button></div></div><div class="panel table-wrap"><table><thead><tr><th>序号</th><th>账号</th><th>地区 / 语言</th><th>登录与代理</th><th>操作</th></tr></thead><tbody>${rows}</tbody></table></div></section>`
    } catch (error) {
        content.innerHTML = `<div class="panel empty">${esc(error.message)}</div>`
    }
}

function renderAccountForm(account = null) {
    const edit = Boolean(account)
    content.innerHTML = `<section class="section"><div class="section-head"><div><h2>${edit ? `编辑 ${esc(account.label)}` : '新增账号'}</h2><p>密码、TOTP、恢复邮箱和代理密码不会回显；编辑时留空表示保留。</p></div></div>
        <form id="accountForm" data-id="${esc(account?.id || '')}" class="panel form-grid panel-body">
            <label>邮箱<input name="email" type="email" ${edit ? 'placeholder="留空保留原账号"' : 'required'}></label>
            <label>密码<input name="password" type="password" autocomplete="new-password" placeholder="${edit ? '留空保留' : '可留空使用免密码登录'}"></label>
            <label>TOTP 密钥<input name="totpSecret" type="password" autocomplete="off" placeholder="${edit ? '留空保留' : '可选'}"></label>
            <label>恢复邮箱<input name="recoveryEmail" type="email" placeholder="${edit ? '留空保留' : '可选'}"></label>
            <label>地区<input name="geoLocale" value="${esc(account?.geoLocale || 'auto')}" required></label>
            <label>语言<input name="langCode" value="${esc(account?.langCode || 'zh-CN')}" required></label>
            <label>代理地址<input name="proxyUrl" placeholder="https://proxy.example.com"></label>
            <label>代理端口<input name="proxyPort" type="number" min="0" max="65535" value="${esc(account?.proxy?.port || 0)}"></label>
            <label>代理用户名<input name="proxyUsername" autocomplete="off"></label>
            <label>代理密码<input name="proxyPassword" type="password" autocomplete="new-password" placeholder="${edit ? '留空保留' : '可选'}"></label>
            <fieldset class="full"><legend>运行选项</legend><label class="check"><input name="proxyHttp" type="checkbox" ${account?.proxy?.proxyHttp ? 'checked' : ''}>HTTP 请求也使用代理</label><label class="check"><input name="fingerprintMobile" type="checkbox" ${account?.saveFingerprint?.mobile ? 'checked' : ''}>保存移动端指纹</label><label class="check"><input name="fingerprintDesktop" type="checkbox" ${account?.saveFingerprint?.desktop ? 'checked' : ''}>保存桌面端指纹</label></fieldset>
            ${edit ? '<fieldset class="full danger-zone"><legend>明确清除已保存字段</legend><label class="check"><input name="clear-password" type="checkbox">清除密码</label><label class="check"><input name="clear-totpSecret" type="checkbox">清除 TOTP</label><label class="check"><input name="clear-recoveryEmail" type="checkbox">清除恢复邮箱</label><label class="check"><input name="clear-proxyCredentials" type="checkbox">清除代理用户名和密码</label><label class="check"><input name="clearProxy" type="checkbox">清除全部代理配置</label></fieldset>' : ''}
            <div class="form-actions full"><button class="primary" type="submit">保存账号</button><button class="ghost" type="button" data-action="cancel-account">取消</button></div>
        </form></section>`
}

function renderTasks() {
    const accounts = state?.accounts || []
    const body = accounts.length
        ? accounts
              .map(account => {
                  const tasks = account.tasks?.length
                      ? account.tasks
                            .map(
                                task =>
                                    `<tr><td>${esc(task.title)}</td><td>${taskStatusLabel(task.status)}</td><td>${task.progress ? `${task.progress.current}/${task.progress.total}` : '待确认'}</td><td>${valueOrUnknown(task.expectedPoints, ' 分')}</td><td>${valueOrUnknown(task.earnedPoints, ' 分')}</td></tr>`
                            )
                            .join('')
                      : '<tr><td colspan="5" class="empty">运行后将显示从 Rewards 数据源读取的当日任务</td></tr>'
                  return `<article class="task-account"><h3>${esc(account.label)}</h3><p>${esc(account.status.label)} · ${esc(account.status.message)}</p>
                    <div class="task-summary"><span>本次已得 <strong>${valueOrUnknown(account.points.collected, ' 分')}</strong></span><span>当前积分 <strong>${valueOrUnknown(account.points.balance)}</strong></span></div>
                    <div class="table-wrap"><table><thead><tr><th>任务</th><th>状态</th><th>进度</th><th>预计分值</th><th>实际得分</th></tr></thead><tbody>${tasks}</tbody></table></div></article>`
              })
              .join('')
        : '<div class="empty">暂无结构化任务状态</div>'
    content.innerHTML = `<section class="section"><div class="section-head"><div><h2>当日任务与得分</h2><p>任务来自当前账号的 Rewards 数据源；未返回的分值显示“待确认”。</p></div></div><div class="task-grid">${body}</div></section>`
}

function taskStatusLabel(status) {
    return (
        {
            pending: '待执行',
            running: '执行中',
            completed: '已完成',
            partial: '部分完成',
            failed: '失败',
            skipped: '已跳过',
            locked: '未解锁'
        }[status] || '待确认'
    )
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
    content.innerHTML = '<div class="panel empty">正在读取运行记录...</div>'
    try {
        const [data, logData] = await Promise.all([api('/api/history?limit=100'), api('/api/logs?limit=400')])
        liveLogs = logData.logs || liveLogs
        const runs = data.active ? [data.active, ...data.runs] : data.runs
        const rows = runs.length
            ? runs
                  .map(
                      run =>
                          `<tr><td>${formatTime(run.startedAt)}</td><td>${run.endedAt ? formatTime(run.endedAt) : '进行中'}</td><td><span class="status ${esc(run.status)}">${taskStatusLabel(run.status)}</span></td><td>${valueOrUnknown(run.collected, ' 分')}</td><td>${run.accounts.length}</td><td><button class="small-button" data-action="history-detail" data-id="${esc(run.id || '')}" ${run.id ? '' : 'disabled'}>查看</button></td></tr>`
                  )
                  .join('')
            : '<tr><td colspan="6" class="empty">暂无运行记录</td></tr>'
        content.innerHTML = `<section class="section"><div class="section-head"><div><h2>运行记录</h2><p>结构化结果长期保留，折叠诊断日志保留 7 天并限制容量。</p></div></div><div class="panel table-wrap"><table><thead><tr><th>开始</th><th>结束</th><th>状态</th><th>得分</th><th>账号数</th><th>详情</th></tr></thead><tbody>${rows}</tbody></table></div></section>
            ${data.active ? `<section class="section"><div class="section-head"><div><h2>实时步骤</h2></div></div><div class="timeline">${stepMarkup(liveLogs.slice(-80))}</div><details class="diagnostic"><summary>展开原始脱敏诊断日志</summary><div class="log-view">${logMarkup(liveLogs.slice(-200))}</div></details></section>` : ''}`
    } catch (error) {
        content.innerHTML = `<div class="panel empty">${esc(error.message)}</div>`
    }
}

function logMarkup(logs) {
    if (!logs.length) return '<div class="empty">暂无可显示的脱敏日志</div>'
    return logs
        .map(log => {
            const displayMessage = log.displayMessage || '任务状态已更新'
            const rawDetail =
                log.message && log.message !== displayMessage
                    ? `<details class="raw-log"><summary>查看原始脱敏信息</summary><code>${esc(log.message)}</code></details>`
                    : ''
            return `<div class="log-line"><span>${esc(formatTime(log.receivedAt || log.ts))}</span><span class="${esc(log.level)}">${esc(log.levelLabel)}</span><span>${esc(log.titleLabel)}</span><span class="log-message">${esc(displayMessage)}${rawDetail}</span></div>`
        })
        .join('')
}

function stepMarkup(logs) {
    if (!logs.length) return '<div class="empty">暂无实时步骤</div>'
    return logs
        .map(
            log =>
                `<div class="step ${esc(log.level)}"><time>${esc(formatTime(log.receivedAt || log.ts))}</time><strong>${esc(log.titleLabel)}</strong><span>${esc(log.displayMessage || '任务状态已更新')}</span></div>`
        )
        .join('')
}

async function renderRunDetail(id) {
    if (!id) return renderHistory()
    content.innerHTML = '<div class="panel empty">正在读取运行详情...</div>'
    try {
        if (state?.run?.running && state?.core && id === state.core.runId) return renderHistory()
        const data = await api(`/api/history/${encodeURIComponent(id)}`)
        const accounts = data.run.accounts
            .map(
                account =>
                    `<article class="task-account"><h3>${esc(account.label)}</h3><p>${account.success === true ? '完成' : account.success === false ? '失败' : '待确认'} · ${valueOrUnknown(account.collected, ' 分')}</p><div class="table-wrap"><table><thead><tr><th>任务</th><th>状态</th><th>进度</th><th>预计分值</th><th>实际得分</th></tr></thead><tbody>${account.tasks?.length ? account.tasks.map(task => `<tr><td>${esc(task.title)}</td><td>${taskStatusLabel(task.status)}</td><td>${task.progress ? `${task.progress.current}/${task.progress.total}` : '待确认'}</td><td>${valueOrUnknown(task.expectedPoints, ' 分')}</td><td>${valueOrUnknown(task.earnedPoints, ' 分')}</td></tr>`).join('') : '<tr><td colspan="5" class="empty">此记录没有结构化任务明细</td></tr>'}</tbody></table></div></article>`
            )
            .join('')
        content.innerHTML = `<section class="section"><div class="section-head"><div><h2>运行详情</h2><p>${formatTime(data.run.startedAt)} 至 ${formatTime(data.run.endedAt)} · ${valueOrUnknown(data.run.collected, ' 分')}</p></div><button class="ghost" data-action="history-back">返回</button></div><div class="task-grid">${accounts}</div></section><section class="section"><div class="section-head"><div><h2>执行步骤</h2></div></div><div class="timeline">${stepMarkup(data.logs)}</div><details class="diagnostic"><summary>展开原始脱敏诊断日志</summary><div class="log-view">${logMarkup(data.logs)}</div></details></section>`
    } catch (error) {
        content.innerHTML = `<div class="panel empty">${esc(error.message)}</div>`
    }
}

async function renderWeCom() {
    content.innerHTML = '<div class="panel empty">正在读取企业微信配置...</div>'
    try {
        const item = await api('/api/wecom')
        content.innerHTML = `<section class="section"><div class="section-head"><div><h2>企业微信通知</h2><p>凭证加密保存且永不回显；自定义反代会接触 Secret 和访问令牌，只应填写可信地址。</p></div><button class="ghost" data-action="wecom-test" ${!item.configured ? 'disabled' : ''}>发送测试通知</button></div>
            <form id="wecomForm" class="panel form-grid panel-body"><label class="check full"><input name="enabled" type="checkbox" ${item.enabled ? 'checked' : ''}>启用企业微信通知</label><label>连接方式<select name="mode"><option value="direct" ${item.mode !== 'custom' ? 'selected' : ''}>直连</option><option value="custom" ${item.mode === 'custom' ? 'selected' : ''}>自定义反代</option></select></label><label>反代基础地址<input name="baseUrl" type="url" placeholder="${item.customBaseConfigured ? '已保存，留空保留' : 'https://proxy.example.com'}"></label><label>企业 ID<input name="corpId" placeholder="${item.hasCorpId ? '已保存，留空保留' : '未配置'}"></label><label>应用 AgentId<input name="agentId" placeholder="${item.hasAgentId ? '已保存，留空保留' : '未配置'}"></label><label>应用 Secret<input name="corpSecret" type="password" autocomplete="new-password" placeholder="${item.hasSecret ? '已保存，留空保留' : '未配置'}"></label><label>接收成员<input name="toUser" placeholder="留空保留，默认 @all"></label><label class="check full danger-zone"><input name="clearSecret" type="checkbox">明确清除已保存的 Secret</label><div class="form-actions full"><button class="primary" type="submit" ${!item.writable ? 'disabled' : ''}>保存配置</button></div></form>
            <div class="panel"><dl class="details-list"><dt>配置来源</dt><dd>${item.source === 'encrypted' ? 'Web 加密配置库' : '环境变量（保存后转入加密配置库）'}</dd><dt>连接模式</dt><dd>${item.mode === 'custom' ? '自定义反代' : '直连'}</dd><dt>配置状态</dt><dd>${item.configured ? '配置完整' : '未配置完整'}</dd><dt>接收范围</dt><dd>${esc(item.recipient || '-')}</dd><dt>最近成功</dt><dd>${formatTime(item.lastSuccessAt)}</dd><dt>最近错误</dt><dd>${esc(item.lastError || '-')}</dd></dl></div></section>`
    } catch (error) {
        content.innerHTML = `<div class="panel empty">${esc(error.message)}</div>`
    }
}

function renderSystem() {
    const core = state?.core || {}
    content.innerHTML = `<section class="section"><div class="section-head"><div><h2>系统状态</h2></div></div><div class="panel"><dl class="details-list"><dt>核心连接</dt><dd>${core.available ? '正常' : '不可用'}</dd><dt>核心状态</dt><dd>${esc(core.label || '-')}</dd><dt>核心版本</dt><dd>${esc(core.version || '-')}</dd><dt>核心启动时间</dt><dd>${formatTime(core.startedAt)}</dd><dt>最近退出</dt><dd>${core.lastExit ? `代码 ${core.lastExit.code ?? '-'} · ${formatTime(core.lastExit.at)}` : '-'}</dd><dt>日志缓冲数量</dt><dd>${valueOrUnknown(core.logCount)}</dd><dt>持久历史</dt><dd>${state?.history?.runs || 0} 次运行</dd><dt>Web 状态更新时间</dt><dd>${formatTime(state?.updatedAt)}</dd></dl></div></section>`
}

function renderCurrent() {
    if (!state) return
    if (currentView === 'dashboard') renderDashboard()
    else if (currentView === 'accounts') void renderAccounts()
    else if (currentView === 'tasks') renderTasks()
    else if (currentView === 'calendar') void renderCalendar()
    else if (currentView === 'history') void renderHistory()
    else if (currentView === 'wecom') void renderWeCom()
    else renderSystem()
}

async function refreshCurrent() {
    try {
        await loadState()
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
        if (!['calendar', 'history', 'accounts', 'wecom'].includes(currentView)) renderCurrent()
    })
    events.addEventListener('log', event => {
        const log = JSON.parse(event.data)
        liveLogs.push(log)
        liveLogs = liveLogs.slice(-500)
        if (currentView === 'history' && !historyRefreshTimer) {
            historyRefreshTimer = setTimeout(() => {
                historyRefreshTimer = null
                void renderHistory()
            }, 500)
        }
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
