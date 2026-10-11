import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { createGame, applyAction, viewFor, legalRanks, makeRng } from '../src/engine.js';
import { describeEntry, rankName, cardName } from '../src/ui.js';
import { mkState } from './helpers.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const html = read('index.html');

test('every src module passes node --check', () => {
  const files = readdirSync(join(ROOT, 'src')).filter((f) => f.endsWith('.js'));
  assert.ok(files.length >= 4);
  for (const f of files) execFileSync(process.execPath, ['--check', join(ROOT, 'src', f)], { stdio: 'pipe' });
});

test('every local file referenced by index.html exists', () => {
  const refs = [...html.matchAll(/\b(?:src|href)=["']([^"']+)["']/g)].map((m) => m[1])
    .filter((u) => !/^(https?:|data:|#|mailto:)/.test(u));
  assert.ok(refs.includes('styles.css') && refs.includes('src/main.js'));
  for (const r of refs) assert.ok(existsSync(join(ROOT, r.split(/[?#]/)[0])), `missing ${r}`);
});

test('every element id looked up by main.js / ui.js exists in index.html', () => {
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  const wanted = new Set();
  for (const f of ['src/main.js', 'src/ui.js']) {
    for (const m of read(f).matchAll(/\$\('([^']+)'\)/g)) wanted.add(m[1]);
  }
  // ids reached indirectly through loops in ui.js
  for (const id of ['lobby', 'waiting', 'table', 'myBooks', 'oppBooks']) wanted.add(id);
  assert.ok(wanted.size > 20);
  const missing = [...wanted].filter((id) => !ids.has(id));
  assert.deepEqual(missing, []);
  // class selector used by renderTable
  assert.match(html, /class="[^"]*\bpond-card\b/);
});

test('index.html has no duplicate ids', () => {
  const all = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(all.filter((x, i) => all.indexOf(x) !== i), []);
});

test('log region is aria-live', () => {
  assert.match(html, /id="log"[^>]*aria-live=/);
});

// ---------- describeEntry ----------

const engineKinds = [...new Set([...read('src/engine.js').matchAll(/kind: '([^']+)'/g)].map((m) => m[1]))];

function checkEntry(e, view) {
  const s = describeEntry(e, view);
  assert.equal(typeof s, 'string');
  assert.ok(s.length > 0, `empty description for ${JSON.stringify(e)}`);
  assert.ok(!/undefined|null|NaN|\[object/.test(s), `bad description "${s}" for ${JSON.stringify(e)}`);
}

test('engine emits the expected set of log kinds', () => {
  assert.deepEqual(engineKinds.sort(),
    ['ask', 'book', 'fish', 'fish-empty', 'out', 'over', 'refill', 'start', 'turn'].sort());
});

test('describeEntry returns a non-empty string for every log entry the engine emits (both viewers)', () => {
  const seen = new Set();
  const visit = (g) => {
    for (const p of [0, 1]) {
      const v = viewFor(g, p);
      for (const e of v.log) { seen.add(e.kind); checkEntry(e, v); }
    }
  };
  for (let seed = 1; seed <= 300; seed++) {
    let g = createGame({ seed, fishYourWish: seed % 2 === 0, names: ['Anna', 'Ben'] });
    const rng = makeRng(seed);
    while (g.phase === 'playing') {
      const legal = legalRanks(g, g.turn);
      g = applyAction(g, { type: 'ask', player: g.turn, rank: legal[Math.floor(rng() * legal.length)] });
      if (rng() < 0.1) visit(g);
    }
    visit(g);
  }
  // Rare kinds via hand-crafted states.
  visit(applyAction(mkState({ hands: [['5S', '5H', '5D'], ['5C', '9S']] }), { type: 'ask', player: 0, rank: '5' })); // out
  visit(applyAction(mkState({ hands: [['5S'], ['6S']] }), { type: 'ask', player: 0, rank: '5' })); // fish-empty
  for (const k of engineKinds) assert.ok(seen.has(k), `never saw kind ${k}`);
});

test('describeEntry handles synthetic entries of every kind, incl. a tie', () => {
  const view = { you: 0, names: ['Anna', 'Ben'] };
  const entries = [
    { kind: 'start', player: 0 }, { kind: 'start', player: 1 },
    { kind: 'ask', player: 0, rank: 'K', got: 2 }, { kind: 'ask', player: 1, rank: 'A', got: 0 },
    { kind: 'fish', player: 0, card: '10H', wish: false }, { kind: 'fish', player: 1, wish: false },
    { kind: 'fish', player: 1, card: 'QD', wish: true }, { kind: 'fish-empty', player: 1 },
    { kind: 'book', player: 1, rank: '7' }, { kind: 'refill', player: 0, card: 'AS' }, { kind: 'refill', player: 1 },
    { kind: 'out', player: 0 }, { kind: 'out', player: 1 }, { kind: 'turn', player: 1 },
    { kind: 'over', player: 0 }, { kind: 'over', player: 1 }, { kind: 'over', player: null },
  ];
  for (const e of entries) checkEntry(e, view);
  assert.equal(describeEntry({ kind: 'ask', player: 1, rank: 'K', got: 2 }, view), 'Ben asked for Kings — you gave 2');
  assert.equal(describeEntry({ kind: 'over', player: 1 }, view), 'Ben wins!');
});

test('rankName / cardName', () => {
  assert.equal(rankName('K'), 'Kings');
  assert.equal(rankName('7'), '7s');
  assert.equal(rankName('A', false), 'Ace');
  assert.equal(cardName('10H'), '10♥');
  assert.equal(cardName('QS'), 'Queen♠');
});
