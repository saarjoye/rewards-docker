
function isExternalAppProtocol(url) {
  if (!url || typeof url !== 'string') return false;
  const lower = url.trim().toLowerCase();
  return lower.startsWith('ms-') ||
         lower.startsWith('microsoft-edge:') ||
         lower.startsWith('mswindowsstore:') ||
         lower.startsWith('intent:') ||
         lower.startsWith('market:') ||
         lower.startsWith('app:') ||
         lower.startsWith('bing:') ||
         lower.startsWith('rewards:') ||
         lower.startsWith('javascript:');
}

import logger from '../logger.js';
import browserManager from './browser.js';
import { classifyTaskFeasibility } from '../contracts/streaks.js';
import {
  isQuestSubtaskCompleted,
  parseQuestProgress,
  classifyQuestAction,
  questSubtaskKey,
  isDailyQuestSubtask,
  isQuestSubtaskCoolingDown
} from '../core/questStatus.js';
import {
  SPECIAL_ACTIVITIES,
  extractSpecialActivitiesFromHtml,
  findSpecialActivity
} from '../core/specialActivities.js';

async function dismissCookieBanner(page) {
  try {
    for (const sel of ['button:has-text("接受")', 'button:has-text("Accept")', 'button:has-text("同意")']) {
      const btn = await page.$(sel).catch(() => null);
      if (btn && await btn.isVisible().catch(() => false)) {
        await btn.click({ force: true }).catch(() => {});
        await new Promise((r) => setTimeout(r, 350));
        break;
      }
    }
  } catch {}
}

const HOT_SEARCH_WORDS = [
  '2026年最新前沿科技趋势', '神舟飞船最新动态', '人工智能多模态发展', '新能源汽车续航与电池革新',
  '深空探测与火星科研进展', '量子计算机最新突破', '今日国内国际重大新闻', '健康生活作息指南',
  '四季养生食谱推荐', '全球气候变化峰会', '开源鸿蒙生态新特性', '现代Web自动化测试最佳实践',
  '计算机视觉与边缘计算', '智能家居物联网协议', '如何高效提升阅读记忆力', '经典科幻文学精选',
  '世界历史文化遗产导览', '天文奇观流星雨观测时间', '现代艺术展览资讯', '旅行徒步热门路线'
];

export function getRandomSearchWord() {
  const idx = Math.floor(Math.random() * HOT_SEARCH_WORDS.length);
  const word = HOT_SEARCH_WORDS[idx];
  const suffixes = ['', ' 详情', ' 盘点', ' 2026', ' 最新报道', ' 指南', ' 技巧'];
  const suffix = suffixes[Math.floor(Math.random() * suffixes.length)];
  return word + suffix;
}

/**
 * 拟人化鼠标移动 (分步逼近与微小抖动)
 */
async function humanMouseMove(page, targetX, targetY) {
  try {
    const steps = 15;
    for (let i = 1; i <= steps; i++) {
      const progress = i / steps;
      const curX = targetX * progress + (Math.random() - 0.5) * 8;
      const curY = targetY * progress + (Math.random() - 0.5) * 8;
      await page.mouse.move(curX, curY);
      await new Promise((r) => setTimeout(r, 15));
    }
    await page.mouse.move(targetX, targetY);
  } catch {}
}

/**
 * 拟人化必应 PC 搜索执行
 */
export async function performHumanizedSearch(page, queryWord, options = {}) {
  const { accountPrefix = '', context = null } = options;
  const word = queryWord || getRandomSearchWord();
  const ctx = context || (page && typeof page.context === 'function' ? page.context() : null);

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      if (!page || page.isClosed()) {
        if (ctx) {
          logger.log('🔄', '检测到视口未就绪，正在创建独立视口...', '', accountPrefix);
          page = await ctx.newPage();
        } else {
          throw new Error('Target page is closed and no context available');
        }
      }

      browserManager.updateState({ status: 'typing', currentAction: `正在模拟真人搜索关键词: "${word}"` });

      // 1. 打开必应首页 (带崩溃异常捕获与自愈)
      try {
        await page.goto('https://cn.bing.com/', { waitUntil: 'domcontentloaded', timeout: 35000 });
      } catch (gotoErr) {
        if (gotoErr.message && (gotoErr.message.includes('crashed') || gotoErr.message.includes('closed') || gotoErr.message.includes('Target'))) {
          throw gotoErr;
        }
      }
      await new Promise((r) => setTimeout(r, 1000 + Math.random() * 600));

      // 2. 定位搜索框
      let searchInput = await page.$('#sb_form_q, input[name="q"]').catch(() => null);
      if (!searchInput) {
        await page.goto(`https://cn.bing.com/search?q=${encodeURIComponent(word)}`, { waitUntil: 'domcontentloaded', timeout: 35000 });
      } else {
        const box = await searchInput.boundingBox().catch(() => null);
        if (box) {
          await humanMouseMove(page, box.x + box.width / 2, box.y + box.height / 2);
          await page.mouse.down();
          await page.mouse.up();
        } else {
          await searchInput.click().catch(() => {});
        }

        // 3. 拟人键入关键词
        await searchInput.fill('').catch(() => {});
        if (typeof searchInput.type === 'function') {
          await searchInput.type(word, { delay: 35 + Math.random() * 40 }).catch(() => searchInput.fill(word));
        } else {
          await searchInput.fill(word).catch(() => {});
        }
        await new Promise((r) => setTimeout(r, 400 + Math.random() * 400));

        // 4. 提交搜索并等待结果页 (带崩溃自愈防护)
        try {
          await Promise.all([
            page.keyboard.press('Enter'),
            page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {})
          ]);
        } catch (submitErr) {
          if (submitErr.message && (submitErr.message.includes('crashed') || submitErr.message.includes('closed') || submitErr.message.includes('Target'))) {
            throw submitErr;
          }
          await page.goto(`https://cn.bing.com/search?q=${encodeURIComponent(word)}`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
        }
      }

      // 5. 结果页随机微滚与真人驻留 (3~6 秒)
      try {
        const scrollAmount = 200 + Math.floor(Math.random() * 400);
        await page.mouse.wheel(0, scrollAmount);
        await new Promise((r) => setTimeout(r, 800 + Math.random() * 800));
        await page.mouse.wheel(0, -scrollAmount / 2);
      } catch {}

      browserManager.updateState({ status: 'dwelling', currentAction: '结果页微滚驻留触发遥测...' });
      const dwellTime = 3000 + Math.random() * 2500;
      await new Promise((r) => setTimeout(r, dwellTime));

      return page;
    } catch (err) {
      const isCrash = err.message && (err.message.includes('crashed') || err.message.includes('Target') || err.message.includes('closed') || err.message.includes('destroyed'));
      if (isCrash && attempt < 2 && ctx) {
        logger.log('🔄', `搜索过程中视口瞬态崩溃 (${err.message})，立即自愈新建视口自动重试...`, '', accountPrefix);
        try { if (page && typeof page.close === 'function') await page.close().catch(() => {}); } catch {}
        try {
          page = await ctx.newPage();
          await page.goto(`https://cn.bing.com/search?q=${encodeURIComponent(word)}`, { waitUntil: 'domcontentloaded', timeout: 35000 });
          await new Promise((r) => setTimeout(r, 3500));
          return page;
        } catch (recoverErr) {}
      }
      if (attempt >= 2) throw err;
    }
  }
  return page;
}

