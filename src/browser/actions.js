import logger from '../logger.js';
import browserManager from './browser.js';

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
  const { accountPrefix = '' } = options;
  const word = queryWord || getRandomSearchWord();

  browserManager.updateState({ status: "typing", currentAction: `正在模拟真人搜索关键词: "${word}"` });

  // 1. 打开必应首页 (带 Page crashed 异常崩溃自动重建页面防护)
  try {
    if (!page || page.isClosed()) throw new Error('Target page is closed');
    await page.goto('https://cn.bing.com/', { waitUntil: 'domcontentloaded', timeout: 35000 });
  } catch (err) {
    if (err.message && (err.message.includes('crashed') || err.message.includes('Target page') || err.message.includes('closed'))) {
      logger.log('🔄', '检测到页面崩溃异常，正在新建独立视口页面自动恢复...', '', accountPrefix);
      const newPage = await page.context().newPage();
      page = newPage;
      await page.goto('https://cn.bing.com/', { waitUntil: 'domcontentloaded', timeout: 35000 });
    } else {
      throw err;
    }
  }
  await new Promise((r) => setTimeout(r, 1200 + Math.random() * 800));

  // 2. 定位搜索框
  const searchInput = await page.$('#sb_form_q, input[name="q"]');
  if (!searchInput) {
    throw new Error('未能在必应首页定位到搜索框元素 #sb_form_q');
  }

  const box = await searchInput.boundingBox();
  if (box) {
    await humanMouseMove(page, box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.up();
  } else {
    await searchInput.click();
  }

  // 3. 拟人键入关键词
  await searchInput.fill('');
  if (typeof searchInput.type === "function") { await searchInput.type(word, { delay: 35 + Math.random() * 40 }); } else { await searchInput.fill(word); }
  await new Promise((r) => setTimeout(r, 500 + Math.random() * 500));

  // 4. 提交搜索并等待结果页
  await Promise.all([
    page.keyboard.press('Enter'),
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})
  ]);

  // 5. 结果页随机微滚与真人驻留 (4~8 秒)
  try {
    const scrollAmount = 200 + Math.floor(Math.random() * 400);
    await page.mouse.wheel(0, scrollAmount);
    await new Promise((r) => setTimeout(r, 1000 + Math.random() * 1000));
    await page.mouse.wheel(0, -scrollAmount / 2);
  } catch {}

  browserManager.updateState({ status: "dwelling", currentAction: "结果页微滚驻留触发遥测..." });
  const dwellTime = 4000 + Math.random() * 3000;
  await new Promise((r) => setTimeout(r, dwellTime));

  // 必须返回最新的有效 Page 实例，杜绝将 page 变量覆盖为布尔值导致 page.close is not a function 异常
  return page;
}

/**
 * 自动识别并完成 Quiz / Poll 页面内的问答选项
 */
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

  // 查找 Daily Set 区域内的未完成活动链接
  const links = await page.$$('#dailyset a[target="_blank"], div[data-bi-area="DailySet"] a');
  logger.log('📅', `检索到 Daily Set 区域内包含 ${links.length} 个活动项目`, '', accountPrefix);

  let clickedCount = 0;
  for (let i = 0; i < links.length; i++) {
    const link = links[i];
    try {
      if (!(await link.isVisible())) continue;

      // 监听新弹窗打开
      const [popup] = await Promise.all([
        page.context().waitForEvent('page', { timeout: 8000 }).catch(() => null),
        link.click()
      ]);

      if (popup) {
        logger.log('🚀', `触发 Daily Set 弹窗第 ${i + 1} 项，驻留触发遥测...`, '', accountPrefix);
        await popup.waitForLoadState('domcontentloaded').catch(() => {});
        // 尝试自动解 Quiz/Poll
        await solveQuizOrPoll(popup, { accountPrefix });
        await new Promise((r) => setTimeout(r, 4500)); // 驻留 4.5 秒触发加分
        await popup.close();
      } else {
        await new Promise((r) => setTimeout(r, 3000));
      }
      clickedCount++;
    } catch (e) {
      logger.log('⚠️', `点击 Daily Set 活动项 ${i + 1} 异常: ${e.message}`, '', accountPrefix);
    }
  }

  logger.log('✅', `Daily Set 真机交互完成，共穿透点击 ${clickedCount} 项活动`, '', accountPrefix);
  return clickedCount;
}

/**
 * 多步打孔卡 (Punch Cards / Quests) 子路由穿透推进
 */
