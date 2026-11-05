/**
 * 企业微信应用消息类型解析（含历史配置迁移）。
 *
 * 背景：v6.8.26 的 updateNotifyConfig 会把 `msgType: 'textcard'` 写进 config.json，
 * 之后即使在代码里改了默认值，**已保存的旧配置**依然会让消息走 textcard，
 * 于是在微信/插件里露出 `<div class="highlight">` 这类标签。
 *
 * 现在默认走 `news`（图文消息卡片）：企业微信里是带标题的卡片，微信里也显示为卡片，
 * 且完全不依赖 HTML 标签，不会漏标签。
 */

export const WEWORK_MSG_TYPES = ['news', 'text', 'textcard'];

/** 按字节安全截断（不切断多字节字符）。企业微信 news 的 description 上限 512 字节 */
export function truncateBytes(text = '', maxBytes = 480) {
  const str = String(text || '');
  const buf = Buffer.from(str, 'utf8');
  if (buf.length <= maxBytes) return str;
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end -= 1;
  return `${buf.subarray(0, end).toString('utf8').replace(/[\s·]+$/, '')}…`;
}

export function resolveWeworkMsgType(weworkApp = {}) {
  const chosen = String(weworkApp?.msgTypeChosen || '').toLowerCase().trim();
  if (chosen === 'textcard') return 'textcard';
  if (chosen === 'text') return 'text';
  if (chosen === 'news') return 'news';
  // 没有任何显式选择 → 默认用 news 卡片（老配置里的 textcard/text 都会升级到 news）
  return 'news';
}

/** 判断配置是否是被历史版本写入的 textcard（用于日志提示） */
export function isLegacyTextcardConfig(weworkApp = {}) {
  const chosen = String(weworkApp?.msgTypeChosen || '').toLowerCase().trim();
  const configured = String(weworkApp?.msgType || '').toLowerCase().trim();
  return !chosen && configured === 'textcard';
}

/** 构造 news 卡片的 description：标题行 + 统计日期 + 正文 + 平台署名，按字节截断 */
export function buildNewsDescription({
  title = '',
  dateLabel = '',
  body = '',
  footer = '🤖 Microsoft Rewards 自动化平台',
  maxBytes = 480
} = {}) {
  const lines = [
    title ? `🎁 ${title}` : '',
    dateLabel ? `统计日期: ${dateLabel}` : '',
    String(body || '').trimEnd(),
    footer
  ].filter((line) => line && line.trim());
  return truncateBytes(lines.join('\n'), maxBytes);
}
