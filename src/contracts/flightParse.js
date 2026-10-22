/**
 * Next.js Flight / RSC 数据流解析模块 (纯函数)
 *
 * rewards.bing.com 的 /earn 页面把任务卡片数据置于 self.__next_f.push([1,"..."])
 * 必须经过多轮转义归一化与括号配平算法才能准确提取。
 */

export function isEscaped(text, index) {
  let backslashes = 0;
  for (let i = index - 1; i >= 0 && text[i] === '\\'; i--) backslashes++;
  return backslashes % 2 === 1;
}

export function findBalancedEnd(text, openIndex, open = '[', close = ']') {
  if (!text || openIndex < 0 || text[openIndex] !== open) return -1;
  let depth = 0;
  let inString = false;
  for (let i = openIndex; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '"' && !isEscaped(text, i)) inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

export function normalizeFlightFragment(fragment) {
  if (fragment === null || fragment === undefined) return '';
  let text = String(fragment);
  for (let round = 0; round < 8; round++) {
    const before = text;
    text = text.split('\\u0022').join('"');
    text = text.replace(/\\(?=["\\])/g, '');
    if (text === before) break;
  }
  return text;
}

export function extractOfferObjects(text, maxObjectLength = 8000) {
  if (!text) return [];
  const normalized = normalizeFlightFragment(text);
  const found = [];
  const stack = [];
  let inString = false;

  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized[i];
    if (inString) {
      if (ch === '"' && !isEscaped(normalized, i)) inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') {
      stack.push(i);
    } else if (ch === '}' && stack.length > 0) {
      const start = stack.pop();
      const length = i - start + 1;
      if (length > maxObjectLength) continue;
      const slice = normalized.slice(start, i + 1);
      if (slice.includes('"offerId"') && (slice.includes('"hash"') || slice.includes('"title"') || slice.includes('"pointProgress"'))) {
        found.push(slice);
      }
    }
  }
  return found;
}

export function concatFlightChunks(html) {
  const source = String(html ?? '');
  const chunks = [];
  const pushRegex = /self\.__next_f\.push\(\[\d+,\s*"(.*?)"\]\)/gs;
  let match;
  while ((match = pushRegex.exec(source)) !== null) {
    try {
      chunks.push(JSON.parse(`"${match[1]}"`));
    } catch {
      // 容错处理
    }
  }
  if (chunks.length > 0) return chunks.join('');
  return normalizeFlightFragment(source);
}

export function extractJsonArray(text, key) {
  if (text === null || text === undefined || !key) return null;
  const source = normalizeFlightFragment(text);
  const needle = `"${key}"`;
  let idx = source.indexOf(needle);
  while (idx !== -1) {
    const bracketIndex = source.indexOf('[', idx + needle.length);
    if (bracketIndex !== -1 && /^[\s:]*$/.test(source.slice(idx + needle.length, bracketIndex))) {
      const end = findBalancedEnd(source, bracketIndex);
      if (end !== -1) return source.slice(bracketIndex, end + 1);
    }
    idx = source.indexOf(needle, idx + 1);
  }
  return null;
}
