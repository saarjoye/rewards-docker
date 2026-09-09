import { describe, expect, it } from 'vitest'

import {
  buildRewardsQuestRouterStateTree,
  parseDashboardPayload,
  parseRewardsHtml
} from '../src/rewards/DashboardParser.js'

describe('dashboard parser', () => {
  it('accepts a strict dashboard regardless of transport content type', () => {
    const parsed = parseDashboardPayload(
      {
        dashboard: {
          userStatus: {
            isRewardsUser: true,
            market: 'cn',
            availablePoints: 14202,
            counters: {
              pcSearch: [{ pointProgress: 0, pointProgressMax: 60 }]
            }
          }
        }
      },
      'legacy-getuserinfo'
    )
    expect(parsed.availablePoints.value).toBe(14202)
    expect(parsed.market).toMatchObject({ availability: 'valid', value: 'CN' })
    expect(parsed.pcSearch).toMatchObject({
      availability: 'valid',
      value: { completed: 0, total: 60, remaining: 60 }
    })
    expect(parsed.mobileSearch.availability).toBe('missing')
  })

  it('keeps missing and invalid market evidence distinct', () => {
    const missing = parseDashboardPayload(
      { dashboard: { userStatus: { isRewardsUser: true, availablePoints: 1, counters: {} } } },
      'legacy-getuserinfo'
    )
    const invalid = parseDashboardPayload(
      {
        dashboard: {
          userStatus: { isRewardsUser: true, availablePoints: 1, market: 'zh-CN', counters: {} }
        }
      },
      'legacy-getuserinfo'
    )
    expect(missing.market.availability).toBe('missing')
    expect(invalid.market.availability).toBe('invalid')
  })

  it('reads a two-letter market only from nested user-profile scopes', () => {
    const parsed = parseDashboardPayload(
      {
        flyoutResult: {
          userStatus: { isRewardsUser: true, availablePoints: 1, counters: {} },
          userInfo: { profile: { countryCode: 'cn' } },
          promotions: [{ country: 'US' }]
        }
      },
      'bing-flyout'
    )
    expect(parsed.market).toMatchObject({ availability: 'valid', value: 'CN' })
  })

  it('keeps missing, empty and invalid PC counters distinct', () => {
    const make = (pcSearch: unknown, included = true) =>
      parseDashboardPayload(
        {
          dashboard: {
            userStatus: {
              isRewardsUser: true,
              availablePoints: 1,
              counters: included ? { pcSearch } : {}
            }
          }
        },
        'legacy-getuserinfo'
      ).pcSearch.availability

    expect(make(undefined, false)).toBe('missing')
    expect(make([])).toBe('empty')
    expect(make({})).toBe('invalid')
    expect(make([{ pointProgress: 70, pointProgressMax: 60 }])).toBe('invalid')
  })

  it('keeps only the current local business date from dashboard daily sets', () => {
    const parsed = parseDashboardPayload(
      {
        dashboard: {
          userStatus: { isRewardsUser: true, availablePoints: 1, counters: {} },
          dailySetPromotions: {
            '09/04/2026': [
              { offerId: 'daily-current', hash: 'current', activityType: 11, pointProgressMax: 10 }
            ],
            '09/05/2026': [
              { offerId: 'daily-future', hash: 'future', activityType: 11, pointProgressMax: 10 }
            ]
          }
        }
      },
      'legacy-getuserinfo',
      '2026-09-04T16:30:00.000Z',
      '2026-09-04'
    )

    expect(parsed.offers.map((offer) => offer.sourceTaskId)).toEqual(['daily-current'])
  })

  it('filters future daily offers embedded in Next.js Flight data', () => {
    const chunk = JSON.stringify(
      'x:{"offerId":"daily-current","hash":"a","activityType":11,"pointProgressMax":10,"attributes":{"daily_set_date":"09/04/2026"}}' +
        'y:{"offerId":"daily-future","hash":"b","activityType":11,"pointProgressMax":10,"attributes":{"daily_set_date":"09/05/2026"}}'
    )
    const parsed = parseRewardsHtml(
      `<script>self.__next_f.push([1,${chunk}])</script>`,
      undefined,
      '2026-09-04'
    )

    expect(parsed.offers.map((offer) => offer.sourceTaskId)).toEqual(['daily-current'])
  })

  it('parses offers and balances from Next.js Flight without inventing zero', () => {
    const chunk = JSON.stringify(
      'x:{"offerId":"offer-1","title":"Synthetic task","hash":"abc","points":5,"isCompleted":false}'
    )
    const html = `<script>self.__next_f.push([1,${chunk}])</script>`
    const parsed = parseRewardsHtml(html)
    expect(parsed.offers).toHaveLength(1)
    expect(parsed.offers[0]).toMatchObject({ sourceTaskId: 'offer-1', executable: true })
    expect(parsed.availablePoints.availability).toBe('missing')
    expect(parsed.availablePoints.value).toBeUndefined()
  })

  it('keeps an incomplete offerId/hash fragment visible but non-executable', () => {
    const chunk = JSON.stringify('x:{"offerId":"partial","hash":"abc","isCompleted":false}')
    const html = `<script>self.__next_f.push([1,${chunk}])</script>`
    const parsed = parseRewardsHtml(html)
    expect(parsed.offers).toHaveLength(1)
    expect(parsed.offers[0]).toMatchObject({ sourceTaskId: 'partial', executable: false })
  })

  it('derives the encoded router state tree from the parsed Rewards route', () => {
    const parsed = parseRewardsHtml('<html></html>', 'dashboard')
    expect(parsed.routerStateTree).toBeDefined()
    const tree = JSON.parse(decodeURIComponent(parsed.routerStateTree ?? '')) as unknown[]
    expect(tree).toEqual([
      '',
      {
        children: [
          '(nav)',
          {
            children: ['dashboard', { children: ['PAGE', {}, null, null, 4096] }, null, null, 4096]
          },
          null,
          null,
          4096
        ]
      },
      null,
      null,
      4112
    ])

    const quest = JSON.parse(decodeURIComponent(buildRewardsQuestRouterStateTree('quest-1'))) as [
      unknown,
      {
        children: [
          unknown,
          { children: [unknown, { children: [unknown, { children: unknown[] }] }] }
        ]
      }
    ]
    expect(quest[1].children[1].children[1].children[1].children[0]).toEqual([
      'questId',
      'quest-1',
      'd',
      null
    ])
  })

  it('classifies only explicit App task families and keeps unrelated records unknown', () => {
    const observedAt = '2026-09-04T06:00:00.000Z'
    const parsed = parseDashboardPayload(
      {
        response: {
          balance: 100,
          profile: { country: 'CN' },
          promotions: [
            {
              attributes: {
                offerid: 'synthetic-sapphire',
                type: 'sapphire',
                complete: 'false',
                progress: '0',
                max: '10',
                give_eligible: 'false',
                hidden: 'false'
              }
            },
            {
              attributes: {
                offerid: 'synthetic-readarticle',
                type: 'msnreadearn',
                complete: 'false',
                pointprogress: '9',
                pointmax: '30',
                give_eligible: 'false'
              }
            },
            {
              attributes: {
                offerid: 'synthetic-checkin',
                type: 'checkin',
                complete: 'false',
                progress: '76',
                max: '11760',
                last_updated: observedAt
              }
            },
            {
              attributes: {
                offerid: 'synthetic-banner',
                type: 'referral-banner',
                complete: 'false',
                progress: '0',
                max: '10'
              }
            },
            {
              attributes: {
                offerid: 'synthetic-pending-checkin',
                type: 'checkin',
                complete: 'false',
                progress: '0',
                max: '1',
                give_eligible: 'true',
                hidden: 'true'
              }
            },
            {
              attributes: {
                offerid: 'synthetic-visible-checkin',
                type: 'checkin',
                complete: 'false',
                progress: '0',
                max: '1',
                give_eligible: 'false',
                hidden: 'false'
              }
            }
          ]
        }
      },
      'app-dashboard',
      observedAt
    )

    expect(parsed.offers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceTaskId: 'synthetic-sapphire',
          type: 'app-activity',
          executable: true,
          completed: 0,
          total: 10
        }),
        expect.objectContaining({
          sourceTaskId: 'synthetic-readarticle',
          type: 'read-to-earn',
          executable: true,
          completed: 9,
          total: 30
        }),
        expect.objectContaining({
          sourceTaskId: 'synthetic-checkin',
          type: 'app-check-in',
          complete: true,
          executable: false,
          completed: 1,
          total: 1
        }),
        expect.objectContaining({
          sourceTaskId: 'synthetic-banner',
          type: 'unknown',
          executable: false
        }),
        expect.objectContaining({
          sourceTaskId: 'synthetic-pending-checkin',
          type: 'app-check-in',
          complete: false,
          executable: false,
          completed: 0,
          total: 1
        }),
        expect.objectContaining({
          sourceTaskId: 'synthetic-visible-checkin',
          type: 'app-check-in',
          complete: false,
          executable: true,
          completed: 0,
          total: 1
        })
      ])
    )
  })
})
