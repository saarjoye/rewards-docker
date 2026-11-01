import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveHarvestReport } from '../src/contracts/harvestReport.js';

test('真实领到额外积分时，本次收割必须是真实分数（余额差优先）', () => {
  const report = resolveHarvestReport({
    claimStatus: 'claimed',
    claimPoints: 3,
    beforeBalance: 18385,
    finalBalance: 18388,
    runDelta: 0
  });
  assert.equal(report.claimAmount, 3);
  assert.equal(report.harvestedPoints, 3);
  assert.match(report.statusText, /额外积分 \+3 分已入账/);
});

test('余额差缺失时回落到卡片读数，绝不显示 0', () => {
  const report = resolveHarvestReport({
    claimStatus: 'claimed',
    claimPoints: 100,
    beforeBalance: null,
    finalBalance: null
  });
  assert.equal(report.claimAmount, 100);
  assert.equal(report.harvestedPoints, 100);
});

test('任务积分 + 收割积分要合并计入本次收割', () => {
  const report = resolveHarvestReport({
    claimStatus: 'claimed',
    claimPoints: 5,
    beforeBalance: 1000,
    finalBalance: 1005,
    runDelta: 177
  });
  assert.equal(report.claimAmount, 5);
  assert.equal(report.runPoints, 177);
  assert.equal(report.harvestedPoints, 182);
  assert.match(report.statusText, /本次共 \+182 分/);
});

test('官网没有待领取积分时不再谎报"已核验到账 (+0 分)"', () => {
  const emptyNoRun = resolveHarvestReport({ claimStatus: 'already-empty', runDelta: 0 });
  assert.equal(emptyNoRun.harvestedPoints, 0);
  assert.match(emptyNoRun.statusText, /无待领取额外积分/);
  assert.ok(!/已核验到账/.test(emptyNoRun.statusText));

  const emptyWithRun = resolveHarvestReport({ claimStatus: 'already-empty', runDelta: 177 });
  assert.equal(emptyWithRun.harvestedPoints, 177);
  assert.match(emptyWithRun.statusText, /本次任务积分 \+177 分/);
});

test('未确认到账时不虚报分数', () => {
  const report = resolveHarvestReport({
    claimStatus: 'unverified',
    claimPoints: 3,
    beforeBalance: 100,
    finalBalance: 100,
    runDelta: 0
  });
  assert.equal(report.claimAmount, 0);
  assert.equal(report.harvestedPoints, 0);
  assert.match(report.statusText, /未确认到账/);
});
