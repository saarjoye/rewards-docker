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
 * 原子写入文件：先写临时文件再重命名，避免突发断电或重启导致 JSON 损坏
 */
export function writeFileAtomic(filePath, content) {
  ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  fs.writeFileSync(tempPath, content, 'utf-8');
  fs.renameSync(tempPath, filePath);
}