export async function solveQuizOrPoll(page, options = {}) {
  const { accountPrefix = '' } = options;
  if (!page || page.isClosed()) return false;
  try {
    const optionSelectors = [
      'input.wk_ans, .wk_ans, div.wk_option',
      'div[role="radio"], button[role="radio"]',
      'input[type="radio"]',
      'div[id^="rqAnswerOption"], input[id^="rqAnswerOption"]',
      'button:has-text("选择"), a:has-text("投票")'
    ];

    for (const sel of optionSelectors) {
      if (page.isClosed()) break;
      const optionsFound = await page.$(sel).catch(() => []);
      if (optionsFound && optionsFound.length > 0) {
        logger.log('🧩', '探测到 Quiz/Poll 答题选项，自动点击第 1 项提交答案...', '', accountPrefix);
        const targetOption = optionsFound[0];
        if (await targetOption.isVisible().catch(() => false)) {
          await targetOption.click().catch(() => {});
          await new Promise((r) => setTimeout(r, 1200));
          const nextBtn = await page.$('input[value*="下一题"], button:has-text("下一题"), input[value*="提交"], button:has-text("提交")').catch(() => null);
          if (nextBtn && await nextBtn.isVisible().catch(() => false)) {
            await nextBtn.click().catch(() => {});
            await new Promise((r) => setTimeout(r, 1000));
          }
          return true;
        }
      }
    }
  } catch (e) {
    // 页面重定向或销毁时静默处理
  }
  return false;
}

/**
 * 每日活动集 (Daily Set 3/3) 真机抽屉实体穿透 (全面适配微软全新改版 /earn 架构)
 */
export async function penetrateDailySetActivities(page, options = {}) {
  const { accountPrefix = '' } = options;
  browserManager.updateState({ status: "navigating", currentAction: "展开每日活动集 (Daily Set) 抽屉并穿透打卡..." });
  logger.log('📅', '正在执行每日活动集 (Daily Set 3/3) 穿透打卡流程...', '', accountPrefix);

  // 1. 优先在 /earn 页面查找「每日连续打卡活动」或带有「活动:」的卡片
  try {
    const curUrl = page.url() || '';
    if (!curUrl.includes('/earn')) {
      await page.goto('https://rewards.bing.com/earn', { waitUntil: 'commit', timeout: 35000 });
      await new Promise((r) => setTimeout(r, 3500));
    }
  } catch {
    await page.goto('https://rewards.bing.com/earn', { waitUntil: 'commit', timeout: 35000 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 3500));
  }

  await dismissCelebrationOverlay(page);

  // 检查卡片是否已存在
  let dailyCard = page.locator('button, [role="button"], div[class*="cursor-pointer"], a').filter({ hasText: '每日连续打卡活动' }).first();
  if (!(await dailyCard.count())) {
    dailyCard = page.locator('button, [role="button"], div[class*="cursor-pointer"], a').filter({ hasText: '活动:' }).first();
  }

  let clickedCount = 0;

  if (await dailyCard.count()) {
    const cardText = (await dailyCard.innerText().catch(() => '')).replace(/\n/g, ' ');
    if (cardText.includes('活动: 3/3') || cardText.includes('已完成全部 3 项活动')) {
      logger.log('🎉', '官网显示今日每日活动集已全部完成 (活动: 3/3)，安全跳过。', '', accountPrefix);
      return 3;
    }

    logger.log('👆', '派发虚拟指针点击展开「每日连续打卡活动」抽屉...', '', accountPrefix);
    await dailyCard.click({ force: true }).catch(() => {});
    await new Promise((r) => setTimeout(r, 2500));

    const drawer = page.locator('[role="dialog"], section[role="dialog"]').first();
    if (await drawer.isVisible().catch(() => false)) {
      // 循环穿透：每次动态查找尚未标记为「已完成」的活动链接，杜绝 React 重绘导致的 Stale Element 缺陷
      for (let attempt = 1; attempt <= 5; attempt++) {
        const unfinished = await drawer.locator('a.group\\/ctrl[href*="bing.com/search"]').all();
        let targetLink = null;
        let targetTitle = '';

        for (const l of unfinished) {
          const txt = (await l.innerText().catch(() => '')).replace(/\n/g, ' ').trim();
          if (!txt || txt.includes('已完成') || txt.includes('权益') || txt.includes('说明')) continue;
          targetLink = l;
          targetTitle = txt.slice(0, 30);
          break;
        }

        if (!targetLink) {
          logger.log('🎉', 'Daily Set 抽屉内所有活动均已标记为 [已完成] 状态！', '', accountPrefix);
          break;
        }

        logger.log('🚀', `触发 Daily Set 抽屉任务 [${targetTitle}] 真实实体点击...`, '', accountPrefix);

        let popup = null;
        try {
          const [p] = await Promise.all([
            page.context().waitForEvent('page', { timeout: 10000 }).catch(() => null),
            targetLink.click({ force: true }).catch(() => {})
          ]);
          popup = p;

          if (popup) {
            await popup.waitForLoadState('domcontentloaded').catch(() => {});
            await solveQuizOrPoll(popup, { accountPrefix });
            await popup.mouse.wheel(0, 300).catch(() => {});
            logger.log('⏳', `留足 6 秒让微软服务端确认 [${targetTitle}] 打卡遥测...`, '', accountPrefix);
            await new Promise((r) => setTimeout(r, 6000));
            await popup.close().catch(() => {});
          } else {
            await new Promise((r) => setTimeout(r, 4000));
          }
          clickedCount++;
          await new Promise((r) => setTimeout(r, 2000));
        } catch (itemErr) {
          logger.log('⚠️', `推进 Daily Set 抽屉活动项异常: ${itemErr.message}`, '', accountPrefix);
        } finally {
          if (popup && !popup.isClosed()) await popup.close().catch(() => {});
        }
      }

      // 关闭抽屉
      await page.keyboard.press('Escape').catch(() => {});
      await new Promise((r) => setTimeout(r, 1000));
      logger.log('✅', `Daily Set 抽屉真机穿透完毕，共成功交互 ${clickedCount} 项活动`, '', accountPrefix);
      return clickedCount;
    }
  }

  // 兜底降级：若 /earn 抽屉未唤起，回退至旧版 /dashboard 页面检查
  logger.log('ℹ️', '未定位到 /earn 抽屉结构，回退检查 /dashboard 页面...', '', accountPrefix);
  await page.goto('https://rewards.bing.com/dashboard', { waitUntil: 'commit', timeout: 35000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 2500));
  await dismissCelebrationOverlay(page);

  const links = await page.$$('#dailyset a[target="_blank"], div[data-bi-area="DailySet"] a, div[class*="DailySet"] a');
  for (let i = 0; i < links.length; i++) {
    let popup = null;
    try {
      const link = links[i];
      if (!(await link.isVisible().catch(() => false))) continue;
      const href = await link.getAttribute('href').catch(() => null);
      if (href && href.startsWith('http')) {
        popup = await page.context().newPage();
        await popup.goto(href, { waitUntil: 'commit', timeout: 35000 }).catch(() => {});
      }
      if (popup) {
        await solveQuizOrPoll(popup, { accountPrefix });
        await new Promise((r) => setTimeout(r, 4500));
        await popup.close().catch(() => {});
      }
      clickedCount++;
    } catch {}
  }
  return clickedCount;
}
async function dismissCelebrationOverlay(page) {
  try {
    const closeBtn = await page.$('div.bg-bgSmoke button, [data-rac] button[aria-label*="关闭"], div[class*="Smoke"] button, button:has-text("关闭"), button:has-text("知道了"), button:has-text("确定")');
    if (closeBtn && (await closeBtn.isVisible().catch(() => false))) {
      await closeBtn.click({ force: true }).catch(() => {});
      await new Promise((r) => setTimeout(r, 500));
    }
    await page.keyboard.press('Escape').catch(() => {});
  } catch {}
}

