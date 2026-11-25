import fs from 'fs';
import os from 'os';
import path from 'path';
import { Client } from 'ssh2';

// 连接信息只从环境变量读取，禁止在源码里写死主机、账号或密码。
// 用法：
//   DEPLOY_SSH_HOST=192.168.1.100 DEPLOY_SSH_USER=root \
//   DEPLOY_SSH_KEY=$HOME/.ssh/id_ed25519 \
//   node scripts/remote-exec.mjs "pct list"
//
// 或者：
//   node --env-file=.env scripts/remote-exec.mjs "pct list"

let warnedAboutFingerprint = false;

function expandHome(inputPath) {
  return inputPath.startsWith('~') ? path.join(os.homedir(), inputPath.slice(1)) : inputPath;
}

function normalizeFingerprint(input) {
  const value = String(input || '').trim();
  if (!value) return '';
  if (value.startsWith('SHA256:')) {
    return Buffer.from(value.slice(7), 'base64').toString('hex').toLowerCase();
  }
  if (value.startsWith('MD5:')) {
    return value.slice(4).replace(/:/g, '').toLowerCase();
  }
  return value.replace(/:/g, '').toLowerCase();
}

export function getConnectConfig() {
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
  const expectedFingerprint = normalizeFingerprint(process.env.DEPLOY_SSH_HOST_FINGERPRINT);

  const config = {
    host,
    port,
    username,
    readyTimeout: 10000,
    hostHash: 'sha256'
  };

  if (expectedFingerprint) {
    config.hostVerifier = (hash) => hash.toLowerCase() === expectedFingerprint;
  } else {
    if (!warnedAboutFingerprint) {
      console.warn('⚠️ 未设置 DEPLOY_SSH_HOST_FINGERPRINT，跳过 SSH 主机指纹校验');
      warnedAboutFingerprint = true;
    }
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

export function runRemote(cmd) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    conn.on('ready', () => {
      conn.exec(cmd, (err, stream) => {
        if (err) {
          conn.end();
          return reject(err);
        }
        let stdout = '';
        let stderr = '';
        stream.on('close', (code, signal) => {
          conn.end();
          resolve({ code, signal, stdout, stderr });
        });
        stream.on('data', (data) => {
          stdout += data.toString();
        });
        stream.stderr.on('data', (data) => {
          stderr += data.toString();
        });
      });
    }).on('error', (err) => {
      reject(err);
    }).connect(getConnectConfig());
  });
}

// CLI usage
const cmd = process.argv.slice(2).join(' ');
if (cmd) {
  runRemote(cmd)
    .then((res) => {
      if (res.stdout) console.log(res.stdout);
      if (res.stderr) console.error(res.stderr);
      process.exit(res.code || 0);
    })
    .catch((err) => {
      console.error('SSH Error:', err.message);
      process.exit(1);
    });
}
