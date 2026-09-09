import { describe, expect, it } from 'vitest'
import { matchOfferAnchor, sameOfferUrl } from '../src/browser/OfferMatching.js'

describe('safe offer matching', () => {
  it('normalizes HTTPS hosts, default ports, trailing slashes and tracking only', () => {
    expect(
      sameOfferUrl(
        'https://EXAMPLE.test:443/reward/?utm_source=bing&offer=1',
        'https://example.test/reward?offer=1'
      )
    ).toBe(true)
    expect(
      sameOfferUrl('https://example.test/reward?offer=2', 'https://example.test/reward?offer=1')
    ).toBe(false)
    expect(sameOfferUrl('http://example.test/reward', 'https://example.test/reward')).toBe(false)
    expect(
      sameOfferUrl('https://user:synthetic@example.test/reward', 'https://example.test/reward')
    ).toBe(false)
  })
  it('preserves Bing search query, filters and other business parameters', () => {
    const url = 'https://www.bing.com/search?q=topic&filters=offer1'
    expect(sameOfferUrl(url, 'https://cn.bing.com/search/?filters=offer1&q=topic&FORM=test')).toBe(
      true
    )
    expect(sameOfferUrl(url, 'https://bing.com/search?q=other&filters=offer1')).toBe(false)
    expect(sameOfferUrl(url, 'https://bing.com/search?q=topic&filters=offer2')).toBe(false)
    expect(sameOfferUrl(url, 'https://bing.com/search?q=topic&filters=offer1&campaign=2')).toBe(
      false
    )
  })
  it('requires a unique identity fallback and never overrides a different Bing query', () => {
    const identity = { sourceTaskId: 'offer1', displayName: 'Synthetic task' }
    const candidate = {
      href: 'https://rewards.bing.com/activate',
      offerId: 'offer1',
      destinationUrl: 'https://bing.com/search?q=topic'
    }
    expect(matchOfferAnchor([candidate], candidate.destinationUrl, identity).index).toBe(0)
    expect(matchOfferAnchor([candidate, candidate], candidate.destinationUrl, identity).index).toBe(
      -1
    )
    expect(
      matchOfferAnchor(
        [{ ...candidate, href: 'https://bing.com/search?q=other' }],
        candidate.destinationUrl,
        identity
      ).index
    ).toBe(-1)
    expect(
      matchOfferAnchor(
        [{ ...candidate, href: 'https://evil.test/activate' }],
        candidate.destinationUrl,
        identity
      ).index
    ).toBe(-1)
  })
})
