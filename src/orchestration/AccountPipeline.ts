import { redactText } from '../security/Redactor.js'
import { LoginStateError, requiresUserAction } from '../auth/LoginState.js'
import { BusinessDateChanged } from './BusinessDate.js'

export const ACCOUNT_PIPELINE_STAGES = [
  'authenticate',
  'discover',
  'web-rewards',
  'app-tasks',
  'search',
  'claim-bonus-points',
  'final-verification'
] as const

export type AccountPipelineStage = (typeof ACCOUNT_PIPELINE_STAGES)[number]

export interface AccountPipelineContext {
  runId: string
  accountId: string
  runAccountIndex: number
  localDate: string
  signal: AbortSignal
}

export interface StageResult {
  status: 'completed' | 'skipped' | 'partial' | 'failed' | 'action-required'
  message?: string
  failureStage?: string
}

export interface AccountPipelinePort {
  execute(stage: AccountPipelineStage, context: AccountPipelineContext): Promise<StageResult>
  checkpoint(
    stage: AccountPipelineStage,
    result: StageResult,
    context: AccountPipelineContext
  ): Promise<void>
}

export interface AccountPipelineResult {
  stages: ReadonlyArray<{ stage: AccountPipelineStage; result: StageResult }>
  status: 'success' | 'partial' | 'failed' | 'action-required'
}

export function accountPipelineDiagnostic(result: AccountPipelineResult): {
  stage?: string
  message?: string
} {
  const terminal =
    result.stages.find(
      ({ result: stageResult }) =>
        stageResult.status === 'failed' || stageResult.status === 'action-required'
    ) ??
    result.stages.find(({ result: stageResult }) => stageResult.status === 'partial') ??
    result.stages.at(-1)
  if (!terminal) return {}
  return {
    stage: terminal.result.failureStage ?? terminal.stage,
    ...(terminal.result.message === undefined ? {} : { message: terminal.result.message })
  }
}

export class AccountPipeline {
  constructor(private readonly port: AccountPipelinePort) {}

  async run(context: AccountPipelineContext): Promise<AccountPipelineResult> {
    const stages: Array<{ stage: AccountPipelineStage; result: StageResult }> = []

    for (const stage of ACCOUNT_PIPELINE_STAGES) {
      if (context.signal.aborted) throw context.signal.reason
      let result: StageResult
      try {
        result = await this.port.execute(stage, context)
      } catch (error) {
        if (error instanceof BusinessDateChanged) throw error
        context.signal.throwIfAborted()
        result = {
          status:
            error instanceof LoginStateError && requiresUserAction(error.loginState)
              ? 'action-required'
              : 'failed',
          message: redactText(error instanceof Error ? error.message : 'Stage execution failed'),
          failureStage: error instanceof LoginStateError ? error.loginStage : stage
        }
      }
      stages.push({ stage, result })
      await this.port.checkpoint(stage, result, context)

      if (result.status === 'failed' || result.status === 'action-required') {
        return { stages, status: result.status }
      }
    }

    return {
      stages,
      status: stages.some(({ result }) => result.status === 'partial') ? 'partial' : 'success'
    }
  }
}
