export const AUTH_SLOTS = ['web-desktop', 'web-mobile', 'app-oauth'] as const

export type AuthSlot = (typeof AUTH_SLOTS)[number]

export interface AuthSlotState {
  accountId: string
  slot: AuthSlot
  status: 'missing' | 'validating' | 'valid' | 'invalid' | 'action-required'
  validatedAt?: string
  failureStage?: string
  message?: string
}
