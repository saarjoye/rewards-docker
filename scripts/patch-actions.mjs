import fs from 'fs';

let content = fs.readFileSync('src/browser/actions.js', 'utf8');

if (!content.includes("import browserManager from './browser.js';")) {
  content = content.replace("import logger from '../logger.js';", "import logger from '../logger.js';\nimport browserManager from './browser.js';");
}

content = content.replace(
  'logger.log(\'🔍\', `模拟真人搜索关键词: "${word}"`, \'\', accountPrefix);',
  'browserManager.updateState({ status: "typing", currentAction: `正在模拟真人搜索关键词: "${word}"` });\n  logger.log(\'🔍\', `模拟真人搜索关键词: "${word}"`, \'\', accountPrefix);'
);

content = content.replace(
  'const dwellTime = 4000 + Math.random() * 3000;',
  'browserManager.updateState({ status: "dwelling", currentAction: "结果页微滚驻留触发遥测..." });\n  const dwellTime = 4000 + Math.random() * 3000;'
);

content = content.replace(
  "logger.log('📅', '打开 Rewards 仪表盘执行每日活动集 (Daily Set) 点击穿透...",
  "browserManager.updateState({ status: \"navigating\", currentAction: \"打开仪表盘执行每日活动集 (Daily Set) 穿透...\" });\n  logger.log('📅', '打开 Rewards 仪表盘执行每日活动集 (Daily Set) 点击穿透..."
);

content = content.replace(
  "logger.log('🎁', '开始执行每日 01:00 额外积分 React Aria 抽屉收割流程...",
  "browserManager.updateState({ status: \"harvesting\", currentAction: \"React Aria 抽屉虚拟指针展开与额外积分收割...\" });\n  logger.log('🎁', '开始执行每日 01:00 额外积分 React Aria 抽屉收割流程..."
);

fs.writeFileSync('src/browser/actions.js', content, 'utf8');
console.log('actions.js updated successfully');
