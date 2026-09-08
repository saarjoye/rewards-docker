const timestamp = value => typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null
const time = value => new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
}).format(new Date(value))

export function accountTimingMarkup(timing = {}, now = Date.now()) {
    const start = timestamp(timing?.startedAt)
    const end = timestamp(timing?.endedAt)
    const running = timing?.running === true && end === null
    const until = running ? now : end
    const elapsed = start !== null && until !== null && Number.isFinite(until) && until >= start ? Math.floor((until - start) / 1000) : null
    const duration = elapsed === null ? '待确认' : `${Math.floor(elapsed / 3600)}小时${Math.floor(elapsed % 3600 / 60)}分${elapsed % 60}秒`
    return '<div class="account-timing" aria-label="账号执行时间，Asia/Shanghai">' +
        '<span>开始时间 <strong>' + (start === null ? '待确认' : time(start)) + '</strong></span>' +
        '<span>- 结束时间 <strong>' + (end !== null ? time(end) : running ? '进行中' : '待确认') + '</strong></span>' +
        '<span>= ' + (running ? '已执行' : '执行时间') + ' <strong>' + duration + '</strong></span></div>'
}
