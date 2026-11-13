/**
 * 企业微信应用消息类型解析 + 各类消息体构造。
 *
 * 样式约定（2026-11-13 按用户确认定稿）：
 *   默认用 `textcard`（图文卡片）：在企业微信里是不带头像的灰色卡片，
 *   标题一行、正文多行，视觉效果最好——这正是用户要求的样式。
 *
 * 但 textcard 的 description 是 HTML，客户端对 class 的支持并不一致：
 *   实测 `div.gray` / `div.normal` 渲染正常，唯独 `div.highlight`
 *   在部分客户端（微信插件 / 中转链路）会**原样漏出**
 *   `<div class="highlight">` 这串标签文字。
 *   因此这里彻底不用 `highlight`，平台署名改用 `normal`，
 *   既保留卡片外观，又不会漏标签。
 */

export const WEWORK_MSG_TYPES = ['textcard', 'news', 'text'];

/** 按字节安全截断（不切断多字节字符）。企业微信 textcard/news 的 description 上限 512 字节 */
export function truncateBytes(text = '', maxBytes = 480) {
  const str = String(text || '');
  const buf = Buffer.from(str, 'utf8');
  if (buf.length <= maxBytes) return str;
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end -= 1;
  return `${buf.subarray(0, end).toString('utf8').replace(/[\s·]+$/, '')}…`;
}

/** HTML 转义，避免正文里混入的 < > & 破坏卡片结构 */
export function escapeHtml(text = '') {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function resolveWeworkMsgType(weworkApp = {}) {
  const chosen = String(weworkApp?.msgTypeChosen || '').toLowerCase().trim();
  if (chosen === 'textcard') return 'textcard';
  if (chosen === 'news') return 'news';
  if (chosen === 'text') return 'text';
  const configured = String(weworkApp?.msgType || '').toLowerCase().trim();
  if (configured === 'news' || configured === 'text' || configured === 'textcard') {
    // 没有显式选择标记的历史配置：统一回到 textcard 卡片样式
    return 'textcard';
  }
  return 'textcard';
}

/** 判断配置是否是被历史版本写入的 textcard（用于日志提示） */
export function isLegacyTextcardConfig(weworkApp = {}) {
  const chosen = String(weworkApp?.msgTypeChosen || '').toLowerCase().trim();
  const configured = String(weworkApp?.msgType || '').toLowerCase().trim();
  return !chosen && configured === 'textcard';
}

/** 把战报正文拆成干净的单行数组（去掉 Markdown 符号与裸 HTML） */
export function splitReportLines(body = '') {
  return String(body || '')
    .split('\n')
    .map((line) => line
      .replace(/<[^>]*>/g, '')
      .replace(/^[>\s*#]+/, '')
      .replace(/\*\*/g, '')
      .replace(/`/g, '')
      .trim())
    .filter(Boolean);
}

/**
 * 构造 textcard 的 description：只使用 gray / normal 两种 class，绝不使用 highlight。
 */
export function buildTextCardDescription({
  dateLabel = '',
  body = '',
  footer = '🤖 Microsoft Rewards 自动化平台',
  maxBytes = 480
} = {}) {
  const entries = [];
  if (dateLabel) entries.push({ cls: 'gray', text: `统计日期: ${dateLabel}` });
  for (const line of splitReportLines(body)) entries.push({ cls: 'normal', text: line });
  if (footer) entries.push({ cls: 'normal', text: footer });

  const wrap = (cls, text) => `<div class="${cls}">${escapeHtml(text)}</div>`;
  const bytes = (s) => Buffer.byteLength(s, 'utf8');

  const parts = [];
  let used = 0;
  for (const entry of entries) {
    const full = wrap(entry.cls, entry.text);
    if (used + bytes(full) <= maxBytes) {
      parts.push(full);
      used += bytes(full);
      continue;
    }
    // 放不下整行：把这一行的文字截短，但**必须保留完整的 </div>**，
    // 否则 description 末尾会出现未闭合的 <div class="normal">，客户端会把它当文字显示出来。
    const wrapperBytes = bytes(wrap(entry.cls, ''));
    const ellipsisBytes = bytes('…');
    const budget = maxBytes - used - wrapperBytes - ellipsisBytes;
    if (budget > 6) {
      // 逐字回退，确保转义后（& → &amp;）也不超限
      let text = entry.text;
      while (text.length > 0 && bytes(escapeHtml(text)) > budget) {
        text = text.slice(0, -1);
      }
      if (text) parts.push(wrap(entry.cls, `${text}…`));
    }
    break;
  }
  return parts.join('');
}

/** 构造 news 卡片的 description（纯文本版式，无 HTML） */
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
    ...splitReportLines(body),
    footer
  ].filter((line) => line && String(line).trim());
  return truncateBytes(lines.join('\n'), maxBytes);
}

/** 构造纯文本消息正文（保留卡片那套版式） */
export function buildTextContent({ title = '', dateLabel = '', body = '', footer = '🤖 Microsoft Rewards 自动化平台' } = {}) {
  return [
    title ? `🎁 ${title}` : '',
    dateLabel ? `统计日期: ${dateLabel}` : '',
    ...splitReportLines(body),
    footer
  ].filter((line) => line && String(line).trim()).join('\n');
}
