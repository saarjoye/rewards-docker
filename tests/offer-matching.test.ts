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
  it('uses visible task text only with a trusted destination and unique candidate', () => {
    const candidate = {
      href: 'https://rewards.bing.com/activate',
      text: 'Synthetic task',
      destinationUrl: 'https://bing.com/search?q=topic'
    }
    const identity = { sourceTaskId: 'offer1', displayName: 'Synthetic task' }
    expect(matchOfferAnchor([candidate], candidate.destinationUrl, identity).index).toBe(0)
    expect(matchOfferAnchor([candidate, candidate], candidate.destinationUrl, identity).index).toBe(
      -1
    )
    expect(
      matchOfferAnchor([candidate], 'https://bing.com/search?q=different', identity).index
    ).toBe(-1)
  })
})

describe('compatible identity disambiguation', () => {
  const destination = 'https://www.bing.com/search?q=synthetic&filters=offer-1'
  const identity = { sourceTaskId: 'offer-1', displayName: 'Synthetic card' }

  it('keeps the existing unique URL path without requiring new metadata', () => {
    expect(matchOfferAnchor([{ href: destination }], destination, identity)).toMatchObject({
      index: 0,
      method: 'url'
    })
  })

  it('disambiguates repeated URLs only with a unique matching official task ID', () => {
    expect(
      matchOfferAnchor(
        [
          { href: destination, offerId: 'other-offer' },
          { href: destination, offerId: 'offer-1' }
        ],
        destination,
        identity
      )
    ).toMatchObject({ index: 1, method: 'url-identity' })
  })

  it('uses a unique exact card label only when task IDs do not conflict', () => {
    expect(
      matchOfferAnchor(
        [
          { href: destination, cardLabel: 'Another card' },
          { href: destination, cardLabel: 'Synthetic card' }
        ],
        destination,
        identity
      )
    ).toMatchObject({ index: 1, method: 'url-name' })
  })

  it('does not infer identity by eliminating another card from repeated URLs', () => {
    const anchors = [{ href: destination, offerId: 'other-offer' }, { href: destination }]
    expect(matchOfferAnchor(anchors, destination, identity)).toMatchObject({
      index: -1,
      method: 'ambiguous'
    })
    expect(
      matchOfferAnchor(
        [
          { href: destination, offerId: 'other-offer' },
          { href: destination, cardLabel: 'Synthetic card' }
        ],
        destination,
        identity
      )
    ).toMatchObject({ index: 1, method: 'url-name' })
  })

  it('never uses matching text to override an explicit conflicting task ID', () => {
    expect(
      matchOfferAnchor(
        [{ href: destination, offerId: 'other-offer', text: 'Synthetic card' }],
        destination,
        identity
      ).index
    ).toBe(-1)
  })

  it('preserves ambiguity for duplicated IDs, missing identity and duplicated names', () => {
    for (const anchors of [
      [
        { href: destination, offerId: 'offer-1' },
        { href: destination, offerId: 'offer-1' }
      ],
      [{ href: destination }, { href: destination }],
      [
        { href: destination, text: 'Synthetic card' },
        { href: destination, text: 'Synthetic card' }
      ]
    ])
      expect(matchOfferAnchor(anchors, destination, identity).index).toBe(-1)
  })

  it('rejects stale destination metadata, hidden candidates and conflicting business queries', () => {
    const other = 'https://www.bing.com/search?q=other&filters=offer-1'
    for (const candidate of [
      { href: destination, offerId: 'offer-1', destinationUrl: other },
      { href: destination, offerId: 'offer-1', visible: false },
      { href: other, offerId: 'offer-1', text: 'Synthetic card' }
    ])
      expect(matchOfferAnchor([candidate], destination, identity).index).toBe(-1)
  })

  it('prefers ID evidence over a name-only wrapper, without dropping the destination constraint', () => {
    const wrapper = 'https://rewards.bing.com/activate'
    expect(
      matchOfferAnchor(
        [
          { href: wrapper, text: 'Synthetic card', destinationUrl: destination },
          { href: wrapper, offerId: 'offer-1', destinationUrl: destination }
        ],
        destination,
        identity
      )
    ).toMatchObject({ index: 1, method: 'identity-destination' })
  })
})
