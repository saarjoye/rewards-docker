import path from 'path'
import fs from 'fs'
import { getDirname, getProjectRoot, log, loadJsonFile, safeRemoveDirectory } from '../utils.js'

const __dirname = getDirname(import.meta.url)
const projectRoot = getProjectRoot(__dirname)

const possibleConfigPaths = [
    path.join(projectRoot, 'config.json'),
    path.join(projectRoot, 'src', 'config.json'),
    path.join(projectRoot, 'dist', 'config.json')
]

log('DEBUG', '项目根目录:', projectRoot)
log('DEBUG', '正在搜索 config.json...')

const configResult = loadJsonFile(possibleConfigPaths, true)
const config = configResult.data
const configPath = configResult.path

log('INFO', '使用配置:', configPath)

if (!config.sessionPath) {
    log('ERROR', '无效的 config.json - 缺少必需字段: sessionPath')
    log('ERROR', `配置文件: ${configPath}`)
    process.exit(1)
}

log('INFO', '来自配置的会话路径:', config.sessionPath)

const configDir = path.dirname(configPath)
const possibleSessionDirs = [
    path.resolve(configDir, config.sessionPath),
    path.join(projectRoot, 'src/browser', config.sessionPath),
    path.join(projectRoot, 'dist/browser', config.sessionPath)
]

log('DEBUG', '正在搜索会话目录...')

let sessionDir = null
for (const p of possibleSessionDirs) {
    log('DEBUG', '检查:', p)
    if (fs.existsSync(p)) {
        sessionDir = p
        log('DEBUG', '在以下位置找到会话目录:', p)
        break
    }
}

if (!sessionDir) {
    sessionDir = path.resolve(configDir, config.sessionPath)
    log('DEBUG', '使用备用会话目录:', sessionDir)
}

const success = safeRemoveDirectory(sessionDir, projectRoot)

if (!success) {
    process.exit(1)
}

log('INFO', '完成.')
