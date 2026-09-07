import fs from 'node:fs'
import path from 'node:path'
import { keyFromFile } from '../src/crypto-vault.mjs'

// Only startup needs root: the server and every request run as the image's node user.
try {
    if (process.getuid?.() === 0) {
        const uid = 1000
        const gid = 1000
        const directory = fs.mkdtempSync('/tmp/mrs-web-key-')
        fs.chmodSync(directory, 0o700)
        const keyPath = path.join(directory, 'key')
        try {
            const key = keyFromFile(process.env.WEB_SETTINGS_KEY_FILE || '/run/secrets/web_settings.key')
            try {
                fs.writeFileSync(keyPath, key, { mode: 0o400, flag: 'wx' })
            } finally {
                key.fill(0)
            }
            fs.chownSync(keyPath, uid, gid)
            fs.chownSync(directory, uid, gid)
            process.env.WEB_SETTINGS_KEY_FILE = keyPath
        } catch {
            console.error('Web Secret 不可用，请检查挂载、权限和密钥格式')
        }
        const dataDir = process.env.WEB_DATA_DIR || '/app/data'
        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { mode: 0o700 })
            fs.chownSync(dataDir, uid, gid)
        } else if (fs.lstatSync(dataDir).isDirectory() && fs.readdirSync(dataDir).length === 0) {
            fs.chownSync(dataDir, uid, gid)
            fs.chmodSync(dataDir, 0o700)
        }
        process.setgroups([])
        process.setgid(gid)
        process.setuid(uid)
    }
    await import('../src/server.mjs')
} catch {
    console.error('Web 启动失败，请检查数据目录权限和运行配置；未输出敏感信息')
    process.exitCode = 1
}
