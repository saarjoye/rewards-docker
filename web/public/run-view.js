const esc = value =>
    String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;')
const amount = value => (value === null || value === undefined ? '待确认' : `${Number(value)} 分`)
export function taskStatusLabel(status) {
    return (
        {
            pending: '待执行',
            running: '执行中',
            verifying: '待复核',
            completed: '已完成',
            partial: '部分完成',
            stopped: '未得分停止',
            failed: '失败',
            skipped: '已跳过',
            locked: '未解锁',
            interrupted: '已中断',
            unknown: '待确认'
        }[status] || '待确认'
    )
}
export function taskTableMarkup(tasks, dataStatus = 'not-read') {
    const empty =
        {
            'not-read': '尚未读取任务数据',
            pending: '正在读取任务数据',
            unavailable: '任务数据获取失败',
            partial: '部分任务来源不可用',
            available: '当前数据源没有任务'
        }[dataStatus] || '任务数据待确认'
    const rows = tasks?.length
        ? tasks
              .map(task => {
                  const progress = task.progress
                      ? `${task.progress.current}/${task.progress.total} ${task.progress.unit === 'items' ? '项' : '分'}`
                      : '待确认'
                  const attempt = task.attemptProgress
                      ? `尝试 ${task.attemptProgress.current}/${task.attemptProgress.total} 次`
                      : ''
                  const state = taskStatusLabel(task.status)
                  const legacy =
                      task.verification === 'legacy'
                          ? '（旧记录未核验）'
                          : task.verification === 'pending'
                            ? '（待复核）'
                            : ''
                  const time = task.updatedAt
                      ? new Date(task.updatedAt).toLocaleTimeString('zh-CN', { hour12: false })
                      : '-'
                  return `<tr><td>${esc(task.title)}<small>${esc(task.platform || '')}</small></td><td>${esc(state)}</td><td class="task-action">${esc(task.action || state)}${task.stale ? '<strong class="warn">长时间无有效进展</strong>' : ''}<small>${task.elapsedSeconds === null || task.elapsedSeconds === undefined ? '' : `${Number(task.elapsedSeconds)} 秒`} ${esc(time)}</small></td><td>${esc(progress)}<small>${esc(attempt)}</small></td><td>${amount(task.expectedPoints)}</td><td>${amount(task.remainingPoints)}</td><td>${task.group ? '-' : amount(task.earnedPoints)}<small>${esc(legacy)}</small></td></tr>`
              })
              .join('')
        : `<tr><td colspan="7" class="empty">${esc(empty)}</td></tr>`
    return `<div class="table-wrap"><table class="task-table"><thead><tr><th>任务</th><th>状态</th><th>当前动作</th><th>进度</th><th>预计分值</th><th>剩余额度</th><th>已确认得分</th></tr></thead><tbody>${rows}</tbody></table></div>`
}
export function filterAndGroupLogs(logs, { level = '', query = '' } = {}) {
    const grouped = []
    for (const log of logs) {
        const previous = grouped.at(-1)
        const key = JSON.stringify([log.runId, log.platform, log.title, log.displayMessage, log.message])
        if (log.level === 'debug' && previous?.level === 'debug' && previous.groupKey === key) {
            previous.repeatCount++
            previous.lastReceivedAt = log.receivedAt || log.ts
        } else grouped.push({ ...log, groupKey: key, repeatCount: 1, lastReceivedAt: log.receivedAt || log.ts })
    }
    const needle = query.trim().toLowerCase()
    return grouped.filter(
        log =>
            (!level || log.level === level) &&
            (!needle ||
                `${log.titleLabel} ${log.platformLabel} ${log.displayMessage} ${log.message}`
                    .toLowerCase()
                    .includes(needle))
    )
}
