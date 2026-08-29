import type { DashboardData } from '../interface/DashboardData'

export type DashboardDataSource = 'api' | 'legacy-html' | 'next-flight'

export interface DashboardParseResult {
    data: DashboardData | null
    source: DashboardDataSource | null
    reason: string
}

interface BalancedJson {
    json: string
    end: number
}

const MAX_NODES = 20_000
const MAX_DEPTH = 30
const MAX_EMBEDDED_JSON_LENGTH = 2_000_000

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasFiniteNonNegativeNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

export function validateDashboardData(value: unknown): { valid: true; data: DashboardData } | { valid: false; reason: string } {
    if (!isRecord(value)) return { valid: false, reason: 'dashboard 不是对象' }

    const userStatus = value.userStatus
    if (!isRecord(userStatus)) return { valid: false, reason: '缺少 userStatus' }
    if (!hasFiniteNonNegativeNumber(userStatus.availablePoints)) {
        return { valid: false, reason: 'userStatus.availablePoints 非法' }
    }

    const counters = userStatus.counters
    if (!isRecord(counters)) return { valid: false, reason: '缺少 userStatus.counters' }
    if (!Array.isArray(counters.pcSearch) || !Array.isArray(counters.mobileSearch)) {
        return { valid: false, reason: '搜索 counters 不完整' }
    }
    for (const counter of [...counters.pcSearch, ...counters.mobileSearch]) {
        if (!isRecord(counter)) return { valid: false, reason: '搜索 counter 不是对象' }
        if (!hasFiniteNonNegativeNumber(counter.pointProgress) || !hasFiniteNonNegativeNumber(counter.pointProgressMax)) {
            return { valid: false, reason: '搜索 counter 进度非法' }
        }
        if (counter.pointProgress > counter.pointProgressMax) {
            return { valid: false, reason: '搜索 counter 进度超过上限' }
        }
    }

    if (!isRecord(value.dailySetPromotions)) return { valid: false, reason: '缺少 dailySetPromotions' }
    if (!Object.values(value.dailySetPromotions).every(Array.isArray)) {
        return { valid: false, reason: 'dailySetPromotions 日期项不是数组' }
    }
    for (const field of [
        'promotionalItems',
        'morePromotions',
        'morePromotionsWithoutPromotionalItems',
        'punchCards'
    ]) {
        if (!Array.isArray(value[field])) return { valid: false, reason: `缺少 ${field}` }
        if (!(value[field] as unknown[]).every(isRecord)) return { valid: false, reason: `${field} 包含非法项目` }
    }

    const userProfile = value.userProfile
    if (
        !isRecord(userProfile) ||
        !isRecord(userProfile.attributes) ||
        typeof userProfile.attributes.country !== 'string' ||
        userProfile.attributes.country.trim().length === 0
    ) {
        return { valid: false, reason: '缺少 userProfile.attributes.country' }
    }

    return { valid: true, data: value as unknown as DashboardData }
}

export function dashboardFromApiPayload(payload: unknown): DashboardParseResult {
    if (!isRecord(payload) || !Object.prototype.hasOwnProperty.call(payload, 'dashboard')) {
        return { data: null, source: null, reason: 'API 响应缺少 dashboard 字段' }
    }

    const validation = validateDashboardData(payload.dashboard)
    return validation.valid
        ? { data: validation.data, source: 'api', reason: 'ok' }
        : { data: null, source: null, reason: `API dashboard 校验失败：${validation.reason}` }
}

export function dashboardFromFlightEntries(entries: unknown): DashboardParseResult {
    const roots: unknown[] = []
    collectDecodedValues(entries, roots, 0, new Set<unknown>())
    return findUniqueDashboard(roots, 'next-flight')
}

export function dashboardFromHtml(html: string): DashboardParseResult {
    if (!html) return { data: null, source: null, reason: 'dashboard HTML 为空' }

    const legacy = extractLegacyDashboard(html)
    if (legacy !== null) {
        const validation = validateDashboardData(legacy)
        if (validation.valid) return { data: validation.data, source: 'legacy-html', reason: 'ok' }
    }

    const entries = extractNextFlightPushEntries(html)
    if (entries.length === 0) {
        return {
            data: null,
            source: null,
            reason: legacy === null ? '未找到旧版 dashboard 或 Next.js Flight 数据' : '旧版 dashboard 数据不完整'
        }
    }

    return dashboardFromFlightEntries(entries)
}

