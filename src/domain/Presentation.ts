export const stateLabel = (state: string): string =>
  ({
    confirmed: '已确认',
    final: '最终观测',
    live: '实时观测',
    unmatched: '未匹配',
    overreported: '上报超额',
    conflict: '数据冲突',
    unavailable: '暂无数据',
    pending: '—'
  })[state] ?? '—'

// Legacy diagnostics remain unchanged in storage; the presentation contract applies on output.
export const publicText = (text: string): string => text.replaceAll('待确认', '未匹配')
