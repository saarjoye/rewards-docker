const esc = value =>
    String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;')
const amount = value => (value === null || value === undefined ? '待确认' : `${Number(value)} 分`)
export const platformLabel = value => ({ mobile: '移动端', desktop: '桌面端', main: '主流程' })[value] || '平台未确认'
export function localeLabel(region, language) {
    const display = (value, type) => {
        if (!value || value === '-') return '未指定'
        if (value === 'auto') return '自动识别'
        try {
            return new Intl.DisplayNames(['zh-CN'], { type, fallback: 'none' }).of(value) || '未识别'
        } catch {
            return '未识别'
        }
    }
    return `${display(region, 'region')} / ${display(language, 'language')}`
}
export function taskStatusLabel(status) {
    return (
        {
            pending: '待执行',
            eligible: '可执行',
            submitted: '已提交，等待积分确认',
            unsupported: '当前版本不支持',
            unavailable: '任务数据不可用',
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
export function taskEligibilityLabel(task) {
    const hasPlanMetadata = Boolean(task?.capability || task?.eligibility || task?.dataStatus || task?.taskType)
    if (!hasPlanMetadata) return ''
    if (task?.capability === 'unsupported') return '当前版本不支持此任务类型'
    if (task?.eligibility === 'locked' || task?.status === 'locked') return '任务尚未解锁'
    if (task?.eligibility === 'manual-required') return '需要人工领取'
    if (task?.eligibility === 'disabled') return '功能开关已关闭'
    if (task?.eligibility === 'data-missing' || task?.dataStatus === 'unavailable' || task?.status === 'unavailable')
        return '任务数据不可用'
    if (task?.eligibility === 'completed' || task?.previouslyCompleted || task?.status === 'skipped')
        return '活动已完成，但本轮未提交'
    if (task?.status === 'submitted' || task?.verification === 'pending') return '已提交，等待积分确认'
    if (task?.verification === 'confirmed') return '已确认获得积分'
    if (task?.verification === 'confirmed-zero') return '已执行，本次无新增积分'
    return ''
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
                  const state = taskEligibilityLabel(task) || (task.status === 'submitted' && task.terminal ? '已提交，复核结束' : taskStatusLabel(task.status))
                  const legacy =
                      task.verification === 'legacy'
                          ? '（旧记录未核验）'
                          : task.verification === 'pending'
                            ? task.terminal
                                ? '（本轮未确认得分）'
                                : '（待复核）'
                            : task.verification === 'confirmed-zero'
                              ? '已执行，本次无新增积分'
                              : task.verification === 'confirmed'
                                ? '得分已确认'
                                : '不适用'
                  const time = task.updatedAt
                      ? new Date(task.updatedAt).toLocaleTimeString('zh-CN', {
                            hour12: false,
                            timeZone: 'Asia/Shanghai'
                        })
                      : '-'
                  return `<tr><td>${esc(task.title)}<small>${esc(platformLabel(task.platform))}</small></td><td>${esc(state)}</td><td class="task-action">${esc(task.action || state)}${task.stale ? '<strong class="warn">长时间无有效进展</strong>' : ''}<small>${task.elapsedSeconds === null || task.elapsedSeconds === undefined ? '' : `累计 ${Number(task.elapsedSeconds)} 秒`} ${esc(time)}</small></td><td>${esc(progress)}<small>${esc(attempt)}</small></td><td>${amount(task.expectedPoints)}</td><td>${amount(task.remainingPoints)}</td><td>${task.group ? '-' : amount(task.earnedPoints)}<small>${esc(legacy)}</small></td></tr>`
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
