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

export function assertAuthSlot(value: string): asserts value is AuthSlot {
  if (!AUTH_SLOTS.includes(value as AuthSlot))
    throw new TypeError(`Unknown authentication slot: ${value}`)
}
