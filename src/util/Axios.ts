import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios'
import axiosRetry from 'axios-retry'
import { HttpProxyAgent } from 'http-proxy-agent'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { SocksProxyAgent } from 'socks-proxy-agent'
import { URL } from 'url'
import type { AccountProxy } from '../interface/Account'
import type { DashboardFailureKind } from './DashboardError'

export interface SafeHttpDiagnostic {
    status: number | null
    code: string | null
    contentType: string | null
    topLevelFields: string[]
    category: DashboardFailureKind
    finalUrl: string | null
    redirected: boolean | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function safeHttpUrl(rawUrl: unknown): string | null {
    if (typeof rawUrl !== 'string') return null
    try {
        const url = new URL(rawUrl)
        return `${url.origin}${url.pathname}`.slice(0, 300)
    } catch {
        return null
    }
}

export function axiosFinalUrl(value: unknown): string | null {
    if (!isRecord(value)) return null
    const request = isRecord(value.request) ? value.request : null
    const response = isRecord(value.response) ? value.response : null
    const nestedRequest = response && isRecord(response.request) ? response.request : request
    const nestedResponse = nestedRequest && isRecord(nestedRequest.res) ? nestedRequest.res : null
    return safeHttpUrl(nestedRequest?.responseURL ?? nestedResponse?.responseUrl)
}

export function axiosRedirected(value: unknown, originalUrl: string): boolean | null {
    const finalUrl = axiosFinalUrl(value)
    const safeOriginal = safeHttpUrl(originalUrl)
    if (!finalUrl || !safeOriginal) return null
    return finalUrl !== safeOriginal
}

export function responseContentType(headers: unknown): string | null {
    if (!headers || typeof headers !== 'object') return null
    const headerRecord = headers as Record<string, unknown>
    const getter = headerRecord.get
    const fromGetter = typeof getter === 'function' ? getter.call(headers, 'content-type') : undefined
    const key = Object.keys(headerRecord).find(name => name.toLowerCase() === 'content-type')
    const value = fromGetter ?? (key ? headerRecord[key] : undefined)
    return typeof value === 'string' ? value.slice(0, 160) : null
}

export function responseTopLevelFields(data: unknown): string[] {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return []
    const safeFields = Object.keys(data as Record<string, unknown>)
        .sort()
        .slice(0, 30)
        .map(field =>
            /cookie|authorization|token|password|oauth|secret|verification|requestcode/i.test(field)
                ? '<redacted-field>'
                : field.slice(0, 80)
        )
    return [...new Set(safeFields)]
}

export function classifyHttpFailure(status: number | null): DashboardFailureKind {
    if (status === 401 || status === 403) return 'auth'
    if (status === 404) return 'endpoint-unavailable'
    if (status === 429) return 'rate-limit'
    if (status !== null && status >= 500) return 'server'
    return status === null ? 'network' : 'invalid-response'
}

export function safeAxiosDiagnostic(error: unknown): SafeHttpDiagnostic {
    if (!axios.isAxiosError(error)) {
        return {
            status: null,
            code: null,
            contentType: null,
            topLevelFields: [],
            category: 'network',
            finalUrl: null,
            redirected: null
        }
    }

    const status = error.response?.status ?? null
    const originalUrl = typeof error.config?.url === 'string' ? error.config.url : ''
    return {
        status,
        code: typeof error.code === 'string' ? error.code.slice(0, 80) : null,
        contentType: responseContentType(error.response?.headers),
        topLevelFields: responseTopLevelFields(error.response?.data),
        category: classifyHttpFailure(status),
        finalUrl: axiosFinalUrl(error),
        redirected: originalUrl ? axiosRedirected(error, originalUrl) : null
    }
}

class AxiosClient {
    private instance: AxiosInstance
    private account: AccountProxy

    constructor(account: AccountProxy) {
        this.account = account

        this.instance = axios.create({
            timeout: 20000
        })

        if (this.account.url && this.account.proxyAxios) {
            const agent = this.getAgentForProxy(this.account)
            this.instance.defaults.httpAgent = agent
            this.instance.defaults.httpsAgent = agent
        }

        axiosRetry(this.instance, {
            retries: 5,
            retryDelay: axiosRetry.exponentialDelay,
            shouldResetTimeout: true,
            retryCondition: error => {
                if (axiosRetry.isNetworkError(error)) return true
                if (!error.response) return true

                const status = error.response.status
                return status === 429 || (status >= 500 && status <= 599)
            }
        })
    }

    private getAgentForProxy(
        proxyConfig: AccountProxy
    ): HttpProxyAgent<string> | HttpsProxyAgent<string> | SocksProxyAgent {
        const { url: baseUrl, port, username, password } = proxyConfig

        let urlObj: URL
        try {
            urlObj = new URL(baseUrl)
        } catch {
            try {
                urlObj = new URL(`http://${baseUrl}`)
            } catch {
                throw new Error(`Invalid proxy URL format: ${baseUrl}`)
            }
        }

        const protocol = urlObj.protocol.toLowerCase()
        let proxyUrl: string

        if (username && password) {
            urlObj.username = encodeURIComponent(username)
            urlObj.password = encodeURIComponent(password)
            urlObj.port = port.toString()
            proxyUrl = urlObj.toString()
        } else {
            proxyUrl = `${protocol}//${urlObj.hostname}:${port}`
        }

        switch (protocol) {
            case 'http:':
                return new HttpProxyAgent(proxyUrl)
            case 'https:':
                return new HttpsProxyAgent(proxyUrl)
            case 'socks4:':
            case 'socks5:':
                return new SocksProxyAgent(proxyUrl)
            default:
                throw new Error(`Unsupported proxy protocol: ${protocol}. Only HTTP(S) and SOCKS4/5 are supported!`)
        }
    }

    public async request(config: AxiosRequestConfig, bypassProxy = false): Promise<AxiosResponse> {
        if (bypassProxy) {
            const bypassInstance = axios.create()
            axiosRetry(bypassInstance, {
                retries: 3,
                retryDelay: axiosRetry.exponentialDelay
            })
            return bypassInstance.request(config)
        }

        return this.instance.request(config)
    }

    public async requestOnce(config: AxiosRequestConfig, timeout = 15000): Promise<AxiosResponse> {
        return this.instance.request({
            ...config,
            timeout,
            'axios-retry': { retries: 0 }
        })
    }
}

export default AxiosClient
