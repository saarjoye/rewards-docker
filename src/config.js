
export function getTodayDateString() {
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(new Date()).replace(/\//g, '-');
  } catch {
    const d = new Date();
    return d.toISOString().split('T')[0];
  }
}

﻿import fs from 'fs';
import path from 'path';
import { DATA_DIR, writeFileAtomic } from './fsUtil.js';
import logger from './logger.js';

const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
export const SECRET_PLACEHOLDER = '******';

const DEFAULT_CONFIG = {
  server: {
    port: 5308
  },
  scheduler: {
    enabled: true,
    peakSlots: [
      '09:00-13:00',
      '13:00-17:00',
      '17:00-21:00',
      '21:00-01:00'
    ],
    randomJitterMinutes: 30,
    midnightHarvest: true
  },
  // 方案 A：极致拟人安全搜索风控配置 (60~180秒退避 + 0~30秒抖动 + 停滞熔断)
  network: {
    enabled: false,
    proxyUrl: '',
    lockChinaIp: true
  },
  taskOptions: {
    dailyCheckIn: true,       // 每日双端签入 (PC+App)
    bingSearch: true,         // 必应 PC 搜索任务 (60分)
    dailySet: true,           // 每日连续活动集 (Daily Set)
    newsReading: true,        // 新闻资讯自动阅读 (10篇)
    promosQuiz: true,         // 活动卡片与 Quiz 自动答题
    weeklyQuest: true,        // 桌面端专属每周打孔卡 (70分/周)
    manualRerun: true,        // 全部完成后，手动重跑仍完整执行
    pacingPreset: 'fast',     // 'fast' (18s+6s) | 'relaxed' (180s+30s)
    baseIntervalSec: 18,
    randomJitterSec: 6,
    stagnationLimit: 10,
    theme: 'auto',
    engine: 'playwright'
  },
  searchSettings: {
    maxDailySearches: 30,
    searchesPerSlot: 8,
    stagnationLimit: 3,
    typingDelayMinMs: 35,
    typingDelayMaxMs: 75,
    searchIntervalMinSec: 60,
    searchIntervalMaxSec: 180,
    jitterMaxSec: 30
  },
  admin: {
    initialized: false,
    username: '',
    salt: '',
    passwordHash: '',
    sessionSecret: ''
  },
  notify: {
    weworkApp: {
      enabled: false,
      baseUrl: 'https://qyapi.weixin.qq.com', // 支持自定义反代域名
      corpId: '',
      agentId: '',
      secret: '',
      toUser: '@all'
    }
  },
  accounts: []
};

class ConfigManager {
  constructor() {
    this.config = this.load();
  }

  load() {
    try {
      if (fs.existsSync(CONFIG_FILE)) {
        const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
        const parsed = JSON.parse(raw);
        return {
          ...DEFAULT_CONFIG,
          ...parsed,
          server: { ...DEFAULT_CONFIG.server, ...(parsed.server || {}) },
          scheduler: { ...DEFAULT_CONFIG.scheduler, ...(parsed.scheduler || {}) },
          searchSettings: { ...DEFAULT_CONFIG.searchSettings, ...(parsed.searchSettings || {}) },
          notify: {
            ...DEFAULT_CONFIG.notify,
            ...(parsed.notify || {}),
            weworkApp: { ...DEFAULT_CONFIG.notify.weworkApp, ...(parsed.notify?.weworkApp || {}) }
          },
          accounts: Array.isArray(parsed.accounts) ? parsed.accounts : []
        };
      }
    } catch (e) {
      logger.log('⚠️', `加载配置文件异常，使用安全默认配置: ${e.message}`);
    }
    return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  }

  save() {
    try {
      writeFileAtomic(CONFIG_FILE, JSON.stringify(this.config, null, 2));
    } catch (e) {
      logger.log('🔴', `保存配置文件失败: ${e.message}`);
    }
  }

