import logger from '../logger.js';
import { getProxyAgent } from '../network.js';
import axios from 'axios';

export const DESKTOP_APP_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) MSRewards/Desktop/1.4.56';

export const DESKTOP_APP_HEADERS = {
  'user-agent': DESKTOP_APP_USER_AGENT,
  'X-MSRewards-App': '1',
  'X-Rewards-Source': 'msrewards-desktop'
};

export function extractJsonObjectsWithKey(text, anchor = '"offerId"') {
  const source = String(text || '');
  const objects = [];
  let position = 0;

  while ((position = source.indexOf(anchor, position)) !== -1) {
    const start = source.lastIndexOf('{', position);
    if (start === -1) {
      position += anchor.length;
      continue;
    }

    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;
    for (let i = start; i < source.length; i++) {
      const char = source[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') {
        inString = true;
      } else if (char === '{') {
        depth++;
      } else if (char === '}') {
        depth--;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }

    if (end === -1) {
      position += anchor.length;
      continue;
    }

    const raw = source.slice(start, end)
      .replace(/:\$undefined/g, ':null')
      .replace(/:\$D[^",}\]]+/g, ':null');
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        objects.push(parsed);
      }
    } catch {}
    position = end;
  }

  return objects;
}

export function isServerActionAcknowledged(payload) {
  return /^\d+:true\s*$/m.test(String(payload || ''));
}

export function buildQuestRouterStateTree(questId) {
  const tree = [
    '',
    {
      children: [
        '(nav)',
        {
          children: [
            'earn',
            {
              children: [
                'quest',
                {
                  children: [
                    ['questId', questId, 'd', null],
                    { children: ['__PAGE__', {}, null, null, 0] },
                    null,
                    null,
                    0
                  ]
                },
                null,
                null,
                0
              ]
            },
            null,
            null,
            0
          ]
        },
        null,
        null,
        0
      ]
    },
    null,
    null,
    16
  ];
  return encodeURIComponent(JSON.stringify(tree));
}

export function weekdayFromOfferId(offerId = '') {
  const match = String(offerId).match(/_(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)_/i);
  return match ? match[1].toLowerCase() : '';
}

export function getDeploymentId(html = '') {
  const text = String(html || '');
  return text.match(/[?&](?:amp;)?dpl=([A-Za-z0-9._-]+)/i)?.[1]
    || text.match(/"buildId"\s*:\s*"([A-Za-z0-9._-]+)"/i)?.[1]
    || text.match(/\/_next\/static\/([A-Za-z0-9._-]+)\//)?.[1]
    || '';
}

export async function getNextActionHash(html, baseUrl = 'https://rewards.bing.com', requestFn = null) {
  if (!html || !String(html).includes('_next/static/')) return null;
  const source = String(html);
  const scriptSrcs = [...new Set(
    [...source.matchAll(/(?:src|href)="([^"]*\/_next\/static\/[^"]+?\.js(?:\?[^"]*)?)"/g)]
      .map(match => match[1])
  )];

  for (const src of scriptSrcs.slice(0, 80)) {
    try {
      const url = src.startsWith('http') ? src : new URL(src, baseUrl).toString();
      let chunkText = '';
      if (requestFn) {
        chunkText = await requestFn(url);
      } else {
        const res = await axios.get(url, { timeout: 15000 });
        chunkText = String(res.data || '');
      }
      const createReferenceRegex = /createServerReference\s*\)?\s*\(\s*"([a-f0-9]{40,64})"([\s\S]{0,800}?)\)/g;
      for (const match of String(chunkText).matchAll(createReferenceRegex)) {
        if (match[2].includes('reportActivity')) {
          return match[1];
        }
      }
    } catch {}
  }
  return null;
}