function findUniqueDashboard(roots: unknown[], source: DashboardDataSource): DashboardParseResult {
    const candidates: DashboardData[] = []
    const signatures = new Set<string>()
    const visited = new Set<unknown>()
    let nodes = 0

    const visit = (value: unknown, depth: number): void => {
        if (depth > MAX_DEPTH || nodes >= MAX_NODES || value === null || value === undefined) return
        nodes += 1

        if (typeof value === 'object') {
            if (visited.has(value)) return
            visited.add(value)
        }

        const validation = validateDashboardData(value)
        if (validation.valid) {
            const signature = JSON.stringify(validation.data)
            if (!signatures.has(signature)) {
                signatures.add(signature)
                candidates.push(validation.data)
            }
            return
        }

        if (Array.isArray(value)) {
            for (const child of value) visit(child, depth + 1)
        } else if (isRecord(value)) {
            for (const child of Object.values(value)) visit(child, depth + 1)
        }
    }

    for (const root of roots) visit(root, 0)

    if (candidates.length === 1 && candidates[0]) return { data: candidates[0], source, reason: 'ok' }
    if (candidates.length > 1) return { data: null, source: null, reason: '发现多个不一致的合法 dashboard 候选' }
    return { data: null, source: null, reason: 'Next.js Flight 中未找到完整合法的 DashboardData' }
}

function collectDecodedValues(value: unknown, output: unknown[], depth: number, visited: Set<unknown>): void {
    if (depth > MAX_DEPTH || output.length >= MAX_NODES || value === null || value === undefined) return

    if (typeof value === 'string') {
        if (value.length > MAX_EMBEDDED_JSON_LENGTH) return
        output.push(...extractJsonValues(value))
        return
    }

    if (typeof value !== 'object' || visited.has(value)) return
    visited.add(value)
    output.push(value)

    if (Array.isArray(value)) {
        for (const child of value) collectDecodedValues(child, output, depth + 1, visited)
    } else {
        for (const child of Object.values(value as Record<string, unknown>)) {
            collectDecodedValues(child, output, depth + 1, visited)
        }
    }
}

function extractJsonValues(text: string): unknown[] {
    const values: unknown[] = []
    for (let index = 0; index < text.length && values.length < MAX_NODES; index += 1) {
        const char = text[index]
        if (char !== '{' && char !== '[') continue
        const balanced = readBalancedJson(text, index)
        if (!balanced) continue
        try {
            const parsed = JSON.parse(balanced.json) as unknown
            values.push(parsed)
            collectDecodedValues(parsed, values, 0, new Set<unknown>())
            index = balanced.end - 1
        } catch {
            // RSC text can contain non-JSON braces; continue at the next character.
        }
    }
    return values
}

function extractLegacyDashboard(html: string): unknown | null {
    const marker = /\bvar\s+dashboard\s*=\s*/g
    const match = marker.exec(html)
    if (!match) return null
    const start = html.indexOf('{', marker.lastIndex)
    if (start < 0) return null
    const balanced = readBalancedJson(html, start)
    if (!balanced) return null
    try {
        return JSON.parse(balanced.json) as unknown
    } catch {
        return null
    }
}

function extractNextFlightPushEntries(html: string): unknown[] {
    const entries: unknown[] = []
    const marker = 'self.__next_f.push('
    let offset = 0
    while (offset < html.length) {
        const markerIndex = html.indexOf(marker, offset)
        if (markerIndex < 0) break
        const start = html.indexOf('[', markerIndex + marker.length)
        if (start < 0) break
        const balanced = readBalancedJson(html, start)
        if (!balanced) {
            offset = start + 1
            continue
        }
        try {
            entries.push(JSON.parse(balanced.json) as unknown)
        } catch {
            // Ignore malformed push entries and continue looking for the next one.
        }
        offset = balanced.end
    }
    return entries
}

function readBalancedJson(text: string, start: number): BalancedJson | null {
    const opening = text[start]
    if (opening !== '{' && opening !== '[') return null

    const stack: string[] = [opening]
    let inString = false
    let escaped = false
    for (let index = start + 1; index < text.length; index += 1) {
        const char = text[index]
        if (inString) {
            if (escaped) escaped = false
            else if (char === '\\') escaped = true
            else if (char === '"') inString = false
            continue
        }

        if (char === '"') {
            inString = true
            continue
        }
        if (char === '{' || char === '[') stack.push(char)
        else if (char === '}' || char === ']') {
            const expected = char === '}' ? '{' : '['
            if (stack.pop() !== expected) return null
            if (stack.length === 0) return { json: text.slice(start, index + 1), end: index + 1 }
        }
    }
    return null
}
