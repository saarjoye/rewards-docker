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
    final: '最终观测',
    unmatched: '—',
    overreported: '上报超额',
    conflict: '数据冲突',
    unavailable: '暂无数据',
    pending: '—',
    provisional: '暂时',
    live: '实时观测',
    durable: '已保存',
    discovered: '待执行',
    submitted: '已提交',
    'verification-pending': '待复核',
    skipped: '已跳过',
    unknown: '—'
  })[value] ?? '—'

export { publicText } from '../../domain/Presentation'

export function points(value: number | null | undefined): string {
  return value === null || value === undefined || !Number.isFinite(value)
    ? '—'
    : `${value > 0 ? '+' : ''}${String(value)} 分`
}

export function clockTime(value: string | null | undefined): string {
  return value && Number.isFinite(Date.parse(value))
    ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
    : '—'
}

export function duration(start: string | null | undefined, end: string | null | undefined): string {
  if (!start || !end) return '—'
  const elapsed = Date.parse(end) - Date.parse(start)
  if (!Number.isFinite(elapsed) || elapsed < 0) return '—'
  const seconds = Math.floor(elapsed / 1000)
  return `${String(Math.floor(seconds / 3600))}时${String(Math.floor(seconds / 60) % 60)}分${String(seconds % 60)}秒`
}
