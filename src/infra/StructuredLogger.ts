import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import { localDateKey } from '../domain/DateKey.js'
import { redactRecord } from '../security/Redactor.js'

export interface LogEvent {
  usedFallback?: boolean | null
  source?: string
  availability?: string
  completed?: number | null
  total?: number | null
  remaining?: number | null
  observedAt?: string
  submittedCount?: number
  unknownSubmissionCount?: number
  level: 'debug' | 'info' | 'warn' | 'error'
  event: string
  runId?: string
  accountIndex?: number
  accountAlias?: string
  taskType?: string
  stage?: string
  status?: string
  durationMs?: number
  attempt?: number
  httpStatus?: number | null
  host?: string
  path?: string
  message?: string
  retryReason?: string
  result?: string
  networkErrorType?: string | null
  activationStarted?: boolean
  surface?: string
}

export class StructuredLogger {
  constructor(private readonly directory: string) {}

  async write(event: LogEvent, now = new Date()): Promise<void> {
    await mkdir(this.directory, { recursive: true })
    const safe = redactRecord(event as unknown as Record<string, unknown>)
    const line = JSON.stringify({ timestamp: now.toISOString(), ...safe })
    await appendFile(join(this.directory, `${localDateKey(now)}.log`), `${line}\n`, {
      encoding: 'utf8',
      mode: 0o600
    })
  }
}
