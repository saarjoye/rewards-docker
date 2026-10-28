import configManager, { SECRET_PLACEHOLDER } from '../config.js';
import networkClient from '../network.js';
import logger from '../logger.js';

const WEWORK_DEFAULT_BASE_URL = 'https://qyapi.weixin.qq.com';
const TOKEN_REFRESH_AHEAD_MS = 5 * 60 * 1000;
const TOKEN_ERROR_CODES = new Set([40014, 42001, 42007, 42009]);

export function buildWeWorkAppBaseUrl(raw) {
  const value = String(raw || '').trim();
  if (!value) return WEWORK_DEFAULT_BASE_URL;
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('企业微信应用 Base URL 格式无效，必须包含合法协议与域名');
  }
  if (url.protocol !== 'https:') throw new Error('企业微信应用 Base URL 必须使用 HTTPS 协议');
  if (url.username || url.password) throw new Error('企业微信应用 Base URL 不能包含账号密码');
  if (url.search || url.hash) throw new Error('企业微信应用 Base URL 不能包含查询参数或片段');
  const prefix = url.pathname.replace(/\/+$/, '');
  return `${url.origin}${prefix}`;
}

export function buildWeWorkAppTokenUrl(baseUrl, corpId, secret) {
  const base = buildWeWorkAppBaseUrl(baseUrl);
  const id = encodeURIComponent(String(corpId || '').trim());
  const key = encodeURIComponent(String(secret || '').trim());
  return `${base}/cgi-bin/gettoken?corpid=${id}&corpsecret=${key}`;
}

export function buildWeWorkAppSendUrl(baseUrl, accessToken) {
  const base = buildWeWorkAppBaseUrl(baseUrl);
  return `${base}/cgi-bin/message/send?access_token=${encodeURIComponent(String(accessToken || '').trim())}`;
}

/**
 * 格式化每日任务结算与 01:00 对账战报文本内容
 */