export async function executeDesktopAppQuest(page, options = {}) {
  const { accountPrefix = '', cookies = [], proxy = null, context = null } = options;
  const log = (msg) => logger.log('🖥️', '[桌面专享任务] ' + msg, '', accountPrefix);

  try {
    const ctx = context || (page && typeof page.context === 'function' ? page.context() : null);
    const cookieHeader = (cookies || [])
      .filter((c) => !c.domain || c.domain.includes('bing.com'))
      .map((c) => c.name + '=' + c.value)
      .join('; ');

    const axiosInstance = axios.create({
      timeout: 25000,
      validateStatus: () => true,
      ...(proxy ? { httpsAgent: getProxyAgent(proxy), httpAgent: getProxyAgent(proxy) } : {})
    });

    const sendRequest = async (opts) => {
      if (ctx && ctx.request) {
        try {
          if (opts.method === 'POST') {
            const resp = await ctx.request.post(opts.url, {
              headers: { ...opts.headers },
              data: opts.data
            });
            const text = await resp.text().catch(() => '');
            return { status: resp.status(), data: text };
          } else {
            const resp = await ctx.request.get(opts.url, {
              headers: { ...opts.headers }
            });
            const text = await resp.text().catch(() => '');
            return { status: resp.status(), data: text };
          }
        } catch {}
      }
      const res = await axiosInstance({
        ...opts,
        headers: {
          'Cookie': cookieHeader,
          ...(opts.headers || {})
        }
      });
      return { status: res.status, data: res.data };
    };

    log('正在检测官网“桌面奖励应用每周专属任务”入口...');
    const earnResp = await sendRequest({
      url: 'https://rewards.bing.com/earn',
      method: 'GET',
      headers: DESKTOP_APP_HEADERS
    });
    const earnHtml = String(earnResp.data || '');

    const questMatch = earnHtml.match(/href="(\/earn\/quest\/(WW_pcparent_RewardsApp_weekly_Exclusive[^"]+))"/i)
      || earnHtml.match(/"(\/earn\/quest\/(WW_pcparent_RewardsApp_weekly_Exclusive[^"]+))"/i);

    if (!questMatch) {
      log('官网当前无桌面专享打孔卡活动（或当前账号未下发），跳过。');
      return { success: true, count: 0, reason: 'not-available' };
    }

    const questUrl = 'https://rewards.bing.com' + questMatch[1];
    const parentQuestId = questMatch[1].match(/WW_pcparent_[^/?#]+/)?.[0] || '';
    log('发现桌面专享打孔卡路由: ' + questMatch[1]);

    const questResp = await sendRequest({
      url: questUrl,
      method: 'GET',
      headers: DESKTOP_APP_HEADERS
    });
    const questHtml = String(questResp.data || '');
    if (!questHtml) {
      log('获取专享打孔卡页面内容为空，跳过');
      return { success: false, count: 0 };
    }

    const qChunks = [];
    const qPushRegex = /self\.__next_f\.push\(\[\d+,\s*"(.*?)"\]\)/gs;
    let qm;
    while ((qm = qPushRegex.exec(questHtml)) !== null) {
      try { qChunks.push(JSON.parse('"' + qm[1] + '"')); } catch {}
    }
    const qText = qChunks.length > 0 ? qChunks.join('') : questHtml.replace(/\\"/g, '"');
    const children = extractJsonObjectsWithKey(qText)
      .filter((item) => /^WW_pcchild\d+_/.test(String(item.offerId || '')));
    const uniqueChildren = [...new Map(children.map((item) => [item.offerId, item])).values()];

    const readyChildren = uniqueChildren.filter((item) => (
      item.isCompleted !== true
      && item.isLocked !== true
      && item.isDisabled !== true
      && !!item.hash
    ));

    const lockedChildren = uniqueChildren.filter((item) => (
      item.isLocked === true || item.isDisabled === true
    ));

    const totalCount = uniqueChildren.length;
    const completedCount = uniqueChildren.filter(item => item.isCompleted === true).length;

    log('桌面专属任务状态: 共 ' + totalCount + ' 项，已完成 ' + completedCount + ' 项，本次可推进 ' + readyChildren.length + ' 项，锁定 ' + lockedChildren.length + ' 项');

    if (readyChildren.length === 0) {
      const nextDay = weekdayFromOfferId(lockedChildren[0]?.offerId);
      const nextDayLabel = {
        monday: '周一', tuesday: '周二', wednesday: '周三', thursday: '周四',
        friday: '周五', saturday: '周六', sunday: '周日'
      }[nextDay] || nextDay;
      const nextHint = nextDayLabel ? ('，下一项预计于 ' + nextDayLabel + ' 解锁') : '';
      log('当前无待推进步骤（今日已做满或在锁定期' + nextHint + '）');
      return { success: true, count: 0, ready: 0 };
    }

    const deploymentId = getDeploymentId(questHtml) || getDeploymentId(earnHtml);
    let nextAction = await getNextActionHash(questHtml, questUrl, async (u) => {
      const r = await sendRequest({ url: u, method: 'GET' });
      return String(r.data || '');
    });

    if (!nextAction) {
      nextAction = await getNextActionHash(earnHtml, 'https://rewards.bing.com/earn', async (u) => {
        const r = await sendRequest({ url: u, method: 'GET' });
        return String(r.data || '');
      });
    }

    if (!nextAction) {
      log('⚠️ 未能从 Next.js 静态脚本中提取到 reportActivity Server Action Hash，尝试标准兜底');
    }

    let advancedCount = 0;
    for (const qItem of readyChildren) {
      const stepName = qItem.title || qItem.name || qItem.offerId;
      log('>>> 正在提交桌面专属子任务: ' + stepName + ' (+' + (qItem.points || 10) + '分)... ');

      const headers = {
        'accept': 'text/x-component',
        'content-type': 'text/plain;charset=UTF-8',
        'referer': questUrl,
        'origin': 'https://rewards.bing.com',
        ...DESKTOP_APP_HEADERS
      };
      if (nextAction) headers['next-action'] = nextAction;
      if (parentQuestId) headers['next-router-state-tree'] = buildQuestRouterStateTree(parentQuestId);
      if (deploymentId) headers['x-deployment-id'] = deploymentId;

      const payload = JSON.stringify([qItem.hash, 11, { offerid: qItem.offerId, isPromotional: '$undefined', timezoneOffset: '-480' }]);

      const submitResp = await sendRequest({
        url: questUrl,
        method: 'POST',
        headers,
        data: payload
      });

      const ack = isServerActionAcknowledged(submitResp.data);
      if (ack || submitResp.status === 200) {
        advancedCount++;
        log('🎉 [Server Action确认] 桌面专属子任务成功达成入账: ' + stepName);
      } else {
        log('🟡 提交返回未完全确认 (HTTP ' + submitResp.status + '): ' + String(submitResp.data || '').slice(0, 100));
      }

      await new Promise((r) => setTimeout(r, 2000 + Math.random() * 1500));
    }

    log('桌面应用每周专属任务流水线执行完毕，共成功推进 ' + advancedCount + '/' + readyChildren.length + ' 项');
    return { success: true, count: advancedCount };
  } catch (err) {
    logger.log('🔴', '[桌面专享任务] 执行异常: ' + err.message, '', accountPrefix);
    return { success: false, error: err.message };
  }
}
