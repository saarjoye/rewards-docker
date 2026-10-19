import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeCid,
  normalizeRuid,
  verifyIdentityConsistency,
  parseWlsInfo
} from '../src/identity/auth.js';

test('normalizeCid 规范化 CID', () => {
  assert.equal(normalizeCid('00058F47B6D3BEA1C91'), '58f47b6d3bea1c91');
  assert.equal(normalizeCid('58f4-7b6d-3bea-1c91'), '58f47b6d3bea1c91');
});

test('normalizeRuid 剥离区域前缀', () => {
  assert.equal(normalizeRuid('hk-96202fa2da0fbcd246'), '96202FA2DA0FBCD246');
  assert.equal(normalizeRuid('USW-ABCDEF123456'), 'ABCDEF123456');
});

test('verifyIdentityConsistency 严格同源校验', () => {
  const matchRes = verifyIdentityConsistency('58f47b6d3bea1c91', '58f47b6d3bea1c91');
  assert.equal(matchRes.match, true);

  const mismatchRes = verifyIdentityConsistency('58f47b6d3bea1c91', '9999999999999999');
  assert.equal(mismatchRes.match, false);
});

test('parseWlsInfo 从 WLS Cookie 中解析 CID 与用户昵称', () => {
  const cookies = [
    { name: 'WLS', value: 'C%3D58f47b6d3bea1c91%26N%3DOctavia' },
    { name: '_U', value: 'some_session_hash' }
  ];
  const wls = parseWlsInfo(cookies);
  assert.equal(wls.cid, '58f47b6d3bea1c91');
  assert.equal(wls.name, 'Octavia');
});
