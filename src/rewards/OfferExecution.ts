import type { RewardOffer } from './RewardsModel.js'

export type WebOfferExecutionPath =
  | 'report-activity'
  | 'navigate-only'
  | 'interactive-quiz'
  | 'interactive-poll'
  | 'unsupported'

function interactionSignature(offer: RewardOffer): string {
  return [
    offer.attributes?.type,
    offer.attributes?.promotionType,
    offer.attributes?.promotionSubtype,
    offer.attributes?.['answerScenario.Tag'],
    offer.attributes?.['classification.Tag']
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
}

function interactionPath(offer: RewardOffer): string {
  if (!offer.destinationUrl) return ''
  try {
    return new URL(offer.destinationUrl, 'https://rewards.bing.com').pathname.toLowerCase()
  } catch {
    return ''
  }
}

function hasSafeNavigationTarget(offer: RewardOffer): boolean {
  if (!offer.destinationUrl) return false
  try {
    return new URL(offer.destinationUrl, 'https://rewards.bing.com').protocol === 'https:'
  } catch {
    return false
  }
}

export function webOfferExecutionPath(
  offer: RewardOffer,
  reportActivityAvailable: boolean
): WebOfferExecutionPath {
  const signature = interactionSignature(offer)
  const pathname = interactionPath(offer)
  if (/poll/.test(signature) || /\/poll(?:\/|$)/.test(pathname)) return 'interactive-poll'
  if (
    /quiz|this.?or.?that|supersonic|lightspeed/.test(signature) ||
    /\/(?:quiz|this-or-that)(?:\/|$)/.test(pathname)
  ) {
    return 'interactive-quiz'
  }

  // A hash obtained from the flyout is not proof that it is valid for the
  // current Next.js Server Action. Prefer the official card in that case.
  if (offer.source === 'rsc' && offer.hash && reportActivityAvailable) {
    return 'report-activity'
  }
  if (hasSafeNavigationTarget(offer)) return 'navigate-only'
  return 'unsupported'
}
