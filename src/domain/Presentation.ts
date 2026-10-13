export const stateLabel = (state: string): string =>
  ({
    confirmed: '已确认',
    final: '最终观测',
    live: '实时观测',
    unmatched: '—',
    overreported: '上报超额',
    conflict: '数据冲突',
    unavailable: '暂无数据',
    pending: '—'
  })[state] ?? '—'

// Legacy diagnostics remain unchanged in storage; the presentation contract applies on output.
export const publicText = (text: string): string => {
  const mapped = taskFailure(text).failureLabel
  return (mapped ?? text).replace(/待确认(?:积分)?|未取得|未匹配/g, '—')
}

export function taskFailure(reason?: string) {
  const labels: Record<string, string> = {
    'offer-not-found-before-activation': '链接不可用',
    'offer-activation-failed': '任务激活失败，结果不明',
    'offer-submission-rejected': '任务提交被拒绝',
    'task-verification-failed': '任务复核未通过',
    'task-still-incomplete': '已执行，官方进度仍未完成',
    'task-not-found-during-verification': '已执行，复核未找到原任务',
    'task-verification-timeout': '已执行，只读复核超时',
    'task-verification-unavailable': '已执行，复核数据暂不可用',
    'task-verification-source-mismatch': '已执行，复核任务或来源不一致',
    'task-verification-date-changed': '业务日期已变化，原任务待复核',
    'offer-authentication-failed': '任务页面需要认证',
    'offer-network-failed': '任务页面网络失败',
    'offer-browser-failed': '任务页面浏览器异常',
    'offer-invalid-destination': '任务链接不安全'
  }
  return {
    errorCode: reason && labels[reason] ? reason : null,
    failureLabel: reason ? (labels[reason] ?? null) : null,
    activationStarted:
      reason === 'offer-not-found-before-activation'
        ? false
        : reason === 'offer-activation-failed'
          ? true
          : null
  }
}

const detailedFailureLabels: Record<string, string> = {
  'offer-not-found-before-activation': '任务链接已失效或不可用',
  'offer-activation-failed': '任务激活失败，页面无响应',
  'offer-submission-rejected': '提交被微软拒绝，可能已过期',
  'task-verification-failed': '任务复核未通过，稍后重试',
  'task-still-incomplete': '已尝试执行，但官方进度仍未达标',
  'task-not-found-during-verification': '复核时未找到该任务',
  'task-verification-timeout': '复核超时，网络响应过慢',
  'task-verification-unavailable': '复核数据暂不可用',
  'task-verification-source-mismatch': '复核任务或来源不一致',
  'task-verification-date-changed': '跨天日期变更，保留待复核',
  'offer-authentication-failed': '账号登录态失效，需重新认证',
  'offer-network-failed': '网络连接异常，页面加载超时',
  'offer-browser-failed': '自动化浏览器执行异常',
  'offer-invalid-destination': '任务目标链接安全检查未通过',
  'dashboard-request-failed': '微软仪表盘请求超时，已保留进度稍后重试',
  'progress-unconfirmed': '已提交但官方进度未及时刷新，稍后复核',
  'stagnant-progress': '连续多次查询未见积分增长，已自动安全停止',
  'stagnant-search': '搜索积分未再增加，已自动收工',
  'query-limit-reached': '已达到单次最大搜索次数上限',
  'network-or-provider-error': '消息推送服务网络异常',
    'action-required': '需要人工在浏览器中处理',
  'verification-pending': '等待微软服务器确认进度',
  'Execution stopped; verification remains pending': '运行已停止，保留待复核',
  'Execution stopped (user-cancelled); verification remains pending': '用户手动停止，保留待复核',
  'Execution stopped (process-interrupted); verification remains pending': '进程中断(SIGTERM/SIGINT)，保留待复核'
}

export function friendlyFailureReason(reason?: string | null): string {
  if (!reason) return '—'
  const trimmed = reason.trim()
  if (!trimmed) return '—'
  if (detailedFailureLabels[trimmed]) return detailedFailureLabels[trimmed]
  const mapped = taskFailure(trimmed).failureLabel
  if (mapped) return mapped
  if (/^[a-z0-9_-]+$/i.test(trimmed)) {
    return trimmed.replace(/-/g, ' ')
  }
  return publicText(trimmed)
}

export interface TaskTypeInfo {
  label: string
  icon: string
  fullLabel: string
}

export function taskTypeInfo(type?: string | null): TaskTypeInfo {
  const map: Record<string, { label: string; icon: string }> = {
    'pc-search': { label: 'PC 必应搜索', icon: '💻' },
    'mobile-search': { label: '移动必应搜索', icon: '📱' },
    'read-to-earn': { label: 'MSN 资讯阅读', icon: '📰' },
    'app-check-in': { label: '每日签到', icon: '📅' },
    'pc-check-in': { label: 'PC 每日签到', icon: '🖥️' },
    'daily-set': { label: '每日任务', icon: '🧩' },
    'punch-card': { label: '打卡活动', icon: '📦' },
    'more-promotion': { label: '更多推广', icon: '🎁' },
    'special-promotion': { label: '限时特惠活动', icon: '✨' },
    'claim-bonus-points': { label: '额外积分奖励', icon: '🎉' },
    'app-activity': { label: '移动端专属活动', icon: '⚡' },
    unknown: { label: '其他活动', icon: '📌' }
  }
  const key = type ?? 'unknown'
  const item = map[key] ?? { label: type || '其他活动', icon: '📌' }
  return {
    label: item.label,
    icon: item.icon,
    fullLabel: `${item.icon} ${item.label}`
  }
}

export function friendlyTaskDisplayName(task: {
  taskId?: string | null | undefined
  displayName?: string | null | undefined
  type?: string | null | undefined
}): string {
  const raw = task.displayName?.trim()
  const id = (task.taskId ?? '').toLowerCase()
  const type = (task.type ?? '').toLowerCase()
  const combined = `${id} ${raw ?? ''}`.toLowerCase()

  if (raw && /[\u4e00-\u9fa5]/.test(raw)) {
    return publicText(raw)
  }

  if (
    type === 'read-to-earn' ||
    combined.includes('readarticle') ||
    combined.includes('read-to-earn')
  ) {
    return 'MSN 资讯阅读'
  }
  if (type === 'pc-search' || combined.includes('pc-search') || combined.includes('pc_search')) {
    return 'PC 必应搜索'
  }
  if (
    type === 'mobile-search' ||
    combined.includes('mobile-search') ||
    combined.includes('mobile_search')
  ) {
    return '移动必应搜索'
  }
  if (
    type === 'pc-check-in' ||
    combined.includes('pc-check-in') ||
    combined.includes('pc_check_in') ||
    id === 'pc-check-in'
  ) {
    return 'PC 每日签到'
  }
  if (
    combined.includes('rewardsapp_weekly_exclusive') ||
    combined.includes('weekly_exclusive')
  ) {
    return '电脑端专属周任务'
  }
  if (
    type === 'app-check-in' ||
    combined.includes('app-check-in') ||
    combined.includes('checkin') ||
    combined.includes('check-in')
  ) {
    return '每日签到'
  }
  if (combined.includes('quiz')) {
    return '每日测验'
  }
  if (combined.includes('poll')) {
    return '每日投票'
  }

  if (task.type) {
    const info = taskTypeInfo(task.type)
    if (info.label && info.label !== '其他活动' && info.label !== task.type) {
      return info.label
    }
  }

  if (raw && !/^[a-z0-9_:-]+$/i.test(raw)) {
    return publicText(raw)
  }

  return taskTypeInfo(task.type).label
}
