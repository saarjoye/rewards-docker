import { URLs } from '../../../constants/urls'
import { BaseActivity } from '../BaseActivity'
import type { ParentQuest, QuestChild } from '../../../browser/ReactFunc'
import type { DashboardData, PunchCard } from '../../../interface/DashboardData'
import { questEligibility, isClaimQuestChild } from '../../../util/TaskEligibility'
import { accountReference, markTaskStatus } from '../../../util/TaskTelemetry'

export class PunchCards extends BaseActivity {
    public async runMobile(data: DashboardData): Promise<void> {
        try {
            await this.run(data)
        } catch (error) {
            this.bot.logger.error(
                'main',
                'PUNCHCARD',
                `Mobile punchcards failed | ${error instanceof Error ? error.message : String(error)}`
            )
        }
    }

    public async runDesktop(): Promise<void> {
        if (!this.bot.config.workers.doPunchCards) return

        let data: DashboardData
        try {
            data = await this.bot.browser.func.getDashboardData(this.bot.cookies.desktop)
        } catch (error) {
            this.bot.logger.warn(
                'main',
                'PUNCHCARD',
                `Desktop punchcard data unavailable | ${error instanceof Error ? error.message : String(error)}`
            )
            return
        }

        try {
            await this.run(data)
        } catch (error) {
            this.bot.logger.error(
                'main',
                'PUNCHCARD',
                `Desktop punchcards failed | ${error instanceof Error ? error.message : String(error)}`
            )
        }
    }

    private async run(data: DashboardData): Promise<void> {
        const parents = await this.getParentQuests()
        if (!parents) {
            markTaskStatus('verifying', '打卡列表读取失败，不能判定为没有任务')
            return
        }

        const apiById = new Map(
            (data.dashboard.punchCards ?? [])
                .filter(card => card.parentPromotion?.offerId)
                .map(card => [card.parentPromotion.offerId, card] as const)
        )

        this.mergeApiParents(parents, apiById)
        const pending = parents.filter(parent => {
            if (parent.complete) return false
            return !this.bot.config.skipNonPointTasks || parent.pointProgressMax > 0
        })

        if (!pending.length) {
            this.bot.logger.info(this.bot.isMobile, 'PUNCHCARD', 'No actionable quests')
            return
        }

        this.bot.logger.info(
            this.bot.isMobile,
            'PUNCHCARD',
            `Found ${pending.length} incomplete quest(s) | apiMatched=${pending.filter(parent => apiById.has(parent.offerId)).length}`
        )

        for (const parent of pending) {
            try {
                await this.solvePunchCard(parent, apiById.get(parent.offerId))
            } catch (error) {
                this.bot.logger.error(
                    this.bot.isMobile,
                    'PUNCHCARD',
                    `Error solving quest "${parent.title || parent.offerId}" | message=${
                        error instanceof Error ? error.message : String(error)
                    }`
                )
            }
        }

        this.bot.logger.info(this.bot.isMobile, 'PUNCHCARD', 'Finished processing quests')
    }

    private async getParentQuests(): Promise<ParentQuest[] | null> {
        try {
            const earn = await this.bot.browser.func.getRewardsPageHtml(URLs.rewards.earn, '/earn')
            if (!earn) {
                this.bot.logger.warn(this.bot.isMobile, 'PUNCHCARD', '/earn unavailable - cannot list quests')
                return null
            }

            const parents = this.bot.browser.react.snapshotQuestList(earn)
            if (parents.length) return parents

            const dashboard = await this.bot.browser.func.getRewardsPageHtml(URLs.rewards.dashboard, '/dashboard')
            return dashboard ? this.bot.browser.react.snapshotQuestList(earn, dashboard) : parents
        } catch (error) {
            this.bot.logger.warn(
                this.bot.isMobile,
                'PUNCHCARD',
                `Failed fetching quest list | ${error instanceof Error ? error.message : String(error)}`
            )
            return null
        }
    }

    private mergeApiParents(parents: ParentQuest[], apiById: Map<string, PunchCard>): void {
        const seen = new Set(parents.map(parent => parent.offerId))

        for (const card of apiById.values()) {
            const promotion = card.parentPromotion
            if (!promotion?.offerId || seen.has(promotion.offerId)) continue

            parents.push({
                offerId: promotion.offerId,
                title: promotion.title ?? '',
                pointProgressMax: promotion.pointProgressMax ?? 0,
                complete: Boolean(promotion.complete)
            })
            seen.add(promotion.offerId)
        }

        for (const parent of parents) {
            if (parent.pointProgressMax > 0) continue
            parent.pointProgressMax = apiById.get(parent.offerId)?.parentPromotion?.pointProgressMax ?? 0
        }
    }