  get() {
    return this.config;
  }

  getAccounts() {
    const list = this.config.accounts || [];
    const todayStr = getTodayDateString();
    let changed = false;

    for (const a of list) {
      if (!a.todayDate) {
        // 首次初始化或版本升级：坚决保留已有真实积分，仅记录今日日期，杜绝误杀清零
        a.todayDate = todayStr;
        changed = true;
      } else if (a.todayDate !== todayStr) {
        // 确实跨越了自然天（昨天是旧日期）：开启新一天重置
        a.todayEarned = 0;
        a.todayDate = todayStr;
        changed = true;
      }
    }
    if (changed) {
      this.save();
    }
    return list;
  }

  getAccount(id) {
    return this.getAccounts().find((a) => a.id === id) || null;
  }

  upsertAccount(accountData) {
    if (!accountData || !accountData.id) return null;
    const list = this.config.accounts || [];
    const idx = list.findIndex((a) => a.id === accountData.id);
    const existing = idx >= 0 ? list[idx] : null;

    let pass = accountData.pass;
    if (existing && (!pass || pass === SECRET_PLACEHOLDER)) {
      pass = existing.pass;
    }

    let resolvedName = accountData.name;
    if (!resolvedName || resolvedName === '默认账号') {
      resolvedName = existing?.name && existing.name !== '默认账号' ? existing.name : '';
    }
    if (!resolvedName) {
      const userStr = (accountData.user && accountData.user !== '') ? accountData.user : (existing?.user || '');
      resolvedName = userStr.includes('@') ? userStr.split('@')[0] : (userStr || '默认账号');
    }

    const merged = {
      id: accountData.id,
      name: resolvedName,
      user: (accountData.user !== undefined && accountData.user !== '') ? accountData.user : (existing?.user || ''),
      pass: pass || (existing?.pass || ''),
      proxy: accountData.proxy !== undefined ? accountData.proxy : (existing?.proxy || ''),
      enabled: accountData.enabled !== undefined ? accountData.enabled : (existing?.enabled !== false),
      status: accountData.status || (existing?.status || 'ready'),
      balance: accountData.balance !== undefined ? accountData.balance : (existing?.balance || 0),
      todayEarned: accountData.todayEarned !== undefined ? accountData.todayEarned : (existing?.todayEarned || 0),
      streakDays: accountData.streakDays !== undefined ? accountData.streakDays : (existing?.streakDays || 0),
      claimablePoints: accountData.claimablePoints !== undefined ? accountData.claimablePoints : (existing?.claimablePoints || 0),
      lastRun: accountData.lastRun || (existing?.lastRun || null)
    };

    if (idx >= 0) {
      list[idx] = { ...existing, ...merged };
    } else {
      list.push(merged);
    }

    this.config.accounts = list;
    this.save();
    return merged;
  }

  deleteAccount(id) {
    const list = this.config.accounts || [];
    this.config.accounts = list.filter((a) => a.id !== id);
    this.save();
  }


  updateGlobalSettings(settings = {}) {
    if (settings.network) {
      this.config.network = { ...this.config.network, ...settings.network };
    }
    if (settings.taskOptions) {
      this.config.taskOptions = { ...this.config.taskOptions, ...settings.taskOptions };
    }
    if (settings.scheduler) {
      this.config.scheduler = { ...this.config.scheduler, ...settings.scheduler };
    }
    if (settings.notify) {
      this.config.notify = {
        ...this.config.notify,
        ...settings.notify,
        weworkApp: {
          ...this.config.notify?.weworkApp,
          ...(settings.notify.weworkApp || {})
        }
      };
    }
    this.save();
    return this.getPublicConfig();
  }