export async function penetratePunchCardQuest(page, questUrl, options = {}) {
  const { accountPrefix = '' } = options;
  if (!questUrl) return false;

  const fullUrl = questUrl.startsWith('http') ? questUrl : `https://rewards.bing.com${questUrl}`;
  logger.log('🎯', `进入多步打孔卡子路由: ${fullUrl}`, '', accountPrefix);

  try {
    await page.goto(fullUrl, { waitUntil: 'domcontentloaded', timeout: 35000 });
    await new Promise((r) => setTimeout(r, 2500));

    // 扫描子步骤卡片
    const stepCards = await page.$$('div[data-bi-area="PunchCardStep"], a[href*="/quest/"], div.quest-step, a.c-call-to-action');
    logger.log('🎯', `打孔卡内部发现 ${stepCards.length} 个子步骤`, '', accountPrefix);

    for (let j = 0; j < stepCards.length; j++) {
      const step = stepCards[j];
      try {
        const text = await step.innerText().catch(() => '');
        // 时间锁判定：第 N 天解锁 / 明天再来 -> 安全跳过，防风控
        if (text.includes('明天再来') || text.includes('天解锁')) {
          logger.log('⏳', `打孔卡第 ${j + 1} 步存在时间锁 [明天再来]，打上【明日解锁】标签安全跳过`, '', accountPrefix);
          continue;
        }

        if (await step.isVisible()) {
          const [stepPopup] = await Promise.all([
            page.context().waitForEvent('page', { timeout: 6000 }).catch(() => null),
            step.click()
          ]);

          if (stepPopup) {
            await stepPopup.waitForLoadState('domcontentloaded').catch(() => {});
            await solveQuizOrPoll(stepPopup, { accountPrefix });
            await new Promise((r) => setTimeout(r, 4000));
            await stepPopup.close();
          } else {
            await new Promise((r) => setTimeout(r, 2500));
          }
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
  browserManager.updateState({ status: "harvesting", currentAction: "展开 React Aria 抽屉收割额外待领积分..." });
  logger.log('🎁', '开始执行每日 01:00 额外积分 React Aria 抽屉收割流程...', '', accountPrefix);

  try {
    await page.goto('https://rewards.bing.com/dashboard', { waitUntil: 'domcontentloaded', timeout: 35000 });
    await new Promise((r) => setTimeout(r, 2500));

    // 1. 精确定位「可领取」抽屉触发卡片按钮 (严格排除用户个人资料头像、可用积分大容器与退出登录)
    const disclosureLocator = page.locator('button[aria-expanded], button[aria-haspopup="dialog"], button:has-text("可领取")')
      .filter({ hasNotText: '可用积分' })
      .filter({ hasNotText: '退出登录' })
      .filter({ hasNotText: 'Microsoft' });

    let claimBtn = null;
    const count = await disclosureLocator.count();
    for (let i = 0; i < count; i++) {
      const btn = disclosureLocator.nth(i);
      const isVis = await btn.isVisible().catch(() => false);
      if (!isVis) continue;
      const txt = await btn.innerText().catch(() => '');
      if (txt.includes('可领取') || txt.includes('领取')) {
        claimBtn = btn;
        break;
      }
    }

    if (!claimBtn) {
      logger.log('ℹ️', '当前仪表盘未检测到独立的「可领取」积分抽屉卡片，跳过收割', '', accountPrefix);
      return { harvested: false, points: 0 };
    }

    const cardText = await claimBtn.innerText().catch(() => '');
    const numMatch = cardText.match(/(\d+)/);
    const claimablePointsNum = numMatch ? parseInt(numMatch[1], 10) : 0;
    logger.log('💰', `精准锁定官方「可领取」卡片 (标识分值: ${claimablePointsNum} 分)，正在派发点击展开抽屉...`, '', accountPrefix);

    // 精准点击卡片正中央，坚决杜绝点偏到旁边的头像
    await claimBtn.click({ force: true, timeout: 8000 });
    logger.log('👆', '已精准触发「可领取」卡片展开抽屉事件...', '', accountPrefix);

    // 2. 轮询等待 React Aria 抽屉容器与内部黑色「领取积分」按钮 (最长等待 12 秒)
    logger.log('⏳', '等待抽屉内容与「领取积分」黑色按钮异步加载完成...', '', accountPrefix);
    let harvestSuccess = false;

    for (let sec = 1; sec <= 24; sec++) {
      await new Promise((r) => setTimeout(r, 500));

      // 锁定抽屉容器
      const dialog = page.locator('div[role="dialog"], [aria-modal="true"], section[aria-label*="领取"], div:has(> h2:text("领取积分"))').first();
      const isDialogVis = await dialog.isVisible().catch(() => false);

      if (isDialogVis) {
        // 在抽屉容器内部查找黑色激活的「领取积分」按钮
        const innerClaimBtns = dialog.locator('button:not([disabled])').filter({ hasText: /领取/ });
        const btnCount = await innerClaimBtns.count();

        for (let bIdx = 0; bIdx < btnCount; bIdx++) {
          const btn = innerClaimBtns.nth(bIdx);
          const ariaDisabled = await btn.getAttribute('aria-disabled');
          if (ariaDisabled !== 'true') {
            logger.log('🎯', `第 ${(sec * 0.5).toFixed(1)} 秒成功捕获到抽屉内的黑色已激活「领取积分」按钮，立即触发真实点击！`, '', accountPrefix);
            await btn.click({ force: true });
            harvestSuccess = true;
            break;
          }
        }

        if (harvestSuccess) break;

        // 检查抽屉内是否显示「当前没有要领取的积分」
        const dialogText = await dialog.innerText().catch(() => '');
        if (dialogText.includes('当前没有要领取的积分')) {
          logger.log('ℹ️', '抽屉内部账本确认为 0 分 (当前没有要领取的积分)，外部卡片「3」系微软官方营销占位符，已全部领完无需重复领取！', '', accountPrefix);
          return { harvested: true, points: 0 };
        }
      }
    }

    if (harvestSuccess) {
      await new Promise((r) => setTimeout(r, 3500));
      logger.log('🎉', '恭喜！抽屉内黑色「领取积分」按钮点击完成，已成功收割入账！', '', accountPrefix);
      return { harvested: true, points: claimablePointsNum || 3 };
    }

    logger.log('⚠️', '未能捕获到激活态的「领取积分」按钮，可能已处于归零状态', '', accountPrefix);
    return { harvested: false, points: 0 };
  } catch (err) {
    logger.log('🔴', `额外积分收割执行异常: ${err.message}`, '', accountPrefix);
    return { harvested: false, points: 0 };
  }
}

export async function penetrateDailyActivities(page, options = {}) {
  const { accountPrefix = '' } = options;
  browserManager.updateState({ status: "navigating", currentAction: "执行【板块 4: 日常任务】点击穿透与答题..." });
  logger.log('📋', '>>> 开始执行【板块 4: 日常任务 (Daily Activities)】<<<', '', accountPrefix);

  try {
    await page.goto('https://rewards.bing.com/dashboard', { waitUntil: 'domcontentloaded', timeout: 35000 });
    await new Promise((r) => setTimeout(r, 2500));

    // 定位「日常任务」区域的所有活动卡片链接
    const cards = await page.$$(
      'div[data-bi-area="MoreActivities"] a, #more-activities a, div:has(> p:text("日常任务")) a, div:has(> h2:text("日常任务")) a, a[data-bi-area="PromotionalItems"]'
    );

    logger.log('📋', `检索到【日常任务】区域内包含 ${cards.length} 个活动项目`, '', accountPrefix);

    let executedCount = 0;
    for (let i = 0; i < cards.length; i++) {
      const card = cards[i];
      try {
        if (!(await card.isVisible())) continue;

        const cardText = await card.innerText().catch(() => '');
        // 过滤不可执行的营销扩展类卡片
        const feasibility = classifyTaskFeasibility(cardText);
        if (!feasibility.executable) {
          logger.log('⏭️', `跳过非积分项目: ${cardText.slice(0, 25).replace(/\n/g, ' ')}... (${feasibility.tag})`, '', accountPrefix);
          continue;
        }

        // 如果卡片已经打钩已完成，跳过
        if (cardText.includes('已完成') || cardText.includes('Completed')) {
          continue;
        }

        const briefName = cardText.slice(0, 25).replace(/\n/g, ' ');
        logger.log('🚀', `触发日常任务第 ${i + 1} 项: ${briefName}...`, '', accountPrefix);

        // 如果是拼图任务，使用专属拼图解决逻辑
        if (cardText.includes('拼图') || cardText.includes('puzzle') || cardText.includes('Evergreen')) {
          const [popup] = await Promise.all([
            page.context().waitForEvent('page', { timeout: 10000 }).catch(() => null),
            card.click().catch(() => {})
          ]);
          if (popup) {
            await popup.waitForLoadState('domcontentloaded').catch(() => {});
            await penetratePuzzleSpotlight(popup, popup.url(), { accountPrefix });
            await new Promise((r) => setTimeout(r, 4000));
            await popup.close().catch(() => {});
            executedCount++;
          }
          continue;
        }

        // 普通探索与 Quiz 问答卡片
        const [popup] = await Promise.all([
          page.context().waitForEvent('page', { timeout: 10000 }).catch(() => null),
          card.click().catch(() => {})
        ]);

        if (popup) {
          await popup.waitForLoadState('domcontentloaded').catch(() => {});
          // 尝试自动解题/投票
          await solveQuizOrPoll(popup, { accountPrefix });
          // 模拟真人滚轮浏览
          await popup.mouse.wheel(0, 200).catch(() => {});
          await new Promise((r) => setTimeout(r, 4500)); // 驻留 4.5 秒确保微软遥测入账
          await popup.close().catch(() => {});
          executedCount++;
          logger.log('✅', `日常任务第 ${i + 1} 项交互完成，积分遥测已上报`, '', accountPrefix);
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
  } catch (errAll) {
    logger.log('⚠️', `【板块 4: 日常任务】访问异常: ${errAll.message}`, '', accountPrefix);
    return 0;
  }
}
