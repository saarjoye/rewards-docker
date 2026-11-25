import fs from 'fs';
import os from 'os';
import path from 'path';
import { Client } from 'ssh2';

// 所有连接信息只从环境变量读取，禁止在源码里写死主机、账号或密码。
// 用法：
//   DEPLOY_SSH_HOST=192.168.1.100 \
//   DEPLOY_SSH_USER=root \
//   DEPLOY_SSH_KEY=$HOME/.ssh/id_ed25519 \
//   node scripts/deploy-to-remote.mjs
//
// 更推荐把变量放进项目根目录的 .env（已在 .gitignore 中），然后：
//   node --env-file=.env scripts/deploy-to-remote.mjs

const remoteDir = process.env.DEPLOY_REMOTE_DIR || '/tmp/rewards-update';
const containerName = process.env.DEPLOY_CONTAINER || 'rewards-v3';
const healthUrl = process.env.DEPLOY_HEALTH_URL || 'http://127.0.0.1:8787/';

if (!/^[A-Za-z0-9._/-]+$/.test(remoteDir)) {
  throw new Error('DEPLOY_REMOTE_DIR 只能包含字母、数字、点、下划线、斜杠和短横线');
}
if (!/^[A-Za-z0-9_.-]+$/.test(containerName)) {
  throw new Error('DEPLOY_CONTAINER 只能包含字母、数字、点、下划线和短横线');
}

function expandHome(inputPath) {
  return inputPath.startsWith('~') ? path.join(os.homedir(), inputPath.slice(1)) : inputPath;
}

const filesToUpload = [
  { local: 'src/web/public/style.css', remote: 'src/web/public/style.css' },
  { local: 'src/web/public/index.html', remote: 'src/web/public/index.html' },
  { local: 'src/web/public/app.js', remote: 'src/web/public/app.js' },
  { local: 'src/browser/browser.js', remote: 'src/browser/browser.js' },
  { local: 'package.json', remote: 'package.json' }
];

function getConnectConfig() {
  const host = process.env.DEPLOY_SSH_HOST;
  if (!host) {
    throw new Error('缺少 DEPLOY_SSH_HOST（不要再把主机写进源码）');
  }

  const port = Number(process.env.DEPLOY_SSH_PORT || 22);
  const username = process.env.DEPLOY_SSH_USER || 'root';
  const password = process.env.DEPLOY_SSH_PASSWORD;
  const keyPath = expandHome(
    process.env.DEPLOY_SSH_KEY || path.join(os.homedir(), '.ssh', 'id_ed25519')
  );
  const expectedFingerprint = process.env.DEPLOY_SSH_HOST_FINGERPRINT;

  const config = {
    host,
    port,
    username,
    readyTimeout: 10000,
    hostHash: 'sha256'
  };

  if (expectedFingerprint) {
    config.hostVerifier = (hash) => hash === expectedFingerprint;
  } else {
    console.warn('⚠️ 未设置 DEPLOY_SSH_HOST_FINGERPRINT，跳过 SSH 主机指纹校验');
    console.warn('   建议先运行 ssh-keyscan 获取指纹，再写入环境变量。');
    config.hostVerifier = () => true;
  }

  if (password) {
    console.warn('⚠️ 正在使用 DEPLOY_SSH_PASSWORD 密码认证；建议改用 SSH key。');
    config.password = password;
  } else {
    if (!fs.existsSync(keyPath)) {
      throw new Error(`找不到 SSH 私钥: ${keyPath}`);
    }
    config.privateKey = fs.readFileSync(keyPath);
  }

  return config;
}

async function main() {
  const conn = new Client();

  await new Promise((resolve, reject) => {
    conn.on('ready', resolve).on('error', reject).connect(getConnectConfig());
  });

  console.log(`SSH connection established to ${process.env.DEPLOY_SSH_HOST}`);

  try {
    // 1. 创建远程目录
    await runCmd(conn, `mkdir -p ${remoteDir}/src/web/public ${remoteDir}/src/browser`);

    // 2. 通过 SFTP 上传文件
    const sftp = await new Promise((resolve, reject) => {
      conn.sftp((err, client) => (err ? reject(err) : resolve(client)));
    });

    for (const item of filesToUpload) {
      const remotePath = path.posix.join(remoteDir, item.remote);
      console.log(`Uploading ${item.local} -> ${remotePath}...`);
      await new Promise((resolve, reject) => {
        sftp.fastPut(item.local, remotePath, (err) => (err ? reject(err) : resolve()));
      });
    }

    console.log(`All files uploaded to ${remoteDir}`);

    // 3. 将文件复制到容器内部
    console.log(`Copying files into Docker container ${containerName}...`);
    await runCmd(conn, `docker cp ${remoteDir}/src/web/public/. ${containerName}:/app/src/web/public/`);
    await runCmd(conn, `docker cp ${remoteDir}/src/browser/browser.js ${containerName}:/app/src/browser/browser.js`);
    await runCmd(conn, `docker cp ${remoteDir}/package.json ${containerName}:/app/package.json`);

    // 4. 重启容器使新逻辑和静态资源生效
    console.log(`Restarting ${containerName} container...`);
    await runCmd(conn, `docker restart ${containerName}`);

    console.log('Waiting 3 seconds for container to initialize...');
    await new Promise((r) => setTimeout(r, 3000));

    // 5. 校验远程服务响应
    const checkRes = await runCmd(
      conn,
      `curl -s ${healthUrl} | grep -o 'Rewards.v[0-9.]*' | head -n 1`
    );
    console.log('Remote container active version:', checkRes.stdout.trim() || 'Ready');
    console.log('🎉 远程容器热发布更新完成！');
  } finally {
    conn.end();
  }
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
  console.error('Deploy error:', err.message);
  process.exit(1);
});
