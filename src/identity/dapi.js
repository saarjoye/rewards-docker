import crypto from 'crypto';
import networkClient from '../network.js';
import { USER_AGENTS, refreshAccessToken } from './auth.js';
import logger from '../logger.js';

export const DAPI_CONFIG = {
  rewardsAppId: 'SAAndroid/32.6.2110003560',
  channel: 'SAAndroid',
  endpoint: 'https://prod.rewardsplatform.microsoft.com/dapi/me'
};

export function generateDapiActivityId() {
  const u1 = crypto.randomUUID().replace(/-/g, '').toUpperCase();
  const u2 = crypto.randomUUID().replace(/-/g, '').toUpperCase();
  return (u1 + u2).slice(0, 56);
}

export class DapiClient {
  constructor(account, tokens, onTokenRefresh) {
    this.account = account;
    this.tokens = tokens;
    this.onTokenRefresh = onTokenRefresh;
  }

  async getValidToken() {
    if (!this.tokens || !this.tokens.accessToken) {
      throw new Error('未配置移动端 Access Token，需先执行自主登录换取');
    }

    // 检查 Token 是否在 5 分钟内过期
    const isExpired = this.tokens.obtainedAt && this.tokens.expiresIn &&
      (Date.now() - this.tokens.obtainedAt > (this.tokens.expiresIn - 300) * 1000);

    if (isExpired && this.tokens.refreshToken) {
      logger.log('🔄', `Access Token 即将过期，使用 Refresh Token 自动续期...`, '', this.account.name);
      try {
        const refreshed = await refreshAccessToken(this.tokens.refreshToken, this.account.proxy);
        this.tokens = refreshed;
        if (this.onTokenRefresh) this.onTokenRefresh(refreshed);
      } catch (e) {
        logger.log('⚠️', `Token 续期失败，尝试使用当前 Token 继续: ${e.message}`, '', this.account.name);
      }
    }

    return this.tokens.accessToken;
  }

  /**
   * 提交 DAPI 任务活动
   */
  async submitActivity(offerId, amount = 1) {
    const token = await this.getValidToken();
    const activityId = generateDapiActivityId();

    const payload = {
      amount,
      country: 'CN',
      id: activityId,
      type: 101,
      attributes: {
        offerid: offerId
      }
    };

    const res = await networkClient.request({
      url: `${DAPI_CONFIG.endpoint}/activities`,
      method: 'POST',
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'user-agent': USER_AGENTS.app,
        'authorization': `Bearer ${token}`,
        'x-rewards-appid': DAPI_CONFIG.rewardsAppId
      },
      data: JSON.stringify(payload),
      proxy: this.account.proxy
    });

    if (res && (res.error || res.status === 'error')) {
      throw new Error(res.error?.message || res.message || 'DAPI 返回业务错误');
    }

