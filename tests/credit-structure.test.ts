import { expect, it } from 'vitest'
import { inspectCreditStructure } from '../src/rewards/CreditStructure.js'

it('reports only fixed field names and types, never values or arbitrary keys', () => {
  const report = inspectCreditStructure({
    response: {
      balance: 12345,
      promotions: [
        {
          attributes: {
            offerid: 'private-offer',
            pointprogress: '30',
            earnedPoints: 30,
            creditId: 'private-credit',
            'private-key': 'private-value'
          }
        }
      ],
      credentials: { earnedPoints: 999 }
    }
  })
  expect(report.fields).toEqual(
    expect.arrayContaining([
      { field: 'earnedpoints', types: ['number'], occurrences: 1 },
      { field: 'creditid', types: ['string'], occurrences: 1 }
    ])
  )
  expect(JSON.stringify(report)).not.toMatch(/private|12345|999/)
  expect(report.hasUninspectedBranches).toBe(true)
})

it('does not execute getters or parse strings and bounds traversal', () => {
  const input = {
    response: {
      attributes: '{"creditId":"hidden"}',
      get balance() {
        throw new Error('getter')
      }
    }
  }
  expect(inspectCreditStructure(input).fields).toEqual([])
  expect(inspectCreditStructure({ response: new Array(20_000).fill(null) }).truncated).toBe(true)
})
