import test from 'node:test';
import assert from 'node:assert/strict';
import {
  findBalancedEnd,
  normalizeFlightFragment,
  extractOfferObjects,
  concatFlightChunks,
  extractJsonArray
} from '../src/contracts/flightParse.js';

test('findBalancedEnd 括号配平测试', () => {
  const text = '[1, 2, [3, 4], "nested ] bracket", 5]';
  const end = findBalancedEnd(text, 0, '[', ']');
  assert.equal(end, text.length - 1);
});

test('normalizeFlightFragment 多层转义还原', () => {
  const escaped = '\\u0022activityCards\\u0022:\\\"[1,2,3]\\\"';
  const normalized = normalizeFlightFragment(escaped);
  assert.ok(normalized.includes('"activityCards"'));
});

test('extractOfferObjects 提取任务卡片对象', () => {
  const flightSample = `
    {"foo":"bar"}
    {"offerId":"ZHstar_Rewards_DailyGlobalOffer_Evergreen_Monday","pointProgress":5,"hash":"abc123"}
    {"other":"data"}
  `;
  const offers = extractOfferObjects(flightSample);
  assert.equal(offers.length, 1);
  assert.ok(offers[0].includes('ZHstar_Rewards_DailyGlobalOffer_Evergreen_Monday'));
});

test('concatFlightChunks 拼接 Next.js Flight 片段', () => {
  const html = `
    <script>self.__next_f.push([1,"{\\"page\\":"])</script>
    <script>self.__next_f.push([1,"\\"dashboard\\"}"])</script>
  `;
  const combined = concatFlightChunks(html);
  assert.equal(combined, '{"page":"dashboard"}');
});

test('extractJsonArray 提取数组字面量', () => {
  const text = 'prefix "activityCards" : [ {"id":1}, {"id":2} ] suffix';
  const arrStr = extractJsonArray(text, 'activityCards');
  assert.equal(arrStr, '[ {"id":1}, {"id":2} ]');
});