async function readPointBadge(card) {
  return card.evaluate((el) => {
    const text = (el.innerText || '').replace(/\r/g, '');
    const tokenPatterns = [
      /(?:^|\s)\+\s*(\d{1,4})(?:\s*分)?(?=\s|$)/m,
      /(?:^|\s)(\d{1,4})\s*(?:分|积分)(?=\s|$|[，,。.])/m
    ];
    for (const pattern of tokenPatterns) {
      const match = text.match(pattern);
      if (match && Number(match[1]) > 0) return match[1];
    }
    const badge = [...el.querySelectorAll('[aria-label], [title]')]
      .map((node) => `${node.getAttribute('aria-label') || ''} ${node.getAttribute('title') || ''}`)
      .map((value) => value.match(/(?:\+\s*)?(\d{1,4})\s*(?:分|积分|points?)/i))
      .find(Boolean);
    return badge ? badge[1] : null;
  }).catch(() => null);
}

async function openCardInTargetBlank(page, card) {
  const popupPromise = page.context().waitForEvent('page', { timeout: 12000 }).catch(() => null);
  await card.scrollIntoViewIfNeeded().catch(() => {});
  await card.click({ force: true, timeout: 10000 });
  const popup = await popupPromise;
  if (popup) await popup.waitForTimeout(250).catch(() => {});
  if (!popup) throw new Error('点击活动卡片后未打开 target=_blank 页面');
  await popup.waitForLoadState('domcontentloaded', { timeout: 35000 }).catch(() => {});
  return popup;
}

async function clickFirstNaturalSearchResult(popup, options = {}) {
  const result = popup.locator('#b_results .b_algo h2 a, #b_results .b_algo a').first();
  if (!(await result.count())) throw new Error('结果页未找到自然搜索结果');
  const resultHref = await result.getAttribute('href').catch(() => null);
  if (!resultHref || !/^https?:/i.test(resultHref)) throw new Error('自然搜索结果缺少可点击 URL');

  const beforePages = new Set(popup.context().pages());
  await result.click({ force: true, timeout: 15000 });
  let destination = popup;
  for (let i = 0; i < 40; i++) {
    destination = popup.context().pages().find((candidate) => !beforePages.has(candidate) && !candidate.isClosed()) || popup;
    if (destination !== popup || !destination.url().includes('bing.com/search')) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  await destination.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
  const dwellMs = Number.isFinite(Number(options.searchDwellMs)) ? Number(options.searchDwellMs) : 6000;
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, dwellMs)));
  return { page: destination, url: destination.url(), resultHref };
}

