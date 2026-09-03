import { sanitizeText } from './security.mjs'

function boolEnv(name, fallback = false) {
    const value = process.env[name]
    if (value === undefined) return fallback
    return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())
}

export class WeComNotifier {
    constructor({ fetchImpl = fetch } = {}) {
        this.fetchImpl = fetchImpl
        this.enabled = boolEnv('WEB_WECOM_ENABLED')
        this.corpId = process.env.WEB_WECOM_CORP_ID?.trim() || ''
        this.agentId = process.env.WEB_WECOM_AGENT_ID?.trim() || ''
        this.corpSecret = process.env.WEB_WECOM_CORP_SECRET?.trim() || ''
        this.toUser = process.env.WEB_WECOM_TO_USER?.trim() || '@all'
        this.token = null
        this.tokenExpiresAt = 0
        this.lastSuccessAt = null
        this.lastError = null
    }

    configured() {
        return this.enabled && Boolean(this.corpId && this.agentId && this.corpSecret && this.toUser)
    }

    status() {
        return {
            enabled: this.enabled,
            configured: this.configured(),
            recipient: this.toUser === '@all' ? '全部成员' : '指定成员',
            lastSuccessAt: this.lastSuccessAt,
            lastError: this.lastError ? sanitizeText(this.lastError, 300) : null
        }
    }

    async accessToken() {
        if (this.token && Date.now() < this.tokenExpiresAt) return this.token
        const url = new URL('https://qyapi.weixin.qq.com/cgi-bin/gettoken')
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
                const url = new URL('https://qyapi.weixin.qq.com/cgi-bin/message/send')
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
}
