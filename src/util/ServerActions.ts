export type ServerActionName = 'toggleStreakProtection' | 'claimBonusPoints'

export interface ServerActionRuntimeInfo {
    deploymentId: string | null
    hashes: Partial<Record<ServerActionName, string>>
    diagnostics: Partial<Record<ServerActionName, ServerActionHashDiagnostic>>
    scriptUrls: string[]
}

export interface ServerActionHashDiagnostic {
    candidateCount: number
    unique: boolean
    reason: 'unique' | 'no-candidate' | 'ambiguous'
}

export const LAST_KNOWN_SERVER_ACTION_DEPLOYMENT_ID = '20260612-3'

export const FALLBACK_SERVER_ACTION_HASHES: Record<ServerActionName, string> = {
    toggleStreakProtection: '40eddd39784c87de1e9c077e72117f3ed9a016a2d2',
    claimBonusPoints: '00cf5ba7699f0e920ffcff223f9e48fea78fd49784'
}

const ACTION_KEYWORDS: Record<ServerActionName, string[]> = {
    toggleStreakProtection: [
        'toggleStreakProtection',
        'streakProtection',
        'toggleStreak',
        'togglestreak',
        'streak protection',
        'streak',
        '连击保护',
        '连击',
        '保护'
    ],
    claimBonusPoints: [
        'claimBonusPoints',
        'claimAllPoints',
        'claimallpoints',
        'claimBonus',
        'bonusPoints',
        'bonus points',
        'claim points',
        'claim',
        'bonus',
        '领取奖励',
        '领取积分',
        '奖励积分',
        '奖励'
    ]
}

const DIRECT_ACTION_NAMES: Record<ServerActionName, string[]> = {
    toggleStreakProtection: ['toggleStreakProtection'],
    claimBonusPoints: ['claimBonusPoints', 'claimAllPoints']
}

const HASH_PATTERN = /[a-f0-9]{40,64}/gi

export interface ServerActionSource {
    name: string
    content: string
}

interface ActionCandidate {
    action: ServerActionName
    hash: string
    score: number
}

export function extractDeploymentIdFromHtml(html: string): string | null {
    const match = html.match(/(?:[?&]dpl=|["']deploymentId["']\s*:\s*["'])([0-9]{8}-[0-9]+)/i)
    return match?.[1] ?? null
}

export function extractScriptUrls(html: string, baseUrl = 'https://rewards.bing.com/dashboard'): string[] {
    const urls = new Set<string>()
    const scriptPattern = /<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi
    let match: RegExpExecArray | null

    while ((match = scriptPattern.exec(html))) {
        const src = match[1]
        if (!src || !/\.js(?:\?|$)/i.test(src)) continue

        try {
            const url = new URL(src, baseUrl)
            if (url.hostname.endsWith('rewards.bing.com') || url.pathname.includes('/_next/static/')) {
                urls.add(url.toString())
            }
        } catch {
            // Ignore malformed script URLs from the page.
        }
    }

    return [...urls]
}

export function extractServerActionHashesFromSources(
    sources: ServerActionSource[]
): Partial<Record<ServerActionName, string>> {
    return extractServerActionHashResultFromSources(sources).hashes
}

export function extractServerActionHashResultFromSources(sources: ServerActionSource[]): {
    hashes: Partial<Record<ServerActionName, string>>
    diagnostics: Partial<Record<ServerActionName, ServerActionHashDiagnostic>>
} {
    const candidates: ActionCandidate[] = []

    for (const source of sources) {
        for (const action of Object.keys(ACTION_KEYWORDS) as ServerActionName[]) {
            candidates.push(...findActionCandidates(source, action))
        }
    }

    const result: Partial<Record<ServerActionName, string>> = {}
    const diagnostics: Partial<Record<ServerActionName, ServerActionHashDiagnostic>> = {}
    for (const action of Object.keys(ACTION_KEYWORDS) as ServerActionName[]) {
        const directHashes = new Set(sources.flatMap(source => findDirectActionHashes(source.content, action)))
        const uniqueHashes = directHashes.size > 0
            ? directHashes
            : new Set(candidates.filter(candidate => candidate.action === action).map(candidate => candidate.hash))

        if (uniqueHashes.size === 1) {
            result[action] = [...uniqueHashes][0]
            diagnostics[action] = { candidateCount: 1, unique: true, reason: 'unique' }
        } else if (uniqueHashes.size > 1) {
            diagnostics[action] = { candidateCount: uniqueHashes.size, unique: false, reason: 'ambiguous' }
        } else {
            diagnostics[action] = { candidateCount: 0, unique: false, reason: 'no-candidate' }
        }
    }

    return { hashes: result, diagnostics }
}

