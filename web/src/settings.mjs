import path from 'node:path'

import { CryptoVault } from './crypto-vault.mjs'

export class SettingsStore {
    constructor({ dataDir, keyFile, dataFile } = {}) {
        this.vault = new CryptoVault({
            keyFile: keyFile || process.env.WEB_SETTINGS_KEY_FILE || '/run/secrets/web_settings.key',
            dataFile: dataFile || process.env.WEB_SETTINGS_FILE || path.join(dataDir, 'settings.enc.json')
        })
    }

    status() {
        return { encrypted: this.vault.exists(), writable: this.vault.available() }
    }

    read() {
        const data = this.vault.read({ version: 1, wecom: null })
        if (data?.version !== 1) throw new Error('Web 加密配置格式无效')
        return data
    }

    getWeCom() {
        return this.read().wecom
    }

    setWeCom(config) {
        const data = this.read()
        data.wecom = { ...config, updatedAt: new Date().toISOString() }
        this.vault.write(data)
        return data.wecom
    }
}