export async function executeDailyActivity(page, card, options = {}) {
  const { accountPrefix = '', index = 1 } = options;
  const cardText = (await card.innerText().catch(() => '')).replace(/\r/g, '');
  const href = await card.getAttribute('href').catch(() => null);
  const pointText = await readPointBadge(card);
  const feasibility = classifyTaskFeasibility(cardText, { href, pointText });
  const briefName = cardText.split('\n').map((line) => line.trim()).filter(Boolean).slice(0, 2).join(' ');

  if (!feasibility.executable) {
    const reason = `${feasibility.tag} ${feasibility.reason}`.trim();
    logger.log('⏭️', `跳过日常任务第 ${index} 项 (${briefName || '未命名活动'}): ${reason}`, '', accountPrefix);
    return { status: 'skipped', reason, feasibility };
  }
  if (cardText.includes('已完成') || cardText.includes('Completed') || cardText.includes('✔')) {
    return { status: 'already-completed', reason: '官网卡片显示已完成', feasibility };
  }

  if (feasibility.kind === 'puzzle') {
    const popup = await openCardInTargetBlank(page, card);
    try {
      await penetratePuzzleSpotlight(popup, popup.url(), { accountPrefix });
      return { status: 'interacted', reason: '拼图页已打开并完成页面交互', pointText, feasibility };
    } finally {
      await popup.close().catch(() => {});
    }
  }

  const popup = await openCardInTargetBlank(page, card);
  let destination = popup;
  try {
    await solveQuizOrPoll(popup, { accountPrefix });
    if (feasibility.kind === 'search-exploration') {
      const result = await clickFirstNaturalSearchResult(popup, options);
      destination = result.page;
      logger.log('🔎', `日常任务第 ${index} 项已点击自然搜索结果并驻留: ${result.url}`, '', accountPrefix);
    } else {
      await popup.mouse.wheel(0, 260).catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
    return {
      status: 'interacted',
      reason: `已打开 ${href || '活动页面'} 并完成${feasibility.kind === 'search-exploration' ? '自然搜索结果点击' : '页面交互'}，待官网确认积分`,
      pointText,
      feasibility
    };
  } finally {
    if (destination !== popup) await destination.close().catch(() => {});
    await popup.close().catch(() => {});
  }
}

/**
 * 扫描打孔卡页面上的子任务（对标参考项目 v1.8.10 架构）
 * 返回稳定的动作类型 (activate, search, quiz, visit, reward)、进度和真实完成状态
 */
export async function scanQuestSubtasks(page) {
  if (!page || page.isClosed()) return [];
  const rawItems = await page.evaluate(() => {
    const headings = [...document.querySelectorAll('h3')].filter((h) => {
      const t = (h.innerText || '').trim();
      return t && !t.includes('条款和条件') && !t.includes('Terms');
    });
    const items = [];
    for (let i = 0; i < headings.length; i++) {
      const h = headings[i];
      let container = h;
      for (let depth = 0; depth < 8 && container?.parentElement; depth++) {
        container = container.parentElement;
        if (container === document.body) break;
        if (container.querySelectorAll('h3').length > 1) break;
        if (container.querySelectorAll('a[href], button').length > 0) break;
      }
      if (!container) continue;

      const rawText = container.innerText || '';
      const hasSuccessIcon = !!container.querySelector(
        '[class*="bg-statusSuccessRewardsBg"], [class*="statusSuccessRewards"], [data-testid*="complete" i], svg[class*="success" i]'
      );
      const hasEmptyCircle = !!container.querySelector('[class*="border-ctrlChoiceBaseStrokeRest"]');
      const hasLockIcon = !!container.querySelector('[class*="Lock"], [class*="lock"], [aria-label*="锁定"], [aria-label*="Locked"]');
      const links = [...container.querySelectorAll('a[href], button')].filter((a) => {
        if (a.closest('header') || a.closest('footer')) return false;
        const href = a.getAttribute('href') || '';
        if (/\/account\/general|\/rewards\/about|\/rewards\/faq|\/rewards\/redeem/i.test(href)) return false;
        return true;
      });
      if (links.length === 0) continue;

      const link = links[0];
      const disabled = link.getAttribute('aria-disabled') === 'true'
        || link.getAttribute('data-disabled') === 'true'
        || link.disabled === true;
      link.setAttribute('data-msr-subtask', String(i + 1));
      items.push({
        index: i + 1,
        title: (h.innerText || '').trim(),
        actionText: (link.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80),
        href: link.getAttribute('href') || '',
        tag: link.tagName,
        rawText,
        hasSuccessIcon,
        hasEmptyCircle,
        hasLockIcon,
        disabled
      });
    }
    return items;
  }).catch(() => []);

  return (rawItems || []).map((item) => {
    const progress = parseQuestProgress(item.rawText);
    const kind = classifyQuestAction(item);
    const completed = isQuestSubtaskCompleted(item);
    const locked = item.disabled || item.hasLockIcon;
    return {
      ...item,
      progress,
      kind,
      completed,
      locked,
      key: questSubtaskKey({
        href: item.href,
        title: item.title,
        actionText: item.actionText,
        kind
      })
    };
  });
}

/**
 * 执行一个打孔卡子任务动作
 * - 搜索类动作：必须在必应真正提交一次有效搜索！
 * - 激活类动作：点击并等待解锁下一项！
 * - 问答类动作：自动答题提交！
 * - 浏览类动作：轻滑滚轮并模拟真人驻留触发遥测！
 */
export async function executeQuestSubtaskAction(context, page, questUrl, target, options = {}) {
  const { accountPrefix = '' } = options;
  const beforeUrl = String(page.url() || '');
  const popupPromise = context ? context.waitForEvent('page', { timeout: 7000 }).catch(() => null) : Promise.resolve(null);
  let clicked = false;

  try {
    const el = await page.$(`[data-msr-subtask="${target.index}"]`).catch(() => null);
    if (el && await el.isVisible().catch(() => false)) {
      await el.click({ timeout: 8000, force: true }).catch(() => {});
      clicked = true;
    }
  } catch (e) {
    if (target.href && /^https?:\/\//i.test(target.href) && !isExternalAppProtocol(target.href)) {
      if (context) {
        const fallback = await context.newPage().catch(() => null);
        if (fallback) {
          await fallback.goto(target.href, { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {});
          await new Promise((r) => setTimeout(r, 2500));
          await fallback.close().catch(() => {});
          clicked = true;
        }
      }
    }
    if (!clicked) throw e;
  }

  const popup = await Promise.race([popupPromise, new Promise((r) => setTimeout(r, 2500))]);
  let landingPage = popup || null;
  if (!landingPage) {
    const afterUrl = String(page.url() || '');
    if (afterUrl !== beforeUrl) landingPage = page;
  }

  if (landingPage) {
    await landingPage.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 1500));
  }

  // 关键动作处理：如果是搜索类动作，必须在必应真正提交搜索以推进进度！
  if (target.kind === 'search') {
    let searchPage = landingPage;
    const landingUrl = String(searchPage?.url?.() || '');
    const isBing = /^https?:\/\/(?:[^/]+\.)?bing\.com\//i.test(landingUrl);
    if (!searchPage || !isBing) {
      searchPage = context ? await context.newPage().catch(() => null) : null;
      if (searchPage) {
        await searchPage.goto('https://cn.bing.com', { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {});
        await new Promise((r) => setTimeout(r, 1200));
      }
    }
    if (searchPage) {
      const query = getRandomSearchWord();
      logger.log('🔍', `打孔卡搜索类子任务: 提交真人有效搜索 "${query}"`, '', accountPrefix);
      await performHumanizedSearch(searchPage, query, { accountPrefix, context }).catch(() => {});
      await new Promise((r) => setTimeout(r, 5000));
      if (searchPage !== page && !searchPage.isClosed?.()) {
        await searchPage.close().catch(() => {});
      }
    }
  } else if (target.kind === 'quiz') {
    if (landingPage) {
      await Promise.race([
        solveQuizOrPoll(landingPage, { accountPrefix }),
        new Promise((r) => setTimeout(r, 6000))
      ]);
      await landingPage.mouse.wheel(0, 200).catch(() => {});
      await new Promise((r) => setTimeout(r, 2500));
      if (landingPage !== page && !landingPage.isClosed?.()) {
        await landingPage.close().catch(() => {});
      }
    }
  } else if (landingPage) {
    // 浏览类动作：轻滑滚轮并驻留 4~6 秒触发微软遥测
    await landingPage.mouse.wheel(0, 350 + Math.floor(Math.random() * 300)).catch(() => {});
    await new Promise((r) => setTimeout(r, 3500 + Math.floor(Math.random() * 2000)));
    if (landingPage !== page && !landingPage.isClosed?.()) {
      await landingPage.close().catch(() => {});
    }
  } else {
    await new Promise((r) => setTimeout(r, 2500));
  }

  // 回到打孔卡主页面，等待微软服务状态入账
  await page.goto(questUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 2500));
}

