import { sanitizeText } from './security.mjs'

function boolEnv(name, fallback = false) {
    const value = process.env[name]
    if (value === undefined) return fallback
    return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())
}

export function normalizeWeComBaseUrl(mode, value) {
    if (mode !== 'custom') return 'https://qyapi.weixin.qq.com'
    let parsed
    try {
        parsed = new URL(String(value || '').trim())
    } catch {
        throw new Error('自定义反代地址格式无效')
    }
    if (
        parsed.protocol !== 'https:' ||
        !parsed.hostname ||
        parsed.username ||
        parsed.password ||
        parsed.search ||
        parsed.hash
    ) {
        throw new Error('自定义反代必须是无账号、查询参数和片段的 HTTPS 地址')
    }
    return parsed.toString().replace(/\/$/, '')
}

function environmentConfig() {
    const mode = process.env.WEB_WECOM_BASE_URL?.trim() ? 'custom' : 'direct'
    return {
        enabled: boolEnv('WEB_WECOM_ENABLED'),
        mode,
        baseUrl: normalizeWeComBaseUrl(mode, process.env.WEB_WECOM_BASE_URL),
        corpId: process.env.WEB_WECOM_CORP_ID?.trim() || '',
        agentId: process.env.WEB_WECOM_AGENT_ID?.trim() || '',
        corpSecret: process.env.WEB_WECOM_CORP_SECRET?.trim() || '',
        toUser: process.env.WEB_WECOM_TO_USER?.trim() || '@all'
    }
}

export class WeComNotifier {
    constructor({ fetchImpl = fetch, settings = null } = {}) {
        this.fetchImpl = fetchImpl
        this.settings = settings
        this.token = null
        this.tokenExpiresAt = 0
        this.lastSuccessAt = null
        this.lastError = null
        this.reload()
    }

    reload() {
        const stored = this.settings?.getWeCom()
        const config = stored || environmentConfig()
        this.enabled = Boolean(config.enabled)
        this.mode = config.mode === 'custom' ? 'custom' : 'direct'
        this.baseUrl = normalizeWeComBaseUrl(this.mode, config.baseUrl)
        this.corpId = String(config.corpId || '').trim()
        this.agentId = String(config.agentId || '').trim()
        this.corpSecret = String(config.corpSecret || '').trim()
        this.toUser = String(config.toUser || '').trim() || '@all'
        this.source = stored ? 'encrypted' : 'environment'
        this.token = null
        this.tokenExpiresAt = 0
    }

    update(input) {
        if (!this.settings) throw new Error('Web 加密配置存储不可用')
        const current = this.settings.getWeCom() || environmentConfig()
        const mode = input.mode === 'custom' ? 'custom' : 'direct'
        const baseUrl = String(input.baseUrl || '').trim() || (current.mode === 'custom' ? current.baseUrl : '')
        const next = {
            enabled: Boolean(input.enabled),
            mode,
            baseUrl: normalizeWeComBaseUrl(mode, baseUrl),
            corpId: String(input.corpId || '').trim() || current.corpId,
            agentId: String(input.agentId || '').trim() || current.agentId,
            corpSecret: input.clearSecret ? '' : String(input.corpSecret || '').trim() || current.corpSecret,
            toUser: String(input.toUser || '').trim() || current.toUser || '@all'
        }
        if (
            next.corpId.length > 128 ||
            next.agentId.length > 64 ||
            next.corpSecret.length > 512 ||
            next.toUser.length > 1024
        ) {
            throw new Error('企业微信配置字段过长')
        }
        this.settings.setWeCom(next)
        this.reload()
        return this.status()
    }

    configured() {
        return this.enabled && Boolean(this.corpId && this.agentId && this.corpSecret && this.toUser)
    }

    status() {
        return {
            enabled: this.enabled,
            configured: this.configured(),
            mode: this.mode,
            source: this.source,
            writable: this.settings?.status().writable ?? false,
            hasCorpId: Boolean(this.corpId),
            hasAgentId: Boolean(this.agentId),
            hasSecret: Boolean(this.corpSecret),
            customBaseConfigured: this.mode === 'custom',
            recipient: this.toUser === '@all' ? '全部成员' : '指定成员',
            lastSuccessAt: this.lastSuccessAt,
            lastError: this.lastError ? sanitizeText(this.lastError, 300) : null
        }
    }

    async accessToken() {
        if (this.token && Date.now() < this.tokenExpiresAt) return this.token
        const url = new URL(`${this.baseUrl}/cgi-bin/gettoken`)
        url.searchParams.set('corpid', this.corpId)
        url.searchParams.set('corpsecret', this.corpSecret)
        const response = await this.fetchImpl(url, { signal: AbortSignal.timeout(10000) })
        const data = await response.json().catch(() => null)
        if (!response.ok || data?.errcode !== 0 || !data?.access_token) {
            throw new Error(`企业微信令牌获取失败（${data?.errcode ?? response.status}）`)
        }
        this.token = data.access_token
        this.tokenExpiresAt = Date.now() + Math.max(60, Number(data.expires_in || 7200) - 300) * 1000
        return this.token
    }

    async sendText(content) {
        if (!this.configured()) return { sent: false, reason: 'not-configured' }
        let lastError
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                const token = await this.accessToken()
                const url = new URL(`${this.baseUrl}/cgi-bin/message/send`)
                url.searchParams.set('access_token', token)
                const response = await this.fetchImpl(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        touser: this.toUser,
                        msgtype: 'text',
                        agentid: Number(this.agentId),
                        text: { content: sanitizeText(content, 1900) },
                        safe: 0
                    }),
                    signal: AbortSignal.timeout(10000)
                })
                const data = await response.json().catch(() => null)
                if (!response.ok || data?.errcode !== 0) {
                    if ([40014, 42001].includes(data?.errcode)) {
                        this.token = null
                        this.tokenExpiresAt = 0
                    }
                    throw new Error(`企业微信发送失败（${data?.errcode ?? response.status}）`)
                }
                this.lastSuccessAt = new Date().toISOString()
                this.lastError = null
                return { sent: true }
            } catch (error) {
                lastError = error
                if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 500 * 2 ** attempt))
            }
        }
        this.lastError = lastError instanceof Error ? lastError.message : String(lastError)
        throw lastError
    }

    async sendRun(run) {
        const status = run.status === 'completed' ? '完成' : run.status === 'partial' ? '部分完成' : '失败'
        const lines = [
            `Microsoft Rewards 任务${status}`,
            `时间：${run.endedAt}`,
            `本次积分：+${run.collected}`,
            `账号数：${run.accounts.length}`
        ]
        for (const account of run.accounts) {
            const accountStatus = account.success === true ? '完成' : account.success === false ? '失败' : '待确认'
            lines.push(`${account.label}：+${account.collected}，${accountStatus}`)
        }
        return this.sendText(lines.join('\n'))
    }

    sendCoreOffline(since) {
        return this.sendText(`Microsoft Rewards 核心接口连续不可用\n开始时间：${since}\n请检查核心容器健康状态。`)
    }

    sendTest() {
        return this.sendText(`Microsoft Rewards 企业微信通知测试\n时间：${new Date().toISOString()}\n配置连接正常。`)
    }
}
