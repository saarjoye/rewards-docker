export function stripAnsi(value: string): string {
    return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
}

export function readableLogSnippet(line: string): string {
    const cleaned = stripAnsi(line).replace(/\r?\n/g, ' ')
    const chars = [...cleaned]
    const badCount = chars.filter(char => {
        const code = char.charCodeAt(0)
        return (code >= 0 && code < 9) || (code > 13 && code < 32) || code === 65533
    }).length
    if (cleaned.length > 0 && badCount / cleaned.length > 0.05) {
        return `<binary-like log line omitted | chars=${cleaned.length}>`
    }
    return cleaned
        .replace(/[^\x09\x20-\x7E\u4E00-\u9FFF，。！？、；：“”‘’（）《》【】]/g, '�')
        .slice(0, 1200)
}

export function formatLogTimestamp(date = new Date()): string {
    const h = String(date.getHours()).padStart(2, '0')
    const m = String(date.getMinutes()).padStart(2, '0')
    const s = String(date.getSeconds()).padStart(2, '0')
    return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}, ${h}:${m}:${s}`
}

export function parseExistingLogTimestamp(line: string): { date: Date; rest: string } | null {
    const iso = line.match(/^\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)\]\s*(.*)$/)
    if (iso?.[1]) {
        const date = new Date(iso[1])
        if (Number.isFinite(date.getTime())) return { date, rest: iso[2] ?? '' }
    }

    const bracketedLocal = line.match(
        /^\[(\d{4})-(\d{1,2})-(\d{1,2}),\s*(\d{1,2}):(\d{2}):(\d{2})\]\s*(.*)$/
    )
    if (bracketedLocal) {
        const date = new Date(
            Number(bracketedLocal[1]),
            Number(bracketedLocal[2]) - 1,
            Number(bracketedLocal[3]),
            Number(bracketedLocal[4]),
            Number(bracketedLocal[5]),
            Number(bracketedLocal[6])
        )
        if (Number.isFinite(date.getTime())) return { date, rest: bracketedLocal[7] ?? '' }
    }

    const usLocal = line.match(
        /^\[(\d{1,2})\/(\d{1,2})\/(\d{4}),\s*(\d{1,2}):(\d{2}):(\d{2})\s*(AM|PM)?\]\s*(.*)$/i
    )
    if (usLocal) {
        let hour = Number(usLocal[4])
        const meridiem = usLocal[7]?.toUpperCase()
        if (meridiem === 'PM' && hour < 12) hour += 12
        if (meridiem === 'AM' && hour === 12) hour = 0
        const date = new Date(Number(usLocal[3]), Number(usLocal[1]) - 1, Number(usLocal[2]), hour, Number(usLocal[5]), Number(usLocal[6]))
        if (Number.isFinite(date.getTime())) return { date, rest: usLocal[8] ?? '' }
    }

    const shellLocal = line.match(
        /^\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+([A-Za-z]{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+[A-Z]{2,5}\s+(\d{4})\]\s*(.*)$/i
    )
    if (shellLocal) {
        const month = monthIndex(shellLocal[1] ?? '')
        if (month >= 0) {
            const date = new Date(
                Number(shellLocal[6]),
                month,
                Number(shellLocal[2]),
                Number(shellLocal[3]),
                Number(shellLocal[4]),
                Number(shellLocal[5])
            )
            if (Number.isFinite(date.getTime())) return { date, rest: shellLocal[7] ?? '' }
        }
    }

    return null
}

export function stampLogLine(line: string, fallbackDate = new Date()): string {
    let rest = line.trim()
    let date = fallbackDate
    let extracted = false

    while (rest.length > 0) {
        const parsed = parseExistingLogTimestamp(rest)
        if (!parsed) break

        if (!extracted) {
            date = parsed.date
            extracted = true
        }
        rest = parsed.rest.trim()
    }

    return `[${formatLogTimestamp(date)}] ${rest}`
}

function monthIndex(value: string): number {
    return ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(
        value.toLowerCase()
    )
}
