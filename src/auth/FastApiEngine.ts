import type { AppToken } from '../browser/AppOAuthClient.js'
import { exchangeOAuthRefreshToken } from './SessionImportManager.js'
import { decodeFlightChunks } from '../rewards/DashboardParser.js'

export const USER_AGENTS = {
  pc: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
  mobile: 'Mozilla/5.0 (Linux; Android 16; Redmi K20 Pro Build/BP4A.251205.006; ) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/144.0.7559.132 Mobile Safari/537.36 EdgA/131.0.0.0',
  app: 'Mozilla/5.0 (Linux; Android 16; Redmi K20 Pro Build/BP4A.251205.006; ) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/144.0.7559.132 Mobile Safari/537.36 BingSapphire/32.6.2110003560'
} as const

export interface CookieStatusResult {
  valid: boolean
  balance?: number
  todayPoints?: number
  userName?: string
  streakDays?: number
  stamps?: { progress: number; max: number }
  pcSearch?: string
  message: string
}

export interface TokenStatusResult {
  valid: boolean
  balance?: number
  todayPoints?: number
  readProgress?: string
  message: string
  refreshedToken?: AppToken
}

export interface HealthCheckResult {
  accountId: string
  overallValid: boolean
  balance: number
  todayPoints?: number
  nickname?: string | undefined
  cookie: CookieStatusResult
  token: TokenStatusResult
  conflict?: boolean | undefined
  conflictMessage?: string | undefined
}

export interface RegionLockResult {
  allowed: boolean
  region?: string
  ipInfo?: string
  message: string
}

export function extractNicknameFromCookie(cookieStr: string): string | undefined {
  if (!cookieStr || typeof cookieStr !== 'string') return undefined

  // 1. 优先从 N 字段获取 (N=xxxx)
  const nMatch = cookieStr.match(/(?:^|;\s*)N=([^;]+)/)
  if (nMatch && nMatch[1]) {
    try {
      const decoded = decodeURIComponent(nMatch[1].trim())
      if (decoded) return decoded
    } catch {
      return nMatch[1].trim()
    }
  }

  // 2. 从 WLS 字段获取 (WLS=ts=...&t=username...)
  const wlsMatch = cookieStr.match(/(?:^|;\s*)WLS=([^;]+)/)
  if (wlsMatch && wlsMatch[1]) {
    try {
      const decoded = decodeURIComponent(wlsMatch[1])
      const tMatch = decoded.match(/(?:^|&)t=([^&]+)/)
      if (tMatch && tMatch[1]) {
        return decodeURIComponent(tMatch[1].trim())
      }
    } catch {
      // ignore
    }
  }

  return undefined
}

export function cookieItemsToString(cookies: Array<{ name: string; value: string }>): string {
  return cookies.map((c) => `${c.name}=${c.value}`).join('; ')
}

export function extractBalancedJsonObject(str: string, searchKey: string): Record<string, unknown> | undefined {
  const idx = str.indexOf(searchKey)
  if (idx === -1) return undefined
  const braceIdx = str.indexOf('{', idx + searchKey.length)
  if (braceIdx === -1) return undefined
  let depth = 0
  let end = -1
  for (let i = braceIdx; i < str.length && i < braceIdx + 50_000; i++) {
    if (str[i] === '{') depth++
    else if (str[i] === '}') {
      depth--
      if (depth === 0) {
        end = i + 1
        break
      }
    }
  }
  if (end !== -1) {
    try {
      const parsed: unknown = JSON.parse(str.substring(braceIdx, end))
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      // ignore JSON parse error
    }
  }
  return undefined
}

export class FastApiEngine {
  constructor(private readonly fetchImpl: typeof fetch = globalThis.fetch) {}

