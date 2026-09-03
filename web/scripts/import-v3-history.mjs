import fs from 'node:fs'
import path from 'node:path'

import { HistoryStore } from '../src/history.mjs'
import { AccountIdentity } from '../src/security.mjs'

const args = process.argv.slice(2)
const apply = args.includes('--apply')
const positional = args.filter(arg => arg !== '--apply' && arg !== '--dry-run')

if (positional.length !== 1 || args.some(arg => arg.startsWith('--') && !['--apply', '--dry-run'].includes(arg))) {
    console.error('用法: node scripts/import-v3-history.mjs <points-history.json> [--dry-run|--apply]')
    process.exit(2)
}

const source = path.resolve(positional[0])
if (!fs.existsSync(source) || !fs.statSync(source).isFile()) {
    console.error('旧积分历史文件不存在')
    process.exit(2)
}
if (fs.statSync(source).size > 20 * 1024 * 1024) {
    console.error('旧积分历史文件超过 20 MiB，拒绝处理')
    process.exit(2)
}

const dataDir = path.resolve(process.env.WEB_DATA_DIR || path.resolve('data'))
const store = new HistoryStore(dataDir, new AccountIdentity(dataDir))
try {
    const result = store.importLegacy(JSON.parse(fs.readFileSync(source, 'utf8')), { apply })
    console.log(JSON.stringify({ ok: true, mode: apply ? 'apply' : 'dry-run', ...result }))
} catch (error) {
    console.error(`导入失败：${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
} finally {
    store.close()
}
