import type { CanonicalTaskType, QuestTaskContext } from '../domain/Task.js'
import type { FieldEvidence } from '../domain/Evidence.js'

export interface SearchQuota {
  completed: number
  total: number
  remaining: number
}

export interface QuestRow {
  title: string
  state: 'completed' | 'locked' | 'open' | 'unknown'
  actionCount: number
}

export interface QuestObservation {
  parentOfferId: string
  offers: readonly RewardOffer[]
  rows: readonly QuestRow[]
}

export interface RewardOffer {
  quest?: QuestTaskContext
  locked?: boolean
  isGroup?: boolean
  restrictionReason?: string
  sourceTaskId: string
  type: CanonicalTaskType
  source: 'rsc' | 'bing-flyout' | 'app-dashboard' | 'legacy-getuserinfo'
  displayName: string
  completed: number
  total: number | null
  complete: boolean
  executable: boolean
  expectedPoints?: number
  identityStable?: boolean
  requiresOfficialClick?: boolean
  destinationUrl?: string
  hash?: string
  parentOfferId?: string
  activityType?: number
  isPromotional?: boolean
  attributes?: Readonly<Record<string, string>>
}

export interface RewardsObservation {
  readMetadata?: { startedAt: string; durationMs: number; usedFallback: boolean; attempts: number }
  source: RewardOffer['source']
  rewardsUser: FieldEvidence<boolean>
  market: FieldEvidence<string>
  availablePoints: FieldEvidence<number>
  pcSearch: FieldEvidence<SearchQuota>
  mobileSearch: FieldEvidence<SearchQuota>
  offers: readonly RewardOffer[]
  topLevelFields: readonly string[]
}

export interface RewardsDiscoverySnapshot {
  rewardsUser: FieldEvidence<boolean>
  market: FieldEvidence<string>
  availablePoints: FieldEvidence<number>
  pcSearch: FieldEvidence<SearchQuota>
  mobileSearch: FieldEvidence<SearchQuota>
  offers: readonly RewardOffer[]
  actionIds: Readonly<Record<string, string>>
  deploymentId?: string
  routerStateTree?: string
}
