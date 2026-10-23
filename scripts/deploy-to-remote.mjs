import fs from 'fs';
import path from 'path';
import { Client } from 'ssh2';

const filesToUpload = [
  { local: 'src/web/public/style.css', remote: '/tmp/rewards-update/src/web/public/style.css' },
  { local: 'src/web/public/index.html', remote: '/tmp/rewards-update/src/web/public/index.html' },
  { local: 'src/web/public/app.js', remote: '/tmp/rewards-update/src/web/public/app.js' },
  { local: 'src/browser/browser.js', remote: '/tmp/rewards-update/src/browser/browser.js' },
  { local: 'package.json', remote: '/tmp/rewards-update/package.json' }
];

async function main() {
  const conn = new Client();

  await new Promise((resolve, reject) => {
    conn.on('ready', resolve).on('error', reject).connect({
      host: '192.168.18.225',
      port: 22,
      username: 'root',
      password: 'Y858362599j',
      readyTimeout: 10000
    });
  });

  console.log('SSH connection established to 192.168.18.225');

  // 1. 创建远程目录
  await runCmd(conn, 'mkdir -p /tmp/rewards-update/src/web/public /tmp/rewards-update/src/browser');

  // 2. 通过 SFTP 上传文件
  const sftp = await new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => (err ? reject(err) : resolve(sftp)));
  });

  for (const item of filesToUpload) {
    console.log(`Uploading ${item.local} -> ${item.remote}...`);
    await new Promise((resolve, reject) => {
      sftp.fastPut(item.local, item.remote, (err) => (err ? reject(err) : resolve()));
    });
  }

  console.log('All files uploaded to /tmp/rewards-update');

  // 3. 将文件复制到 rewards-v3 容器内部
  console.log('Copying files into Docker container rewards-v3...');
  await runCmd(conn, 'docker cp /tmp/rewards-update/src/web/public/. rewards-v3:/app/src/web/public/');
  await runCmd(conn, 'docker cp /tmp/rewards-update/src/browser/browser.js rewards-v3:/app/src/browser/browser.js');
  await runCmd(conn, 'docker cp /tmp/rewards-update/package.json rewards-v3:/app/package.json');

  // 4. 重启 rewards-v3 容器使新逻辑和静态资源生效
  console.log('Restarting rewards-v3 container...');
  await runCmd(conn, 'docker restart rewards-v3');

  console.log('Waiting 3 seconds for container to initialize...');
  await new Promise((r) => setTimeout(r, 3000));

  // 5. 校验远程 8787 端口服务响应
  const checkRes = await runCmd(conn, "curl -s http://127.0.0.1:8787/ | grep -o 'Rewards.v[0-9.]*' | head -n 1");
  console.log('Remote container active version:', checkRes.stdout.trim() || 'Ready');

  conn.end();
  console.log('🎉 远程容器 rewards-v3 热发布更新完成！');
}

function runCmd(conn, cmd) {
  return new Promise((resolve, reject) => {
    conn.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      let stdout = '';
      let stderr = '';
      stream.on('close', (code) => resolve({ code, stdout, stderr }));
      stream.on('data', (d) => (stdout += d.toString()));
      stream.stderr.on('data', (d) => (stderr += d.toString()));
    });
  });
}

main().catch((err) => {
  console.error('Deploy error:', err);
  process.exit(1);
});
