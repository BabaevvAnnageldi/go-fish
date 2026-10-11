import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGame, applyAction, legalRanks, makeRng, RANKS, GameError } from '../src/engine.js';
import { checkInvariants } from './helpers.js';

const GAMES_PER_MODE = 3000; // x2 modes = 6,000 games
const MAX_ACTIONS = 5000;

function playOut(seed, fishYourWish) {
  const rng = makeRng(seed ^ 0x9e3779b9);
  let g = createGame({ seed, fishYourWish, starter: seed & 1, names: ['A', 'B'] });
  let errs = checkInvariants(g);
  if (errs.length) return { error: `seed ${seed} after deal: ${errs.join('; ')}` };
  let actions = 0;
  let lastSeq = g.seq;
  while (g.phase === 'playing') {
    if (++actions > MAX_ACTIONS) return { error: `seed ${seed}: did not terminate in ${MAX_ACTIONS} actions` };
    const p = g.turn;
    const legal = legalRanks(g, p);
    if (!legal.length) return { error: `seed ${seed}: active player ${p} has no legal ranks while playing` };
    if (legalRanks(g, 1 - p).length) return { error: `seed ${seed}: inactive player has legal ranks` };

    // Occasionally throw an illegal action at the engine; it must be rejected without effect.
    if (rng() < 0.05) {
      const illegal = RANKS.find((r) => !legal.includes(r));
      const bad = illegal ? { type: 'ask', player: p, rank: illegal } : { type: 'ask', player: 1 - p, rank: legal[0] };
      const snap = JSON.stringify(g);
      try { applyAction(g, bad); return { error: `seed ${seed}: illegal action accepted ${JSON.stringify(bad)}` }; }
      catch (e) { if (!(e instanceof GameError)) throw e; }
      if (JSON.stringify(g) !== snap) return { error: `seed ${seed}: rejected action mutated state` };
    }

    const rank = legal[Math.floor(rng() * legal.length)];
    g = applyAction(g, { type: 'ask', player: p, rank });
    errs = checkInvariants(g);
    if (errs.length) return { error: `seed ${seed} action ${actions} (${p} asks ${rank}): ${errs.join('; ')}` };
    if (g.seq <= lastSeq) return { error: `seed ${seed}: seq did not advance` };
    lastSeq = g.seq;
    for (let i = 1; i < g.log.length; i++) {
      if (g.log[i].id <= g.log[i - 1].id) return { error: `seed ${seed}: log ids not increasing` };
    }
  }
  const books = g.players.map((pl) => pl.books.length);
  if (books[0] + books[1] !== 13) return { error: `seed ${seed}: ended with ${books[0] + books[1]} books` };
  if (g.winner !== 0 && g.winner !== 1) return { error: `seed ${seed}: winner ${g.winner}` };
  if (books[g.winner] <= books[1 - g.winner]) return { error: `seed ${seed}: winner does not have most books` };
  if (g.players[0].hand.length || g.players[1].hand.length || g.stock.length) return { error: `seed ${seed}: cards left at end` };
  if (g.log.at(-1).kind !== 'over' || g.log.at(-1).player !== g.winner) return { error: `seed ${seed}: last log entry is not 'over' for the winner` };
  return { actions, books, hadKinds: new Set(g.log.map((e) => e.kind)) };
}

for (const fishYourWish of [false, true]) {
  test(`${GAMES_PER_MODE} random games, fishYourWish=${fishYourWish}: invariants hold after every action`, () => {
    const failures = [];
    let totalActions = 0;
    let maxActions = 0;
    const winners = [0, 0];
    for (let i = 0; i < GAMES_PER_MODE; i++) {
      const seed = (fishYourWish ? 1_000_000 : 0) + i + 1;
      const r = playOut(seed, fishYourWish);
      if (r.error) { failures.push(r.error); if (failures.length >= 5) break; continue; }
      totalActions += r.actions;
      maxActions = Math.max(maxActions, r.actions);
      winners[r.books[0] > r.books[1] ? 0 : 1]++;
    }
    assert.deepEqual(failures, []);
    assert.ok(winners[0] > 0 && winners[1] > 0, 'both seats win sometimes');
    // Sanity: games are of plausible length.
    assert.ok(totalActions / GAMES_PER_MODE > 5, `avg actions ${totalActions / GAMES_PER_MODE}`);
    assert.ok(maxActions < MAX_ACTIONS);
  });
}

test('identical seeds and moves replay identically', () => {
  for (let seed = 1; seed <= 50; seed++) {
    const a = playOut(seed, seed % 2 === 0);
    const b = playOut(seed, seed % 2 === 0);
    assert.equal(a.actions, b.actions);
    assert.deepEqual(a.books, b.books);
  }
});
