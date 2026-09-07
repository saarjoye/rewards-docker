import { businessDate } from './BusinessDate'

export const CHECK_IN_CHANNEL = 'SAIOS'
export const CHECK_IN_OFFER = 'Gamification_Sapphire_DailyCheckIn'

export function checkInState(attrs: Record<string, unknown>, now = new Date()) {
    const raw = attrs.last_updated
    let day: string | null = null
    if (typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw)) {
        const parsed = new Date(raw)
        if (Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === raw) day = raw
    } else if (typeof raw === 'string' && /T.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw)) {
        const parsed = new Date(raw)
        if (Number.isFinite(parsed.getTime())) day = businessDate(parsed)
    }
    const today = businessDate(now)
    const completed = day === null || day > today ? null : day === today
    const numeric = (value: unknown): number | null => {
        if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return null
        const number = Number(value)
        return Number.isFinite(number) && number >= 0 ? number : null
    }
    const progress = numeric(attrs.progress)
    const expected =
        progress !== null && Number.isInteger(progress) ? numeric(attrs[`day_${(progress % 7) + 1}_points`]) : null
    return { completed, expected: completed === true ? 0 : expected }
}

export function validateAppResult(payload: unknown): void {
    const code = payload && typeof payload === 'object' ? (payload as { code?: unknown }).code : undefined
    if (code === 0) return
    // Never include the response body or server-provided text in errors.
    if (typeof code === 'number' && Number.isSafeInteger(code)) throw new Error(`App 业务请求失败，结果码 ${code}`)
    throw new Error('App 响应缺少有效业务结果码，无法确认请求被接受')
}
