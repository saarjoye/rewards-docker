import { describe, expect, it } from 'vitest'

import { classifyAppOffer, summarizeAppOffers } from '../src/acceptance/AppOfferAudit.js'
import type { RewardOffer } from '../src/rewards/RewardsModel.js'

function offer(input: {
  id: string
  type?: string
  complete?: boolean
  total?: number | null
}): RewardOffer {
  return {
    sourceTaskId: input.id,
    type: 'app-activity',
    source: 'app-dashboard',
    displayName: `Sensitive ${input.id}`,
    completed: 0,
    total: input.total ?? 1,
    complete: input.complete ?? false,
    executable: true,
    ...(input.type ? { attributes: { type: input.type, offerid: input.id } } : {})
  }
}

describe('App offer audit', () => {
  it('classifies only explicit App activity families', () => {
    expect(classifyAppOffer(offer({ id: 'daily', type: 'sapphire' }))).toBe('app-activity')
    expect(classifyAppOffer(offer({ id: 'check', type: 'checkin' }))).toBe('app-check-in')
    expect(classifyAppOffer(offer({ id: 'read', type: 'msnreadearn' }))).toBe('read-to-earn')
    expect(classifyAppOffer(offer({ id: 'unrelated', type: 'other' }))).toBe('unknown')
  })

  it('aggregates safe metadata without identifiers or display text', () => {
    const sensitiveId = 'private-offer-identifier-canary'
    const result = summarizeAppOffers([
      offer({ id: sensitiveId, type: 'sapphire' }),
      offer({ id: 'second', type: 'sapphire', complete: true })
    ])
    expect(result).toEqual([
      {
        kind: 'app-activity',
        sourceType: 'sapphire',
        count: 2,
        completed: 1,
        pending: 1,
        executable: 2,
        progressTotal: 'positive',
        giveEligible: 'missing',
        hidden: 'missing',
        attributeKeys: ['offerid', 'type']
      }
    ])
    expect(JSON.stringify(result)).not.toContain(sensitiveId)
    expect(JSON.stringify(result)).not.toContain('Sensitive')
  })

  it('reports only bounded source type identifiers', () => {
    const safe = summarizeAppOffers([offer({ id: 'safe', type: 'daily_set' })])
    const unsafe = summarizeAppOffers([
      offer({ id: 'unsafe', type: 'person@example.test should not appear' })
    ])
    expect(safe[0]?.sourceType).toBe('daily_set')
    expect(unsafe[0]?.sourceType).toBe('other')
    expect(JSON.stringify(unsafe)).not.toContain('person@example.test')
  })
})