  updateNotifyConfig(weworkCfg) {
    if (!this.config.notify) this.config.notify = {};
    const cur = this.config.notify.weworkApp || {};
    let secret = weworkCfg.secret;
    if (secret === SECRET_PLACEHOLDER) {
      secret = cur.secret;
    }

    this.config.notify.weworkApp = {
      enabled: weworkCfg.enabled !== false,
      baseUrl: (weworkCfg.baseUrl || 'https://qyapi.weixin.qq.com').trim(),
      corpId: (weworkCfg.corpId || '').trim(),
      agentId: (weworkCfg.agentId || '').trim(),
      secret: (secret || '').trim(),
      toUser: (weworkCfg.toUser || '@all').trim()
    };
    this.save();
    return this.config.notify.weworkApp;
  }

  readLocalUserEnv() {
    const candidatePaths = [
      path.join(process.cwd(), '.env'),
      path.join(process.cwd(), '..', '.env'),
      path.join(DATA_DIR, '.env'),
      path.join(DATA_DIR, 'user', '.env'),
      path.join(process.cwd(), '..', '.env配置', 'user', '.env'),
      path.join(process.cwd(), '..', 'Microsoft-Rewards-Script-main', 'Microsoft-Rewards', '.env配置', 'user', '.env')
    ];

    for (const p of candidatePaths) {
      if (fs.existsSync(p)) {
        try {
          const content = fs.readFileSync(p, 'utf-8');
          const lines = content.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
          let user = '';
          let pass = '';

          for (const line of lines) {
            if (/^user\s*[:=]\s*(.+)$/i.test(line)) {
              user = line.match(/^user\s*[:=]\s*(.+)$/i)[1].trim();
            } else if (/^pass(word)?\s*[:=]\s*(.+)$/i.test(line)) {
              pass = line.match(/^pass(word)?\s*[:=]\s*(.+)$/i)[2].trim();
            } else if (/^MS_USER\s*=\s*(.+)$/i.test(line)) {
              user = line.match(/^MS_USER\s*=\s*(.+)$/i)[1].trim();
            } else if (/^MS_PASS(WORD)?\s*=\s*(.+)$/i.test(line)) {
              pass = line.match(/^MS_PASS(WORD)?\s*=\s*(.+)$/i)[2].trim();
            } else if (line.includes(':') && line.includes('@') && !user && !pass) {
              const parts = line.split(':');
              user = parts[0].trim();
              pass = parts.slice(1).join(':').trim();
            }
          }

          if (user && pass) {
            return { found: true, path: p, user, pass };
          }
        } catch {}
      }
    }
    return { found: false, path: null, user: '', pass: '' };
  }


  ensureAdminSessionSecret() {
    if (!this.config.admin) this.config.admin = {};
    if (!this.config.admin.sessionSecret) {
      this.config.admin.sessionSecret = Math.random().toString(36).slice(2) + Date.now().toString(36) + Math.random().toString(36).slice(2);
      this.save();
    }
    return this.config.admin.sessionSecret;
  }

  getAdminConfig() {
    this.ensureAdminSessionSecret();
    return this.config.admin || {};
  }

  setAdminCredentials(username, salt, passwordHash) {
    this.ensureAdminSessionSecret();
    this.config.admin.initialized = true;
    this.config.admin.username = username;
    this.config.admin.salt = salt;
    this.config.admin.passwordHash = passwordHash;
    this.save();
    return this.config.admin;
  }

  getPublicConfig() {
    const cfg = JSON.parse(JSON.stringify(this.config));
    if (Array.isArray(cfg.accounts)) {
      cfg.accounts = cfg.accounts.map((a) => ({
        ...a,
        pass: a.pass ? SECRET_PLACEHOLDER : ''
      }));
    }
    if (cfg.admin) {
      cfg.admin = {
        initialized: !!cfg.admin.initialized,
        username: cfg.admin.username || ''
      };
    }
    if (cfg.notify?.weworkApp?.secret) {
      cfg.notify.weworkApp.secret = SECRET_PLACEHOLDER;
    }
    return cfg;
  }
}

export const configManager = new ConfigManager();
export default configManager;
