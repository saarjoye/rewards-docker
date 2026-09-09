import type { FieldEvidence } from '../domain/Evidence.js'

export interface LoginVerificationEvidence {
  microsoftAuthenticated: boolean
  bingIdentity: FieldEvidence<{ rewardsUser: boolean }>
  rewardsProfile: FieldEvidence<{ availablePoints: number }>
}

export interface LoginVerificationResult {
  valid: boolean
  failedStage?: 'microsoft' | 'bing' | 'rewards-data'
  reason?: string
}

export function verifyLogin(evidence: LoginVerificationEvidence): LoginVerificationResult {
  if (!evidence.microsoftAuthenticated) {
    return {
      valid: false,
      failedStage: 'microsoft',
      reason: 'Microsoft authentication not confirmed'
    }
  }

  if (
    evidence.bingIdentity.availability !== 'valid' ||
    evidence.bingIdentity.value?.rewardsUser !== true
  ) {
    return { valid: false, failedStage: 'bing', reason: 'Bing Rewards identity not confirmed' }
  }

  const points = evidence.rewardsProfile.value?.availablePoints
  if (
    evidence.rewardsProfile.availability !== 'valid' ||
    !Number.isSafeInteger(points) ||
    (points ?? -1) < 0
  ) {
    return { valid: false, failedStage: 'rewards-data', reason: 'Rewards profile not confirmed' }
  }

  return { valid: true }
}
