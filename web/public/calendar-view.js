import { taskStatusLabel } from './run-view.js'

const esc = value =>
    String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;')
const iso = date => date.toISOString().slice(0, 10)
const parseDate = value => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? '')) throw new Error('日期格式无效')
    const date = new Date(value + 'T00:00:00Z')
    if (!Number.isFinite(date.getTime()) || iso(date) !== value) throw new Error('日期无效')
    return date
}
const number = value => (typeof value === 'number' && Number.isFinite(value) ? value : null)
const points = value => (number(value) === null ? '待确认' : (value > 0 ? '+' : '') + value)
const sources = {
    rsc: '网页活动',
    flyout: 'Bing 任务',
    dashboard: '网页任务',
    app: 'App 活动',
    pcSearch: '桌面搜索',
    mobileSearch: '移动搜索',
    readToEarn: '阅读',
    checkIn: '签到',
    bonus: '奖励领取'
}

export function calendarRange(preset, today, custom = {}) {
    const end = parseDate(today)
    const start = new Date(end)
    if (preset === 'custom') {
        parseDate(custom.start)
        parseDate(custom.end)
        if (custom.start > custom.end) throw new Error('开始日期不能晚于结束日期')
        if (Date.parse(custom.end) - Date.parse(custom.start) > 365 * 86400000) throw new Error('单次查询最多 366 天')
        return { start: custom.start, end: custom.end }
    }
    if (preset === 'week') start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7))
    else if (preset === 'quarter') start.setUTCMonth(Math.floor(start.getUTCMonth() / 3) * 3, 1)
    else if (preset === 'year') start.setUTCMonth(0, 1)
    else start.setUTCDate(1)
    return { start: iso(start), end: iso(end) }
}

export function calendarDays(range, days) {
    const start = parseDate(range.start)
    const end = parseDate(range.end)
    if (start > end || (end - start) / 86400000 > 365) throw new Error('日期范围无效或超过 366 天')
    const byDate = new Map(days.map(day => [day.date, day]))
    const result = []
    for (const date = new Date(start); date <= end; date.setUTCDate(date.getUTCDate() + 1)) {
        const key = iso(date)
        result.push(byDate.get(key) ?? { date: key, totalGained: null, records: 0, status: 'not-run' })
    }
    return result
}

function categoryMarkup(values) {
    const entries = Object.entries(values ?? {}).filter(([, value]) => number(value) !== null)
    return entries.length
        ? entries
              .map(
                  ([key, value]) =>
                      '<span class="calendar-category">' + esc(sources[key] ?? key) + ' ' + points(value) + '</span>'
              )
              .join('')
        : '未归类'
}

export function calendarMarkup(data) {
    const days = calendarDays(data.range, data.days ?? [])
    const max = Math.max(1, ...days.map(day => number(day.totalGained) ?? 0))
    const grid = days
        .map(day => {
            const known = number(day.totalGained) !== null
            const heat =
                known && day.totalGained > 0 ? Math.min(4, Math.max(1, Math.ceil((day.totalGained / max) * 4))) : 0
            return (
                '<article class="calendar-cell heat-' +
                heat +
                '"><strong>' +
                esc(day.date) +
                '</strong><b>' +
                (day.status === 'not-run' ? '无记录' : points(day.totalGained)) +
                '</b><span>' +
                (day.status === 'not-run' ? '未运行或无记录' : esc(taskStatusLabel(day.status))) +
                ' · ' +
                Number(day.records || 0) +
                ' 条记录</span></article>'
            )
        })
        .join('')
    const groups = new Map()
    for (const record of data.records ?? []) {
        const key = JSON.stringify([record.date, record.accountId])
        if (!groups.has(key)) groups.set(key, [])
        groups.get(key).push(record)
    }
    const rows = [...groups.values()]
        .map(records => {
            const record = records[0]
            const ordered = records.toSorted((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)))
            const verified = records.filter(item => item.verification !== 'legacy' && number(item.runGained) !== null)
            const subtotal = verified.length ? verified.reduce((sum, item) => sum + item.runGained, 0) : null
            const unknown = records.length - verified.length
            const status = records.every(item => item.status === 'completed')
                ? 'completed'
                : records.some(item => item.status === 'interrupted')
                  ? 'interrupted'
                  : records.some(item => item.status === 'failed')
                    ? 'failed'
                    : 'partial'
            const runs = ordered
                .map(
                    run =>
                        '<tr><td>' +
                        esc(run.startedAt || '-') +
                        '</td><td>' +
                        esc(run.endedAt || '-') +
                        '</td><td>' +
                        (number(run.beforePoints) ?? '待确认') +
                        '</td><td>' +
                        (number(run.afterPoints) ?? '待确认') +
                        '</td><td>' +
                        points(run.runGained) +
                        (run.verification === 'legacy' ? '（旧记录未核验）' : '') +
                        '</td><td>' +
                        esc(taskStatusLabel(run.status)) +
                        '</td><td>' +
                        categoryMarkup(run.sources) +
                        '</td><td><button class="small-button" data-action="history-detail" data-id="' +
                        esc(run.runId) +
                        '">运行详情</button></td></tr>'
                )
                .join('')
            return (
                '<tr><td>' +
                esc(record.date) +
                '</td><td>' +
                esc(record.accountLabel) +
                '</td><td>' +
                (number(ordered[0].beforePoints) ?? '待确认') +
                '</td><td>' +
                (number(ordered.at(-1).afterPoints) ?? '待确认') +
                '</td><td>' +
                points(subtotal) +
                (unknown ? '<small>' + unknown + ' 条未核验或待确认</small>' : '') +
                '</td><td>' +
                esc(taskStatusLabel(status)) +
                '</td><td>' +
                records.length +
                ' 次</td></tr>' +
                '<tr class="calendar-runs"><td colspan="7"><details><summary>查看 ' +
                records.length +
                ' 次执行记录</summary><div class="table-wrap"><table><thead><tr><th>开始</th><th>结束</th><th>任务前</th>' +
                '<th>任务后</th><th>本次积分</th><th>状态</th><th>分类来源</th><th>明细</th></tr></thead><tbody>' +
                runs +
                '</tbody></table></div></details></td></tr>'
            )
        })
        .join('')
    return (
        '<section class="section"><div class="section-head"><h2>日历视图</h2></div><div class="calendar-grid">' +
        grid +
        '</div></section><section class="section"><div class="section-head"><h2>账号与日期明细</h2></div>' +
        (rows
            ? '<div class="table-wrap"><table class="calendar-records"><thead><tr><th>日期</th><th>账号</th>' +
              '<th>任务前</th><th>任务后</th><th>运行已确认小计</th><th>状态</th><th>执行次数</th></tr></thead><tbody>' +
              rows +
              '</tbody></table></div>'
            : '<div class="empty">当前筛选范围没有执行记录</div>') +
        '</section>'
    )
}
