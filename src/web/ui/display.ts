export const stateLabel = (value: string): string =>
  ({
    running: '进行中',
    queued: '等待执行',
    cancelling: '正在停止',
    completed: '执行已结束',
    success: '成功',
    partial: '部分完成',
    failed: '失败',
    cancelled: '已停止',
    interrupted: '中断',
    'action-required': '需要人工处理',
    confirmed: '已确认',
    pending: '待确认',
    provisional: '暂时',
    live: '实时运行',
    durable: '已保存',
    discovered: '待执行',
    submitted: '已提交',
    'verification-pending': '待复核',
    skipped: '已跳过',
    unknown: '待确认'
  })[value] ?? '待确认'

export function points(value: number | null | undefined): string {
  return value === null || value === undefined || !Number.isFinite(value)
    ? '待确认'
    : `${value > 0 ? '+' : ''}${String(value)} 分`
}

export function clockTime(value: string | null | undefined): string {
  return value && Number.isFinite(Date.parse(value))
    ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
    : '待确认'
}

export function duration(start: string | null | undefined, end: string | null | undefined): string {
  if (!start || !end) return '待确认'
  const elapsed = Date.parse(end) - Date.parse(start)
  if (!Number.isFinite(elapsed) || elapsed < 0) return '待确认'
  const seconds = Math.floor(elapsed / 1000)
  return `${String(Math.floor(seconds / 3600))}时${String(Math.floor(seconds / 60) % 60)}分${String(seconds % 60)}秒`
}
