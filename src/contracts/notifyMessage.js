/**
 * 企业微信应用消息类型解析（含历史配置迁移）。
 *
 * 背景：v6.8.26 的 updateNotifyConfig 会把 `msgType: 'textcard'` 写进 config.json，
 * 之后即使在代码里把默认值改成 `text`，**已保存的旧配置**依然会让消息走 textcard，
 * 于是在微信/插件里露出 `<div class="highlight">` 这类标签。
 *
 * 规则：
 *  - 用户在界面上显式选择过（msgTypeChosen 有值）→ 尊重用户选择；
 *  - 没有显式选择、但配置里是 textcard（历史写入）→ 自动迁移为 text，避免漏 HTML；
 *  - 其它情况默认 text。
 */
export function resolveWeworkMsgType(weworkApp = {}) {
  const chosen = String(weworkApp?.msgTypeChosen || '').toLowerCase().trim();
  if (chosen === 'textcard') return 'textcard';
  if (chosen === 'text') return 'text';
  const configured = String(weworkApp?.msgType || '').toLowerCase().trim();
  // 历史配置（v6.8.26 自动写入的 textcard）→ 迁移成 text
  if (configured === 'textcard') return 'text';
  return 'text';
}

/** 判断配置是否发生过"textcard → text"的历史迁移（用于日志提示） */
export function isLegacyTextcardConfig(weworkApp = {}) {
  const chosen = String(weworkApp?.msgTypeChosen || '').toLowerCase().trim();
  const configured = String(weworkApp?.msgType || '').toLowerCase().trim();
  return !chosen && configured === 'textcard';
}
