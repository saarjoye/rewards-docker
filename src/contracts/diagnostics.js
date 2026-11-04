import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../fsUtil.js';

/**
 * 诊断日志导出（近 24 小时，全部脱敏）。
 *
 * 目标：出问题时可一键把"现场"导出来，但绝不能把账号密码 / Cookie / Token / Secret
 * 带出去（参考项目 v1.10.8 的 24 小时脱敏诊断日志）。
 */

const REDACT_RULES = [
  // Bearer / JWT 类
  { re: /(Bearer\s+)[A-Za-z0-9._~+/-]{8,}=*/gi, to: '$1<REDACTED_TOKEN>' },
  // key=value 形式里的敏感键（token/secret/password/cookie 等）
  {
    re: /("?\b(?:pass|password|pwd|secret|corpsecret|client_secret|access_token|refresh_token|token|authorization|cookie|set-cookie|sessionSecret)\b"?\s*[:=]\s*"?)([^"\s,;}]{3,})/gi,
    to: '$1<REDACTED>'
  },
  // Cookie 串 name=value（保留 name，值脱敏）；offerId/activityId 这类排查必需的标识不脱敏
  {
    re: /\b(?!(?:offerId|offerid|activityId|activityid|questId|questid)\b)([A-Za-z0-9_.\-]{2,})[=:]([A-Za-z0-9%._~+/=\-]{12,})/gi,
    to: '$1=<REDACTED>'
  },
  // 邮箱
  { re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, to: '<EMAIL>' },
  // 代理里的账号密码 user:pass@host
  { re: /\/\/([^:/@\s]+):([^@\s]+)@/g, to: '//<USER>:<PASS>@' },
  // 长十六进制/长随机串（hash、offerId 里的 hash、activity id 等）
  { re: /\b[a-f0-9]{24,}\b/gi, to: '<HASH>' },
  // 手机号
  { re: /\b1[3-9]\d{9}\b/g, to: '<PHONE>' }
];

export function redactText(text = '') {
  let out = String(text || '');
  for (const rule of REDACT_RULES) out = out.replace(rule.re, rule.to);
  return out;
}

function parseLogTimestamp(line = '') {
  const match = String(line).match(/^\[(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2})\]/);
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match;
  return new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)).getTime();
}

export function readRecentLogLines({ hours = 24, maxLines = 4000, now = Date.now(), filePath = path.join(DATA_DIR, 'app.log') } = {}) {
  let raw = '';
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }
  const cutoff = Number(now) - Math.max(1, Number(hours) || 24) * 60 * 60 * 1000;
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const kept = [];
  for (let i = lines.length - 1; i >= 0 && kept.length < maxLines; i--) {
    const ts = parseLogTimestamp(lines[i]);
    if (ts === null || ts < cutoff) {
      if (ts !== null && ts < cutoff) break;
      continue;
    }
    kept.push(lines[i]);
  }
  return kept.reverse();
}

export function buildDiagnosticsReport({ version = '', accounts = [], notify = {}, now = Date.now(), hours = 24 } = {}) {
  const logLines = readRecentLogLines({ hours, now });
  const redacted = logLines.map((line) => redactText(line));

  const accountLines = (accounts || []).map((a) => {
    const lastSync = a.lastSyncAt ? new Date(Number(a.lastSyncAt)).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '-';
    return ` - ${redactText(a.name || '未命名')} | 状态=${a.status || '-'} | 今日=${a.todayEarned ?? '-'} | 可用=${a.balance ?? '-'} | 待领=${a.claimablePoints ?? '-'} | 连签=${a.streakDays ?? '-'} | 数据=${a.dataState || '-'} | 上次同步=${lastSync}`;
  });

  const warnLines = redacted
    .filter((line) => /⚠️|🔴|失败|异常|error|Error|ERROR/.test(line))
    .slice(-40);

  const app = notify?.weworkApp || {};
  const channelLines = [
    ` - 企业微信应用: ${app.enabled ? '启用' : '关闭'}${app.msgType ? `（消息类型 ${app.msgType}）` : ''}`,
    ` - 企业微信群机器人: ${notify?.weworkRobot ? '已配置' : '未配置'}`,
    ` - 钉钉群机器人: ${notify?.dingdingRobot ? '已配置' : '未配置'}`
  ];

  const body = [
    '=== Microsoft Rewards 自动化平台 · 诊断报告（已脱敏） ===',
    `生成时间: ${new Date(now).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`,
    `程序版本: ${version || '未知'}`,
    `日志范围: 最近 ${hours} 小时（共 ${logLines.length} 行）`,
    '',
    '=== 账号概览 ===',
    ...(accountLines.length ? accountLines : [' - 无账号']),
    '',
    '=== 推送渠道 ===',
    ...channelLines,
    '',
    '=== 最近告警/异常（最多 40 条） ===',
    ...(warnLines.length ? warnLines : ['（无）']),
    '',
    '=== 完整日志（已脱敏） ===',
    ...(redacted.length ? redacted : ['（无日志）']),
    ''
  ].join('\n');

  return body;
}
