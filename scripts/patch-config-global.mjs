import fs from 'fs';

let content = fs.readFileSync('src/config.js', 'utf8');

const oldDefaultSettings = `  searchSettings: {
    maxDailySearches: 30,          // 单日目标上限 30 次 (60 分)
    searchesPerSlot: 8,            // 每个错峰时段轻度搜 8 轮，分散全天
    stagnationLimit: 3,            // 连续 3 次无积分增量则熔断本轮
    typingDelayMinMs: 35,          // 拟人键入延迟
    typingDelayMaxMs: 75,
    searchIntervalMinSec: 60,      // 单次搜索平缓退避下限 (秒)
    searchIntervalMaxSec: 180,     // 单次搜索平缓退避上限 (秒)
    jitterMaxSec: 30               // 高斯动态抖动 (秒)
  },`;

const newDefaultSettings = `  network: {
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
  },`;

content = content.replace(oldDefaultSettings, newDefaultSettings);

// 增加全局配置批量更新方法
const updateGlobalConfigMethod = `
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
`;

if (!content.includes('updateGlobalSettings')) {
  content = content.replace('  updateNotifyConfig(weworkCfg) {', updateGlobalConfigMethod + '\n  updateNotifyConfig(weworkCfg) {');
}

fs.writeFileSync('src/config.js', content, 'utf8');
console.log('config.js updated with all Image 1-6 global settings');
