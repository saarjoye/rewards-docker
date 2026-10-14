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
  userName?: string
  streakDays?: number
  stamps?: { progress: number; max: number }
  pcSearch?: string
  message: string
}

export interface TokenStatusResult {
  valid: boolean
  balance?: number
  readProgress?: string
  message: string
  refreshedToken?: AppToken
}

export interface HealthCheckResult {
  accountId: string
  overallValid: boolean
  balance: number
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
    const timer = setTimeout(() => { controller.abort(); }, timeoutMs)

    try {
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
      const clean = rawHtml.replace(/\\"/g, '"')
      const isAuthValid =
        clean.includes('pointsCounters') ||
        clean.includes('pointsHistory') ||
        clean.includes('activityCards')

      if (isAuthValid) {
        let balance = 0
        let pcProgress = 0
        let pcMax = 60
        let streakDays = 0
        const userName = extractNicknameFromCookie(trimmed) ?? ''

        // 提取 PC 搜索配额与 pointsCounters 内部结构
        const pcIdx = clean.indexOf('"pointsCounters"')
        if (pcIdx !== -1) {
          const braceIdx = clean.indexOf('{', pcIdx)
          if (braceIdx !== -1) {
            let depth = 0
            let end = braceIdx
            for (let i = braceIdx; i < clean.length && i < braceIdx + 1000; i++) {
              if (clean[i] === '{') depth++
              else if (clean[i] === '}') {
                depth--
                if (depth === 0) {
                  end = i + 1
                  break
                }
              }
            }
            try {
              const pts = JSON.parse(clean.substring(braceIdx, end)) as {
                pc?: { max?: number; progress?: number }
                totalPoints?: number
                balance?: number
              }
              pcMax = pts.pc?.max ?? 60
              pcProgress = pts.pc?.progress ?? 0
              if (pts.totalPoints != null) balance = pts.totalPoints
              else if (pts.balance != null) balance = pts.balance
            } catch {
              // ignore JSON parse
            }
          }
        }

        // 提取余额
        if (balance === 0) {
          const balMatch =
            clean.match(/"totalPoints":(\d+)/) ||
            clean.match(/"balance":(\d+)/) ||
            clean.match(/"availablePoints":(\d+)/) ||
            trimmed.match(/rc=(\d+)/) ||
            trimmed.match(/rb=(\d+)/)
          if (balMatch && balMatch[1]) {
            balance = parseInt(balMatch[1], 10)
          }
        }

        // 提取连续签到
        const cleanText = clean.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ')
        const streakMatch = cleanText.match(/每日连续打卡\s*(\d+)/)
        if (streakMatch && streakMatch[1]) {
          streakDays = parseInt(streakMatch[1], 10)
        }

        // 提取印章进度
        let stampsProgress = 0
        let stampsMax = 12
        const stampMatch =
          clean.match(/"aria-label":"收集的印章[^}]*?"aria-valuemax":(\d+)[^}]*?"aria-valuenow":(\d+)/) ||
          clean.match(/aria-label="收集的印章[^>]*?aria-valuemax="(\d+)"[^>]*?aria-valuenow="(\d+)"/)
        if (stampMatch && stampMatch[1] && stampMatch[2]) {
          stampsMax = parseInt(stampMatch[1], 10) || 12
          stampsProgress = parseInt(stampMatch[2], 10) || 0
        }

        return {
          valid: true,
          balance,
          userName,
          streakDays,
          stamps: { progress: stampsProgress, max: stampsMax },
          pcSearch: `${String(pcProgress)}/${String(pcMax)}`,
          message: `网页端在线 | 积分: ${String(balance)} | 连签: ${String(streakDays)}天 | 搜索: ${String(pcProgress)}/${String(pcMax)}`
        }
      }

      if (clean.includes('login.live.com') || clean.includes('Sign in')) {
        return { valid: false, message: 'Cookie 已过期，页面重定向至微软登录页' }
      }

      return { valid: false, message: '未能识别微软 Rewards 登录态，请检查 Cookie 是否完整' }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      return { valid: false, message: `网页端请求异常: ${msg}` }
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

        return {
          valid: true,
          balance,
          readProgress: readProg,
          message: `移动端在线 | 积分: ${String(balance)} | 阅读进度: ${readProg}`,
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

    const balance = cookieRes.balance || tokenRes.balance || 0
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
      conflictMessage = `双轨凭据冲突：Cookie 余额 (${String(cookieRes.balance)}) 与 App Token 余额 (${String(tokenRes.balance)}) 偏差过大，可能绑定了不同账号！`
    }

    return {
      accountId: input.accountId,
      overallValid,
      balance,
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