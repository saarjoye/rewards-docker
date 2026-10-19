import fs from 'fs';
import path from 'path';
import { DATA_DIR, writeFileAtomic } from '../fsUtil.js';
import logger from '../logger.js';

const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');

export function getSessionFilePath(accountId) {
  const safeId = String(accountId).replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(SESSIONS_DIR, `${safeId}.json`);
}

export function readBrowserSession(accountId) {
  const p = getSessionFilePath(accountId);
  try {
    if (fs.existsSync(p)) {
      const raw = fs.readFileSync(p, 'utf-8');
      return JSON.parse(raw);
    }
  } catch (e) {
    logger.log('⚠️', `读取会话文件失败 [${accountId}]: ${e.message}`);
  }
  return null;
}

export function writeBrowserSession(accountId, sessionData) {
  const p = getSessionFilePath(accountId);
  try {
    const payload = {
      accountId,
      updatedAt: Date.now(),
      cookies: sessionData.cookies || [],
      tokens: sessionData.tokens || null,
      identity: sessionData.identity || null,
      origins: sessionData.origins || []
    };
    writeFileAtomic(p, JSON.stringify(payload, null, 2));
    return true;
  } catch (e) {
    logger.log('🔴', `写入会话文件失败 [${accountId}]: ${e.message}`);
    return false;
  }
}

export function deleteBrowserSession(accountId) {
  const p = getSessionFilePath(accountId);
  try {
    if (fs.existsSync(p)) {
      fs.unlinkSync(p);
    }
  } catch {}
}
