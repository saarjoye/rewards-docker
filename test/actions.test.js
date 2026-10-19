import test from 'node:test';
import assert from 'node:assert/strict';
import { getRandomSearchWord } from '../src/browser/actions.js';

test('getRandomSearchWord 随机热搜词生成且非空', () => {
  for (let i = 0; i < 10; i++) {
    const word = getRandomSearchWord();
    assert.ok(typeof word === 'string' && word.length > 2);
  }
});
