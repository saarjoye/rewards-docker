import fs from 'fs';

let content = fs.readFileSync('src/web/public/app.js', 'utf8');

const targetIdx = content.indexOf('  // 主动触发任务开启事件绑定');
if (targetIdx !== -1) {
  content = content.slice(0, targetIdx) + `  // 顶部「🚀 立即执行任务」弹窗控制 (支持全账号/单账号，全任务/单任务)
  const modalRunTasks = document.getElementById("modal-run-tasks");
  const formRunTasks = document.getElementById("form-run-tasks");
  const groupSingleAcc = document.getElementById("group-single-account");
  const selectTargetAcc = document.getElementById("select-target-account");

  function openRunTasksModal() {
    if (accounts.length === 0) {
      alert("当前没有托管账号，请先添加或导入账号！");
      return;
    }

    // 填充单账号下拉选项
    selectTargetAcc.innerHTML = accounts
      .map((a) => \`<option value="\${a.id}">\${escapeHtml(a.name || a.user)} (\${escapeHtml(a.user)})\</option>\`)
      .join("");

    modalRunTasks.classList.remove("hidden");
  }

  const btnRunActive = document.getElementById("btn-run-active-task");
  if (btnRunActive) btnRunActive.addEventListener("click", openRunTasksModal);

  const btnTriggerSlot = document.getElementById("btn-trigger-slot");
  if (btnTriggerSlot) btnTriggerSlot.addEventListener("click", openRunTasksModal);

  const closeRunModal = document.getElementById("close-run-modal");
  if (closeRunModal) closeRunModal.addEventListener("click", () => modalRunTasks.classList.add("hidden"));
  const cancelRunModal = document.getElementById("cancel-run-modal");
  if (cancelRunModal) cancelRunModal.addEventListener("click", () => modalRunTasks.classList.add("hidden"));

  // 监听单选框切换
  document.querySelectorAll('input[name="run-acc-scope"]').forEach((radio) => {
    radio.addEventListener("change", (e) => {
      groupSingleAcc.style.display = e.target.value === "single" ? "block" : "none";
    });
  });

  // 提交执行
  formRunTasks.addEventListener("submit", async (e) => {
    e.preventDefault();
    const accountScope = document.querySelector('input[name="run-acc-scope"]:checked')?.value || "all";
    const accountId = selectTargetAcc.value;
    const taskScope = document.getElementById("select-task-scope").value;

    try {
      const res = await fetch("/api/tasks/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountScope, accountId, taskScope })
      });
      const data = await res.json();
      modalRunTasks.classList.add("hidden");
      alert(data.message || (data.success ? "任务已成功提交启动！" : "启动失败"));
      refreshDashboard();
    } catch (err) {
      alert("请求异常: " + err.message);
    }
  });

  setInterval(refreshDashboard, 8000);
});
`;
  fs.writeFileSync('src/web/public/app.js', content, 'utf8');
  console.log('app.js cleanly replaced');
} else {
  console.log('target not found');
}
