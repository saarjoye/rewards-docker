import type { FieldEvidence } from '../domain/Evidence.js'
import type { TaskRecord } from '../domain/Task.js'

export interface DiscoveryContext {
  accountId: string
  localDate: string
  signal: AbortSignal
}

export interface DiscoveryResult {
  tasks: readonly TaskRecord[]
  fields: Readonly<Record<string, FieldEvidence<unknown>>>
}

export interface RewardsDataSource {
  readonly name: 'rsc' | 'bing-flyout' | 'app-dashboard' | 'legacy-getuserinfo'
  discover(context: DiscoveryContext): Promise<DiscoveryResult>
}

export interface SourceCoordinator {
  discoverAll(context: DiscoveryContext): Promise<readonly DiscoveryResult[]>
}
