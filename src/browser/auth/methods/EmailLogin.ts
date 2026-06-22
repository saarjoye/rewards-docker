import type { Page } from 'patchright'
import type { MicrosoftRewardsBot } from '../../../index'

export class EmailLogin {
    private submitButton = 'button[type="submit"]'

    constructor(private bot: MicrosoftRewardsBot) {}

    async enterEmail(page: Page, email: string): Promise<'ok' | 'error'> {
        try {
            const emailInputSelector = 'input[type="email"]'
            const emailField = await page
                .waitForSelector(emailInputSelector, { state: 'visible', timeout: 1000 })
                .catch(() => {})
            if (!emailField) {
                this.bot.logger.warn(this.bot.isMobile, 'LOGIN-ENTER-EMAIL', '未找到邮箱字段')
                return 'error'
            }

            await this.bot.utils.wait(1000)

            const prefilledEmail = await page
                .waitForSelector('#userDisplayName', { state: 'visible', timeout: 1000 })
                .catch(() => {})
            if (!prefilledEmail) {
                await page.fill(emailInputSelector, '').catch(() => {})
                await this.bot.utils.wait(500)
                await page.fill(emailInputSelector, email).catch(() => {})
                await this.bot.utils.wait(1000)
            } else {
                this.bot.logger.info(this.bot.isMobile, 'LOGIN-ENTER-EMAIL', '邮箱已预填充')
            }

            await page.waitForSelector(this.submitButton, { state: 'visible', timeout: 2000 }).catch(() => {})

            await this.bot.browser.utils.ghostClick(page, this.submitButton)
            this.bot.logger.info(this.bot.isMobile, 'LOGIN-ENTER-EMAIL', '邮箱已提交')

            return 'ok'
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'LOGIN-ENTER-EMAIL',
                `发生错误: ${error instanceof Error ? error.message : String(error)}`
            )
            return 'error'
        }
    }

    async enterPassword(page: Page, password: string): Promise<'ok' | 'needs-2fa' | 'error'> {
        try {
            const passwordInputSelector = 'input[type="password"]'
            const passwordField = await page
                .waitForSelector(passwordInputSelector, { state: 'visible', timeout: 1000 })
                .catch(() => {})
            if (!passwordField) {
                this.bot.logger.warn(this.bot.isMobile, 'LOGIN-ENTER-PASSWORD', '未找到密码字段')
                return 'error'
            }

            await this.bot.utils.wait(1000)
            await page.fill(passwordInputSelector, '').catch(() => {})
            await this.bot.utils.wait(500)
            await page.fill(passwordInputSelector, password).catch(() => {})
            let inputMatches = await this.passwordInputMatches(page, passwordInputSelector, password)
            if (!inputMatches) {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'LOGIN-ENTER-PASSWORD',
                    '密码输入值校验失败，使用DOM赋值兜底'
                )
                await page
                    .locator(passwordInputSelector)
                    .evaluate((el, value) => {
                        const input = el as HTMLInputElement
                        input.value = value
                        input.dispatchEvent(new Event('input', { bubbles: true }))
                        input.dispatchEvent(new Event('change', { bubbles: true }))
                    }, password)
                    .catch(() => {})
                inputMatches = await this.passwordInputMatches(page, passwordInputSelector, password)
            }
            if (!inputMatches) {
                this.bot.logger.error(this.bot.isMobile, 'LOGIN-ENTER-PASSWORD', '密码输入值仍不匹配，停止提交')
                return 'error'
            }
            await this.bot.utils.wait(1000)

            const submitButton = await page
                .waitForSelector(this.submitButton, { state: 'visible', timeout: 2000 })
                .catch(() => null)

            if (submitButton) {
                await this.bot.browser.utils.ghostClick(page, this.submitButton)
                this.bot.logger.info(this.bot.isMobile, 'LOGIN-ENTER-PASSWORD', '密码已提交')
            }

            return 'ok'
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'LOGIN-ENTER-PASSWORD',
                `发生错误: ${error instanceof Error ? error.message : String(error)}`
            )
            return 'error'
        }
    }

    private async passwordInputMatches(page: Page, selector: string, password: string): Promise<boolean> {
        return page
            .locator(selector)
            .evaluate((el, expected) => (el as HTMLInputElement).value === expected, password)
            .catch(() => false)
    }
}
