import fs from 'fs';

let content = fs.readFileSync('src/web/public/app.js', 'utf8');

const logoutHandler = `
  // 管理员退出登录事件
  const btnAdminLogout = document.getElementById("btn-admin-logout");
  if (btnAdminLogout) {
    btnAdminLogout.addEventListener("click", async () => {
      if (!confirm("确定退出当前管理员登录吗？")) return;
      try {
        await fetch("/api/auth/logout", { method: "POST" });
        window.location.replace("/login.html");
      } catch {
        window.location.replace("/login.html");
      }
    });
  }
`;

if (!content.includes('btnAdminLogout')) {
  content = content.replace('  // 初始化\n  refreshDashboard();', logoutHandler + '\n  // 初始化\n  refreshDashboard();');
  fs.writeFileSync('src/web/public/app.js', content, 'utf8');
  console.log('app.js updated with logout handler');
} else {
  console.log('logout handler already exists');
}