    return res;
  }

  /**
   * 移动端每日 App 签入 (Streaks 板块: 签到: 1/1 - 对标 Sapphire type 103 协议规范)
   */
  async performAppCheckIn() {
    logger.log('📱', '正在执行必应应用连续打卡 (DAPI Sapphire 网关直连签入)...', '', this.account.name);
    try {
      const token = await this.getValidToken();
      const activityId = generateDapiActivityId();

      const payload = {
        amount: 1,
        // DAPI 的 activity.id 官方客户端是 56 位十六进制（两段 UUID 拼接），
        // 只给 32 位时接口返回 200，但连签类任务不会真正入账。
        id: activityId,
        // 新版 App 的签到按普通领取活动处理。type=103 仅触发启动上报，
        // 接口会返回 200，但连签 progress / last_updated 不会推进。
        type: 101,
        country: 'CN',
        // 关键：必须用 Android 渠道（SAAndroid）+ App 的 UA/AppId，
        // 用 iOS 渠道（SAiOS）时接口同样返回 200、也会加通用积分，
        // 但「必应应用连续打卡」的连签进度不会推进（实测 0/1 不动）。
        channel: 'SAAndroid',
        attributes: { offerid: 'Gamification_Sapphire_DailyCheckIn' }
      };

      const res = await networkClient.request({
        url: `${DAPI_CONFIG.endpoint}/activities`,
        method: 'POST',
        headers: {
          'content-type': 'application/json; charset=UTF-8',
          'user-agent': USER_AGENTS.app,
          'authorization': `Bearer ${token}`,
          'x-rewards-appid': DAPI_CONFIG.rewardsAppId,
          'x-rewards-ismobile': 'true',
          'x-rewards-country': 'cn',
          'x-rewards-language': 'zh',
          'x-rewards-partnerid': 'startapp',
          'x-rewards-flights': 'rwgobig'
        },
        data: JSON.stringify(payload),
        proxy: this.account.proxy
      });

      if (res && res.code === 0) {
        const gained = Number(res.response?.activity?.p ?? res.response?.activity?.points ?? res.response?.creditedPoints ?? 0);
        const newBalance = res.response?.balance ?? null;
        const isDuplicate = !!res.response?.isDuplicate;
        // 只有"真的加了分"或"服务端明确说不重复"才算签上；不再无脑宣称已点亮
        if (gained > 0) {
          logger.log('✅', `必应移动端签到成功！本次入账: +${gained} 分${newBalance ? `，最新余额: ${newBalance} 分` : ''}`, '', this.account.name);
        } else if (isDuplicate) {
          logger.log('📱', `必应移动端今日已签到（服务端标记重复，余额 ${newBalance ?? '-'} 分）`, '', this.account.name);
        } else {
          logger.log('📱', `必应移动端签到已提交，服务端本次未加分（余额 ${newBalance ?? '-'} 分），留待官网连签核验`, '', this.account.name);
        }
        return { success: gained > 0 || isDuplicate, gained, balance: newBalance, isDuplicate };
      }
    } catch (e) {
      logger.log('⚠️', `Sapphire 移动端直连签到异常: ${e.message}，尝试备用候选通道...`, '', this.account.name);
    }

    // 备用通道回退
    const offerCandidates = [
      'Gamification_DailyCheckIn',
      'Gamification_Sapphire_DailyCheckIn',
      'Sapphire_DailyCheckIn'
    ];
    for (const offerId of offerCandidates) {
      try {
        const res = await this.submitActivity(offerId);
        logger.log('✅', `必应移动端签到备用通道成功 (${offerId})！`, '', this.account.name);
        return { success: true };
      } catch (e) {}
    }

    logger.log('⚠️', '必应移动端签到未能在当前轮次点亮 (可等待稍后重试或确认移动 Token)', '', this.account.name);
    return { success: false };
  }

  /**
   * 读取 App 端 promotions（签到 / 阅读 / sapphire 活动的唯一权威来源）。
   * 注意：官方网页 /earn 的 bingapp 连签模型不会因为 DAPI 签到而更新，
   * 判断"今天是否已签到"必须以这里的 last_updated / complete 为准。
   */
  async fetchAppPromotions() {
    try {
      const token = await this.getValidToken();
      const res = await networkClient.request({
        url: `${DAPI_CONFIG.endpoint}?channel=SAAndroid&options=613`,
        method: 'GET',
        headers: {
          'content-type': 'application/json; charset=UTF-8',
          'user-agent': USER_AGENTS.app,
          'authorization': `Bearer ${token}`,
          'x-rewards-appid': DAPI_CONFIG.rewardsAppId,
          'x-rewards-ismobile': 'true',
          'x-rewards-country': 'cn',
          'x-rewards-language': 'zh'
        },
        proxy: this.account.proxy
      });
      const data = typeof res === 'string' ? JSON.parse(res) : res;
      const promotions = data?.response?.promotions;
      return Array.isArray(promotions) ? promotions : [];
    } catch {
      return [];
    }
  }

  /**
   * 移动端新闻资讯阅读 (每篇加 3 分，上限 30 分)
   */
  async performNewsReading(targetArticles = 10) {
    logger.log('📖', `开始执行移动端新闻资讯阅读 (目标 ${targetArticles} 篇，共 30 分)...`, '', this.account.name);
    let successCount = 0;

    for (let i = 1; i <= targetArticles; i++) {
      try {
        await this.submitActivity('ENUS_readarticle3_30points');
        successCount++;
        logger.log('📰', `已完成第 ${i}/${targetArticles} 篇新闻阅读打卡`, '', this.account.name);
        await new Promise((r) => setTimeout(r, 2500 + Math.random() * 2000));
      } catch (e) {
        logger.log('⚠️', `第 ${i} 篇新闻上报异常: ${e.message}`, '', this.account.name);
      }
    }

    if (successCount > 0) {
      logger.log('✅', `新闻资讯阅读任务结束，共成功上报 ${successCount}/${targetArticles} 篇`, '', this.account.name);
    } else {
      logger.log('⚠️', `新闻资讯阅读任务未上报成功 (需确认移动端 Token 授权是否有效)`, '', this.account.name);
    }
    return { success: successCount > 0, count: successCount };
  }
}
