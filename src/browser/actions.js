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
 * 每日活动集 (Daily Set 3/3) 真机弹窗点击穿透 (含自动答题)
 */
export async function penetrateDailySetActivities(page, options = {}) {
  const { accountPrefix = '' } = options;
  browserManager.updateState({ status: "navigating", currentAction: "打开仪表盘执行每日活动集 (Daily Set) 穿透..." });
  logger.log('📅', '打开 Rewards 仪表盘执行每日活动集 (Daily Set) 点击穿透...', '', accountPrefix);

  await page.goto('https://rewards.bing.com/dashboard', { waitUntil: 'domcontentloaded', timeout: 35000 });
  await new Promise((r) => setTimeout(r, 2500));

  // 先行清理可能遮挡视口的祝贺弹窗 (如「干得漂亮」等 bg-bgSmoke 浮层)
  await dismissCelebrationOverlay(page);

  // 查找 Daily Set 区域内的未完成活动链接
  const links = await page.$$('#dailyset a[target="_blank"], div[data-bi-area="DailySet"] a, div[class*="DailySet"] a');
  logger.log('📅', `检索到 Daily Set 区域内包含 ${links.length} 个活动项目`, '', accountPrefix);

  let clickedCount = 0;
  for (let i = 0; i < links.length; i++) {
    const link = links[i];
    try {
      if (!(await link.isVisible().catch(() => false))) continue;

      // 每次点击前确保无遮挡蒙层
      await dismissCelebrationOverlay(page);

      const href = await link.getAttribute('href').catch(() => null);
      let popup = null;

      if (href && href.startsWith('http')) {
        popup = await page.context().newPage();
        await popup.goto(href, { waitUntil: 'domcontentloaded', timeout: 35000 }).catch(() => {});
      } else {
        const [p] = await Promise.all([
          page.context().waitForEvent('page', { timeout: 8000 }).catch(() => null),
          link.click({ force: true, timeout: 6000 }).catch(() => {})
        ]);
        popup = p;
      }

      if (popup) {
        logger.log('🚀', `触发 Daily Set 弹窗第 ${i + 1} 项，驻留触发遥测...`, '', accountPrefix);
        await popup.waitForLoadState('domcontentloaded').catch(() => {});
        await solveQuizOrPoll(popup, { accountPrefix });
        await new Promise((r) => setTimeout(r, 4500));
        await popup.close().catch(() => {});
      } else {
        await new Promise((r) => setTimeout(r, 3000));
      }
      clickedCount++;

      // 点击完成后再次清理可能弹出的「干得漂亮」连击祝贺框，杜绝阻断后续卡片
      await dismissCelebrationOverlay(page);
      await new Promise((r) => setTimeout(r, 1500));
    } catch (e) {
      logger.log('⚠️', `点击 Daily Set 活动项 ${i + 1} 异常: ${e.message}`, '', accountPrefix);
      await dismissCelebrationOverlay(page);
    }
  }

  logger.log('✅', `Daily Set 真机交互完成，共穿透点击 ${clickedCount} 项活动`, '', accountPrefix);
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

export async function penetratePunchCardQuest(page, questUrl, options = {}) {
  const { accountPrefix = '' } = options;
  if (!questUrl) return false;

  const fullUrl = questUrl.startsWith('http') ? questUrl : `https://rewards.bing.com${questUrl}`;
  logger.log('🎯', `进入多步打孔卡子路由: ${fullUrl}`, '', accountPrefix);

  try {
    await page.goto(fullUrl, { waitUntil: 'domcontentloaded', timeout: 35000 });
    await new Promise((r) => setTimeout(r, 2500));

    // 扫描子步骤卡片 (使用 page.$ 严防 null.length 异常)
    let stepCards = (await page.$('a[href*="bing.com"][class*="rounded-cornerCtrlRest"], a[class*="bg-bgCtrlBrandRest"], div[data-bi-area="PunchCardStep"], a[href*="/quest/"], a.c-call-to-action')) || [];
    if (stepCards.length === 0) {
      stepCards = (await page.$('a[class*="rounded-cornerCtrlRest"], a[class*="Button"], button[class*="bg-bgCtrlBrandRest"]')) || [];
    }
    logger.log('🎯', `打孔卡内部发现 ${stepCards.length} 个子步骤`, '', accountPrefix);

    for (let j = 0; j < stepCards.length; j++) {
      const step = stepCards[j];
      try {
        const text = await step.innerText().catch(() => '');
        if (text.includes('明天再来') || text.includes('天解锁')) {
          logger.log('⏳', `打孔卡第 ${j + 1} 步存在时间锁 [明天再来]，打上【明日解锁】标签安全跳过`, '', accountPrefix);
          continue;
        }

        const href = await step.getAttribute('href').catch(() => null);
        let stepPopup = null;

        if (href && href.startsWith('http')) {
          stepPopup = await page.context().newPage();
          await stepPopup.goto(href, { waitUntil: 'domcontentloaded', timeout: 35000 }).catch(() => {});
        } else if (await step.isVisible().catch(() => false)) {
          const [p] = await Promise.all([
            page.context().waitForEvent('page', { timeout: 8000 }).catch(() => null),
            step.click({ force: true, timeout: 6000 }).catch(() => {})
          ]);
          stepPopup = p;
        }

        if (stepPopup) {
          await stepPopup.waitForLoadState('domcontentloaded').catch(() => {});
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
      }
    }
    return true;
  } catch (e) {
    logger.log('⚠️', `穿透打孔卡异常: ${e.message}`, '', accountPrefix);
    return false;
  }
}

/**
 * 拼图任务 (ZHstar Evergreen Puzzle) 目标落地页访问
 */
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
  const claimLabel = '\u53ef\u9886\u53d6';
  const claimButtonLabel = '\u9886\u53d6\u79ef\u5206';
  const balanceLabel = '\u53ef\u7528\u79ef\u5206';

  browserManager.updateState({ status: 'harvesting', currentAction: '\u5c55\u5f00\u9886\u53d6\u79ef\u5206\u62bd\u5c49\u5e76\u6838\u9a8c\u5b98\u65b9\u5230\u8d26...' });
  logger.log('\u{1f381}', '\u5f00\u59cb\u6267\u884c\u989d\u5916\u79ef\u5206\u9886\u53d6\u6d41\u7a0b...', '', accountPrefix);

  const readDashboard = async () => {
    const body = await page.locator('body').innerText().catch(() => '');
    const card = page.locator('button[aria-expanded]').filter({ hasText: claimLabel }).first();
    let points = null;
    if (await card.count()) {
      const cardText = (await card.innerText().catch(() => '')).replace(/\s+/g, ' ');
      const match = cardText.match(new RegExp(claimLabel + '\\s*([0-9,]+)'));
      if (match) points = Number(match[1].replace(/,/g, ''));
    }
    const balanceMatch = body.match(new RegExp(balanceLabel + '\\s*[\\r\\n]+\\s*([0-9,]+)'));
    const balance = balanceMatch ? Number(balanceMatch[1].replace(/,/g, '')) : null;
    return { card, points, balance };
  };

  try {
    await page.goto('https://rewards.bing.com/dashboard', { waitUntil: 'domcontentloaded', timeout: 35000 });
    await page.waitForTimeout(4500);
    await dismissCookieBanner(page);

    const before = await readDashboard();
    if (!(await before.card.count())) {
      logger.log('\u2139\ufe0f', '\u5f53\u524d\u4eea\u8868\u76d8\u672a\u68c0\u6d4b\u5230\u300c\u53ef\u9886\u53d6\u300d\u79ef\u5206\u5361\u7247\uff0c\u8df3\u8fc7\u6536\u5272', '', accountPrefix);
      return { harvested: false, points: 0, reason: 'claim-card-not-found', before };
    }
    if (before.points === 0) {
      logger.log('\u2139\ufe0f', '\u300c\u53ef\u9886\u53d6\u300d\u5f53\u524d\u4e3a 0 \u5206\uff0c\u65e0\u9700\u9886\u53d6', '', accountPrefix);
      return { harvested: true, points: 0, reason: 'already-zero', before };
    }
    if (!Number.isFinite(before.points)) {
      throw new Error('\u65e0\u6cd5\u4ece\u5b98\u7f51\u5361\u7247\u89e3\u6790\u53ef\u9886\u53d6\u79ef\u5206\uff0c\u62d2\u7edd\u731c\u6d4b\u6210\u529f\u72b6\u6001');
    }

    logger.log('\u{1f4b0}', '\u5b98\u7f51\u663e\u793a\u53ef\u9886\u53d6 ' + before.points + ' \u5206\uff0c\u53ef\u7528\u4f59\u989d ' + (before.balance ?? '\u672a\u77e5') + ' \u5206\uff0c\u5c55\u5f00\u9886\u53d6\u62bd\u5c49...', '', accountPrefix);
    await before.card.click({ timeout: 10000 });

    const claimButton = page.locator('button').filter({ hasText: claimButtonLabel }).first();
    await claimButton.waitFor({ state: 'visible', timeout: 20000 });
    await claimButton.click({ timeout: 10000 });
    logger.log('\u{1f446}', '\u5df2\u70b9\u51fb\u300c\u9886\u53d6\u79ef\u5206\u300d\uff0c\u7b49\u5f85\u5b98\u65b9\u4f59\u989d\u4e0e\u5f85\u9886\u53d6\u72b6\u6001\u5165\u8d26...', '', accountPrefix);

    let after = null;
    for (let attempt = 0; attempt < 20; attempt++) {
      await page.waitForTimeout(1000);
      after = await readDashboard();
      const balanceIncreased = before.balance !== null && after.balance !== null && after.balance >= before.balance + before.points;
      if (after.points === 0 && balanceIncreased) {
        logger.log('\u{1f389}', '\u9886\u53d6\u6210\u529f\u5e76\u5df2\u5bf9\u8d26\uff1a\u4f59\u989d ' + before.balance + ' \u2192 ' + after.balance + '\uff0c\u53ef\u9886\u53d6 ' + before.points + ' \u2192 0', '', accountPrefix);
        return { harvested: true, points: before.points, before, after, reason: 'balance-and-claimable-verified' };
      }
    }

    await page.reload({ waitUntil: 'domcontentloaded', timeout: 35000 }).catch(() => {});
    await page.waitForTimeout(3500);
    const finalState = await readDashboard();
    const increased = before.balance !== null && finalState.balance !== null && finalState.balance > before.balance;
    if (finalState.points === 0 && increased) {
      logger.log('\u{1f389}', '\u5237\u65b0\u5bf9\u8d26\u6210\u529f\uff1a\u4f59\u989d ' + before.balance + ' \u2192 ' + finalState.balance + '\uff0c\u53ef\u9886\u53d6\u5df2\u5f52\u96f6', '', accountPrefix);
      return { harvested: true, points: before.points, before, after: finalState, reason: 'reload-verified' };
    }

    logger.log('\u26a0\ufe0f', '\u70b9\u51fb\u540e\u5c1a\u672a\u786e\u8ba4\u5230\u8d26\uff1a\u4f59\u989d ' + (finalState.balance ?? '\u672a\u77e5') + '\uff0c\u53ef\u9886\u53d6 ' + (finalState.points ?? '\u672a\u77e5') + '\u3002\u672a\u6807\u8bb0\u4e3a\u6210\u529f\u3002', '', accountPrefix);
    return { harvested: false, points: before.points, before, after: finalState, reason: 'unverified-after-click' };
  } catch (err) {
    logger.log('\u{1f534}', '\u989d\u5916\u79ef\u5206\u9886\u53d6\u6267\u884c\u5f02\u5e38: ' + err.message, '', accountPrefix);
    return { harvested: false, points: 0, reason: 'exception', error: err.message };
  }
}

export async function penetrateDailyActivities(page, options = {}) {
  const { accountPrefix = '', pendingKeys = null } = options;
  browserManager.updateState({ status: "navigating", currentAction: "执行【板块 4: 日常任务】点击穿透与答题..." });
  logger.log('📋', '>>> 开始执行【板块 4: 日常任务 (Daily Activities)】<<<', '', accountPrefix);

  try {
    // 关键修正：官方全量日常任务 (素食汉堡、化石精选、你是否知道答案、完成此拼图等) 位于 /earn 路由
    await page.goto('https://rewards.bing.com/earn', { waitUntil: 'domcontentloaded', timeout: 35000 });
    await new Promise((r) => setTimeout(r, 3000));

    // 先行清理可能遮挡的蒙层
    await dismissCelebrationOverlay(page);

    // 定位「日常任务」区域的所有活动卡片链接
    let cards = await page.$$('div.react-aria-Disclosure:has(h2:has-text("日常任务")) a, div:has(> h2:text("日常任务")) a, div[data-bi-area="MoreActivities"] a, #more-activities a');
    if (!cards || cards.length === 0) {
      // 兼容兜底选择器
      cards = await page.$$('a[class*="rounded-cornerCardDefault"][href*="bing.com"]');
    }

    logger.log('📋', `检索到【日常任务】区域内包含 ${cards.length} 个活动项目`, '', accountPrefix);

    let executedCount = 0;
    for (let i = 0; i < cards.length; i++) {
      const card = cards[i];
      try {
        if (!(await card.isVisible().catch(() => false))) continue;

        const cardText = await card.innerText().catch(() => '');
        // 过滤不可执行的营销扩展类卡片
        const feasibility = classifyTaskFeasibility(cardText);
        if (!feasibility.executable) {
          logger.log('⏭️', `跳过非积分项目: ${cardText.slice(0, 25).replace(/\n/g, ' ')}... (${feasibility.tag})`, '', accountPrefix);
          continue;
        }

        // 如果卡片已经打钩已完成，跳过
        if (cardText.includes('已完成') || cardText.includes('Completed') || cardText.includes('✔')) {
          continue;
        }

        const hrefNow = await card.getAttribute('href').catch(() => null);
        if (Array.isArray(pendingKeys) && pendingKeys.length) {
          const matched = pendingKeys.some((k) => k && ((hrefNow && k === hrefNow) || cardText.includes(String(k).slice(0, 12))));
          if (!matched) continue;
        }

        const briefName = cardText.slice(0, 25).replace(/\n/g, ' ');
        logger.log('🚀', `触发日常任务第 ${i + 1} 项: ${briefName}...`, '', accountPrefix);

        const href = await card.getAttribute('href').catch(() => null);

        // 如果是拼图任务，使用专属拼图解决逻辑
        if (cardText.includes('拼图') || cardText.includes('puzzle') || (href && href.includes('imagepuzzle'))) {
          let popup = null;
          if (href && href.startsWith('http')) {
            popup = await page.context().newPage();
            await popup.goto(href, { waitUntil: 'domcontentloaded', timeout: 35000 }).catch(() => {});
          } else {
            const [p] = await Promise.all([
              page.context().waitForEvent('page', { timeout: 10000 }).catch(() => null),
              card.click({ force: true }).catch(() => {})
            ]);
            popup = p;
          }

          if (popup) {
            await popup.waitForLoadState('domcontentloaded').catch(() => {});
            await penetratePuzzleSpotlight(popup, popup.url(), { accountPrefix });
            await new Promise((r) => setTimeout(r, 4000));
            await popup.close().catch(() => {});
            executedCount++;
          }
          continue;
        }

        // 普通探索与 Quiz 问答卡片 (如化石精选 +15、你是否知道答案 +5)
        let popup = null;
        if (href && href.startsWith('http')) {
          popup = await page.context().newPage();
          await popup.goto(href, { waitUntil: 'domcontentloaded', timeout: 35000 }).catch(() => {});
        } else {
          const [p] = await Promise.all([
            page.context().waitForEvent('page', { timeout: 10000 }).catch(() => null),
            card.click({ force: true }).catch(() => {})
          ]);
          popup = p;
        }

        if (popup) {
          await popup.waitForLoadState('domcontentloaded').catch(() => {});
          // 尝试自动解题/投票 (Quiz 卡片)
          await solveQuizOrPoll(popup, { accountPrefix });
          // 模拟真人滚轮浏览与搜索结果探测 (探索类卡片如化石精选)
          try {
            await popup.mouse.wheel(0, 300);
            await new Promise((r) => setTimeout(r, 1500));
            // 触碰首个自然搜索结果以彻底激活微软防刷加分遥测
            const firstAlgo = await popup.$('#b_results .b_algo h2 a, #b_results .b_algo a').catch(() => null);
            if (firstAlgo) {
              await firstAlgo.hover().catch(() => {});
            }
          } catch {}
          await new Promise((r) => setTimeout(r, 6000)); // 驻留 6 秒确保微软服务端遥测完全入账
          await popup.close().catch(() => {});
          executedCount++;
          logger.log('✅', `日常任务第 ${i + 1} 项 (${briefName}) 交互完成，积分遥测已上报`, '', accountPrefix);
        } else {
          await new Promise((r) => setTimeout(r, 3000));
        }

        // 卡片间退避睡眠防风控
        await new Promise((r) => setTimeout(r, 2500 + Math.random() * 2000));
      } catch (errItem) {
        logger.log('⚠️', `日常任务项 ${i + 1} 交互异常: ${errItem.message}`, '', accountPrefix);
      }
    }

    logger.log('✅', `【板块 4: 日常任务】执行完毕，共穿透打卡 ${executedCount} 项`, '', accountPrefix);
    return executedCount;
  } catch (e) {
    logger.log('🔴', `日常任务板块穿透异常: ${e.message}`, '', accountPrefix);
    return 0;
  }
}
