import fs from 'fs';
import path from 'path';
import { chromium } from 'patchright-core';
import logger from '../logger.js';
import { USER_AGENTS } from '../identity/auth.js';
import memorySampler from '../core/memorySampler.js';

class BrowserSlotLock {
  constructor() {
    this.locked = false;
    this.waitQueue = [];
  }

  async acquire(timeoutMs = 60000) {
    if (!this.locked) {
      this.locked = true;
      return true;
    }

    const start = Date.now();
    return new Promise((resolve) => {
      const timer = setInterval(() => {
        if (!this.locked) {
          clearInterval(timer);
          this.locked = true;
          resolve(true);
        } else if (Date.now() - start > timeoutMs) {
          clearInterval(timer);
          resolve(false);
        }
      }, 200);
    });
  }

  release() {
    this.locked = false;
  }
}

export const browserSlotLock = new BrowserSlotLock();

export function getExecutablePath() {
  if (process.env.CHROMIUM_PATH && fs.existsSync(process.env.CHROMIUM_PATH)) {
    return process.env.CHROMIUM_PATH;
  }

  const localAppData = process.env.LOCALAPPDATA || '';
  const candidatePaths = [
    // 1. 本地 Playwright Chromium 预装包
    path.join(localAppData, 'ms-playwright', 'chromium-1200', 'chrome-win64', 'chrome.exe'),
    path.join(localAppData, 'ms-playwright', 'chromium-1248', 'chrome-win64', 'chrome.exe'),
    // 2. Windows 宿主机原生 Edge / Chrome
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    // 3. Linux (Docker/NAS/LXC)
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    // 4. macOS
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  ];

  for (const p of candidatePaths) {
    if (p && fs.existsSync(p)) return p;
  }
  return null;
}

export class BrowserManager {
  constructor() {
    this.activeBrowser = null;
    this.state = {
      status: 'idle', // 'idle' | 'starting' | 'navigating' | 'typing' | 'dwelling' | 'stopped'
      activeAccountId: null,
      activeAccountName: '无活跃任务',
      currentAction: '无头浏览器处于空闲休眠状态 (0 进程占用)',
      currentUrl: '',
      searchProgress: '',
      lastUpdate: Date.now()
    };
  }

  updateState(partial = {}) {
    this.state = {
      ...this.state,
      ...partial,
      lastUpdate: Date.now()
    };
  }

  getState() {
    const mem = memorySampler.getSnapshot();
    return {
      ...this.state,
      memory: mem
    };
  }

  async launch(options = {}) {
    const { proxy, headless = true } = options;

    const launchArgs = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--no-zygote',
      '--disable-gpu',
      '--disable-software-rasterizer',
      '--disable-breakpad',
      '--disable-crash-reporter',
      '--js-flags=--max-old-space-size=512',
      '--disable-background-networking',
      '--disable-default-apps',
      '--disable-extensions',
      '--disable-sync',
      '--disable-translate',
      '--mute-audio',
      '--no-first-run',
      '--blink-settings=imagesEnabled=true'
    ];

    const launchOptions = {
      headless: headless !== false,
      args: launchArgs
    };

    const execPath = getExecutablePath();
    if (execPath) {
      launchOptions.executablePath = execPath;
    }

    if (proxy) {
      launchOptions.proxy = { server: proxy };
    }

    this.updateState({
      status: 'starting',
      currentAction: '正在启动 Chromium 无头进程 (内存优化模式)...'
    });
    const browser = await chromium.launch(launchOptions);
    this.activeBrowser = browser;
    this.updateState({
      status: 'running',
      currentAction: 'Chromium 实例就绪，已分配独立上下文槽位'
    });
    return browser;
  }

  async createContext(browser, options = {}) {
    const { cookies = [], proxy, isMobile = false } = options;

    const contextOptions = {
      userAgent: isMobile ? USER_AGENTS.app : USER_AGENTS.pc,
      viewport: isMobile ? { width: 390, height: 844 } : { width: 1440, height: 900 },
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai'
    };

    const context = await browser.newContext(contextOptions);

    if (Array.isArray(cookies) && cookies.length > 0) {
      try {
        await context.addCookies(cookies);
      } catch (e) {
        logger.log('⚠️', `向浏览器注入 Cookies 出现部分跳过: ${e.message}`);
      }
    }

    return context;
  }

  async close(browser) {
    if (browser) {
      try {
        await browser.close();
      } catch {}
    }
    if (this.activeBrowser === browser) {
      this.activeBrowser = null;
    }
    this.updateState({
      status: 'idle',
      activeAccountName: '无活跃任务',
      currentAction: '无头浏览器已安全关闭，内存已完全释放',
      currentUrl: ''
    });
  }

  /**
   * 带互斥锁与安全回收的执行包装器
   */
  async withBrowser(options = {}, fn) {
    const lockAcquired = await browserSlotLock.acquire(options.timeoutMs || 90000);
    if (!lockAcquired) {
      throw new Error('获取全局浏览器并发锁超时，另一账号或任务正在占用浏览器资源');
    }

    let browser = null;
    try {
      browser = await this.launch(options);
      const context = await this.createContext(browser, options);
      return await fn(browser, context);
    } finally {
      if (browser) {
        await this.close(browser);
      }
      browserSlotLock.release();
    }
  }
}

export const browserManager = new BrowserManager();
export default browserManager;

