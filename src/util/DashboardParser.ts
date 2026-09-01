import type { DashboardData, DashboardFieldAvailability, DashboardFieldStatus } from '../interface/DashboardData'

export type DashboardDataSource = 'api' | 'legacy-html' | 'next-flight' | 'bing-flyout'

export interface DashboardParseResult {
    data: DashboardData | null
    source: DashboardDataSource | null
    reason: string
    flightEntryCount?: number
}

export interface DashboardValidationOptions {
    geoLocale?: string
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

function fieldStatus(value: unknown, valid: (candidate: unknown) => boolean): DashboardFieldStatus {
    if (value === undefined || value === null) return 'missing'
    return valid(value) ? 'available' : 'invalid'
}

function searchFieldStatus(value: unknown): DashboardFieldStatus {
    if (value === undefined || value === null) return 'missing'
    if (Array.isArray(value) && value.length === 0) return 'empty'
    return validSearchCounterArray(value) ? 'available' : 'invalid'
}

function validRecordArray(value: unknown): value is Record<string, unknown>[] {
    return Array.isArray(value) && value.every(isRecord)
}

function validSearchCounterArray(value: unknown): boolean {
    if (!Array.isArray(value)) return false
    return value.every(counter => {
        if (!isRecord(counter)) return false
        if (
            !hasFiniteNonNegativeNumber(counter.pointProgress) ||
            !hasFiniteNonNegativeNumber(counter.pointProgressMax)
        ) {
            return false
        }
        return counter.pointProgress <= counter.pointProgressMax
    })
}

function fallbackCountry(geoLocale: string | undefined): string {
    const candidate = geoLocale?.trim()
    return candidate && candidate.toLowerCase() !== 'auto' ? candidate.toLowerCase() : 'unknown'
}

export function validateDashboardData(
    value: unknown,
    options: DashboardValidationOptions = {}
): { valid: true; data: DashboardData } | { valid: false; reason: string } {
    if (!isRecord(value)) return { valid: false, reason: 'dashboard 不是对象' }

    const userStatus = value.userStatus
    if (!isRecord(userStatus)) return { valid: false, reason: '缺少 userStatus' }
    if (!hasFiniteNonNegativeNumber(userStatus.availablePoints)) {
        return { valid: false, reason: 'userStatus.availablePoints 非法' }
    }

    const counters = userStatus.counters
    if (!isRecord(counters)) return { valid: false, reason: '缺少 userStatus.counters' }

    const userProfile = value.userProfile
    const attributes = isRecord(userProfile) && isRecord(userProfile.attributes) ? userProfile.attributes : {}
    const countryValue = attributes.country
    const countryAvailable = typeof countryValue === 'string' && countryValue.trim().length > 0

    const availability: DashboardFieldAvailability = {
        pcSearch: searchFieldStatus(counters.pcSearch),
        mobileSearch: searchFieldStatus(counters.mobileSearch),
        dailySetPromotions: fieldStatus(
            value.dailySetPromotions,
            candidate => isRecord(candidate) && Object.values(candidate).every(items => validRecordArray(items))
        ),
        promotionalItems: fieldStatus(value.promotionalItems, validRecordArray),
        morePromotions: fieldStatus(value.morePromotions, validRecordArray),
        morePromotionsWithoutPromotionalItems: fieldStatus(
            value.morePromotionsWithoutPromotionalItems,
            validRecordArray
        ),
        punchCards: fieldStatus(value.punchCards, validRecordArray),
        country: countryAvailable ? 'available' : countryValue === undefined ? 'fallback' : 'invalid'
    }

    const normalized = {
        ...value,
        dashboardFieldAvailability: availability,
        userStatus: {
            ...userStatus,
            counters: {
                ...counters,
                pcSearch: availability.pcSearch === 'available' ? counters.pcSearch : [],
                mobileSearch: availability.mobileSearch === 'available' ? counters.mobileSearch : []
            }
        },
        dailySetPromotions: availability.dailySetPromotions === 'available' ? value.dailySetPromotions : {},
        promotionalItems: availability.promotionalItems === 'available' ? value.promotionalItems : [],
        morePromotions: availability.morePromotions === 'available' ? value.morePromotions : [],
        morePromotionsWithoutPromotionalItems:
            availability.morePromotionsWithoutPromotionalItems === 'available'
                ? value.morePromotionsWithoutPromotionalItems
                : [],
        punchCards: availability.punchCards === 'available' ? value.punchCards : [],
        userProfile: {
            ...(isRecord(userProfile) ? userProfile : {}),
            attributes: {
                ...attributes,
                country: countryAvailable ? countryValue.trim() : fallbackCountry(options.geoLocale)
            }
        }
    }

    return { valid: true, data: normalized as unknown as DashboardData }
}

export function dashboardFromApiPayload(
    payload: unknown,
    options: DashboardValidationOptions = {}
): DashboardParseResult {
    if (!isRecord(payload) || !Object.prototype.hasOwnProperty.call(payload, 'dashboard')) {
        return { data: null, source: null, reason: 'API 响应缺少 dashboard 字段' }
    }

    const validation = validateDashboardData(payload.dashboard, options)
    return validation.valid
        ? { data: validation.data, source: 'api', reason: 'ok' }
        : { data: null, source: null, reason: `API dashboard 校验失败：${validation.reason}` }
}

export function dashboardFromFlyoutPayload(
    payload: unknown,
    options: DashboardValidationOptions = {}
): DashboardParseResult {
    if (!isRecord(payload)) {
        return { data: null, source: null, reason: 'Bing flyout 响应不是对象' }
    }
    if (payload.isError === true) {
        return { data: null, source: null, reason: 'Bing flyout 返回错误状态' }
    }

    const userInfo = payload.userInfo
    const flyout = payload.flyoutResult
    if (!isRecord(userInfo) || !isRecord(flyout)) {
        return { data: null, source: null, reason: 'Bing flyout 缺少用户或活动数据' }
    }

    const flyoutStatus = flyout.userStatus
    if (!isRecord(flyoutStatus)) {
        return { data: null, source: null, reason: 'Bing flyout 缺少 userStatus' }
    }
    const rewardsUser =
        payload.isRewardsUser === true || userInfo.isRewardsUser === true || flyoutStatus.isRewardsUser === true
    if (!rewardsUser) {
        return { data: null, source: null, reason: 'Bing flyout 未确认 Rewards 用户状态' }
    }

    const availablePoints = hasFiniteNonNegativeNumber(flyoutStatus.availablePoints)
        ? flyoutStatus.availablePoints
        : userInfo.balance
    const sourceCounters = isRecord(flyoutStatus.counters) ? flyoutStatus.counters : {}
    const highValuePromotions = recordArrays(flyout, ['highValueActionPromotions'])
    const additionalPromotions = recordArrays(flyout, [
        'edgeHighValueActionPromotions',
        'exploreOnBingPromotions',
        'exploreOnOutlookPromotions',
        'onboardingChecklistPromotions'
    ])
    const promotionalItems =
        highValuePromotions === undefined && additionalPromotions === undefined
            ? undefined
            : uniqueRecords([...(highValuePromotions ?? []), ...(additionalPromotions ?? [])])
    const profile = isRecord(userInfo.profile) ? userInfo.profile : flyout.profile

    const candidate = {
        ...flyout,
        userStatus: {
            ...flyoutStatus,
            availablePoints,
            counters: {
                ...sourceCounters,
                pcSearch: sourceCounters.pcSearch ?? sourceCounters.PCSearch,
                mobileSearch: sourceCounters.mobileSearch ?? sourceCounters.MobileSearch,
                activityAndQuiz: sourceCounters.activityAndQuiz ?? sourceCounters.ActivityAndQuiz,
                dailyPoint: sourceCounters.dailyPoint ?? sourceCounters.DailyPoint
            }
        },
        userWarnings: [],
        promotionalItem: highValuePromotions?.[0],
        promotionalItems,
        dailySetPromotions: flyout.dailySetPromotions,
        morePromotions: flyout.morePromotions,
        morePromotionsWithoutPromotionalItems: Array.isArray(flyout.morePromotions) ? [] : undefined,
        punchCards: flyout.punchCards,
        componentImpressionPromotions: flyout.impressionPromotions,
        userProfile: profile
    }

    const validation = validateDashboardData(candidate, options)
    return validation.valid
        ? { data: validation.data, source: 'bing-flyout', reason: 'ok' }
        : { data: null, source: null, reason: `Bing flyout dashboard 校验失败：${validation.reason}` }
}

export function dashboardFromFlightEntries(
    entries: unknown,
    options: DashboardValidationOptions = {}
): DashboardParseResult {
    const roots: unknown[] = []
    collectDecodedValues(entries, roots, 0, new Set<unknown>())
    return findUniqueDashboard(roots, 'next-flight', options)
}

export function dashboardFromHtml(html: string, options: DashboardValidationOptions = {}): DashboardParseResult {
    if (!html) return { data: null, source: null, reason: 'dashboard HTML 为空' }

    const legacy = extractLegacyDashboard(html)
    if (legacy !== null) {
        const validation = validateDashboardData(legacy, options)
        if (validation.valid) return { data: validation.data, source: 'legacy-html', reason: 'ok', flightEntryCount: 0 }
    }

    const entries = extractNextFlightPushEntries(html)
    if (entries.length === 0) {
        return {
            data: null,
            source: null,
            reason: legacy === null ? '未找到旧版 dashboard 或 Next.js Flight 数据' : '旧版 dashboard 核心数据不完整',
            flightEntryCount: 0
        }
    }

    return { ...dashboardFromFlightEntries(entries, options), flightEntryCount: entries.length }
}

function findUniqueDashboard(
    roots: unknown[],
    source: DashboardDataSource,
    options: DashboardValidationOptions
): DashboardParseResult {
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

        const validation = validateDashboardData(value, options)
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
    return { data: null, source: null, reason: 'Next.js Flight 中未找到核心字段合法的 DashboardData' }
}

function recordArrays(record: Record<string, unknown>, keys: string[]): Record<string, unknown>[] | undefined {
    const values = keys.map(key => record[key]).filter(value => value !== undefined)
    if (values.length === 0) return undefined
    if (!values.every(validRecordArray)) return undefined
    return values.flatMap(value => value as Record<string, unknown>[])
}

function uniqueRecords(records: Record<string, unknown>[]): Record<string, unknown>[] {
    const seen = new Set<string>()
    return records.filter((record, index) => {
        const identifier =
            typeof record.offerId === 'string'
                ? `offer:${record.offerId}`
                : typeof record.hash === 'string'
                  ? `hash:${record.hash}`
                  : `index:${index}`
        if (seen.has(identifier)) return false
        seen.add(identifier)
        return true
    })
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
