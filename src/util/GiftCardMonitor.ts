import fs from 'fs'
import path from 'path'
import type { AxiosRequestConfig } from 'axios'

import type { MicrosoftRewardsBot } from '../index'
import type { ConfigGiftCardMonitor } from '../interface/Config'
import { sendDiscord } from '../logging/Discord'
import { sendNtfy } from '../logging/Ntfy'
import { sendPushPlus } from '../logging/PushPlus'
import { sendWeCom } from '../logging/WeCom'

export interface GiftCardItem {
    sku: string
    title: string
    points: number | null
    shortfall: number | null
    url: string
    rawText: string
    available: boolean
    affordable: boolean
    matchedKeywords: string[]
}

export interface GiftCardMonitorResult {
    checked: boolean
    matches: GiftCardItem[]
    notified: GiftCardItem[]
    message: string
}

const DEFAULT_SHOP_URL = 'https://rewards.bing.com/redeem/cn?section=shop'
const UNAVAILABLE_PATTERNS = /(已售罄|无货|缺货|不可用|暂不可|售完|out\s*of\s*stock|sold\s*out|unavailable)/i
const BLOCKED_CATEGORY_PATTERNS = /(抽奖|sweepstakes|捐赠|donat)/i

function cacheFile(): string {
    const logDir = path.join(process.cwd(), 'logs')
    if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true })
    }
    return path.join(logDir, 'gift-card-monitor.json')
}

function readNotifiedSkus(): Set<string> {
    try {
        const raw = JSON.parse(fs.readFileSync(cacheFile(), 'utf8')) as { notifiedSkus?: string[] }
        return new Set(Array.isArray(raw.notifiedSkus) ? raw.notifiedSkus.filter(Boolean) : [])
    } catch {
        return new Set()
    }
}

function saveNotifiedSkus(skus: Set<string>): void {
    fs.writeFileSync(
        cacheFile(),
        JSON.stringify(
            {
                updatedAt: new Date().toISOString(),
                notifiedSkus: [...skus].sort()
            },
            null,
            2
        )
    )
}

function normalizeText(value: string): string {
    return value.replace(/\s+/g, ' ').trim()
}