  /**
   * 国区防风控安全锁探测
   */
  async checkRegionLock(timeoutMs = 10_000): Promise<RegionLockResult> {
    const controller = new AbortController()
    const timer = setTimeout(() => { controller.abort(); }, timeoutMs)

    let ipInfo = ''
    try {
      // 1. 尝试获取腾讯 IP 调度详情（获取公网出口 IP 和归属地）
      try {
        const ipRes = await this.fetchImpl('https://disp-qryapi.3g.qq.com/v1/dispatch', {
          headers: { referer: 'https://3g.qq.com/' },
          signal: controller.signal
        })
        if (ipRes.ok) {
          const ipData = (await ipRes.json()) as { code?: number; extra?: { ip?: string }; ipInfo?: string }
          if (ipData.code === 0) {
            const ip = ipData.extra?.ip || ''
            const rawInfo = (ipData.ipInfo || '').replace(/[#*]+/g, ' ').trim()
            ipInfo = `出口 IP: ${ip} 所在地: ${rawInfo}`
          }
        }
      } catch {
        // IP 查询失败不阻断地区识别
      }

      // 2. 向微软 Bing 发起地区探测
      const bingRes = await this.fetchImpl('https://www.bing.com/', {
        headers: { 'user-agent': USER_AGENTS.pc },
        signal: controller.signal
      })
      const html = await bingRes.text()
      const match = html.replace(/\s/g, '').match(/Region:"(.*?)"(.*?)RevIpCC:"(.*?)"/)

      if (match && match[3]) {
        const region = match[3].toUpperCase()
        if (region !== 'CN') {
          return {
            allowed: false,
            region,
            ipInfo,
            message: `检测到微软探测的当前网络出口位于非中国大陆地区 (${region})！为了防止账号被微软风控/锁区，已触发安全锁拦截。${ipInfo ? ` (${ipInfo})` : ''}`
          }
        }
        return {
          allowed: true,
          region: 'CN',
          ipInfo,
          message: `安全锁校验通过：中国大陆出口 (CN)${ipInfo ? ` - ${ipInfo}` : ''}`
        }
      }

      return {
        allowed: true,
        region: 'UNKNOWN',
        ipInfo,
        message: '未能在响应中解析到微软地区代码，默认放行'
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      return {
        allowed: true,
        message: `安全锁探测请求异常 (${msg})，跳过拦截`
      }
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * 探测网页端 Cookie 的有效性并提取积分明细
   */
  async checkCookieStatus(cookieStr: string, timeoutMs = 15_000): Promise<CookieStatusResult> {
    const trimmed = cookieStr.trim()
    if (!trimmed) {
      return { valid: false, message: '尚未配置网页端 Cookie' }
    }

    const controller = new AbortController()
    const timer = setTimeout(() => { controller.abort() }, timeoutMs)

    try {
      const userName = extractNicknameFromCookie(trimmed) ?? ''

      // 1. 优先尝试微软官方权威 JSON 接口 (api/getuserinfo)
      try {
        const userInfoRes = await this.fetchImpl('https://rewards.bing.com/api/getuserinfo?type=1', {
          headers: {
            'user-agent': USER_AGENTS.pc,
            referer: 'https://rewards.bing.com/',
            cookie: trimmed
          },
          signal: controller.signal
        })

        if (userInfoRes.status === 401) {
          return { valid: false, message: '微软官方返回 HTTP 401（未授权），Cookie 已过期失效' }
        }

        if (userInfoRes.ok) {
          const contentType = userInfoRes.headers.get('content-type') ?? ''
          if (contentType.includes('application/json')) {
            const data = (await userInfoRes.json()) as Record<string, unknown>
            const userStatus =
              (data.userStatus as Record<string, unknown> | undefined) ??
              ((data.dashboard as Record<string, unknown> | undefined)?.userStatus as Record<string, unknown> | undefined)

            if (userStatus) {
              let apiBalance: number | undefined
              const rawAvail = userStatus.availablePoints
              if (typeof rawAvail === 'number' && Number.isSafeInteger(rawAvail) && rawAvail >= 0) {
                apiBalance = rawAvail
              } else if (typeof rawAvail === 'string') {
                const num = parseInt(rawAvail.replace(/,/g, ''), 10)
                if (Number.isSafeInteger(num) && num >= 0) apiBalance = num
              }

              let apiTodayPoints: number | undefined
              const counters = userStatus.counters as Record<string, unknown> | undefined
              const dailyPointRaw = counters?.dailyPoint
              const dp = Array.isArray(dailyPointRaw)
                ? (dailyPointRaw[0] as Record<string, unknown> | undefined)
                : (dailyPointRaw as Record<string, unknown> | undefined)
              if (dp) {
                const rawProgress = dp.pointProgress ?? dp.progress
                if (typeof rawProgress === 'number' && Number.isSafeInteger(rawProgress) && rawProgress >= 0) {
                  apiTodayPoints = rawProgress
                } else if (typeof rawProgress === 'string') {
                  const num = parseInt(rawProgress.replace(/,/g, ''), 10)
                  if (Number.isSafeInteger(num) && num >= 0) apiTodayPoints = num
                }
              }

              let apiPcProgress = 0
              let apiPcMax = 60
              if (counters && Array.isArray(counters.pcSearch) && counters.pcSearch[0]) {
                const pc = counters.pcSearch[0] as Record<string, unknown>
                if (typeof pc.pointProgress === 'number') apiPcProgress = pc.pointProgress
                if (typeof pc.pointProgressMax === 'number') apiPcMax = pc.pointProgressMax
              }

              const streakInfo = userStatus.streakInfo as Record<string, unknown> | undefined
              const rawStreak = streakInfo?.currentStreak ?? userStatus.currentStreak ?? userStatus.streakDays
              const apiStreak = typeof rawStreak === 'number' ? rawStreak : 0

              if (apiBalance !== undefined) {
                const msgParts = ['网页端在线', '积分: ' + String(apiBalance)]
                if (apiTodayPoints !== undefined) msgParts.push('今日: +' + String(apiTodayPoints))
                msgParts.push('连签: ' + String(apiStreak) + '天')
                msgParts.push('搜索: ' + String(apiPcProgress) + '/' + String(apiPcMax))

                return {
                  valid: true,
                  balance: apiBalance,
                  ...(apiTodayPoints !== undefined ? { todayPoints: apiTodayPoints } : {}),
                  userName,
                  streakDays: apiStreak,
                  stamps: { progress: 0, max: 12 },
                  pcSearch: String(apiPcProgress) + '/' + String(apiPcMax),
                  message: msgParts.join(' | ')
                }
              }
            }
          }
        }
      } catch {
        // 若 api/getuserinfo 请求异常或非 JSON，平滑回退到 earn 页面抓取
      }

      // 2. 回退请求 /earn 页面抓取
      const response = await this.fetchImpl('https://rewards.bing.com/earn', {
        headers: {
          'user-agent': USER_AGENTS.pc,
          referer: 'https://rewards.bing.com/',
          cookie: trimmed
        },
        signal: controller.signal
      })

      if (response.status === 401) {
        return { valid: false, message: '微软官方返回 HTTP 401（未授权），Cookie 已过期失效' }
      }

      const rawHtml = await response.text()
      const flight = decodeFlightChunks(rawHtml)
      const clean = (flight ? (flight + '\n' + rawHtml) : rawHtml).replace(/\\"/g, '"')
      const isAuthValid =
        clean.includes('pointsCounters') ||
        clean.includes('pointsHistory') ||
        clean.includes('activityCards') ||
        clean.includes('availablePoints') ||
        clean.includes('userStatus') ||
        clean.includes('dailySetPromotions') ||
        clean.includes('可用积分') ||
        clean.includes('今日积分')

      if (isAuthValid) {
        let balance: number | undefined
        let todayPoints: number | undefined
        let pcProgress = 0
        let pcMax = 60
        let streakDays = 0

        // 2.1 尝试从 userStatus 结构中直接提取权威余额与今日得分
        const userStatusObj = extractBalancedJsonObject(clean, '"userStatus"')
        if (userStatusObj) {
          const rawAvail = userStatusObj.availablePoints
          if (typeof rawAvail === 'number' && Number.isSafeInteger(rawAvail) && rawAvail >= 0) {
            balance = rawAvail
          }
          const counters = userStatusObj.counters as Record<string, unknown> | undefined
          if (counters && Array.isArray(counters.dailyPoint) && counters.dailyPoint[0]) {
            const dp = counters.dailyPoint[0] as Record<string, unknown>
            const rawProgress = dp.pointProgress ?? dp.progress
            if (typeof rawProgress === 'number' && Number.isSafeInteger(rawProgress) && rawProgress >= 0) {
              todayPoints = rawProgress
            }
          }
          if (counters && Array.isArray(counters.pcSearch) && counters.pcSearch[0]) {
            const pc = counters.pcSearch[0] as Record<string, unknown>
            if (typeof pc.pointProgress === 'number') pcProgress = pc.pointProgress
            if (typeof pc.pointProgressMax === 'number') pcMax = pc.pointProgressMax
          }
          const streakInfo = userStatusObj.streakInfo as Record<string, unknown> | undefined
          const rawStreak = streakInfo?.currentStreak ?? userStatusObj.currentStreak ?? userStatusObj.streakDays
          if (typeof rawStreak === 'number') streakDays = rawStreak
        }

        // 2.2 尝试从 pointsCounters 内部结构提取
        const pointsCountersObj = extractBalancedJsonObject(clean, '"pointsCounters"')
        if (pointsCountersObj) {
          const pts = pointsCountersObj as {
            pc?: { max?: number; progress?: number; pointProgress?: number; pointProgressMax?: number }
            totalPoints?: number
            balance?: number
            dailyPoint?: { progress?: number; pointProgress?: number }
          }
          if (pts.pc) {
            pcMax = pts.pc.max ?? pts.pc.pointProgressMax ?? pcMax
            pcProgress = pts.pc.progress ?? pts.pc.pointProgress ?? pcProgress
          }
          if (balance === undefined) {
            if (pts.totalPoints != null && pts.totalPoints > 0) balance = pts.totalPoints
            else if (pts.balance != null && pts.balance > 0) balance = pts.balance
          }
          if (todayPoints === undefined && pts.dailyPoint) {
            const dpVal = pts.dailyPoint.pointProgress ?? pts.dailyPoint.progress
            if (typeof dpVal === 'number' && dpVal >= 0) todayPoints = dpVal
          }
        }

        // 2.3 兜底提取 PC 搜索配额
        if (pcProgress === 0 && pcMax === 60) {
          const pcMatch =
            clean.match(/"pcSearch"\s*:\s*\[\s*\{[^}]*?"pointProgress"\s*:\s*(\d+)[^}]*?"pointProgressMax"\s*:\s*(\d+)/) ||
            clean.match(/"pointProgress"\s*:\s*(\d+)[^}]*?"pointProgressMax"\s*:\s*(\d+)/)
          if (pcMatch && pcMatch[1] && pcMatch[2]) {
            pcProgress = parseInt(pcMatch[1], 10)
            pcMax = parseInt(pcMatch[2], 10)
          }
        }

        // 2.4 中文与文本锚定提取：总积分 / 可用积分（支持千分位逗号，如 13,150）
        if (balance === undefined) {
          const availTextMatch = clean.match(/(?:可用积分|当前积分|账户总分|总积分|Available\s+points)[\s\S]{0,100}?([0-9,]{1,10})/i)
          if (availTextMatch && availTextMatch[1]) {
            const num = parseInt(availTextMatch[1].replace(/,/g, ''), 10)
            if (Number.isSafeInteger(num) && num >= 0) balance = num
          }
        }

        // 2.5 正则安全兜底提取余额（仅在 activityCards 之前的安全区域提取，彻底杜绝把底部活动卡片 222 分当成余额）
        if (balance === undefined) {
          const userStatusMatch = clean.match(/"userStatus"\s*:\s*\{[^}]*?"availablePoints"\s*:\s*["']?([0-9,]+)["']?/)
          if (userStatusMatch && userStatusMatch[1]) {
            const num = parseInt(userStatusMatch[1].replace(/,/g, ''), 10)
            if (Number.isSafeInteger(num) && num >= 0) balance = num
          }
        }
        if (balance === undefined) {
          const cardIdx = clean.indexOf('"activityCards"')
          const promoIdx = clean.indexOf('"promotions"')
          const cutIdx = Math.min(
            cardIdx === -1 ? clean.length : cardIdx,
            promoIdx === -1 ? clean.length : promoIdx
          )
          const safeScope = clean.substring(0, cutIdx)
          const availMatches = [...safeScope.matchAll(/"availablePoints"\s*:\s*["']?([0-9,]+)["']?/g)]
          const totalMatches = [...safeScope.matchAll(/"totalPoints"\s*:\s*["']?([0-9,]+)["']?/g)]
          const balMatches = [...safeScope.matchAll(/"balance"\s*:\s*["']?([0-9,]+)["']?/g)]

          const raw = availMatches[0]?.[1] ?? totalMatches[0]?.[1] ?? balMatches[0]?.[1]
          if (raw !== undefined) {
            const num = parseInt(raw.replace(/,/g, ''), 10)
            if (Number.isSafeInteger(num) && num >= 0) balance = num
          }
        }

        // 2.6 中文与正则安全兜底提取今日获得积分
        if (todayPoints === undefined) {
          const todayTextMatch = clean.match(/(?:今日积分|今日获得|今日已得|Today's\s+points)[\s\S]{0,100}?([0-9,]{1,10})/i)
          if (todayTextMatch && todayTextMatch[1]) {
            const num = parseInt(todayTextMatch[1].replace(/,/g, ''), 10)
            if (Number.isSafeInteger(num) && num >= 0) todayPoints = num
          }
        }
        if (todayPoints === undefined) {
          const dailyMatch =
            clean.match(/"dailyPoint"\s*:\s*\[\s*\{[^}]*?"pointProgress"\s*:\s*(\d+)/) ||
            clean.match(/"dailyPoint"\s*:\s*\{[^}]*?"pointProgress"\s*:\s*(\d+)/) ||
            clean.match(/(?:今日获得|今日积分|今日已得)\s*[:：+]?\s*(\d+)/) ||
            clean.match(/"todayPoints"\s*:\s*["']?(\d+)["']?/)
          if (dailyMatch && dailyMatch[1]) {
            todayPoints = parseInt(dailyMatch[1], 10)
          }
        }

        // 2.7 铁律自检纠偏：绝不允许把今日得分（如 222）误当成总积分
        if (balance !== undefined && todayPoints !== undefined && balance === todayPoints && balance < 1000) {
          const largerMatch = clean.match(/(?:可用积分|当前积分|账户总分|总积分)[\s\S]{0,150}?([0-9,]{4,10})/i)
          if (largerMatch && largerMatch[1]) {
            const num = parseInt(largerMatch[1].replace(/,/g, ''), 10)
            if (Number.isSafeInteger(num) && num >= 0) balance = num
          } else {
            balance = undefined
          }
        }

        // 2.8 提取连续签到
        if (streakDays === 0) {
          const cleanText = clean.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ')
          const streakMatch =
            cleanText.match(/(?:每日连续打卡|连续打卡)\s*(\d+)/) ||
            clean.match(/"(?:streakDays|streakCount|currentStreak)"\s*:\s*(\d+)/)
          if (streakMatch && streakMatch[1]) {
            streakDays = parseInt(streakMatch[1], 10)
          }
        }

        // 2.9 提取印章进度
        let stampsProgress = 0
        let stampsMax = 12
        const stampMatch =
          clean.match(/"aria-label":"收集的印章[^}]*?"aria-valuemax":(\d+)[^}]*?"aria-valuenow":(\d+)/) ||
          clean.match(/aria-label="收集的印章[^>]*?aria-valuemax="(\d+)"[^>]*?aria-valuenow="(\d+)"/)
        if (stampMatch && stampMatch[1] && stampMatch[2]) {
          stampsMax = parseInt(stampMatch[1], 10) || 12
          stampsProgress = parseInt(stampMatch[2], 10) || 0
        }

        const msgParts = ['网页端在线']
        if (balance !== undefined) msgParts.push('积分: ' + String(balance))
        if (todayPoints !== undefined) msgParts.push('今日: +' + String(todayPoints))
        msgParts.push('连签: ' + String(streakDays) + '天')
        msgParts.push('搜索: ' + String(pcProgress) + '/' + String(pcMax))

        return {
          valid: true,
          ...(balance !== undefined ? { balance } : {}),
          ...(todayPoints !== undefined ? { todayPoints } : {}),
          userName,
          streakDays,
          stamps: { progress: stampsProgress, max: stampsMax },
          pcSearch: String(pcProgress) + '/' + String(pcMax),
          message: msgParts.join(' | ')
        }
      }

      if (clean.includes('login.live.com') || clean.includes('Sign in')) {
        return { valid: false, message: 'Cookie 已过期，页面重定向至微软登录页' }
      }

      return { valid: false, message: '未能识别微软 Rewards 登录态，请检查 Cookie 是否完整' }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      return { valid: false, message: '网页端请求异常: ' + msg }
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * 探测移动端 App Token 有效性并提取阅读任务进度
   */
    async checkTokenStatus(token: AppToken, timeoutMs = 15_000): Promise<TokenStatusResult> {
    if (!token.accessToken) {
      return { valid: false, message: '尚未配置移动端 Token' }
    }

    let activeToken = token.accessToken
    let refreshed: AppToken | undefined

    const controller = new AbortController()
    const timer = setTimeout(() => { controller.abort(); }, timeoutMs)

    try {
      let res = await this.fetchImpl(
        'https://prod.rewardsplatform.microsoft.com/dapi/me?channel=SAAndroid&options=613',
        {
          headers: {
            'content-type': 'application/json; charset=UTF-8',
            'user-agent': USER_AGENTS.app,
            authorization: `Bearer ${activeToken}`,
            'x-rewards-appid': 'SAAndroid/32.6.2110003560',
            'x-rewards-ismobile': 'true',
            'x-rewards-country': 'cn',
            'x-rewards-language': 'zh'
          },
          signal: controller.signal
        }
      )

      // 若 401 且有 refresh_token，尝试自动换取新 Token
      if (res.status === 401 && token.refreshToken) {
        try {
          refreshed = await exchangeOAuthRefreshToken(token.refreshToken, this.fetchImpl)
          activeToken = refreshed.accessToken
          res = await this.fetchImpl(
            'https://prod.rewardsplatform.microsoft.com/dapi/me?channel=SAAndroid&options=613',
            {
              headers: {
                'content-type': 'application/json; charset=UTF-8',
                'user-agent': USER_AGENTS.app,
                authorization: `Bearer ${activeToken}`,
                'x-rewards-appid': 'SAAndroid/32.6.2110003560',
                'x-rewards-ismobile': 'true',
                'x-rewards-country': 'cn',
                'x-rewards-language': 'zh'
              },
              signal: controller.signal
            }
          )
        } catch {
          return { valid: false, message: 'OAuth Token 已过期且自动续期失败，需重新授权' }
        }
      }

      if (!res.ok) {
        return { valid: false, message: `移动端 DAPI 响应异常 (HTTP ${String(res.status)})` }
      }

      const data = (await res.json()) as {
        response?: {
          balance?: number | string
          promotions?: Array<{ attributes?: { offerid?: string; progress?: number; max?: number } }>
        }
      }

      if (data.response) {
        const balance = Number(data.response.balance || 0)
        const promos = data.response.promotions || []
        const readTask = promos.find((x) => x.attributes?.offerid === 'ENUS_readarticle3_30points')
        const readProg = readTask
          ? `${String(readTask.attributes?.progress || 0)}/${String(readTask.attributes?.max || 30)}`
          : '就绪'

        let todayPoints: number | undefined
        const rawDp =
          (data.response as Record<string, unknown>).dailyPoints ??
          (data.response as Record<string, unknown>).todayPoints
        if (rawDp !== undefined && Number.isFinite(Number(rawDp))) {
          todayPoints = Number(rawDp)
        }

        const msgParts = ['移动端在线', `积分: ${String(balance)}`]
        if (todayPoints !== undefined) msgParts.push(`今日: +${String(todayPoints)}`)
        msgParts.push(`阅读进度: ${readProg}`)

        return {
          valid: true,
          balance,
          ...(todayPoints !== undefined ? { todayPoints } : {}),
          readProgress: readProg,
          message: msgParts.join(' | '),
          ...(refreshed ? { refreshedToken: refreshed } : {})
        }
      }

      return {
        valid: true,
        message: '移动端 Token 有效',
        ...(refreshed ? { refreshedToken: refreshed } : {})
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      return { valid: false, message: `移动端验证异常: ${msg}` }
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * 账号一键秒级体检诊断
   */
  async testAccount(input: {
    accountId: string
    cookieStr?: string | undefined
    token?: AppToken | undefined
  }): Promise<HealthCheckResult> {
    const [cookieRes, tokenRes] = await Promise.all([
      input.cookieStr
        ? this.checkCookieStatus(input.cookieStr)
        : Promise.resolve<CookieStatusResult>({ valid: false, message: '未配置 Cookie' }),
      input.token
        ? this.checkTokenStatus(input.token)
        : Promise.resolve<TokenStatusResult>({ valid: false, message: '未配置 App Token' })
    ])

    let balance = cookieRes.balance ?? tokenRes.balance ?? 0
    let todayPoints = cookieRes.todayPoints ?? tokenRes.todayPoints
    const nickname =
      cookieRes.userName || (input.cookieStr ? extractNicknameFromCookie(input.cookieStr) : undefined)
    let overallValid = cookieRes.valid || tokenRes.valid

    // 双轨智能自愈与纠偏：
    // 若某一端余额被误读为今日积分（例如 balance 等于今日积分，或 balance <= 500 且另一端 balance > 2000 悬殊）
    if (
      cookieRes.valid &&
      tokenRes.valid &&
      cookieRes.balance !== undefined &&
      tokenRes.balance !== undefined &&
      tokenRes.balance >= 1000 &&
      ((cookieRes.todayPoints !== undefined &&
        (cookieRes.balance === cookieRes.todayPoints ||
          Math.abs(cookieRes.balance - cookieRes.todayPoints) <= 10)) ||
        (cookieRes.balance <= 600 && tokenRes.balance - cookieRes.balance >= 500))
    ) {
      todayPoints = cookieRes.todayPoints ?? cookieRes.balance
      cookieRes.todayPoints = todayPoints
      cookieRes.balance = tokenRes.balance
      balance = tokenRes.balance
    } else if (
      cookieRes.valid &&
      tokenRes.valid &&
      cookieRes.balance !== undefined &&
      tokenRes.balance !== undefined &&
      cookieRes.balance >= 1000 &&
      ((tokenRes.todayPoints !== undefined &&
        (tokenRes.balance === tokenRes.todayPoints ||
          Math.abs(tokenRes.balance - tokenRes.todayPoints) <= 10)) ||
        (tokenRes.balance <= 600 && cookieRes.balance - tokenRes.balance >= 500))
    ) {
      todayPoints = tokenRes.todayPoints ?? tokenRes.balance
      tokenRes.todayPoints = todayPoints
      tokenRes.balance = cookieRes.balance
      balance = cookieRes.balance
    }

    let conflict = false
    let conflictMessage: string | undefined
    if (
      cookieRes.valid &&
      tokenRes.valid &&
      cookieRes.balance !== undefined &&
      tokenRes.balance !== undefined &&
      Math.abs(cookieRes.balance - tokenRes.balance) > 100
    ) {
      conflict = true
      overallValid = false
      conflictMessage = '双轨凭据冲突：Cookie 余额 (' + String(cookieRes.balance) + ') 与 App Token 余额 (' + String(tokenRes.balance) + ') 偏差过大，可能绑定了不同账号！'
    }

    return {
      accountId: input.accountId,
      overallValid,
      balance,
      ...(todayPoints !== undefined ? { todayPoints } : {}),
      ...(nickname ? { nickname } : {}),
      cookie: cookieRes,
      token: tokenRes,
      ...(conflict ? { conflict: true, ...(conflictMessage ? { conflictMessage } : {}) } : {})
    }
  }

  /**
   * 视觉搜索连签自动补签（秒级轻量完成）
   */
    async runVisualSearchStreak(cookieStr: string, timeoutMs = 8_000): Promise<boolean> {
    const controller = new AbortController()
    const timer = setTimeout(() => { controller.abort(); }, timeoutMs)

    try {
      const res = await this.fetchImpl(
        'https://www.bing.com/?features=vsstreak,vstooltip&form=ML2XES',
        {
          headers: {
            'user-agent': USER_AGENTS.pc,
            cookie: cookieStr,
            referer: 'https://www.bing.com/'
          },
          signal: controller.signal
        }
      )
      return res.ok
    } catch {
      return false
    } finally {
      clearTimeout(timer)
    }
  }
}

export const fastApiEngine = new FastApiEngine()