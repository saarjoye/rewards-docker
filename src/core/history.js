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
    if (!this.data.accounts[accountId]) {
      this.data.accounts[accountId] = [];
    }

    const todayStr = new Date().toISOString().slice(0, 10);
    const list = this.data.accounts[accountId];
    const existingIdx = list.findIndex((item) => item.date === todayStr);

    const record = {
      date: todayStr,
      timestamp: Date.now(),
      earned: stats.todayEarned || 0,
      balance: stats.balance || 0,
      streakDays: stats.streakDays || 0
    };

    if (existingIdx >= 0) {
      list[existingIdx] = record;
    } else {
      list.push(record);
      if (list.length > 90) list.shift(); // 保留 90 天
    }

    this.save();
  }

  getMonthHistory(accountId, yearMonth) {
    const accounts = this.data.accounts || {};
    const targetAccounts = (!accountId || accountId === 'all') ? Object.keys(accounts) : [accountId];
    const mapByDate = {};

    for (const accId of targetAccounts) {
      const records = accounts[accId] || [];
      for (const rec of records) {
        if (!rec.date || !rec.date.startsWith(yearMonth)) continue;
        if (!mapByDate[rec.date]) {
          mapByDate[rec.date] = { date: rec.date, earned: 0, balance: 0, details: [] };
        }
        mapByDate[rec.date].earned += (rec.earned || 0);
        mapByDate[rec.date].balance += (rec.balance || 0);
        mapByDate[rec.date].details.push({
          accountId: accId,
          earned: rec.earned || 0,
          balance: rec.balance || 0
        });
      }
    }
    return Object.values(mapByDate).sort((a, b) => a.date.localeCompare(b.date));
  }

  getHistory(accountId, days = 14) {
    const list = (this.data.accounts && this.data.accounts[accountId]) || [];
    return list.slice(-days);
  }
}

export const historyManager = new HistoryManager();
export default historyManager;
