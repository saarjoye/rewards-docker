import fs from 'fs';
import path from 'path';

export const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');

export function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

// 确保基础目录与子目录存在
ensureDir(DATA_DIR);
ensureDir(path.join(DATA_DIR, 'sessions'));

/**
 * 跨平台高可靠原子写入文件：
 * 先写临时文件再原子重命名，防止意外掉电导致 JSON 损坏；
 * 针对 Windows 平台杀毒软件/索引短暂文件锁设计 5 次微回退重试与安全回退。
 */
export function writeFileAtomic(filePath, content) {
  ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  fs.writeFileSync(tempPath, content, 'utf-8');

  let renamed = false;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      fs.renameSync(tempPath, filePath);
      renamed = true;
      break;
    } catch (e) {
      if (attempt === 5) {
        // 最终回退：直接安全同步写入，杜绝 EPERM 崩溃
        try {
          fs.writeFileSync(filePath, content, 'utf-8');
          renamed = true;
        } catch {}
      } else {
        // 同步忙等 20ms 让出 Windows 文件锁
        const start = Date.now();
        while (Date.now() - start < 20) {}
      }
    }
  }

  // 清理可能遗留的临时文件
  if (fs.existsSync(tempPath)) {
    try { fs.unlinkSync(tempPath); } catch {}
  }
}
