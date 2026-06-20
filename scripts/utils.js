import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

export function getDirname(importMetaUrl) {
    const __filename = fileURLToPath(importMetaUrl)
    return path.dirname(__filename)
}

export function getProjectRoot(currentDir) {
    let dir = currentDir
    while (dir !== path.parse(dir).root) {
        if (fs.existsSync(path.join(dir, 'package.json'))) {
            return dir
        }
        dir = path.dirname(dir)
    }
    throw new Error('找不到项目根目录 (未找到 package.json)')
}

export function log(level, ...args) {
    console.log(`[${level}]`, ...args)
}

export function parseArgs(argv = process.argv.slice(2)) {
    const args = {}

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]

        if (arg.startsWith('-')) {
            const key = arg.substring(1)

            if (i + 1 < argv.length && !argv[i + 1].startsWith('-')) {
                args[key] = argv[i + 1]
                i++
            } else {
                args[key] = true
            }
        }
    }

    return args
}

export function validateEmail(email) {
    if (!email) {
        log('ERROR', '缺少 -email 参数')
        log('ERROR', '用法: node script.js -email you@example.com')
        process.exit(1)
    }

    if (typeof email !== 'string') {
        log('ERROR', `无效的邮箱类型: 期望是字符串, 实际得到 ${typeof email}`)
        log('ERROR', '用法: node script.js -email you@example.com')
        process.exit(1)
    }

    if (!email.includes('@')) {
        log('ERROR', `无效的邮箱格式: "${email}"`)
        log('ERROR', '邮箱必须包含 "@" 符号')
        log('ERROR', '示例: you@example.com')
        process.exit(1)
    }

    return email
}

export function loadJsonFile(possiblePaths, required = true) {
    for (const filePath of possiblePaths) {
        if (fs.existsSync(filePath)) {
            try {
                const content = fs.readFileSync(filePath, 'utf8')
                return { data: JSON.parse(content), path: filePath }
            } catch (error) {
                log('ERROR', `解析JSON文件失败: ${filePath}`)
                log('ERROR', `解析错误: ${error.message}`)
                if (required) process.exit(1)
                return null
            }
        }
    }

    if (required) {
        log('ERROR', '找不到必需的文件')
        log('ERROR', '在以下位置搜索:')
        possiblePaths.forEach(p => log('ERROR', `  - ${p}`))
        process.exit(1)
    }

    return null
}

export function loadConfig(projectRoot, isDev = false) {
    const possiblePaths = isDev
        ? [path.join(projectRoot, 'src', 'config.json')]
        : [path.join(projectRoot, 'dist', 'config.json'), path.join(projectRoot, 'config.json')]

    const result = loadJsonFile(possiblePaths, true)

    const missingFields = []
    if (!result.data.baseURL) missingFields.push('baseURL')
    if (!result.data.sessionPath) missingFields.push('sessionPath')
    if (result.data.headless === undefined) missingFields.push('headless')
    if (!result.data.workers) missingFields.push('workers')

    if (missingFields.length > 0) {
        log('ERROR', '无效的 config.json - 缺少必需字段:')
        missingFields.forEach(field => log('ERROR', `  - ${field}`))
        log('ERROR', `配置文件: ${result.path}`)
        process.exit(1)
    }

    return result
}

export function loadAccounts(projectRoot, isDev = false) {
    const possiblePaths = isDev
        ? [path.join(projectRoot, 'src', 'accounts.dev.json')]
        : [
              path.join(projectRoot, 'dist', 'accounts.json'),
              path.join(projectRoot, 'accounts.json'),
              path.join(projectRoot, 'accounts.example.json')
          ]

    return loadJsonFile(possiblePaths, true)
}

export function findAccountByEmail(accounts, email) {
    if (!email || typeof email !== 'string') return null
    return (
        accounts.find(a => a?.email && typeof a.email === 'string' && a.email.toLowerCase() === email.toLowerCase()) ||
        null
    )
}

export function getRuntimeBase(projectRoot, isDev = false) {
    return path.join(projectRoot, isDev ? 'src' : 'dist')
}

export function getSessionPath(runtimeBase, sessionPath, email) {
    return path.join(runtimeBase, 'browser', sessionPath, email)
}

export async function loadCookies(sessionBase, type = 'desktop') {
    const cookiesFile = path.join(sessionBase, `session_${type}.json`)

    if (!fs.existsSync(cookiesFile)) {
        return []
    }

    try {
        const content = await fs.promises.readFile(cookiesFile, 'utf8')
        return JSON.parse(content)
    } catch (error) {
        log('WARN', `从以下位置加载 cookies 失败: ${cookiesFile}`)
        log('WARN', `错误: ${error.message}`)
        return []
    }
}

export async function loadFingerprint(sessionBase, type = 'desktop') {
    const fpFile = path.join(sessionBase, `session_fingerprint_${type}.json`)

    if (!fs.existsSync(fpFile)) {
        return null
    }

    try {
        const content = await fs.promises.readFile(fpFile, 'utf8')
        return JSON.parse(content)
    } catch (error) {
        log('WARN', `从以下位置加载指纹失败: ${fpFile}`)
        log('WARN', `错误: ${error.message}`)
        return null
    }
}

export function getUserAgent(fingerprint) {
    if (!fingerprint) return null
    return fingerprint?.fingerprint?.userAgent || fingerprint?.userAgent || null
}

export function buildProxyConfig(account) {
    if (!account.proxy || !account.proxy.url || !account.proxy.port) {
        return null
    }

    const proxy = {
        server: `${account.proxy.url}:${account.proxy.port}`
    }

    if (account.proxy.username && account.proxy.password) {
        proxy.username = account.proxy.username
        proxy.password = account.proxy.password
    }

    return proxy
}

export function setupCleanupHandlers(cleanupFn) {
    const cleanup = async () => {
        try {
            await cleanupFn()
        } catch (error) {
            log('ERROR', '清理失败:', error.message)
        }
        process.exit(0)
    }

    process.on('SIGINT', cleanup)
    process.on('SIGTERM', cleanup)
}

export function validateDeletionPath(targetPath, projectRoot) {
    const normalizedTarget = path.normalize(targetPath)
    const normalizedRoot = path.normalize(projectRoot)

    if (!normalizedTarget.startsWith(normalizedRoot)) {
        return {
            valid: false,
            error: '路径超出项目根目录范围'
        }
    }

    if (normalizedTarget === normalizedRoot) {
        return {
            valid: false,
            error: '不能删除项目根目录'
        }
    }

    const pathSegments = normalizedTarget.split(path.sep)
    if (pathSegments.length < 3) {
        return {
            valid: false,
            error: '路径层级太浅 (安全检查失败)'
        }
    }

    return { valid: true, error: null }
}

export function safeRemoveDirectory(dirPath, projectRoot) {
    const validation = validateDeletionPath(dirPath, projectRoot)

    if (!validation.valid) {
        log('ERROR', '目录删除失败 - 安全检查:')
        log('ERROR', `  原因: ${validation.error}`)
        log('ERROR', `  目标: ${dirPath}`)
        log('ERROR', `  项目根目录: ${projectRoot}`)
        return false
    }

    if (!fs.existsSync(dirPath)) {
        log('INFO', `目录不存在: ${dirPath}`)
        return true
    }

    try {
        fs.rmSync(dirPath, { recursive: true, force: true })
        log('SUCCESS', `目录已删除: ${dirPath}`)
        return true
    } catch (error) {
        log('ERROR', `删除目录失败: ${dirPath}`)
        log('ERROR', `错误: ${error.message}`)
        return false
    }
}
