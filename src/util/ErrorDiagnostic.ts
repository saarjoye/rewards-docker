import fs from 'fs/promises'
import path from 'path'
import type { Page } from 'patchright'

export async function errorDiagnostic(page: Page, error: Error): Promise<void> {
    try {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
        const folderName = `error-${timestamp}`
        const outputDir = path.join(process.cwd(), 'diagnostics', folderName)

        if (!page) {
            return
        }

        if (page.isClosed()) {
            return
        }

        // 错误日志内容
        const errorLog = `
名称: ${error.name}
消息: ${error.message}
时间戳: ${new Date().toISOString()}
---------------------------------------------------
堆栈跟踪:
${error.stack || '无可用堆栈跟踪'}
        `.trim()

        const [htmlContent, screenshotBuffer] = await Promise.all([
            page.content(),
            page.screenshot({ fullPage: true, type: 'png' })
        ])

        await fs.mkdir(outputDir, { recursive: true })

        await Promise.all([
            fs.writeFile(path.join(outputDir, 'dump.html'), htmlContent),
            fs.writeFile(path.join(outputDir, 'screenshot.png'), screenshotBuffer),
            fs.writeFile(path.join(outputDir, 'error.txt'), errorLog)
        ])

        console.log(`诊断信息已保存至: ${outputDir}`)
    } catch (error) {
        console.error('无法创建错误诊断信息:', error)
    }
}
