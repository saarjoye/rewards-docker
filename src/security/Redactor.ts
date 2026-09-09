const SENSITIVE_KEYS = new Set([
  'code',
  'access_token',
  'refresh_token',
  'id_token',
  'state',
  'requestverificationtoken',
  'authorization',
  'cookie',
  'password',
  'session'
])

export function maskEmail(value: string): string {
  const separator = value.indexOf('@')
  if (separator <= 0) return '[redacted-account]'
  const local = value.slice(0, separator)
  const domain = value.slice(separator + 1)
  const visible = local.slice(0, Math.min(2, local.length))
  return `${visible}***@${domain}`
}

export function sanitizeUrl(value: string): string {
  try {
    const url = new URL(value)
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_KEYS.has(key.toLowerCase())) url.searchParams.set(key, '[redacted]')
    }
    return url.toString()
  } catch {
    return '[invalid-url]'
  }
}

export function safePath(value: string): string {
  try {
    const url = new URL(value)
    return `${url.origin}${url.pathname}`
  } catch {
    return '[invalid-url]'
  }
}

export function redactText(value: string): string {
  return value
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, (match) => maskEmail(match))
    .replace(
      /\b(code|access_token|refresh_token|id_token|state|RequestVerificationToken)\s*[:=]\s*([^\s&,;]+)/gi,
      '$1=[redacted]'
    )
    .replace(
      /\bauthorization\s*[:=]\s*(?:(?:Bearer|Basic)\s+)?([^\s,;]+)/gi,
      'authorization=[redacted]'
    )
    .replace(/\b(cookie|password|session)\s*[:=]\s*([^\s,;]+)/gi, '$1=[redacted]')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [redacted]')
    .replace(
      /(正确的(?:备用|备选|恢复)?电子邮件(?:地址)?应以)\s*[“"'‘]?[^”"'’\s。,.]{1,16}[”"'’]?\s*(开头)/g,
      '$1“[redacted-proof]”$2'
    )
    .replace(
      /((?:correct|alternate|recovery) email(?: address)? (?:should )?starts? with)\s*["“']?[A-Za-z0-9._+-]{1,16}["”']?/gi,
      '$1 [redacted-proof]'
    )
}

export function redactRecord(input: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).map(([key, value]) => {
      if (SENSITIVE_KEYS.has(key.toLowerCase())) return [key, '[redacted]']
      if (typeof value === 'string') return [key, redactText(value)]
      return [key, value]
    })
  )
}
