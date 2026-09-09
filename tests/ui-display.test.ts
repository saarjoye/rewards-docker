import { expect, it } from 'vitest'
import { points, clockTime, duration } from '../src/web/ui/display'

it('keeps unknown, real zero and negative point values separate', () => {
  expect(points(null)).toBe('待确认')
  expect(points(Number.NaN)).toBe('待确认')
  expect(points(0)).toBe('0 分')
  expect(points(-20)).toBe('-20 分')
})

it('formats Shanghai time and rejects invalid or reversed time intervals', () => {
  expect(clockTime('2026-09-07T16:00:00Z')).toContain('2026/9/8')
  expect(clockTime('invalid')).toBe('待确认')
  expect(duration('2026-09-08T00:00:00Z', '2026-09-08T01:02:03Z')).toBe('1时2分3秒')
  expect(duration('invalid', 'invalid')).toBe('待确认')
  expect(duration('2026-09-08T01:00:00Z', '2026-09-08T00:00:00Z')).toBe('待确认')
})
