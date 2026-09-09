import { describe, expect, it } from 'vitest'

import { webOfferExecutionPath } from '../src/rewards/OfferExecution.js'
import type { RewardOffer } from '../src/rewards/RewardsModel.js'

function offer(overrides: Partial<RewardOffer> = {}): RewardOffer {
  return {
    sourceTaskId: 'synthetic-offer',
    type: 'daily-set',
    source: 'rsc',
    displayName: 'Synthetic offer',
    completed: 0,
    total: 10,
    complete: false,
    executable: true,
    hash: 'synthetic-hash',
    destinationUrl: 'https://example.test/reward',
    ...overrides
  }
}

describe('web offer execution policy', () => {
  it('uses reportActivity only for a hash observed in RSC', () => {
    expect(webOfferExecutionPath(offer(), true)).toBe('report-activity')
    expect(webOfferExecutionPath(offer(), false)).toBe('navigate-only')
  })

  it('uses the official navigation target for a flyout offer instead of an RSC action', () => {
    expect(webOfferExecutionPath(offer({ source: 'bing-flyout' }), true)).toBe('navigate-only')
    const withoutDestination = offer({ source: 'bing-flyout' })
    delete withoutDestination.destinationUrl
    expect(webOfferExecutionPath(withoutDestination, true)).toBe('unsupported')
  })

  it('keeps Quiz and poll activities on explicit interactive paths', () => {
    expect(webOfferExecutionPath(offer({ attributes: { promotionType: 'quiz' } }), true)).toBe(
      'interactive-quiz'
    )
    expect(webOfferExecutionPath(offer({ attributes: { type: 'poll' } }), true)).toBe(
      'interactive-poll'
    )
    expect(
      webOfferExecutionPath(
        offer({ destinationUrl: 'https://example.test/rewards/quiz?campaign=synthetic' }),
        true
      )
    ).toBe('interactive-quiz')
    expect(
      webOfferExecutionPath(
        offer({ destinationUrl: 'https://example.test/rewards/poll?campaign=synthetic' }),
        true
      )
    ).toBe('interactive-poll')
  })

  it('does not classify a normal Bing search as a Quiz from query text alone', () => {
    expect(
      webOfferExecutionPath(
        offer({
          sourceTaskId: 'daily-search-card',
          destinationUrl:
            'https://www.bing.com/search?q=quiz+topic&filters=IsConversation%3A%22True%22'
        }),
        false
      )
    ).toBe('navigate-only')
  })

  it('does not navigate to a non-HTTPS destination', () => {
    const insecure = offer({ source: 'bing-flyout', destinationUrl: 'http://example.test' })
    delete insecure.hash
    expect(webOfferExecutionPath(insecure, true)).toBe('unsupported')
  })
})
