import crypto from 'node:crypto'

import { accountIndexesFromEnv, envStrFrom, normalizeGeoLocale, normalizeLanguageCode } from '../env.js'
import { CryptoVault } from './cryptoVault.js'

const SECRET_FIELDS = new Set(['password', 'totpSecret', 'recoveryEmail', 'proxyCredentials'])

function badRequest(message, code = 'BAD_REQUEST') {
    const error = new Error(message)
    error.code = code
    return error
}

function text(value, max, name, { required = false } = {}) {
    const normalized = String(value ?? '').trim()
    if (required && !normalized) throw badRequest(`${name} is required.`)
    if (normalized.length > max) throw badRequest(`${name} is too long.`)
    return normalized
}

function bool(value, fallback = false) {
    return value === undefined ? fallback : Boolean(value)
}

function locale(value, fallback) {
    const normalized = String(value ?? fallback).trim()
    try {
        return new Intl.Locale(normalized).toString()
    } catch {
        throw badRequest('langCode must be a valid BCP 47 language tag.')
    }
}

function country(value, fallback) {
    const normalized = normalizeGeoLocale(value ?? fallback)
    if (normalized !== 'auto' && !/^[A-Z]{2}$/.test(normalized)) {
        throw badRequest('geoLocale must be "auto" or a two-letter country code.')
    }
    return normalized
}

function proxyUrl(value) {
    const normalized = text(value, 2048, 'proxy.url')
    if (!normalized) return ''
    let parsed
    try {
        parsed = new URL(normalized)
    } catch {
        throw badRequest('proxy.url must be a valid URL.')
    }
    if (!['http:', 'https:', 'socks4:', 'socks5:'].includes(parsed.protocol)) {
        throw badRequest('proxy.url uses an unsupported protocol.')
    }
    if (parsed.username || parsed.password) throw badRequest('Put proxy credentials in their separate fields.')
    return normalized
}

function normalizeAccount(input, existing = null) {
    const clear = new Set(Array.isArray(input.clearSecrets) ? input.clearSecrets : [])
    if ([...clear].some(field => !SECRET_FIELDS.has(field))) throw badRequest('clearSecrets contains an unknown field.')

    const emailInput = text(input.email, 320, 'email')
    const email = emailInput || existing?.email || ''
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw badRequest('A valid email is required.')

    const preserveSecret = (name, current = '') => {
        if (clear.has(name)) return ''
        const next = text(input[name], name === 'totpSecret' ? 512 : 2048, name)
        return next || current
    }

    const currentProxy = existing?.proxy ?? {}
    const proxy = input.proxy && typeof input.proxy === 'object' && !Array.isArray(input.proxy) ? input.proxy : {}
    const clearProxy = Boolean(input.clearProxy)
    const account = {
        id: existing?.id || crypto.randomUUID(),
        email,
        password: preserveSecret('password', existing?.password),
        totpSecret: preserveSecret('totpSecret', existing?.totpSecret),
        recoveryEmail: preserveSecret('recoveryEmail', existing?.recoveryEmail),
        geoLocale: country(input.geoLocale, existing?.geoLocale ?? 'auto'),
        langCode: locale(input.langCode, existing?.langCode ?? 'en'),
        proxy: {
            proxyHttp: clearProxy ? false : bool(proxy.proxyHttp, currentProxy.proxyHttp ?? false),
            url: clearProxy ? '' : proxyUrl(text(proxy.url, 2048, 'proxy.url') || currentProxy.url || ''),
            port: clearProxy ? 0 : Number(proxy.port ?? currentProxy.port ?? 0),
            username:
                clearProxy || clear.has('proxyCredentials')
                    ? ''
                    : text(proxy.username, 512, 'proxy.username') || currentProxy.username || '',
            password:
                clearProxy || clear.has('proxyCredentials')
                    ? ''
                    : text(proxy.password, 2048, 'proxy.password') || currentProxy.password || ''
        },
        saveFingerprint: {
            mobile: bool(input.saveFingerprint?.mobile, existing?.saveFingerprint?.mobile ?? false),
            desktop: bool(input.saveFingerprint?.desktop, existing?.saveFingerprint?.desktop ?? false)
        },
        createdAt: existing?.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString()
    }
    if (!Number.isSafeInteger(account.proxy.port) || account.proxy.port < 0 || account.proxy.port > 65535) {
        throw badRequest('proxy.port must be an integer between 0 and 65535.')
    }
    if (
        !account.proxy.url &&
        (account.proxy.proxyHttp || account.proxy.port || account.proxy.username || account.proxy.password)
    ) {
        throw badRequest('proxy.url is required when proxy options are configured.')
    }
    if (Boolean(account.proxy.username) !== Boolean(account.proxy.password)) {
        throw badRequest('Proxy username and password must be configured together.')
    }
    return account
}