    private async solvePunchCard(parent: ParentQuest, apiCard: PunchCard | undefined): Promise<void> {
        const parentId = parent.offerId
        const title = parent.title || apiCard?.parentPromotion?.title || parentId
        const children = await this.getQuestChildren(parentId, title)
        if (!children) {
            markTaskStatus('verifying', '打卡子任务读取失败，不能判定为已完成')
            return
        }

        const apiChildById = new Map(
            (apiCard?.childPromotions ?? [])
                .filter(child => child.offerId)
                .map(child => [child.offerId, child] as const)
        )
        const ordered = [...children].sort(
            (left, right) =>
                (apiChildById.get(left.offerId)?.priority ?? Number.MAX_SAFE_INTEGER) -
                (apiChildById.get(right.offerId)?.priority ?? Number.MAX_SAFE_INTEGER)
        )
        this.bot.logger.info(
            this.bot.isMobile,
            'TASK-SNAPSHOT',
            JSON.stringify({
                version: 2,
                accountRef: accountReference(this.bot.currentAccountEmail ?? ''),
                source: 'rsc',
                platform: this.bot.isMobile ? 'mobile' : 'desktop',
                dataStatus: 'available',
                planned: true,
                tasks: ordered.map(child => ({
                    id: child.offerId,
                    title: apiChildById.get(child.offerId)?.title || title + '：子任务',
                    points: child.points,
                    completed: child.isCompleted,
                    ...questEligibility(child, this.bot.config, apiChildById.get(child.offerId))
                }))
            })
        )

        this.bot.logger.info(
            this.bot.isMobile,
            'PUNCHCARD',
            `Solving "${title}" | children=${ordered.length} | reportable=${ordered.filter(child => child.reportable).length}`
        )

        const startBalance = this.bot.userData.currentPoints
        let reported = 0
        let remaining = 0

        for (const child of ordered) {
            const apiChild = apiChildById.get(child.offerId)

            if (child.isCompleted) continue
            const eligibility = questEligibility(child, this.bot.config, apiChild)
            if (eligibility.eligibility !== 'eligible') {
                if (eligibility.eligibility === 'unknown') {
                    remaining += 1
                    markTaskStatus('verifying', eligibility.eligibilityReason)
                }
                this.bot.logger.info(this.bot.isMobile, 'PUNCHCARD', eligibility.eligibilityReason)
                continue
            }

            if (isClaimQuestChild(child.offerId, apiChild)) {
                await this.bot.activities.doClaimReward(child, parentId)
            } else {
                await this.bot.activities.telemetry.run(
                    {
                        key: 'quest-child',
                        title: apiChild?.title || title + '：子任务',
                        source: 'rsc',
                        platform: this.bot.isMobile ? 'mobile' : 'desktop',
                        offerId: child.offerId,
                        parentOfferId: parentId
                    },
                    () => this.reportQuestChild(child, parentId)
                )
            }

            reported += 1
            await this.bot.utils.wait(this.bot.utils.randomDelay(5000, 15000))
        }

        const gained = this.bot.userData.currentPoints - startBalance
        this.bot.logger.info(
            this.bot.isMobile,
            'PUNCHCARD',
            `打卡子任务处理结束，完成情况以任务复核为准 | reported=${reported}` +
                `${remaining ? ` | remaining=${remaining}` : ''} | pointsGained=${gained}` +
                ` | currentBalance=${this.bot.userData.currentPoints}` +
                `${parent.pointProgressMax > 0 ? ` | targetPoints=${parent.pointProgressMax}` : ''}`,
            gained > 0 ? 'green' : undefined
        )
    }

    private async getQuestChildren(parentId: string, title: string): Promise<QuestChild[] | null> {
        try {
            const questUrl = URLs.rewards.quest(parentId)
            const html = await this.bot.browser.func.getRewardsPageHtml(questUrl, `/earn/quest/${parentId}`)
            if (!html) {
                this.bot.logger.warn(this.bot.isMobile, 'PUNCHCARD', `Quest page unavailable for "${title}"`)
                return null
            }

            const children = this.bot.browser.react.snapshotQuestPage(html)
            if (!children.length) {
                this.bot.logger.info(this.bot.isMobile, 'PUNCHCARD', `No actionable children for "${title}"`)
                return null
            }
            return children
        } catch (error) {
            this.bot.logger.warn(
                this.bot.isMobile,
                'PUNCHCARD',
                `Failed fetching quest page for "${title}" | ${error instanceof Error ? error.message : String(error)}`
            )
            return null
        }
    }

    private async reportQuestChild(child: QuestChild, parentId: string): Promise<void> {
        const actionId = this.bot.nextActions.reportActivity
        if (!actionId) {
            markTaskStatus('verifying', '未读取到打卡提交入口，未提交活动')
            this.bot.logger.warn(
                this.bot.isMobile,
                'PUNCHCARD',
                `Skip ${child.offerId}: "reportActivity" was not discovered`
            )
            return
        }
        if (!child.hash) {
            markTaskStatus('verifying', '打卡提交数据缺失，未提交活动')
            this.bot.logger.warn(this.bot.isMobile, 'PUNCHCARD', `Skip ${child.offerId}: no live hash`)
            return
        }

        const oldBalance = this.bot.userData.currentPoints
        try {
            const questUrl = URLs.rewards.quest(parentId)
            const { status, acknowledged } = await this.bot.browser.func.reportServerAction(
                actionId,
                [
                    child.hash,
                    11,
                    {
                        offerid: child.offerId,
                        isPromotional: '$undefined',
                        timezoneOffset: this.bot.userData.timezoneOffset
                    }
                ],
                {
                    url: questUrl,
                    referer: questUrl,
                    routerStateTree: this.bot.browser.react.questRouterStateTree(parentId)
                }
            )

            const newBalance = await this.bot.browser.func.getCurrentPoints()
            const gained = newBalance - oldBalance
            if (gained > 0) {
                this.bot.userData.currentPoints = newBalance
                this.bot.userData.gainedPoints = (this.bot.userData.gainedPoints ?? 0) + gained
            }

            this.bot.logger.info(
                this.bot.isMobile,
                'PUNCHCARD',
                `Reported child | offerId=${child.offerId} | status=${status} | acknowledged=${acknowledged}` +
                    ` | pointsGained=${gained} | currentBalance=${newBalance}`,
                gained > 0 || acknowledged ? 'green' : undefined
            )
        } catch (error) {
            markTaskStatus('failed', '打卡子任务上报失败')
            this.bot.logger.error(
                this.bot.isMobile,
                'PUNCHCARD',
                `Error reporting child | offerId=${child.offerId} | message=${
                    error instanceof Error ? error.message : String(error)
                }`
            )
        }
    }
}