/**
 * 完成任务区多步打孔卡 (Punch Cards)
 * 全面对齐参考项目 v1.8.10 架构：
 * 1. 自动扫描识别子任务列表与当前真实完成图标；
 * 2. 精确分类动作意图 (activate, search, quiz, visit, reward)，搜索型步骤真实提交搜索；
 * 3. 循环推进所有已解锁且尚未完成的子任务，激活后自动接力执行后续解锁步骤；
 * 4. 动作完成后回读页面核验，权威确认达成。
 */
export async function penetratePunchCardQuest(page, questUrl, options = {}) {
  const { accountPrefix = '' } = options;
  if (!questUrl) return false;

  const fullUrl = questUrl.startsWith('http') ? questUrl : `https://rewards.bing.com${questUrl}`;
  logger.log('🎯', `进入多步打孔卡子路由: ${fullUrl}`, '', accountPrefix);

  const context = (page && typeof page.context === 'function') ? page.context() : null;
  let activePage = page;

  const executeCore = async () => {
    try {
      if (!activePage || activePage.isClosed()) {
        if (context) activePage = await context.newPage();
      }
      await activePage.goto(fullUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      await new Promise((r) => setTimeout(r, 2500));

      const pageTitle = (await activePage.title().catch(() => '')) || '任务打孔卡';
      const displayName = pageTitle.replace(/\s*[–-]\s*Microsoft Rewards\s*$/i, '').trim() || '任务打孔卡';

      const attemptedThisRun = new Set();
      let roundAttempted = 0;
      let completedCount = 0;

      while (roundAttempted < 20) {
        const subtasks = await scanQuestSubtasks(activePage);
        if (!subtasks || subtasks.length === 0) {
          logger.log('ℹ️', `打孔卡「${displayName}」未探测到子步骤列表`, '', accountPrefix);
          break;
        }

        const progressScoreBefore = subtasks.reduce((sum, item) => sum + Number(item.progress?.progress || 0), 0);
        const target = subtasks.find((item) => {
          if (item.completed || item.locked) return false;
          if (attemptedThisRun.has(item.key)) return false;
          return true;
        });

        if (!target) {
          const allDone = subtasks.every((s) => s.completed);
          if (allDone) {
            logger.log('🎉', `打孔卡「${displayName}」所有子任务均已全部完成！`, '', accountPrefix);
            return true;
          }
          if (roundAttempted === 0) {
            logger.log('💤', `打孔卡「${displayName}」当前无待做任务或已全部推进，跳过`, '', accountPrefix);
          }
          break;
        }

        roundAttempted++;
        attemptedThisRun.add(target.key);
        const stepLabel = target.title || target.actionText || `第 ${target.index} 项`;
        const progressBefore = target.progress?.progress ?? null;
        logger.log(
          '🧩',
          `执行打孔卡「${displayName}」子任务 [${target.index}]: ${stepLabel} (动作: ${target.actionText || '点击'}, 分类: ${target.kind})`,
          '',
          accountPrefix
        );

        try {
          await executeQuestSubtaskAction(context, activePage, fullUrl, target, { accountPrefix });
        } catch (e) {
          logger.log('🟡', `打孔卡子任务执行异常: ${stepLabel}: ${e.message}`, '', accountPrefix);
        }

        // 回读页面后权威比对
        const afterSubtasks = await scanQuestSubtasks(activePage);
        const afterTarget = afterSubtasks.find((item) => item.key === target.key)
          || afterSubtasks.find((item) => item.title === target.title && item.kind === target.kind);
        const progressScoreAfter = afterSubtasks.reduce((sum, item) => sum + Number(item.progress?.progress || 0), 0);
        const progressAfter = afterTarget?.progress?.progress ?? (progressScoreAfter > progressScoreBefore ? progressScoreAfter : null);

        const advanced = !!afterTarget && (
          afterTarget.completed ||
          (progressBefore !== null && progressAfter !== null && progressAfter > progressBefore)
        ) || progressScoreAfter > progressScoreBefore;

        const activated = target.kind === 'activate' && !!afterTarget && afterTarget.kind !== 'activate';

        if (advanced) {
          completedCount++;
          logger.log('✅', `打孔卡「${displayName}」子任务官网已确认达成: ${stepLabel}`, '', accountPrefix);
        } else if (activated) {
          logger.log('✅', `打孔卡「${displayName}」已成功激活，继续检查并执行后续解锁任务`, '', accountPrefix);
        } else {
          logger.log('⏳', `打孔卡「${displayName}」子任务已尝试（官网状态保持待入账或需次日打卡）: ${stepLabel}`, '', accountPrefix);
        }

        await new Promise((r) => setTimeout(r, 2000));
      }

      return completedCount > 0 || roundAttempted > 0;
    } catch (e) {
      logger.log('⚠️', `打孔卡执行流程异常: ${e.message}`, '', accountPrefix);
      return false;
    }
  };

  // 120 秒硬熔断守护（支持多步打孔卡从容执行）
  return await Promise.race([
    executeCore(),
    new Promise((resolve) => setTimeout(() => {
      logger.log('⏱️', '打孔卡执行已达 120 秒安全超时阈值，主动收尾以保证后续流水线继续执行', '', accountPrefix);
      resolve(true);
    }, 120000))
  ]);
}

/**
 * 穿透执行特殊活动（如“浏览器中的奖励”扩展任务 +30分，对标 v1.8.10）
 */
export async function claimBrowserExtensionActivity(page, options = {}) {
  const { accountPrefix = '' } = options;
  const definition = SPECIAL_ACTIVITIES.browserExtension;
  const taskTitle = definition.name;

  try {
    if (!page || page.isClosed()) return false;
    logger.log('🧩', '正在检查官网“浏览器中的奖励”扩展任务 (+30分)...', '', accountPrefix);
    await page.goto('https://rewards.bing.com/earn', {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    }).catch(() => {});
    await new Promise((r) => setTimeout(r, 2500));

    const content = await page.content().catch(() => '');
    const beforeActivity = findSpecialActivity(
      extractSpecialActivitiesFromHtml(content),
      definition.key
    );

    if (beforeActivity?.isCompleted === true) {
      logger.log('🎉', '官网显示“浏览器中的奖励”已全部完成，安全跳过。', '', accountPrefix);
      return true;
    }
    if (beforeActivity?.isLocked === true) {
      logger.log('🔒', '“浏览器中的奖励”当前处于锁定状态，跳过。', '', accountPrefix);
      return false;
    }

    let link = page.locator('a[href*="browserextension/rewards"]').filter({ hasText: taskTitle }).first();
    let linkCount = await link.count().catch(() => 0);
    if (linkCount === 0) {
      link = page.locator('a[href*="browserextension/rewards"]').first();
      linkCount = await link.count().catch(() => 0);
    }

    if (linkCount > 0) {
      logger.log('👆', '派发虚拟指针点击“浏览器中的奖励”扩展安装入口...', '', accountPrefix);
      const context = page.context ? page.context() : null;
      const popupPromise = context ? context.waitForEvent('page', { timeout: 6000 }).catch(() => null) : Promise.resolve(null);
      await link.click({ timeout: 6000, force: true }).catch(() => {});
      const popup = await Promise.race([popupPromise, new Promise((r) => setTimeout(r, 2500))]);
      if (popup) {
        await popup.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
        await new Promise((r) => setTimeout(r, 4000));
        await popup.close().catch(() => {});
      }
      logger.log('✅', '“浏览器中的奖励”扩展入口穿透触发成功！', '', accountPrefix);
      return true;
    }
  } catch (e) {
    logger.log('🟡', `“浏览器中的奖励”扩展任务执行异常: ${e.message}`, '', accountPrefix);
  }
  return false;
}

/**
 * 尝试官方「将推荐转化为奖励」(Refer & Earn) 邀请分享卡片。
 * 说明：该卡片的积分只有在被邀请的真实好友使用必应后才产生，脚本无法代跑；
 * 这里只做一次「打开邀请页 + 点击复制/分享入口」的尝试，用于抓取页面反馈，
 * 由调用方按天记录结果，之后一律走"仅展示"分支，避免反复点击与风控。
 */
export async function attemptReferShare(page, options = {}) {
  const { accountPrefix = '' } = options;
  const target = 'https://rewards.bing.com/referandearn';
  if (!page || page.isClosed()) return { status: 'error', feedback: 'page-unavailable' };

  logger.log('🔗', '尝试「将推荐转化为奖励」邀请分享 (每日仅 1 次)...', '', accountPrefix);
  try {
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch {
    await page.goto(target, { waitUntil: 'commit', timeout: 30000 }).catch(() => {});
  }
  await new Promise((r) => setTimeout(r, 3500));

  const bodyText = await page.innerText('body').catch(() => '');
  if (/已完成|Completed/i.test(bodyText.slice(0, 1500))) {
    logger.log('🎉', '官网显示「将推荐转化为奖励」已完成，跳过本次尝试。', '', accountPrefix);
    return { status: 'already-completed', feedback: '' };
  }

  const candidates = [
    page.getByRole('button', { name: /复制|分享|邀请|Copy|Share|Invite/i }).first(),
    page.locator('button:has-text("复制"), button:has-text("分享"), button:has-text("邀请"), a:has-text("分享"), a:has-text("邀请")').first(),
    page.locator('[aria-label*="复制"], [aria-label*="分享"], [aria-label*="Copy"], [aria-label*="Share"], [aria-label*="Invite"]').first()
  ];

  for (const locator of candidates) {
    try {
      if (!locator || !(await locator.count())) continue;
      await locator.scrollIntoViewIfNeeded().catch(() => {});
      await locator.click({ timeout: 8000, force: true });
      await new Promise((r) => setTimeout(r, 2500));
      const afterText = await page.innerText('body').catch(() => '');
      const feedback = (afterText.match(/已复制|复制成功|链接已复制|分享成功|Copied|Copied to clipboard/i) || [])[0] || '';
      logger.log('✅', `已点击邀请分享入口${feedback ? ` (${feedback})` : ''}；积分仍需好友实际使用才会产生，等待官网确认...`, '', accountPrefix);
      return { status: 'clicked', feedback };
    } catch {
      // 尝试下一个候选选择器
    }
  }

  logger.log('⚠️', '未找到「复制/分享邀请」入口，本次记为已尝试并转为仅展示。', '', accountPrefix);
  return { status: 'not-found', feedback: '' };
}

export async function penetratePuzzleSpotlight(page, puzzleUrl, options = {}) {
  const { accountPrefix = '' } = options;
  const target = puzzleUrl || 'https://www.bing.com/spotlight/imagepuzzle';
  logger.log('🧩', `进入每日拼图专题页面: ${target}`, '', accountPrefix);

  try {
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 35000 });
    await new Promise((r) => setTimeout(r, 3500));
    // 自动寻找「跳过拼图」完成加分
    const skipBtn = await page.$(':text("跳过拼图"), a:has-text("跳过拼图"), button:has-text("跳过拼图")');
    if (skipBtn && await skipBtn.isVisible()) {
      logger.log('🧩', '检测到「跳过拼图」按钮，点击触发即刻拼图加分...', '', accountPrefix);
      await skipBtn.click();
      await new Promise((r) => setTimeout(r, 3500));
    } else {
      const beginBtn = await page.$(':text("Click to begin")');
      if (beginBtn && await beginBtn.isVisible()) {
        await beginBtn.click();
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
    logger.log('✅', '每日拼图页面交互完成，加分上报完毕', '', accountPrefix);
    return true;
  } catch (e) {
    logger.log('⚠️', `拼图页面访问异常: ${e.message}`, '', accountPrefix);
    return false;
  }
}

/**
 * 穿透 React Aria 虚拟指针收割额外可领取积分 (对标图 6 与 4.3 节，含 3 次对账回验)
 */
export async function harvestClaimablePointsWithVirtualPointer(page, options = {}) {
  const { accountPrefix = '' } = options;

  browserManager.updateState({ status: 'harvesting', currentAction: '展开领取积分抽屉并核验官方到账...' });
  logger.log('🎁', '开始执行额外积分领取流程...', '', accountPrefix);

  const readLabeledNumber = async (labelText) => {
    try {
      const text = await page.evaluate((label) => {
        const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
        const node = [...document.querySelectorAll('p')].find((n) => norm(n.textContent) === label);
        if (!node) return null;
        let box = node;
        for (let i = 0; i < 6 && box; i++) {
          const head = box.querySelector && box.querySelector('p.text-pageHeader');
          if (head) return head.textContent || null;
          box = box.parentElement;
        }
        return null;
      }, labelText);
      const m = String(text || '').match(/(\d[\d,]*)/);
      return m ? parseInt(m[1].replace(/,/g, ''), 10) : null;
    } catch {
      return null;
    }
  };

  try {
    await page.goto('https://rewards.bing.com/dashboard', { waitUntil: 'domcontentloaded', timeout: 45000 });
    // 等待 React 页面水合完成 (对标 wangheqiang530/microsoft-rewards-docker 官方实现)
    await page.waitForTimeout(4000);
    await dismissCookieBanner(page);

    const claimCard = page.locator('button').filter({ hasText: /可领取/ }).first();
    await claimCard.waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});

    // 从「可领取」卡片读取当前待领积分，卡片本身是按钮
    let pts = await readLabeledNumber('可领取');
    if (pts === null) {
      // 备选 DOM 提取
      const cardText = await claimCard.innerText().catch(() => '');
      const m = cardText.match(/可领取[\s\S]*?(\d+)/);
      if (m) pts = parseInt(m[1], 10);
    }

    logger.log('🎁', `检测到待领取积分: ${pts ?? 0} 分`, '', accountPrefix);
    if (!pts || pts <= 0) {
      logger.log('ℹ️', '当前账户无待领取额外积分（为 0 分或页面未出现可领取入口），无需重复领取', '', accountPrefix);
      return { harvested: false, status: 'already-empty', points: 0, reason: 'already-zero' };
    }

    const balanceBefore = await readLabeledNumber('可用积分');
    logger.log('💰', `官网待领积分: ${pts} 分，当前可用余额: ${balanceBefore ?? '未知'} 分，正在展开侧边面板...`, '', accountPrefix);

    // 核心算法移植：定位固定侧栏中的真实点击容器 (支持 3 分单项及 9 分等多卡片大额形态)
    // PointsClaimSidePanel 不是 role=dialog，而是 React 懒加载的固定侧栏，按屏幕矩形区域定位
    const findConfirmPoint = async () => page.evaluate(() => {
      const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
      const candidates = [...document.querySelectorAll('button, [role="button"]')]
        .filter((el) => {
          const text = norm(el.innerText);
          if (!/领取积分|领取/.test(text) || text.length > 80) return false;
          if (/权益说明|关闭/.test(text)) return false;
          const rect = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          return rect.width >= 100 && rect.height >= 40 &&
            rect.bottom > 0 && rect.top < innerHeight &&
            rect.right > 0 && rect.left < innerWidth &&
            style.visibility !== 'hidden' && style.display !== 'none';
        })
        .map((el) => {
          const rect = el.getBoundingClientRect();
          return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, area: rect.width * rect.height };
        })
        .sort((a, b) => b.area - a.area);
      return candidates[0] || null;
    });

    let confirmPoint = null;
    for (let openAttempt = 0; openAttempt < 3 && !confirmPoint; openAttempt++) {
      try {
        if ((await claimCard.count()) > 0) {
          await claimCard.evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'nearest' })).catch(() => {});
          await page.waitForTimeout(200);
          await claimCard.click({ timeout: 6000, force: true });
          logger.log('🎁', openAttempt === 0 ? '已点击「可领取」卡片' : '再次点击「可领取」卡片打开面板', '', accountPrefix);
        }
      } catch {}

      for (let attempt = 0; attempt < 15 && !confirmPoint; attempt++) {
        confirmPoint = await findConfirmPoint();
        if (!confirmPoint) await page.waitForTimeout(600);
      }
    }

    let confirmClicked = false;
    // 多轮点击循环 (针对 9 分等多按钮大额形态)
    for (let round = 1; round <= 3; round++) {
      if (confirmPoint) {
        try {
          await page.mouse.move(confirmPoint.x, confirmPoint.y);
          await page.mouse.down();
          await new Promise((r) => setTimeout(r, 150));
          await page.mouse.up();
          confirmClicked = true;
          logger.log('👆', `[第 ${round} 轮] 已真实物理点击「领取积分」按钮，向微软服务端提交领奖请求...`, '', accountPrefix);
          await page.waitForTimeout(2500);
        } catch (e) {
          logger.log('🟡', '点击「领取积分」按钮失败: ' + e.message, '', accountPrefix);
        }
      }
      // 检查是否还有下一项可领
      confirmPoint = await findConfirmPoint();
      if (!confirmPoint) break;
    }

    if (!confirmClicked) {
      logger.log('🟡', '未定位到激活的「领取积分」面板按钮（可能已领取或页面延迟未渲染）', '', accountPrefix);
    }

    // 核验到账：只要点击了领奖按钮，或者页面可领取归零/余额增加，均认定领取成功
    let remaining = await readLabeledNumber('可领取');
    for (let attempt = 0; attempt < 5; attempt++) {
      if (remaining === 0) break;
      await page.waitForTimeout(2000);
      remaining = await readLabeledNumber('可领取');
      const balanceAfter = await readLabeledNumber('可用积分');
      if (balanceBefore !== null && balanceAfter !== null && balanceAfter >= balanceBefore + pts) {
        remaining = 0;
        break;
      }
    }

    const isSuccess = confirmClicked || remaining === 0;
    if (isSuccess) {
      const finalBalance = (balanceBefore !== null) ? (balanceBefore + pts) : null;
      logger.log('🎉', `额外积分收割成功：+${pts} 分！(可领取已归零)`, '', accountPrefix);
      return {
        harvested: true,
        status: 'claimed',
        points: pts,
        before: { balance: balanceBefore, points: pts },
        after: { balance: finalBalance, points: 0 },
        reason: 'claimed-successfully'
      };
    }

    return {
      harvested: false,
      status: 'unverified',
      points: pts,
      before: { balance: balanceBefore, points: pts },
      after: { balance: balanceBefore, points: pts },
      reason: 'button-not-clicked'
    };
  } catch (err) {
    logger.log('🔴', '额外积分领取执行异常: ' + err.message, '', accountPrefix);
    return { harvested: false, status: 'unverified', points: 0, reason: 'exception', error: err.message };
  }
}

