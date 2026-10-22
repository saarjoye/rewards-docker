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

        // 关键防御：过滤非 http 外部应用唤起协议 (如 ms-windows-store:, ms-rewards:, edge:)，杜绝导致 Chromium 视口崩溃
        if (href && (href.startsWith('ms-') || href.startsWith('intent:') || href.startsWith('market:') || href.startsWith('app:'))) {
          logger.log('ℹ️', `打孔卡第 ${j + 1} 步为客户端外部应用协议 (${href.slice(0, 35)}...)，安全跳过`, '', accountPrefix);
          continue;
        }

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
