export type FieldAvailability = 'valid' | 'missing' | 'empty' | 'invalid' | 'http-error' | 'unknown'

export type EvidenceSource =
  | 'rsc'
  | 'bing-flyout'
  | 'app-dashboard'
  | 'legacy-getuserinfo'
  | 'browser-response'

export interface FieldEvidence<T> {
  availability: FieldAvailability
  source: EvidenceSource
  confidence: number
  observedAt: string
  value?: T
  reason?: string
}

export function createEvidence<T>(input: FieldEvidence<T>): FieldEvidence<T> {
  if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) {
    throw new RangeError('Evidence confidence must be between 0 and 1')
  }

  if (!Number.isFinite(Date.parse(input.observedAt))) {
    throw new TypeError('Evidence observedAt must be an ISO-compatible timestamp')
  }

  if (input.availability === 'valid' && input.value === undefined) {
    throw new TypeError('Valid evidence requires a value')
  }

  return Object.freeze({ ...input })
}

export function selectTrustedEvidence<T>(
  candidates: readonly FieldEvidence<T>[]
): FieldEvidence<T> | undefined {
  return candidates
    .filter(
      (candidate): candidate is FieldEvidence<T> & { value: T } =>
        candidate.availability === 'valid' && candidate.value !== undefined
    )
    .map((candidate, index) => ({ candidate, index }))
    .sort((left, right) => {
      const confidenceDifference = right.candidate.confidence - left.candidate.confidence
      if (confidenceDifference !== 0) return confidenceDifference

      const timeDifference =
        Date.parse(right.candidate.observedAt) - Date.parse(left.candidate.observedAt)
      if (timeDifference !== 0) return timeDifference

      return left.index - right.index
    })[0]?.candidate
}
