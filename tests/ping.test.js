import { test } from 'node:test';
import assert from 'node:assert/strict';
import { median, addSample, pingQuality } from '../src/ping.js';

test('median of odd/even sample sets, NaN when empty', () => {
  assert.equal(median([120]), 120);
  assert.equal(median([300, 100, 200]), 200);
  assert.equal(median([100, 400, 200, 300]), 250);
  assert.ok(Number.isNaN(median([])));
});

test('median ignores a one-off spike', () => {
  assert.equal(median([110, 115, 2400, 112, 118]), 115);
});

test('addSample keeps the last 5 plausible samples and never mutates', () => {
  let s = [];
  for (const r of [1, 2, 3, 4, 5, 6, 7]) s = addSample(s, r);
  assert.deepEqual(s, [3, 4, 5, 6, 7]);
  const frozen = Object.freeze([10]);
  assert.deepEqual(addSample(frozen, 20), [10, 20]);
  for (const bad of [-5, NaN, Infinity, 60000, undefined]) assert.equal(addSample(frozen, bad), frozen);
});

test('pingQuality thresholds', () => {
  assert.equal(pingQuality(40), 'good');
  assert.equal(pingQuality(149), 'good');
  assert.equal(pingQuality(150), 'fair');
  assert.equal(pingQuality(299), 'fair');
  assert.equal(pingQuality(300), 'poor');
});