function htmlToText(html: string): string {
    return normalizeText(
        html
            .replace(/<script[\s\S]*?<\/script>/gi, ' ')
            .replace(/<style[\s\S]*?<\/style>/gi, ' ')
            .replace(/<[^>]+>/g, ' ')
            .replace(/&nbsp;/gi, ' ')
            .replace(/&amp;/gi, '&')
            .replace(/&quot;/gi, '"')
            .replace(/&#x27;|&#39;/gi, "'")
    )
}

function extractSku(href: string): string | null {
    const match = href.match(/\/redeem\/sku\/([^"'?#/]+)/i)
    return match?.[1] ?? null
}

function absoluteUrl(href: string): string {
    try {
        return new URL(href, 'https://rewards.bing.com').toString()
    } catch {
        return href
    }
}

function parsePoints(text: string): { points: number | null; shortfall: number | null } {
    const numbers = [...text.matchAll(/([\d,]+)\s*分/g)]
        .map(match => Number(match[1]?.replace(/,/g, '') ?? NaN))
        .filter(Number.isFinite)
    const shortfallMatch = text.match(/还差\s*([\d,]+)/)

    return {
        points: numbers.length ? Math.max(...numbers) : null,
        shortfall: shortfallMatch?.[1] ? Number(shortfallMatch[1].replace(/,/g, '')) : null
    }
}

function titleFromText(text: string): string {
    const pointIndex = text.search(/[\d,]+\s*分/)
    const title = pointIndex > 0 ? text.slice(0, pointIndex) : text
    return normalizeText(title).slice(0, 80) || '未命名礼品卡'
}

function parseAnchorSegments(html: string): Array<{ href: string; text: string }> {
    const anchors: Array<{ href: string; text: string }> = []
    const anchorPattern = /<a\b[^>]*\bhref=(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi
    let match: RegExpExecArray | null

    while ((match = anchorPattern.exec(html))) {
        const href = match[2] ?? ''
        if (!/\/redeem\/sku\//i.test(href)) continue
        anchors.push({ href: absoluteUrl(href), text: htmlToText(match[3] ?? '') })
    }

    return anchors
}

export function parseGiftCardItems(html: string, keywords: string[], currentPoints: number): GiftCardItem[] {
    const normalizedKeywords = keywords.map(keyword => keyword.trim().toLowerCase()).filter(Boolean)
    const seen = new Set<string>()
    const items: GiftCardItem[] = []

    for (const anchor of parseAnchorSegments(html)) {
        const sku = extractSku(anchor.href)
        const text = normalizeText(anchor.text)
        if (!sku || !text || seen.has(sku)) continue
        if (BLOCKED_CATEGORY_PATTERNS.test(text) || /\/redeem\/sku\/000[579]99036002/i.test(anchor.href)) continue

        const matchedKeywords = normalizedKeywords.filter(keyword => text.toLowerCase().includes(keyword))
        if (normalizedKeywords.length > 0 && matchedKeywords.length === 0) continue

        const { points, shortfall } = parsePoints(text)
        const affordable = shortfall === null && (points === null || currentPoints >= points)
        const available = !UNAVAILABLE_PATTERNS.test(text)

        seen.add(sku)
        items.push({
            sku,
            title: titleFromText(text),
            points,
            shortfall,
            url: anchor.href,
            rawText: text.slice(0, 300),
            available,
            affordable,
            matchedKeywords
        })
    }

    return items
}

function buildNotification(accountEmail: string, items: GiftCardItem[], currentPoints: number): string {
    const lines = [
        'Microsoft Rewards 礼品卡监控：发现可兑换目标',
        `账号：${accountEmail}`,
        `当前积分：${currentPoints}`,
        ''
    ]

    for (const item of items) {
        lines.push(
            `- ${item.title} | ${item.points ?? '未知'} 分 | SKU ${item.sku}`,
            `  ${item.url}`
        )
    }

    return lines.join('\n')
}

async function notify(bot: MicrosoftRewardsBot, content: string): Promise<void> {
    const webhook = bot.config.webhook
    await Promise.allSettled([
        webhook.discord?.enabled && webhook.discord.url
            ? sendDiscord(webhook.discord.url, content, 'info')
            : Promise.resolve(),
        webhook.ntfy?.enabled && webhook.ntfy.url ? sendNtfy(webhook.ntfy, content, 'info') : Promise.resolve(),
        webhook.pushplus?.enabled && webhook.pushplus.token ? sendPushPlus(webhook.pushplus, content) : Promise.resolve(),
        webhook.wecom?.enabled ? sendWeCom(webhook.wecom, content) : Promise.resolve()
    ])
}

export async function monitorGiftCards(
    bot: MicrosoftRewardsBot,
    accountEmail: string,
    currentPoints: number
): Promise<GiftCardMonitorResult> {
    const config = bot.config.giftCardMonitor as ConfigGiftCardMonitor | undefined
    const keywords = config?.keywords?.map(keyword => keyword.trim()).filter(Boolean) ?? []

    if (!config?.enabled) {
        return { checked: false, matches: [], notified: [], message: '礼品卡监控未启用' }
    }

    if (!keywords.length) {
        return { checked: false, matches: [], notified: [], message: '礼品卡监控未设置关键词' }
    }

    const request: AxiosRequestConfig = {
        url: config.shopUrl?.trim() || DEFAULT_SHOP_URL,
        method: 'GET',
        headers: {
            ...(bot.fingerprint?.headers ?? {}),
            Cookie: bot.browser.func.buildCookieHeader(bot.cookies.mobile, [
                'bing.com',
                'live.com',
                'microsoftonline.com'
            ]),
            Referer: 'https://rewards.bing.com/dashboard'
        },
        responseType: 'text',
        transformResponse: data => data
    }

    const response = await bot.axios.request(request)
    const html = typeof response.data === 'string' ? response.data : String(response.data ?? '')
    const matches = parseGiftCardItems(html, keywords, currentPoints)
    const candidates = matches.filter(item => item.available && (!config.requireEnoughPoints || item.affordable))
    const notifiedSkus = config.notifyOnce === false ? new Set<string>() : readNotifiedSkus()
    const notified = candidates.filter(item => !notifiedSkus.has(`${accountEmail}:${item.sku}`))

    if (notified.length > 0) {
        await notify(bot, buildNotification(accountEmail, notified, currentPoints))
        for (const item of notified) {
            notifiedSkus.add(`${accountEmail}:${item.sku}`)
        }
        if (config.notifyOnce !== false) {
            saveNotifiedSkus(notifiedSkus)
        }
    }

    return {
        checked: true,
        matches,
        notified,
        message: `匹配 ${matches.length} 个目标，可通知 ${notified.length} 个`
    }
}
