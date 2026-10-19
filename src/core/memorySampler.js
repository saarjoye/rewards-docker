import fs from 'fs';
import path from 'path';
import os from 'os';

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
  // 1. Linux / Docker cgroup v2 探测
  const cgroupV2Path = '/sys/fs/cgroup';
  const currentPath = path.join(cgroupV2Path, 'memory.current');
  const maxPath = path.join(cgroupV2Path, 'memory.max');

  if (fs.existsSync(currentPath)) {
    const curBytes = Number(readText(currentPath)) || 0;
    const maxRaw = readText(maxPath);
    const maxBytes = maxRaw && maxRaw !== 'max' ? Number(maxRaw) : 512 * 1024 * 1024;
    const curMB = Math.round(curBytes / (1024 * 1024));
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

  // 2. 本地 Node.js 进程内存采样 (Windows / macOS)
  const nodeMem = process.memoryUsage();
  const rssMB = Math.round(nodeMem.rss / (1024 * 1024));
  const heapUsedMB = Math.round(nodeMem.heapUsed / (1024 * 1024));
  const containerLimitMB = 512; // 默认对标 Docker 512MB 限制
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
