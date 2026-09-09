import { createTaskId, type CanonicalTaskType, type TaskRecord } from '../domain/Task.js'
import type { EvidenceSource } from '../domain/Evidence.js'

export interface DiscoveredTask {
  accountId: string
  localDate: string
  sourceTaskId: string
  sourceType: string
  source: EvidenceSource
  displayName: string
  completed: number
  total: number | null
  alreadyComplete: boolean
}

export interface TaskDefinition {
  type: Exclude<CanonicalTaskType, 'unknown'>
  aliases: readonly string[]
  executable: boolean
  required: boolean
}

const DEFAULT_DEFINITIONS: readonly TaskDefinition[] = [
  {
    type: 'claim-bonus-points',
    aliases: ['claim-bonus-points', 'claim-all-points'],
    executable: true,
    required: true
  },
  {
    type: 'app-activity',
    aliases: ['app-activity', 'app-promotion'],
    executable: true,
    required: false
  },
  { type: 'daily-set', aliases: ['daily-set'], executable: true, required: true },
  { type: 'special-promotion', aliases: ['special-promotion'], executable: true, required: false },
  { type: 'more-promotion', aliases: ['more-promotion'], executable: true, required: false },
  { type: 'app-check-in', aliases: ['app-check-in'], executable: true, required: false },
  { type: 'read-to-earn', aliases: ['read-to-earn'], executable: true, required: false },
  { type: 'punch-card', aliases: ['punch-card', 'quest'], executable: true, required: false },
  { type: 'mobile-search', aliases: ['mobile-search'], executable: true, required: false },
  { type: 'pc-search', aliases: ['pc-search', 'desktop-search'], executable: true, required: true }
]

export class TaskRegistry {
  private readonly aliases = new Map<string, TaskDefinition>()

  constructor(definitions: readonly TaskDefinition[] = DEFAULT_DEFINITIONS) {
    for (const definition of definitions) {
      for (const alias of definition.aliases) {
        const key = alias.trim().toLowerCase()
        if (this.aliases.has(key)) throw new Error(`Duplicate task alias: ${key}`)
        this.aliases.set(key, definition)
      }
    }
  }

  classify(task: DiscoveredTask, now = new Date()): TaskRecord {
    const definition = this.aliases.get(task.sourceType.trim().toLowerCase())
    const type = definition?.type ?? 'unknown'
    const executable = definition?.executable ?? false
    return {
      taskId: createTaskId(task.accountId, task.localDate, task.sourceTaskId),
      accountId: task.accountId,
      localDate: task.localDate,
      sourceTaskId: task.sourceTaskId,
      type,
      source: task.source,
      displayName: task.displayName,
      executable,
      required: definition?.required ?? false,
      status: type === 'unknown' ? 'unknown' : task.alreadyComplete ? 'completed' : 'discovered',
      progress: { completed: task.completed, total: task.total },
      ...(type === 'unknown' ? { reason: `Unsupported source task type: ${task.sourceType}` } : {}),
      updatedAt: now.toISOString()
    }
  }
}
