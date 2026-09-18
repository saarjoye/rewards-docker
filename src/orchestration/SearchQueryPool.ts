import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const FALLBACK_SEARCH_TERMS: readonly string[] = [
  '中国传统节日',
  '今日科技新闻',
  '人工智能发展',
  '北京天气',
  '上海旅游',
  '中国历史文化',
  '健康生活方式',
  '世界地理知识',
  '国产电影推荐',
  '音乐基础知识',
  '计算机科学',
  '绿色能源',
  '航天科技',
  '海洋生物',
  '古典文学',
  '摄影技巧',
  '家庭烹饪',
  '运动健康',
  '城市交通',
  '自然保护',
  '数学趣题',
  '物理实验',
  '化学元素',
  '天文观测',
  '建筑设计',
  '园艺知识',
  '博物馆展览',
  '语言学习',
  '网络安全',
  '开源软件',
  '数据库基础',
  '云计算',
  '机器学习',
  '机器人技术',
  '新能源汽车',
  '高速铁路',
  '农业科技',
  '气象科学',
  '地质公园',
  '非物质文化遗产',
  '诗词鉴赏',
  '书法艺术',
  '国画基础',
  '戏曲文化',
  '围棋入门',
  '羽毛球规则',
  '篮球比赛',
  '足球历史',
  '游泳技巧',
  '营养搭配',
  '睡眠健康',
  '心理健康'
]

let cachedQueries: string[] | null = null

export function hashString(str: string): number {
  let hash = 5381
  for (let i = 0; i < str.length; i += 1) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0
  }
  return Math.abs(hash)
}

export function loadSearchQueries(): string[] {
  if (cachedQueries && cachedQueries.length > 0) {
    return cachedQueries
  }

  const candidatePaths: string[] = []

  try {
    candidatePaths.push(fileURLToPath(new URL('./search-queries.json', import.meta.url)))
  } catch {
    // Ignore URL resolution error
  }

  candidatePaths.push(
    join(process.cwd(), 'src', 'orchestration', 'search-queries.json'),
    join(process.cwd(), 'dist', 'server', 'orchestration', 'search-queries.json')
  )

  for (const filePath of candidatePaths) {
    try {
      if (existsSync(filePath)) {
        const raw = readFileSync(filePath, 'utf8')
        const parsed = JSON.parse(raw) as unknown
        if (Array.isArray(parsed) && parsed.length > 0) {
          const valid = parsed
            .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
            .map((item) => item.trim())
          if (valid.length > 0) {
            cachedQueries = valid
            return cachedQueries
          }
        }
      }
    } catch {
      // Continue to next candidate
    }
  }

  cachedQueries = [...FALLBACK_SEARCH_TERMS]
  return cachedQueries
}

export class SearchQueryPool {
  private readonly queries: string[]

  constructor(customQueries?: string[]) {
    this.queries =
      customQueries && customQueries.length > 0 ? customQueries : loadSearchQueries()
  }

  get size(): number {
    return this.queries.length
  }

  getQuery(accountKey: string, date: string, queryOffset: number): string {
    if (this.queries.length === 0) return '微软必应搜索'
    const seed = hashString(`${accountKey}:${date}`)
    const index = (seed + queryOffset) % this.queries.length
    return this.queries[index] ?? this.queries[0] ?? '微软必应搜索'
  }

  getQueries(accountKey: string, date: string, count: number, startOffset = 0): string[] {
    const result: string[] = []
    for (let i = 0; i < count; i += 1) {
      result.push(this.getQuery(accountKey, date, startOffset + i))
    }
    return result
  }
}

export const defaultSearchQueryPool = new SearchQueryPool()
