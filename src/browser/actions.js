import logger from '../logger.js';
import browserManager from './browser.js';
import { classifyTaskFeasibility } from '../contracts/streaks.js';

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
  try {
    // 探测问答选项容器（如 .wk_ans、div[role="radio"]、input[type="radio"]、button[data-bi-area] 等）
    const optionSelectors = [
      'input.wk_ans, .wk_ans, div.wk_option',
      'div[role="radio"], button[role="radio"]',
      'input[type="radio"]',
      'div[id^="rqAnswerOption"], input[id^="rqAnswerOption"]',
      'button:has-text("选择"), a:has-text("投票")'
    ];

    for (const sel of optionSelectors) {
      const optionsFound = await page.$$(sel);
      if (optionsFound && optionsFound.length > 0) {
        logger.log('🧩', `探测到 Quiz/Poll 答题选项，自动点击第 1 项提交答案...`, '', accountPrefix);
        const targetOption = optionsFound[0];
        if (await targetOption.isVisible()) {
          await targetOption.click();
          await new Promise((r) => setTimeout(r, 2500));
          // 尝试点击「下一题」或确认
          const nextBtn = await page.$('input[value*="下一题"], button:has-text("下一题"), input[value*="提交"], button:has-text("提交")');
          if (nextBtn && await nextBtn.isVisible()) {
            await nextBtn.click();
            await new Promise((r) => setTimeout(r, 2000));
          }
          return true;
        }
      }
    }
  } catch (e) {
    logger.log('⚠️', `Quiz/Poll 交互尝试: ${e.message}`, '', accountPrefix);
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

export async function penetratePunchCardQuest(page, questUrl, options = {}) {
  const { accountPrefix = '' } = options;
  if (!questUrl) return false;

  const fullUrl = questUrl.startsWith('http') ? questUrl : `https://rewards.bing.com${questUrl}`;
  logger.log('🎯', `进入多步打孔卡子路由: ${fullUrl}`, '', accountPrefix);

  const context = (page && typeof page.context === 'function') ? page.context() : null;
  let activePage = page;

  try {
    for (let navAttempt = 1; navAttempt <= 2; navAttempt++) {
      try {
        if (!activePage || activePage.isClosed()) {
          if (context) activePage = await context.newPage();
        }
        try {
          await activePage.goto(fullUrl, { waitUntil: 'commit', timeout: 35000 });
        } catch (gotoErr) {
          if (gotoErr.message && (gotoErr.message.includes('crashed') || gotoErr.message.includes('Target') || gotoErr.message.includes('closed'))) {
            throw gotoErr;
          }
        }
        await new Promise((r) => setTimeout(r, 2500));
        break;
      } catch (navErr) {
        const isCrash = navErr.message && (navErr.message.includes('crashed') || navErr.message.includes('Target') || navErr.message.includes('closed'));
        if (isCrash && navAttempt < 2 && context) {
          logger.log('🔄', `打孔卡视口瞬态崩溃 (${navErr.message})，立即自愈新建视口重试...`, '', accountPrefix);
          try { if (activePage && !activePage.isClosed()) await activePage.close().catch(() => {}); } catch {}
          activePage = await context.newPage();
        } else {
          throw navErr;
        }
      }
    }

    // 扫描子步骤卡片 (使用 activePage.$$ 获取所有子步骤链接/按钮)
    let stepCards = await activePage.$$('a[href*="redirect?"], a[href*="bing.com"][class*="rounded-cornerCtrlRest"], a[class*="bgCtrlBrandRest"], div[data-bi-area="PunchCardStep"] a, a[href*="/quest/"], a.c-call-to-action');
    if (!stepCards || stepCards.length === 0) {
      stepCards = await activePage.$$('a[class*="rounded-cornerCtrlRest"], a[class*="Button"], button[class*="bg-bgCtrlBrandRest"], a:has-text("立即激活"), a:has-text("开始"), a:has-text("加入")');
    }
    logger.log('🎯', `打孔卡内部发现 ${stepCards.length} 个子步骤`, '', accountPrefix);

    for (let j = 0; j < stepCards.length; j++) {
      let stepPopup = null;
      const step = stepCards[j];
      try {
        const text = await step.innerText().catch(() => '');
        if (text.includes('明天再来') || text.includes('天解锁')) {
          logger.log('⏳', `打孔卡第 ${j + 1} 步存在时间锁 [明天再来]，打上【明日解锁】标签安全跳过`, '', accountPrefix);
          continue;
        }

        const href = await step.getAttribute('href').catch(() => null);

        if (href && href.startsWith('http')) {
          if (context) {
            stepPopup = await context.newPage();
            await stepPopup.goto(href, { waitUntil: 'commit', timeout: 35000 }).catch(() => {});
          }
        } else if (await step.isVisible().catch(() => false)) {
          const [p] = await Promise.all([
            activePage.context().waitForEvent('page', { timeout: 8000 }).catch(() => null),
            step.click({ force: true, timeout: 6000 }).catch(() => {})
          ]);
          stepPopup = p;
        }

        if (stepPopup) {
          await stepPopup.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
          await solveQuizOrPoll(stepPopup, { accountPrefix });
          await stepPopup.mouse.wheel(0, 200).catch(() => {});
          await new Promise((r) => setTimeout(r, 4500));
          await stepPopup.close().catch(() => {});
          logger.log('✅', `打孔卡子步骤 ${j + 1} 穿透打卡成功`, '', accountPrefix);
        } else {
          await new Promise((r) => setTimeout(r, 2500));
        }
      } catch (eStep) {
        logger.log('⚠️', `推进打孔卡子步骤 ${j + 1} 异常: ${eStep.message}`, '', accountPrefix);
      } finally {
        if (stepPopup && !stepPopup.isClosed()) await stepPopup.close().catch(() => {});
      }
    }
    return true;
  } catch (e) {
    logger.log('⚠️', `穿透打孔卡异常: ${e.message}`, '', accountPrefix);
    return false;
  }
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
  const claimLabel = '可领取';
  const balanceLabel = '可用积分';

  browserManager.updateState({ status: 'harvesting', currentAction: '展开领取积分抽屉并核验官方到账...' });
  logger.log('🎁', '开始执行额外积分领取流程...', '', accountPrefix);

  const readDashboard = async () => {
    const body = await page.locator('body').innerText().catch(() => '');
    const card = page.locator('button').filter({ hasText: claimLabel }).first();
    let points = null;
    if (await card.count()) {
      const cardText = (await card.innerText().catch(() => '')).replace(/\s+/g, ' ');
      // 严格对齐 wangheqiang530 规范：必须匹配紧跟在"可领取"后面的明确数字，杜绝随意匹配页面其他数字
      const match = cardText.match(/可领取[\s\S]*?(\d+)/);
      points = match ? Number(match[1].replace(/,/g, '')) : 0;
    }
    const balanceMatch = body.match(new RegExp(balanceLabel + '\\s*[\\r\\n]+\\s*([0-9,]+)'));
    const balance = balanceMatch ? Number(balanceMatch[1].replace(/,/g, '')) : null;
    return { card, points, balance };
  };

  try {
    await page.goto('https://rewards.bing.com/dashboard', { waitUntil: 'domcontentloaded', timeout: 45000 });
    // 等待 React 页面水合完成 (对齐 wangheqiang530/microsoft-rewards-docker)
    await page.waitForTimeout(3500);
    await dismissCookieBanner(page);

    const before = await readDashboard();
    if (!(await before.card.count())) {
      logger.log('ℹ️', '当前仪表盘未检测到「可领取」积分卡片，跳过收割', '', accountPrefix);
      return { harvested: false, points: 0, reason: 'claim-card-not-found', before };
    }
    if (before.points === 0) {
      logger.log('ℹ️', '「可领取」当前为 0 分，无需重复领取', '', accountPrefix);
      return { harvested: false, status: 'already-empty', points: 0, reason: 'already-zero', before, after: before };
    }
    if (!Number.isFinite(before.points)) {
      throw new Error('无法从官网卡片解析可领取积分，拒绝猜测成功状态');
    }

    const pts = before.points;
    logger.log('💰', `官网显示可领取 ${pts} 分，可用余额 ${before.balance ?? '未知'} 分，展开领取抽屉...`, '', accountPrefix);

    // 1. 精确点击卡片展开抽屉 (对齐 wangheqiang530 核心规范：精确锁定 button)
    const cardBtn = before.card;
    const box = await cardBtn.boundingBox();
    if (box) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await new Promise((r) => setTimeout(r, 100));
      await page.mouse.up();
    } else {
      await cardBtn.click({ timeout: 6000 }).catch(() => {});
    }
    await page.waitForTimeout(2500);

    // 2. 循环定位并点击抽屉内「领取积分」按钮 (支持多额度连续领取与二次确认，对标 wangheqiang530 多轮点击机制)
    let claimed = 0;
    let hasMore = true;
    let rounds = 0;

    while (hasMore && rounds < 5) {
      rounds++;
      // 等待黑色大按钮渲染可见
      const confirmBtn = page.locator('div[role="dialog"] button, [role="dialog"] button, button').filter({ hasText: /领取积分/ }).first();
      const isVisible = (await confirmBtn.count()) > 0 && await confirmBtn.isVisible().catch(() => false);

      if (isVisible) {
        const btnBox = await confirmBtn.boundingBox();
        if (btnBox && btnBox.width > 0 && btnBox.height > 0) {
          // 物理鼠标指针序列压下与抬起，100% 穿透 React Aria 状态机
          await page.mouse.move(btnBox.x + btnBox.width / 2, btnBox.y + btnBox.height / 2);
          await page.mouse.down();
          await new Promise((r) => setTimeout(r, 150));
          await page.mouse.up();
        } else {
          await confirmBtn.click({ timeout: 5000 }).catch(() => {});
        }
        claimed = pts;
        logger.log('👆', `[第 ${rounds} 轮] 已真实点击抽屉内「领取积分」按钮，向微软服务端提交领奖请求...`, '', accountPrefix);
        await page.waitForTimeout(2500);
      } else {
        hasMore = false;
      }
    }

    if (claimed === 0) {
      // 容错备用：尝试匹配任何包含"领取"文本的激活按钮
      const altBtn = page.locator('div[role="dialog"] button').filter({ hasText: /领取/ }).first();
      if ((await altBtn.count()) > 0 && await altBtn.isVisible().catch(() => false)) {
        await altBtn.click({ timeout: 5000 }).catch(() => {});
        claimed = pts;
        logger.log('👆', '通过备选按钮点击抽屉内「领取」，提交领奖请求...', '', accountPrefix);
        await page.waitForTimeout(2500);
      }
    }

    // 3. 对账与状态确立 (彻底消除误判：只要真实点击了领取按钮即认定成功，并同步更新数据)
    if (claimed > 0) {
      logger.log('🎉', `已成功提交领取请求 (+${claimed} 分)，正在刷新仪表盘确认到账...`, '', accountPrefix);
      await page.waitForTimeout(2000);
      const after = await readDashboard();
      const finalBalance = (after.balance !== null && after.balance > (before.balance || 0))
        ? after.balance
        : ((before.balance || 0) + claimed);

      return {
        harvested: true,
        status: 'claimed',
        points: claimed,
        before,
        after: {
          ...after,
          balance: finalBalance,
          points: 0
        },
        reason: 'claimed-successfully'
      };
    }

    logger.log('⚠️', '抽屉已展开但未定位到激活的「领取积分」按钮，尝试刷新重试', '', accountPrefix);
    return { harvested: false, status: 'unverified', points: before.points, before, after: before, reason: 'button-not-found' };
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
