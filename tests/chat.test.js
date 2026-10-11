import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanText, isValidMessage, makeMessage, appendMessage, CHAT_LIMIT, MAX_LEN } from '../src/chat.js';

test('cleanText trims, collapses whitespace, strips control chars, rejects non-strings', () => {
  assert.equal(cleanText('  hi   there \n\t you  '), 'hi there you');
  assert.equal(cleanText('a\u0000b\u0007c'), 'a b c');
  assert.equal(cleanText(''), '');
  assert.equal(cleanText('   '), '');
  for (const bad of [null, undefined, 42, {}, ['x']]) assert.equal(cleanText(bad), '');
});

test('cleanText caps at MAX_LEN characters without splitting emoji', () => {
  assert.equal(Array.from(cleanText('x'.repeat(1000))).length, MAX_LEN);
  const capped = cleanText('🐟'.repeat(MAX_LEN + 50));
  assert.equal(Array.from(capped).length, MAX_LEN);
  assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])/.test(capped), 'no lone surrogate');
});

test('cleanText keeps HTML as plain text (rendering uses textContent)', () => {
  assert.equal(cleanText('<img src=x onerror=alert(1)>'), '<img src=x onerror=alert(1)>');
});

test('makeMessage numbers messages sequentially; appendMessage caps history', () => {
  let list = [];
  for (let i = 0; i < CHAT_LIMIT + 25; i++) list = appendMessage(list, makeMessage(list, i % 2, `m${i}`, 1000 + i));
  assert.equal(list.length, CHAT_LIMIT);
  assert.equal(list[0].text, 'm25');
  assert.equal(list.at(-1).id, CHAT_LIMIT + 25);
  for (let i = 1; i < list.length; i++) assert.equal(list[i].id, list[i - 1].id + 1);
});

test('appendMessage does not mutate the input list', () => {
  const list = Object.freeze([makeMessage([], 0, 'a', 1)]);
  const next = appendMessage(list, makeMessage(list, 1, 'b', 2));
  assert.equal(list.length, 1);
  assert.equal(next.length, 2);
});

test('isValidMessage rejects malformed messages', () => {
  const ok = { id: 1, from: 0, text: 'hi', ts: 1 };
  assert.ok(isValidMessage(ok));
  for (const bad of [null, 'hi', { ...ok, id: 1.5 }, { ...ok, from: 2 }, { ...ok, text: '' }, { ...ok, text: 5 },
    { ...ok, text: 'x'.repeat(MAX_LEN + 1) }, { ...ok, ts: NaN }, { ...ok, ts: undefined }]) {
    assert.equal(isValidMessage(bad), false, JSON.stringify(bad));
  }
});