export function formatSettlementReportContent(account, stats = {}) {
  const metric = (value, unit = ' 分') => {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) return '官网未确认';
    return Number(value).toLocaleString() + unit;
  };

  const formatHarvested = (value) => {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) return '官网未确认';
    const n = Number(value);
    return (n > 0 ? `+${n.toLocaleString()}` : `${n.toLocaleString()}`) + ' 分';
  };

  const cleanStatus = String(stats.taskStatusText || '官网对账完成').replace(/[#*`>]/g, '').trim();

  const todayValue = (stats.todayEarned !== undefined && stats.todayEarned !== null)
    ? stats.todayEarned
    : ((stats.todayPoints !== undefined && stats.todayPoints !== null) ? stats.todayPoints : account.todayEarned);

  const harvestedValue = stats.harvestedPoints !== undefined && stats.harvestedPoints !== null
    ? stats.harvestedPoints
    : (stats.deltaPoints !== undefined && stats.deltaPoints !== null ? stats.deltaPoints : null);

  return [
    `托管账号: ${account.name || account.user}`,
    `本次收割: ${formatHarvested(harvestedValue)}`,
    `今日已增: ${metric(todayValue)}`,
    `账户总额: ${metric(stats.balance)}`,
    `连续打卡: ${metric(stats.streakDays, ' 天')}`,
    `待领额外: ${metric(stats.claimablePoints)}`,
    `执行状态: ${cleanStatus}`
  ].join('\n');
}

/**
 * 汇总当前配置下真正可用的战报推送渠道。
 * 开关关闭或未填写的渠道自动跳过，任一渠道都可单独启停。
 */
export function resolveSettlementChannels(notify = {}) {
  const channels = [];
  const app = notify?.weworkApp || {};
  if (app.enabled && app.corpId && app.secret) {
    channels.push({ type: 'weworkApp', target: app });
  }

  const weworkRobot = String(notify?.weworkRobot || '').trim();
  if (notify?.weworkRobotEnabled !== false && weworkRobot) {
    channels.push({ type: 'weworkRobot', target: weworkRobot });
  }

  const dingdingRobot = String(notify?.dingdingRobot || '').trim();
  if (notify?.dingdingRobotEnabled !== false && dingdingRobot) {
    channels.push({ type: 'dingtalkRobot', target: dingdingRobot });
  }

  return channels;
}

export class Notifier {
  constructor() {
    this.tokenCache = new Map();
  }

  getCacheKey(cfg) {
    return `${buildWeWorkAppBaseUrl(cfg.baseUrl)}|${cfg.corpId}|${cfg.secret}`;
  }

  async getAccessToken(cfg, forceRefresh = false) {
    const baseUrl = buildWeWorkAppBaseUrl(cfg.baseUrl);
    const key = this.getCacheKey(cfg);
    const now = Date.now();

    if (!forceRefresh) {
      const cached = this.tokenCache.get(key);
      if (cached && cached.expiresAt > now + TOKEN_REFRESH_AHEAD_MS) {
        return cached.token;
      }
    }

    const tokenUrl = buildWeWorkAppTokenUrl(cfg.baseUrl, cfg.corpId, cfg.secret);
    const res = await networkClient.request({
      url: tokenUrl,
      method: 'GET',
      headers: { 'Content-Type': 'application/json' }
    });

    const data = typeof res === 'string' ? JSON.parse(res) : res;
    if (!data || Number(data.errcode) !== 0 || !data.access_token) {
      const baseHint = baseUrl !== WEWORK_DEFAULT_BASE_URL ? ` (反代: ${baseUrl})` : ' (直连官方)';
    throw new Error(`企业微信应用获取 Token 失败${baseHint}: ${data?.errmsg || '未知响应'}`);
    }

    const expiresIn = Math.max(60, Number(data.expires_in) || 7200);
    this.tokenCache.set(key, {
      token: data.access_token,
      expiresAt: now + expiresIn * 1000
    });

    return data.access_token;
  }

  async sendWeWorkApp(cfg, title, content) {
    if (!cfg || !cfg.corpId || !cfg.agentId || !cfg.secret) {
      throw new Error('企业微信应用缺少必要配置 (CorpID, AgentId 或 Secret)');
    }

    const baseUrl = buildWeWorkAppBaseUrl(cfg.baseUrl);
    let token = await this.getAccessToken(cfg);

    // 彻底清洗所有 Markdown 符号（**、`、>、#）与裸 HTML 样式，保证普通微信图文卡片 100% 优雅呈现
    const plainLines = content.split('\n')
      .map(l => l.replace(/^[>\s*#]+/, '').replace(/\*\*/g, '').replace(/`/g, '').replace(/>/g, '').trim())
      .filter(Boolean);
    const cardDescription = plainLines.map(l => '<div class="normal">' + l + '</div>').join('');

    const cleanTitle = title.replace(/[#*`>]/g, '').trim();
    const payload = {
      touser: cfg.toUser || '@all',
      msgtype: 'textcard',
      agentid: Number(cfg.agentId),
      textcard: {
        title: '🎁 ' + cleanTitle,
        description: '<div class="gray">统计日期: ' + new Date().toLocaleDateString('zh-CN') + '</div>' + cardDescription + '<div class="highlight">🤖 Microsoft Rewards 自动化平台</div>',
        url: 'https://rewards.bing.com',
        btntxt: '查看详情'
      },
      enable_id_trans: 0,
      enable_duplicate_check: 0
    };

    const sendUrl = buildWeWorkAppSendUrl(baseUrl, token);
    let res = await networkClient.request({
      url: sendUrl,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify(payload)
    });

    let data = typeof res === 'string' ? JSON.parse(res) : res;

    // Token 过期或非法自动重试 1 次
    if (data && TOKEN_ERROR_CODES.has(Number(data.errcode))) {
      logger.log('🔄', '企业微信 Token 已失效，自动刷新重试推送...');
      token = await this.getAccessToken(cfg, true);
      const retryUrl = buildWeWorkAppSendUrl(baseUrl, token);
      res = await networkClient.request({
        url: retryUrl,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify(payload)
      });
      data = typeof res === 'string' ? JSON.parse(res) : res;
    }

    if (!data || Number(data.errcode) !== 0) {
      throw new Error(`企业微信应用消息发送失败: ${data?.errmsg || '网络或参数异常'}`);
    }

    logger.log('📢', `「企业微信应用」消息推送成功！(反代: ${baseUrl})`);
    return true;
  }

  /**
   * 推送每日任务结算与 01:00 对账战报
   */
  async sendSettlementReport(account, stats = {}) {
    const notify = configManager.get().notify || {};
    const channels = resolveSettlementChannels(notify);
    if (channels.length === 0) return false;

    const title = `Rewards 每日对账战报 - ${account.name || account.user}`;
    const content = formatSettlementReportContent(account, stats);

    const senders = {
      weworkApp: (target) => this.sendWeWorkApp(target, title, content),
      weworkRobot: (target) => this.sendWeWorkBot(target, title, content),
      dingtalkRobot: (target) => this.sendDingTalkBot(target, title, content)
    };
    const channelNames = {
      weworkApp: '企业微信应用',
      weworkRobot: '企业微信群机器人',
      dingtalkRobot: '钉钉群机器人'
    };

    // 各渠道完全独立：任一渠道失败或超时都不影响其他渠道投递
    const results = await Promise.all(
      channels.map(async (channel) => {
        try {
          await senders[channel.type](channel.target);
          return true;
        } catch (e) {
          logger.log('🔴', `${channelNames[channel.type]}战报推送失败: ${e.message}`, '', account.name);
          return false;
        }
      })
    );

    return results.some(Boolean);
  }

  /**
   * 测试连通性
   */
  async sendWeWorkBot(webhookUrlOrKey, title, content) {
    if (!webhookUrlOrKey) throw new Error('未提供企业微信群机器人 Webhook Key 或 URL');
    const url = webhookUrlOrKey.startsWith('http')
      ? webhookUrlOrKey
      : `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${webhookUrlOrKey}`;

    const payload = {
      msgtype: 'markdown',
      markdown: { content: `### 🎁 ${title}\n\n${content}\n\n> 🤖 来自 Microsoft Rewards 自动化托管平台` }
    };

    const res = await networkClient.request({
      url,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify(payload)
    });
    const data = typeof res === 'string' ? JSON.parse(res) : res;
    if (data && Number(data.errcode) !== 0) {
      throw new Error(data.errmsg || 'Webhook 发送失败');
    }
    logger.log('📢', '「企业微信群机器人」消息推送成功！');
    return true;
  }

  async sendDingTalkBot(tokenOrUrl, title, content) {
    if (!tokenOrUrl) throw new Error('未提供钉钉群机器人 Access Token 或 URL');
    const url = tokenOrUrl.startsWith('http')
      ? tokenOrUrl
      : `https://oapi.dingtalk.com/robot/send?access_token=${tokenOrUrl}`;

    const payload = {
      msgtype: 'markdown',
      markdown: {
        title,
        text: `### 🎁 ${title}\n\n${content}\n\n> 🤖 来自 Microsoft Rewards 自动化托管平台`
      }
    };

    const res = await networkClient.request({
      url,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify(payload)
    });
    const data = typeof res === 'string' ? JSON.parse(res) : res;
    if (data && Number(data.errcode) !== 0) {
      throw new Error(data.errmsg || '钉钉机器人发送失败');
    }
    logger.log('📢', '「钉钉群机器人」消息推送成功！');
    return true;
  }

  async testChannel(cfgOverrides = {}) {
    const saved = configManager.get().notify?.weworkApp || {};
    let secret = cfgOverrides.secret;
    if (!secret || secret === SECRET_PLACEHOLDER) {
      secret = saved.secret;
    }

    const merged = {
      ...saved,
      ...cfgOverrides,
      secret,
      enabled: true
    };

    const title = '企业微信应用测试连通性';
    const content = `如果你收到此消息，说明你的企业微信应用与反代通道配置已 100% 连通就绪！\n\n> **反代地址**：\`${merged.baseUrl || WEWORK_DEFAULT_BASE_URL}\`\n> **接收人**：\`${merged.toUser || '@all'}\``;

    return await this.sendWeWorkApp(merged, title, content);
  }
}

export const notifier = new Notifier();
export default notifier;