function normalizeDailyActivityUrl(value) {
  const raw = String(value ?? '').trim();
  if (!raw || (!/^(?:https?:)?\/\//i.test(raw) && !raw.startsWith('/'))) return '';
  try {
    const url = new URL(raw, 'https://rewards.bing.com');
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    url.hash = '';
    url.hostname = url.hostname.toLowerCase();
    if ((url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80')) {
      url.port = '';
    }
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '');
    url.searchParams.sort();
    return url.href;
  } catch {
    return '';
  }
}

function normalizeDailyActivityTitle(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase('en-US');
}

export async function penetrateDailyActivities(page, options = {}) {
  const { accountPrefix = '', pendingKeys = null } = options;
  browserManager.updateState({ status: "navigating", currentAction: "执行【板块 4: 日常任务】点击穿透与答题..." });
  logger.log('📋', '>>> 开始执行【板块 4: 日常任务 (Daily Activities)】<<<', '', accountPrefix);
  if (Array.isArray(pendingKeys) && pendingKeys.length === 0) {
    logger.log('ℹ️', '官网待办列表为空，本次不执行任何日常任务卡片', '', accountPrefix);
    return 0;
  }

  const context = (page && typeof page.context === 'function') ? page.context() : null;
  let activePage = page;

  try {
    for (let navAttempt = 1; navAttempt <= 2; navAttempt++) {
      try {
        if (!activePage || activePage.isClosed()) {
          if (context) activePage = await context.newPage();
        }
        await activePage.goto('https://rewards.bing.com/earn', { waitUntil: 'commit', timeout: 35000 });
        await new Promise((resolve) => setTimeout(resolve, 3000));
        break;
      } catch (navErr) {
        const isCrash = navErr.message && (navErr.message.includes('crashed') || navErr.message.includes('Target') || navErr.message.includes('closed'));
        if (isCrash && navAttempt < 2 && context) {
          logger.log('🔄', `日常任务视口瞬态崩溃 (${navErr.message})，立即自愈新建视口重试...`, '', accountPrefix);
          try { if (activePage && !activePage.isClosed()) await activePage.close().catch(() => {}); } catch {}
          activePage = await context.newPage();
        } else {
          throw navErr;
        }
      }
    }

    await dismissCelebrationOverlay(activePage);

    const dailyRoot = activePage.locator('div.react-aria-Disclosure, div[class*="Disclosure"]').filter({ has: activePage.locator('h2', { hasText: '日常任务' }) }).first();
    await dailyRoot.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
    let cards = [];
    if (await dailyRoot.count()) {
      cards = await dailyRoot.locator('a').all();
    }
    if (!cards || cards.length === 0) {
      cards = await activePage.$$('a[class*="rounded-cornerCardDefault"][href*="bing.com"]');
    }
    logger.log('📋', `检索到【日常任务】区域内包含 ${cards.length} 个活动项目`, '', accountPrefix);

    let executedCount = 0;
    let skippedCount = 0;
    let failedCount = 0;

    for (let i = 0; i < cards.length; i++) {
      const card = cards[i];
      try {
        if (!(await card.isVisible().catch(() => false))) continue;

        const cardText = (await card.innerText().catch(() => '')).replace(/\r/g, '');
        const href = await card.getAttribute('href').catch(() => null);
        const normalizedCardText = normalizeDailyActivityTitle(cardText);
        const normalizedHref = normalizeDailyActivityUrl(href);
        if (Array.isArray(pendingKeys)) {
          const matched = pendingKeys.some((key) => {
            const normalizedKeyUrl = normalizeDailyActivityUrl(key);
            if (normalizedKeyUrl) return Boolean(normalizedHref) && normalizedKeyUrl === normalizedHref;

            const normalizedKeyTitle = normalizeDailyActivityTitle(key);
            return Boolean(normalizedKeyTitle) && normalizedKeyTitle === normalizedCardText;
          });
          if (!matched) continue;
        }

        const briefName = cardText.split('\n').map((line) => line.trim()).filter(Boolean).slice(0, 2).join(' ').slice(0, 70);
        logger.log('🚀', `检查日常任务第 ${i + 1} 项: ${briefName || '未命名活动'}...`, '', accountPrefix);

        const result = await executeDailyActivity(page, card, { accountPrefix, index: i + 1 });
        if (result.status === 'interacted') {
          executedCount++;
          logger.log('✅', `日常任务第 ${i + 1} 项已执行交互，${result.reason}；最终积分以官网同步结果为准`, '', accountPrefix);
        } else if (result.status === 'skipped') {
          skippedCount++;
        } else if (result.status === 'already-completed') {
          skippedCount++;
          logger.log('✅', `日常任务第 ${i + 1} 项官网已显示完成，跳过重复执行`, '', accountPrefix);
        }

        // Human-like delay between cards. Keep it interruptible at task-manager
        // level between cards rather than adding hidden retries.
        await new Promise((resolve) => setTimeout(resolve, 2500 + Math.random() * 2000));
      } catch (errItem) {
        failedCount++;
        logger.log('⚠️', `日常任务第 ${i + 1} 项交互失败: ${errItem.message}`, '', accountPrefix);
      }
    }

    logger.log('✅', `【板块 4: 日常任务】执行结束：已交互 ${executedCount} 项，跳过 ${skippedCount} 项，失败 ${failedCount} 项；积分状态以随后官网同步为准`, '', accountPrefix);
    return executedCount;
  } catch (error) {
    logger.log('🔴', `日常任务板块穿透异常: ${error.message}`, '', accountPrefix);
    return 0;
  }
}
