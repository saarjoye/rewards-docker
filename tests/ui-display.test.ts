import { expect, it } from 'vitest'
import {
  points,
  clockTime,
  duration,
  versionLabel,
  friendlyTaskDisplayName
} from '../src/web/ui/display'

it('formats the application version for the web header', () => {
  expect(versionLabel('5.0.0-next.15')).toBe('v5.0.0-next.15')
  expect(versionLabel('')).toBe('vdevelopment')
  expect(versionLabel(null)).toBe('vdevelopment')
})

it('keeps unknown, real zero and negative point values separate', () => {
  expect(points(null)).toBe('—')
  expect(points(Number.NaN)).toBe('—')
  expect(points(0)).toBe('0 分')
  expect(points(-20)).toBe('-20 分')
})

it('formats Shanghai time and rejects invalid or reversed time intervals', () => {
  expect(clockTime('2026-09-07T16:00:00Z')).toContain('2026/9/8')
  expect(clockTime('invalid')).toBe('—')
  expect(duration('2026-09-08T00:00:00Z', '2026-09-08T01:02:03Z')).toBe('1时2分3秒')
  expect(duration('invalid', 'invalid')).toBe('—')
  expect(duration('2026-09-08T01:00:00Z', '2026-09-08T00:00:00Z')).toBe('—')
})

it('transforms raw internal English task IDs to friendly Chinese names', () => {
  expect(
    friendlyTaskDisplayName({
      taskId: 'ENUS_readarticle_301_03_20261012',
      displayName: 'ENUS_readarticle_301_03_20261012',
      type: 'read-to-earn'
    })
  ).toBe('MSN 资讯阅读')

  expect(
    friendlyTaskDisplayName({
      taskId: 'pc-search',
      displayName: 'pc-search',
      type: 'pc-search'
    })
  ).toBe('PC 必应搜索')

  expect(
    friendlyTaskDisplayName({
      taskId: 'mobile-search',
      displayName: 'mobile-search',
      type: 'mobile-search'
    })
  ).toBe('移动必应搜索')

  expect(
    friendlyTaskDisplayName({
      taskId: 'app-check-in',
      type: 'app-check-in'
    })
  ).toBe('每日签到')

  expect(
    friendlyTaskDisplayName({
      taskId: 'daily-set',
      displayName: '合成每日任务',
      type: 'daily-set'
    })
  ).toBe('合成每日任务')
})
