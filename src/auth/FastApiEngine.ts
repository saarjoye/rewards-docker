import type { AppToken } from '../browser/AppOAuthClient.js'
import { exchangeOAuthRefreshToken } from './SessionImportManager.js'

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


export function hasAuthCookieSignatures(cookieStr: string): boolean {
  if (!cookieStr || typeof cookieStr !== 'string') return false
  const names = cookieStr
    .split(';')
    .map((part) => part.trim().split('=')[0] ?? '')
    .filter(Boolean)
  const hasAuthName = names.some((name) =>
    ['WLS', '.MSA.Auth', 'SRCHUID', 'ANON', 'USRLOC'].includes(name)
  )
  if (!hasAuthName) return false
  const hostArea = /rewards\.bing\.com|bing\.com|live\.com/i
  return /domain=[^;]*(bing\.com|live\.com)/i.test(cookieStr) || hostArea.test(cookieStr)
}

export function cookieItemsToString(cookies: Array<{ name: string; value: string }>): string {
  return cookies.map((c) => `${c.name}=${c.value}`).join('; ')
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
    if (!hasAuthCookieSignatures(trimmed)) {
      return {
        valid: false,
        message: '缺少认证 Cookie：需包含 WLS/.MSA.Auth/SRCHUID/ANON/USRLOC 之一，且 domain 覆盖 bing.com/rewards.bing.com/live.com'
      }
    }

    const controller = new AbortController()
    const timer = setTimeout(() => { controller.abort() }, timeoutMs)

    try {
      const userName = extractNicknameFromCookie(trimmed) ?? ''

      // 仅使用微软官方权威 JSON 接口；不再回退 /earn 抓取猜测余额
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

      if (!userInfoRes.ok) {
        return { valid: false, message: '微软官方接口请求失败（HTTP ' + String(userInfoRes.status) + '），Cookie 未就绪' }
      }

      const contentType = userInfoRes.headers.get('content-type') ?? ''
      if (!contentType.includes('application/json')) {
        return { valid: false, message: 'api/getuserinfo 返回非 JSON（疑似登录页），Cookie 已失效' }
      }

      let data: Record<string, unknown>
      try {
        data = (await userInfoRes.json()) as Record<string, unknown>
      } catch {
        return { valid: false, message: 'api/getuserinfo 返回内容无法解析为 JSON，Cookie 已失效' }
      }

      const userStatus =
        (data.userStatus as Record<string, unknown> | undefined) ??
        ((data.dashboard as Record<string, unknown> | undefined)?.userStatus as Record<string, unknown> | undefined)
      const userInfo =
        (data.userInfo as Record<string, unknown> | undefined) ??
        ((data.dashboard as Record<string, unknown> | undefined)?.userInfo as Record<string, unknown> | undefined)

      const toSafeInt = (raw: unknown): number | undefined => {
        if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0) return raw
        if (typeof raw === 'string') {
          const num = parseInt(raw.replace(/,/g, ''), 10)
          if (Number.isSafeInteger(num) && num >= 0) return num
        }
        return undefined
      }

      // 余额只能来自权威字段：userInfo.balance 或 userStatus.availablePoints。
      // 严禁把 pointsCounters.totalPoints / pc.max / dailyPoint.pointProgress 当成余额。
      const apiBalance = toSafeInt(userInfo?.balance) ?? toSafeInt(userStatus?.availablePoints)

      const counters = userStatus?.counters as Record<string, unknown> | undefined
      const dailyPointRaw = counters?.dailyPoint
      const dp = Array.isArray(dailyPointRaw)
        ? (dailyPointRaw[0] as Record<string, unknown> | undefined)
        : (dailyPointRaw as Record<string, unknown> | undefined)
      const apiTodayPoints = toSafeInt(dp?.pointProgress ?? dp?.progress)

      let apiPcProgress = 0
      let apiPcMax = 60
      if (counters && Array.isArray(counters.pcSearch) && counters.pcSearch[0]) {
        const pc = counters.pcSearch[0] as Record<string, unknown>
        if (typeof pc.pointProgress === 'number') apiPcProgress = pc.pointProgress
        if (typeof pc.pointProgressMax === 'number') apiPcMax = pc.pointProgressMax
      }

      const streakInfo = userStatus?.streakInfo as Record<string, unknown> | undefined
      const rawStreak = streakInfo?.currentStreak ?? userStatus?.currentStreak ?? userStatus?.streakDays
      const apiStreak = typeof rawStreak === 'number' ? rawStreak : 0

      if (apiBalance === undefined) {
        return { valid: false, message: 'api/getuserinfo 未返回可解析余额（userInfo.balance / userStatus.availablePoints），Cookie 未就绪' }
      }

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
        const rawBalance = data.response.balance
        let balance: number | undefined
        if (typeof rawBalance === 'number' && Number.isSafeInteger(rawBalance) && rawBalance >= 0) {
          balance = rawBalance
        } else if (typeof rawBalance === 'string') {
          const num = parseInt(rawBalance.replace(/,/g, ''), 10)
          if (Number.isSafeInteger(num) && num >= 0) balance = num
        }
        if (balance === undefined) {
          return { valid: false, message: '移动端 DAPI 未返回有效余额（balance 缺失或非法）' }
        }
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

    const balance = cookieRes.balance ?? tokenRes.balance ?? 0
    const todayPoints = cookieRes.todayPoints ?? tokenRes.todayPoints
    const nickname =
      cookieRes.userName || (input.cookieStr ? extractNicknameFromCookie(input.cookieStr) : undefined)
    let overallValid = cookieRes.valid || tokenRes.valid

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