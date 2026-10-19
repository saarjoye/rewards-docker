import configManager from '../src/config.js';
import { hashAdminPassword, validateAdminCredentials } from '../src/identity/adminAuth.js';

async function main() {
  const args = process.argv.slice(2);
  const username = args[0];
  const password = args[1];

  if (!username || !password) {
    // 重置为未初始化状态
    const admin = configManager.get().admin || {};
    admin.initialized = false;
    admin.username = '';
    admin.salt = '';
    admin.passwordHash = '';
    configManager.save();

    console.log('========================================================');
    console.log('✅ 管理员状态已成功重置为 [未初始化] 状态！');
    console.log('👉 现在打开网页 http://localhost:5308，即可直接设置您自定义的管理员账号与密码。');
    console.log('========================================================');
    return;
  }

  // 命令行直接指定账号密码
  const validUser = validateAdminCredentials(username, password);
  const { salt, passwordHash } = await hashAdminPassword(password);
  configManager.setAdminCredentials(validUser, salt, passwordHash);

  console.log('========================================================');
  console.log(`✅ 管理员账号已成功设置！`);
  console.log(`   账号: ${validUser}`);
  console.log(`   密码: ${password}`);
  console.log('👉 现在可直接使用该账号密码登录控制台。');
  console.log('========================================================');
}

main().catch(console.error);
