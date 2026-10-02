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
