import fs from 'fs';
import path from 'path';
import { DATA_DIR } from './fsUtil.js';

const LOG_FILE = path.join(DATA_DIR, 'app.log');
const MAX_IN_MEMORY_LOGS = 600;
// Node test runner imports production modules. Keep synthetic logs out of data/app.log.
const IS_TEST_RUNNER = Boolean(process.env.NODE_TEST_CONTEXT);

class Logger {
  constructor() {
    this.buffer = [];
    this.subscribers = new Set();
  }

  formatTime(date = new Date()) {
    const pad = (n) => String(n).padStart(2, '0');
    const y = date.getFullYear();
    const m = pad(date.getMonth() + 1);
    const d = pad(date.getDate());
    const h = pad(date.getHours());
    const min = pad(date.getMinutes());
    const s = pad(date.getSeconds());
    return `${y}/${m}/${d} ${h}:${min}:${s}`;
  }

  log(emoji = 'ℹ️', message = '', extra = '', accountPrefix = '') {
    const timeStr = this.formatTime();
    const prefix = accountPrefix ? `[${accountPrefix}] ` : '';
    const fullText = `[${timeStr}] ${emoji} ${prefix}${message}${extra ? ' ' + extra : ''}`;

    // 控制台输出
    console.log(fullText);

    // 内存环形缓存
    const item = {
      id: `${Date.now()}.${Math.random().toString(36).slice(2, 8)}`,
      ts: Date.now(),
      time: timeStr,
      emoji,
      prefix: accountPrefix,
      message,
      extra,
      raw: fullText
    };

    this.buffer.push(item);
    if (this.buffer.length > MAX_IN_MEMORY_LOGS) {
      this.buffer.shift();
    }

    // 文件持久化追加（测试运行器跳过）
    if (!IS_TEST_RUNNER) {
      try {
        fs.appendFileSync(LOG_FILE, fullText + '\n', 'utf-8');
      } catch {}
    }

    // SSE 客户端实时广播
    for (const send of this.subscribers) {
      try {
        send(item);
      } catch {
        this.subscribers.delete(send);
      }
    }
  }

  getRecentLogs(limit = 200) {
    return this.buffer.slice(-limit);
  }

  subscribe(sendFn) {
    this.subscribers.add(sendFn);
    return () => this.subscribers.delete(sendFn);
  }
}

export const logger = new Logger();
export default logger;
