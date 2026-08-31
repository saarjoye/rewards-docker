const sensitiveQueryParameter =
    /([?&](?:code|access_token|refresh_token|id_token|state|request_token|client_secret|RequestVerificationToken)=)[^&#\s|]*/gi

const sensitiveJsonProperty =
    /(["'](?:code|access_token|refresh_token|id_token|state|request_token|client_secret|RequestVerificationToken|cookie|authorization)["']\s*:\s*)["'][^"']*["']/gi

const sensitiveNamedValue =
    /\b(password|passwd|pwd|token|secret|cookie|authorization|corpsecret|client_secret|RequestVerificationToken)(\s*[:=]\s*)([^\s|,}&]+)/gi

export function sanitizeLogMessage(value: string): string {
    return value
        .replace(sensitiveQueryParameter, '$1[REDACTED]')
        .replace(sensitiveJsonProperty, '$1"[REDACTED]"')
        .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
        .replace(sensitiveNamedValue, '$1$2[REDACTED]')
}

export function safeUrlForLog(rawUrl: string): string {
    try {
        const url = new URL(rawUrl)
        return `${url.origin === 'null' ? `${url.protocol}//` : url.origin}${url.pathname}`
    } catch {
        return 'unavailable'
    }
}
