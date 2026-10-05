import { createEvidence } from '../../src/domain/Evidence.js'
import { createTaskId, type TaskRecord } from '../../src/domain/Task.js'
import type { RscBootstrap } from '../../src/browser/DashboardClient.js'
import { parseRewardsQuestHtml } from '../../src/rewards/DashboardParser.js'
import type {
  QuestObservation,
  RewardOffer,
  RewardsObservation
} from '../../src/rewards/RewardsModel.js'

export const parentId = 'SYNTH_pcparent_Monthly_Test_punchcard'
export const childId = 'SYNTH_pcchild1_urlreward_Monthly_Test_punchcard'
export const destination = 'https://www.bing.com/search?q=synthetic+task&form=TEST'
export const quest = {
  parentOfferId: parentId,
  title: '合成子任务',
  ariaLabel: '打开合成页面, 合成子任务'
}
export const date = '2026-10-05'
export const accountId = 'synthetic-account'

export function linkProps(overrides: Record<string, unknown> = {}) {
  return {
    offerId: childId,
    ariaLabel: quest.ariaLabel,
    linkText: '打开合成页面',
    href: destination,
    hash: 'synthetic-action-hash',
    edgeAction: null,
    isCompleted: false,
    isLocked: false,
    ...overrides
  }
}

export function questHtml(props: readonly Record<string, unknown>[] = [linkProps()]) {
  return JSON.stringify({
    offerId: parentId,
    children: props.map((item) => ({ props: item }))
  })
}

export function childOffer(overrides: Partial<RewardOffer> = {}): RewardOffer {
  const offer = parseRewardsQuestHtml(questHtml(), parentId)[0]
  if (!offer) throw new Error('Invalid synthetic quest fixture')
  return { ...offer, ...overrides }
}

export function parentOffer(overrides: Partial<RewardOffer> = {}): RewardOffer {
  return {
    sourceTaskId: parentId,
    source: 'rsc',
    type: 'punch-card',
    displayName: '合成月任务包',
    completed: 0,
    total: 5,
    complete: false,
    executable: true,
    destinationUrl: 'https://rewards.bing.com/earn/quest/' + parentId,
    ...overrides
  }
}

export function childTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: createTaskId(accountId, date, childId),
    accountId,
    localDate: date,
    sourceTaskId: childId,
    type: 'punch-card',
    source: 'rsc',
    displayName: quest.title,
    quest,
    executable: true,
    required: false,
    status: 'discovered',
    progress: { completed: 0, total: 1 },
    updatedAt: date + 'T01:00:00.000Z',
    ...overrides
  }
}

export function questObservation(overrides: Partial<QuestObservation> = {}): QuestObservation {
  return {
    parentOfferId: parentId,
    offers: [childOffer()],
    rows: [{ title: quest.title, state: 'open', actionCount: 1 }],
    ...overrides
  }
}

export function evidence<T>(value: T) {
  return createEvidence({
    value,
    availability: 'valid',
    source: 'rsc',
    confidence: 0.9,
    observedAt: date + 'T01:00:00.000Z'
  })
}

export function observation(): RewardsObservation {
  return {
    source: 'bing-flyout',
    offers: [],
    rewardsUser: evidence(true),
    market: evidence('CN'),
    availablePoints: evidence(100),
    pcSearch: evidence({ completed: 0, total: 0, remaining: 0 }),
    mobileSearch: evidence({ completed: 0, total: 0, remaining: 0 }),
    topLevelFields: []
  }
}

export function bootstrap(offers: readonly RewardOffer[] = [parentOffer()]): RscBootstrap {
  return {
    html: [],
    offers,
    domOffers: [],
    availablePoints: evidence(100),
    actionIds: { reportActivity: 'synthetic-report-action' }
  }
}
