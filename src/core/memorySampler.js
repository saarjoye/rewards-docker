import fs from 'fs';
import path from 'path';

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8').trim();
  } catch {
    return null;
  }
}

function statValue(statText, key) {
  if (!statText) return 0;
  const m = String(statText).match(new RegExp('^' + key + '\\s+(\\d+)', 'm'));
  return m ? Number(m[1]) : 0;
}

export function sampleContainerMemory() {
  const containerLimitMB = 512;

  // 1. Linux / Docker cgroup v2 探测
  const cgroupV2Path = '/sys/fs/cgroup';
  const currentPath = path.join(cgroupV2Path, 'memory.current');
  const maxPath = path.join(cgroupV2Path, 'memory.max');
  const statPath = path.join(cgroupV2Path, 'memory.stat');

  if (fs.existsSync(currentPath)) {
    const statText = readText(statPath);
    // 在 Linux cgroup v2 中，anon 是容器内真实进程所占用的常驻内存，排除可释放的文件缓存 PageCache
    const anonBytes = statValue(statText, 'anon');
    const nodeRss = process.memoryUsage().rss;
    const realBytes = anonBytes > 0 ? Math.max(anonBytes, nodeRss) : nodeRss;

    const maxRaw = readText(maxPath);
    const maxBytes = maxRaw && maxRaw !== 'max' ? Number(maxRaw) : containerLimitMB * 1024 * 1024;
    const curMB = Math.round(realBytes / (1024 * 1024));
    const maxMB = Math.round(maxBytes / (1024 * 1024));
    const percent = Math.min(100, Math.round((curMB / maxMB) * 100));

    return {
      type: 'cgroup_v2',
      usedMB: curMB,
      limitMB: maxMB,
      percent,
      status: percent > 85 ? 'danger' : percent > 65 ? 'warning' : 'healthy'
    };
  }

  // 2. Linux / Docker cgroup v1 探测
  const cgroupV1Stat = '/sys/fs/cgroup/memory/memory.stat';
  if (fs.existsSync(cgroupV1Stat)) {
    const statText = readText(cgroupV1Stat);
    const rssBytes = statValue(statText, 'total_rss') || statValue(statText, 'rss') || process.memoryUsage().rss;
    const curMB = Math.round(rssBytes / (1024 * 1024));
    const percent = Math.min(100, Math.round((curMB / containerLimitMB) * 100));
    return {
      type: 'cgroup_v1',
      usedMB: curMB,
      limitMB: containerLimitMB,
      percent,
      status: percent > 85 ? 'danger' : percent > 65 ? 'warning' : 'healthy'
    };
  }

  // 3. 本地 Node.js 进程内存采样 (Windows / macOS)
  const nodeMem = process.memoryUsage();
  const rssMB = Math.round(nodeMem.rss / (1024 * 1024));
  const heapUsedMB = Math.round(nodeMem.heapUsed / (1024 * 1024));
  const percent = Math.min(100, Math.round((rssMB / containerLimitMB) * 100));

  return {
    type: 'process_rss',
    usedMB: rssMB,
    heapUsedMB,
    limitMB: containerLimitMB,
    percent,
    status: percent > 80 ? 'danger' : percent > 60 ? 'warning' : 'healthy'
  };
}

export class MemorySampler {
  constructor() {
    this.peakMB = 0;
  }

  getSnapshot() {
    const sample = sampleContainerMemory();
    if (sample.usedMB > this.peakMB) {
      this.peakMB = sample.usedMB;
    }
    return {
      ...sample,
      peakMB: this.peakMB,
      timestamp: Date.now()
    };
  }
}

export const memorySampler = new MemorySampler();
export default memorySampler;
