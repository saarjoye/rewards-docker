import configManager from '../src/config.js';
import logger from '../src/logger.js';
import { executeAutonomousAccountLogin } from '../src/identity/adaptiveAuth.js';
import taskManager from '../src/core/taskManager.js';
import browserManager from '../src/browser/browser.js';
import { readBrowserSession } from '../src/identity/browserSession.js';

async function main() {
  console.log('========================================================');
  console.log('🚀 开始对本地探测到的账号执行端到端真实联调实测');
  console.log('========================================================');

  // 1. 读取本地配置
  const envResult = configManager.readLocalUserEnv();
  if (!envResult.found) {
    console.error('未发现本地 .env 凭据');
    process.exit(1);
  }

  console.log(`[1/3] 成功载入本地账号凭据: ${envResult.user}`);
  const account = configManager.upsertAccount({
    id: 'test_live_account',
    name: envResult.user.split('@')[0],
    user: envResult.user,
    pass: envResult.pass
  });

  // 2. 触发全自适应无头登录与双通道凭据收割
  console.log('[2/3] 启动无头浏览器执行全自适应登录、OAuth截获与Bing SSO自愈...');
  try {
    const authRes = await executeAutonomousAccountLogin(account, { timeoutMs: 70000 });
    console.log('登录自愈返回结果:', JSON.stringify(authRes, null, 2));

    if (!authRes.success) {
      if (authRes.status === 'needs_2fa') {
        console.log('⚠️ 联调结论：该账号被微软要求手机端 2FA 多因子验证，触发快速失败预警，验证符合预期！');
      } else {
        console.error('❌ 登录未能成功:', authRes);
      }
      return;
    }

    console.log('✅ 登录自愈 100% 成功！移动端 Token 与必应 _U 凭据已全量就绪。');

    // 3. 拉取官网权威数据看板
    console.log('[3/3] 访问官网获取今日成效看板 (/earn) 与资产总额 (/dashboard)...');
    const session = readBrowserSession(account.id);
    await browserManager.withBrowser(
      { proxy: account.proxy, cookies: session.cookies, headless: true },
      async (browser, context) => {
        const dashData = await taskManager.fetchOfficialDashboard(context, account);
        console.log('========================================================');
        console.log('📊 官网真实权威数据回验报告：');
        console.log(`   今日真实积分: ${dashData.todayPoints} 分`);
        console.log(`   可用总积分余额: ${dashData.balance} 分`);
        console.log(`   连续打卡天数: ${dashData.streakDays} 天`);
        console.log(`   待领额外积分: ${dashData.claimablePoints} 分`);
        console.log(`   四大板块任务数: Streaks(${dashData.taskBoard.streaks.length}), LevelUp(${dashData.taskBoard.levelUp.length}), Quests(${dashData.taskBoard.punchCards.length}), Daily(${dashData.taskBoard.dailyActivities.length})`);
        console.log('========================================================');
      }
    );
  } catch (err) {
    console.error('❌ 联调过程抛出异常:', err.message);
  }
}

main().catch(console.error);
