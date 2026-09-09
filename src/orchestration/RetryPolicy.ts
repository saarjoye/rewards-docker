export type OperationKind = 'read-only' | 'authentication' | 'mutation'

export interface RetryContext {
  kind: OperationKind
  attempt: number
  maxAttempts: number
  status?: number
  timedOut?: boolean
  networkError?: boolean
}

export function shouldRetry(context: RetryContext): boolean {
  if (context.attempt >= context.maxAttempts) return false
  if (context.kind === 'mutation') return false
  if (context.kind === 'authentication') return context.attempt < Math.min(context.maxAttempts, 2)
  return (
    context.timedOut === true ||
    context.networkError === true ||
    context.status === 502 ||
    context.status === 503 ||
    context.status === 504
  )
}

export class OperationTimeoutError extends Error {
  constructor(
    readonly stage: string,
    readonly timeoutMs: number
  ) {
    super(`${stage} timed out after ${String(timeoutMs)}ms`)
    this.name = 'OperationTimeoutError'
  }
}

export async function runAbortable<T>(input: {
  stage: string
  timeoutMs: number
  parentSignal?: AbortSignal
  operation: (signal: AbortSignal) => Promise<T>
}): Promise<T> {
  const controller = new AbortController()
  const asError = (reason: unknown, fallback: Error): Error =>
    reason instanceof Error ? reason : fallback
  const onParentAbort = (): void => {
    controller.abort(
      asError(input.parentSignal?.reason as unknown, new Error('Operation was aborted'))
    )
  }
  if (input.parentSignal?.aborted) onParentAbort()
  else input.parentSignal?.addEventListener('abort', onParentAbort, { once: true })

  const timer = setTimeout(() => {
    controller.abort(new OperationTimeoutError(input.stage, input.timeoutMs))
  }, input.timeoutMs)

  try {
    const aborted = new Promise<never>((_resolve, reject) => {
      const rejectAbort = (): void => {
        reject(
          asError(
            controller.signal.reason as unknown,
            new OperationTimeoutError(input.stage, input.timeoutMs)
          )
        )
      }
      if (controller.signal.aborted) rejectAbort()
      else controller.signal.addEventListener('abort', rejectAbort, { once: true })
    })
    return await Promise.race([input.operation(controller.signal), aborted])
  } finally {
    clearTimeout(timer)
    input.parentSignal?.removeEventListener('abort', onParentAbort)
  }
}