function maskEmail(value) {
    const [local = '', domain = ''] = String(value).split('@')
    const [name = '', ...suffix] = domain.split('.')
    return `${local.slice(0, 1) || '*'}***@${name.slice(0, 1) || '*'}***${suffix.length ? `.${suffix.join('.')}` : ''}`
}

function fromEnvironment(sourceEnv) {
    return accountIndexesFromEnv(sourceEnv).map(index => ({
        id: crypto.randomUUID(),
        email: envStrFrom(sourceEnv, `ACCOUNT_${index}_EMAIL`) || '',
        password: envStrFrom(sourceEnv, `ACCOUNT_${index}_PASSWORD`) || '',
        totpSecret: envStrFrom(sourceEnv, `ACCOUNT_${index}_TOTP_SECRET`) || '',
        recoveryEmail: envStrFrom(sourceEnv, `ACCOUNT_${index}_RECOVERY_EMAIL`) || '',
        geoLocale: normalizeGeoLocale(envStrFrom(sourceEnv, `ACCOUNT_${index}_GEO_LOCALE`) || 'auto'),
        langCode: normalizeLanguageCode(envStrFrom(sourceEnv, `ACCOUNT_${index}_LANG_CODE`) || 'en'),
        proxy: {
            proxyHttp: ['1', 'true', 'yes', 'on'].includes(
                (envStrFrom(sourceEnv, `ACCOUNT_${index}_PROXY_HTTP`) || '').toLowerCase()
            ),
            url: envStrFrom(sourceEnv, `ACCOUNT_${index}_PROXY_URL`) || '',
            port: Number(envStrFrom(sourceEnv, `ACCOUNT_${index}_PROXY_PORT`) || 0),
            username: envStrFrom(sourceEnv, `ACCOUNT_${index}_PROXY_USERNAME`) || '',
            password: envStrFrom(sourceEnv, `ACCOUNT_${index}_PROXY_PASSWORD`) || ''
        },
        saveFingerprint: {
            mobile: ['1', 'true', 'yes', 'on'].includes(
                (envStrFrom(sourceEnv, `ACCOUNT_${index}_SAVE_FINGERPRINT_MOBILE`) || '').toLowerCase()
            ),
            desktop: ['1', 'true', 'yes', 'on'].includes(
                (envStrFrom(sourceEnv, `ACCOUNT_${index}_SAVE_FINGERPRINT_DESKTOP`) || '').toLowerCase()
            )
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    }))
}

function accountEnv(accounts, sourceEnv = process.env) {
    const env = {}
    for (const key of Object.keys(sourceEnv)) if (/^ACCOUNT_\d+_/.test(key)) env[key] = ''
    accounts.forEach((account, offset) => {
        const prefix = `ACCOUNT_${offset + 1}_`
        const values = {
            EMAIL: account.email,
            PASSWORD: account.password,
            TOTP_SECRET: account.totpSecret,
            RECOVERY_EMAIL: account.recoveryEmail,
            GEO_LOCALE: account.geoLocale,
            LANG_CODE: account.langCode,
            PROXY_HTTP: account.proxy.proxyHttp,
            PROXY_URL: account.proxy.url,
            PROXY_PORT: account.proxy.port,
            PROXY_USERNAME: account.proxy.username,
            PROXY_PASSWORD: account.proxy.password,
            SAVE_FINGERPRINT_MOBILE: account.saveFingerprint.mobile,
            SAVE_FINGERPRINT_DESKTOP: account.saveFingerprint.desktop
        }
        for (const [suffix, value] of Object.entries(values)) env[`${prefix}${suffix}`] = String(value ?? '')
    })
    return env
}

export class AccountStore {
    constructor({ keyFile, dataFile, sourceEnv = process.env }) {
        this.vault = new CryptoVault({ keyFile, dataFile })
        this.sourceEnv = sourceEnv
    }

    status() {
        return {
            encrypted: this.vault.exists(),
            writable: this.vault.available(),
            migrationAvailable: !this.vault.exists() && accountIndexesFromEnv(this.sourceEnv).length > 0
        }
    }

    read() {
        const data = this.vault.read({ version: 1, accounts: [] })
        if (data?.version !== 1 || !Array.isArray(data.accounts)) throw new Error('Encrypted account store is invalid.')
        return data.accounts
    }

    sourceAccounts() {
        return this.vault.exists() ? this.read() : fromEnvironment(this.sourceEnv)
    }

    publicAccounts() {
        return this.sourceAccounts().map((account, offset) => ({
            id: account.id,
            index: offset + 1,
            label: maskEmail(account.email),
            geoLocale: account.geoLocale,
            langCode: account.langCode,
            hasPassword: Boolean(account.password),
            hasTotp: Boolean(account.totpSecret),
            hasRecoveryEmail: Boolean(account.recoveryEmail),
            proxy: {
                enabled: Boolean(account.proxy?.url),
                proxyHttp: Boolean(account.proxy?.proxyHttp),
                protocol: (() => {
                    try {
                        return account.proxy?.url ? new URL(account.proxy.url).protocol.replace(':', '') : null
                    } catch {
                        return null
                    }
                })(),
                port: account.proxy?.port || 0,
                hasCredentials: Boolean(account.proxy?.username && account.proxy?.password)
            },
            saveFingerprint: account.saveFingerprint
        }))
    }

    runEnvironment() {
        if (!this.vault.exists()) return null
        return accountEnv(this.read(), this.sourceEnv)
    }

    migrateEnvironment() {
        if (this.vault.exists()) throw badRequest('Encrypted account store is already initialized.', 'ALREADY_MIGRATED')
        const accounts = fromEnvironment(this.sourceEnv).map(account => normalizeAccount(account))
        if (!accounts.length) throw badRequest('No environment accounts are available to migrate.', 'NO_ENV_ACCOUNTS')
        this.vault.write({ version: 1, accounts })
        return { migrated: accounts.length }
    }

    create(input) {
        if (!this.vault.exists() && accountIndexesFromEnv(this.sourceEnv).length) {
            throw badRequest('Migrate environment accounts before creating a managed account.', 'MIGRATION_REQUIRED')
        }
        const accounts = this.vault.exists() ? this.read() : []
        const account = normalizeAccount(input)
        if (accounts.some(item => item.email.toLowerCase() === account.email.toLowerCase())) {
            throw badRequest('An account with this email already exists.', 'DUPLICATE_ACCOUNT')
        }
        accounts.push(account)
        this.vault.write({ version: 1, accounts })
        return account.id
    }

    update(id, input) {
        const accounts = this.read()
        const index = accounts.findIndex(account => account.id === id)
        if (index < 0) throw badRequest('Account was not found.', 'ACCOUNT_NOT_FOUND')
        const previousEmail = accounts[index].email
        const updated = normalizeAccount(input, accounts[index])
        if (
            accounts.some(
                (item, offset) => offset !== index && item.email.toLowerCase() === updated.email.toLowerCase()
            )
        ) {
            throw badRequest('An account with this email already exists.', 'DUPLICATE_ACCOUNT')
        }
        accounts[index] = updated
        this.vault.write({ version: 1, accounts })
        return { id: updated.id, previousEmail, email: updated.email }
    }

    delete(id) {
        const accounts = this.read()
        const index = accounts.findIndex(account => account.id === id)
        if (index < 0) throw badRequest('Account was not found.', 'ACCOUNT_NOT_FOUND')
        const [removed] = accounts.splice(index, 1)
        this.vault.write({ version: 1, accounts })
        return removed
    }
}

export { accountEnv, fromEnvironment, maskEmail, normalizeAccount }