function findActionCandidates(source: ServerActionSource, action: ServerActionName): ActionCandidate[] {
    const content = source.content
    if (!content) return []

    const lower = content.toLowerCase()
    const candidates: ActionCandidate[] = []

    for (const keyword of ACTION_KEYWORDS[action]) {
        const needle = keyword.toLowerCase()
        let keywordIndex = lower.indexOf(needle)

        while (keywordIndex >= 0) {
            const windowStart = Math.max(0, keywordIndex - 4500)
            const windowEnd = Math.min(content.length, keywordIndex + needle.length + 4500)
            const context = content.slice(windowStart, windowEnd)
            const contextLower = context.toLowerCase()
            const localKeywordIndex = keywordIndex - windowStart
            const hashes = collectHashes(context)

            for (const hash of hashes) {
                const hashIndex = contextLower.indexOf(hash.toLowerCase())
                if (hashIndex < 0) continue

                let score = 10000 - Math.abs(hashIndex - localKeywordIndex)
                if (hasServerActionMarker(context, hashIndex)) score += 2500
                if (source.name === 'dashboard-html') score += 500
                if (keyword.length >= 8) score += 250

                candidates.push({ action, hash, score })
            }

            keywordIndex = lower.indexOf(needle, keywordIndex + needle.length)
        }
    }

    return dedupeCandidates(candidates)
}

function findDirectActionHashes(content: string, action: ServerActionName): string[] {
    const hashes = new Set<string>()

    for (const keyword of DIRECT_ACTION_NAMES[action]) {
        const escapedKeyword = escapeRegExp(keyword)
        const beforePattern = new RegExp(
            `${escapedKeyword}[\\s\\S]{0,240}?createServerReference\\(\\s*["'](${HASH_PATTERN.source})["']`,
            'gi'
        )

        let beforeMatch: RegExpExecArray | null
        while ((beforeMatch = beforePattern.exec(content))) {
            if (beforeMatch[1]) hashes.add(beforeMatch[1].toLowerCase())
        }
    }

    return [...hashes]
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function collectHashes(text: string): string[] {
    const hashes = new Set<string>()
    let match: RegExpExecArray | null

    while ((match = HASH_PATTERN.exec(text))) {
        const hash = match[0].toLowerCase()
        if (hash.length >= 40) hashes.add(hash)
    }

    return [...hashes]
}

function hasServerActionMarker(context: string, hashIndex: number): boolean {
    const before = context.slice(Math.max(0, hashIndex - 120), hashIndex).toLowerCase()
    const after = context.slice(hashIndex, Math.min(context.length, hashIndex + 120)).toLowerCase()
    return (
        before.includes('createserverreference') ||
        before.includes('$action_id_') ||
        before.includes('next-action') ||
        after.includes('createserverreference') ||
        after.includes('$action_id_') ||
        after.includes('next-action')
    )
}

function dedupeCandidates(candidates: ActionCandidate[]): ActionCandidate[] {
    const bestByHash = new Map<string, ActionCandidate>()

    for (const candidate of candidates) {
        const existing = bestByHash.get(candidate.hash)
        if (!existing || candidate.score > existing.score) {
            bestByHash.set(candidate.hash, candidate)
        }
    }

    return [...bestByHash.values()]
}
