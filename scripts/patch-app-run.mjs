import fs from 'fs';

let content = fs.readFileSync('src/web/public/app.js', 'utf8');

const runCode = `
  // 主动触发任务开启事件绑定
  async function triggerActiveAccountRun() {
    const primaryAcc = accounts[0];
    if (!primaryAcc || !primaryAcc.id) {
      alert("当前没有检测到可用托管账号，请先添加或导入账号！");
      return;
    }

    try {
      const res = await fetch(\`/api/accounts/\${primaryAcc.id}/run\`, { method: "POST" });
      const data = await res.json();
      if (data.success) {
        alert(\`🚀 账号 [\${primaryAcc.name || primaryAcc.user}] 全自动化任务流水线已成功启动！\n\n请在右下角实时视口或点击「实时日志」观察执行过程。\`);
      } else {
        alert(data.message || "启动任务失败");
      }
      refreshDashboard();
    } catch (e) {
      alert("启动请求异常: " + e.message);
    }
  }

  // 1. 顶部大按钮
  const btnRunActive = document.getElementById("btn-run-active-task");
  if (btnRunActive) btnRunActive.addEventListener("click", triggerActiveAccountRun);

  // 2. 侧边栏账号卡片下方按钮
  const btnSidebarRun = document.getElementById("btn-sidebar-run");
  if (btnSidebarRun) btnSidebarRun.addEventListener("click", triggerActiveAccountRun);

  // 3. 错峰时段内快捷触发
  const btnTriggerSlot = document.getElementById("btn-trigger-slot");
  if (btnTriggerSlot) btnTriggerSlot.addEventListener("click", triggerActiveAccountRun);
`;

if (!content.includes('triggerActiveAccountRun')) {
  // 插在 setInterval(refreshDashboard, 8000) 之前
  content = content.replace('  setInterval(refreshDashboard, 8000);', runCode + '\n  setInterval(refreshDashboard, 8000);');
  fs.writeFileSync('src/web/public/app.js', content, 'utf8');
  console.log('app.js updated with run button handlers');
} else {
  console.log('run button handlers already exist');
}
