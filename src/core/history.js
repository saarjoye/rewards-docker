import fs from 'fs';
import path from 'path';
import { DATA_DIR, writeFileAtomic } from '../fsUtil.js';

const HISTORY_FILE = path.join(DATA_DIR, 'history.json');

class HistoryManager {
  constructor() {
    this.data = this.load();
  }

  load() {
    try {
      if (fs.existsSync(HISTORY_FILE)) {
        return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
      }
    } catch {}
    return { accounts: {} };
  }

  save() {
    try {
      writeFileAtomic(HISTORY_FILE, JSON.stringify(this.data, null, 2));
    } catch {}
  }

  recordDaily(accountId, stats) {
    if (!accountId) return;
    if (!this.data.accounts[accountId]) this.data.accounts[accountId] = [];

    // 所有日期统一使用 Asia/Shanghai，避免 UTC 跨日把“今天”写进昨天。
    const todayStr = new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(new Date()).replace(/\//g, '-');

    const list = this.data.accounts[accountId];
    const existingIdx = list.findIndex((item) => item.date === todayStr);

    // 只有官网成功采集才写入快照。undefined/null 不得被当成 0。
    const record = {
      date: todayStr,
      timestamp: Date.now(),
      earned: stats.todayEarned === undefined || stats.todayEarned === null ? null : Number(stats.todayEarned),
      balance: stats.balance === undefined || stats.balance === null ? null : Number(stats.balance),
      streakDays: Number(stats.streakDays || 0),
      claimablePoints: stats.claimablePoints === undefined || stats.claimablePoints === null ? null : Number(stats.claimablePoints),
      officialTasks: stats.officialTasks || null,
      source: stats.source || 'official-sync'
    };

    if (existingIdx >= 0) list[existingIdx] = record;
    else {
      list.push(record);
      list.sort((a, b) => a.date.localeCompare(b.date));
      if (list.length > 400) list.shift();
    }
    this.save();
  }

  getMonthHistory(accountId, yearMonth) {
    const accounts = this.data.accounts || {};
    const targetAccounts = (!accountId || accountId === 'all') ? Object.keys(accounts) : [accountId];
    const mapByDate = {};

    for (const accId of targetAccounts) {
      for (const rec of accounts[accId] || []) {
        if (!rec.date || !rec.date.startsWith(yearMonth)) continue;
        if (!mapByDate[rec.date]) {
          mapByDate[rec.date] = {
            date: rec.date,
            earned: 0,
            balance: 0,
            syncedAccounts: 0,
            staleAccounts: 0,
            details: []
          };
        }
        const day = mapByDate[rec.date];
        const earned = rec.earned === null || rec.earned === undefined ? null : Number(rec.earned);
        const balance = rec.balance === null || rec.balance === undefined ? null : Number(rec.balance);
        if (earned !== null) {
          day.earned += earned;
          day.balance += balance || 0;
          day.syncedAccounts++;
        } else {
          day.staleAccounts++;
        }
        day.details.push({
          accountId: accId,
          earned,
          balance,
          claimablePoints: rec.claimablePoints,
          timestamp: rec.timestamp,
          source: rec.source || 'official-sync'
        });
      }
    }
    return Object.values(mapByDate)
      .map((d) => ({ ...d, hasOfficialData: d.syncedAccounts > 0, dataState: d.staleAccounts ? (d.syncedAccounts ? 'partial' : 'stale') : 'complete' }))
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  getRecentAll(days = 30) {
    const target = {};
    const now = Date.now();
    for (const [accountId, list] of Object.entries(this.data.accounts || {})) {
      target[accountId] = {};
      for (const rec of list) {
        if (!rec.date || !rec.timestamp || now - rec.timestamp > days * 86400000) continue;
        target[accountId][rec.date] = rec;
      }
    }
    return target;
  }

  getHistory(accountId, days = 14) {
    const list = (this.data.accounts && this.data.accounts[accountId]) || [];
    return list.slice(-days);
  }
}

export const historyManager = new HistoryManager();
export default historyManager;
