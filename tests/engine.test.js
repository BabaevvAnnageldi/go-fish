import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  createGame, applyAction, viewFor, legalRanks, GameError, RANKS, SUITS, HAND_SIZE, TOTAL_BOOKS,
  fullDeck, rankOf, makeRng, shuffle, sortHand,
} from '../src/engine.js';
import { mkState, deepFreeze, checkInvariants } from './helpers.js';

const ask = (player, rank) => ({ type: 'ask', player, rank });
const kinds = (s) => s.log.map((e) => e.kind);

describe('setup', () => {
  test('constants', () => {
    assert.equal(RANKS.length, 13);
    assert.equal(SUITS.length, 4);
    assert.equal(HAND_SIZE, 7);
    assert.equal(TOTAL_BOOKS, 13);
    assert.equal(new Set(fullDeck()).size, 52);
  });

  test('deal: 7 cards each, 38 in stock, 52 unique (books counted as 4)', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const g = createGame({ seed });
      const booked = g.players[0].books.length + g.players[1].books.length;
      if (booked === 0) {
        assert.equal(g.players[0].hand.length, 7);
        assert.equal(g.players[1].hand.length, 7);
      }
      assert.equal(g.stock.length, 38);
      assert.deepEqual(checkInvariants(g), []);
      assert.equal(g.phase, 'playing');
      assert.equal(g.winner, null);
    }
  });

  test('same seed gives the same game; different seeds differ', () => {
    assert.deepEqual(createGame({ seed: 42 }), createGame({ seed: 42 }));
    assert.notDeepEqual(createGame({ seed: 42 }).stock, createGame({ seed: 43 }).stock);
  });

  test('shuffle is a permutation and does not mutate input', () => {
    const d = fullDeck();
    const copy = d.slice();
    const s = shuffle(d, makeRng(7));
    assert.deepEqual(d, copy);
    assert.deepEqual([...s].sort(), [...d].sort());
    assert.notDeepEqual(s, d);
  });

  test('makeRng output in [0,1) and deterministic', () => {
    const a = makeRng(123), b = makeRng(123);
    for (let i = 0; i < 1000; i++) {
      const x = a();
      assert.equal(x, b());
      assert.ok(x >= 0 && x < 1);
    }
  });

  test('starter option, names, fishYourWish option', () => {
    const g = createGame({ seed: 1, starter: 1, names: ['X', 'Y'], fishYourWish: true });
    assert.equal(g.turn, 1);
    assert.equal(g.players[0].name, 'X');
    assert.equal(g.players[1].name, 'Y');
    assert.equal(g.options.fishYourWish, true);
    assert.deepEqual(g.log[0], { id: 1, kind: 'start', player: 1 });
    assert.equal(createGame({ seed: 1 }).options.fishYourWish, false, 'fish your wish off by default');
    assert.equal(createGame({ seed: 1, starter: 5 }).turn, 0);
  });

  test('state.starter survives a full game even after the capped log drops the start entry', () => {
    for (const starter of [0, 1]) {
      let g = createGame({ seed: 9, starter });
      assert.equal(g.starter, starter);
      const rng = makeRng(9);
      while (g.phase === 'playing') {
        const legal = legalRanks(g, g.turn);
        g = applyAction(g, ask(g.turn, legal[Math.floor(rng() * legal.length)]));
      }
      assert.ok(!g.log.some((e) => e.kind === 'start'), 'start entry was trimmed from the log');
      assert.equal(g.starter, starter, 'starter still known at game end (rematch uses 1 - starter)');
    }
  });

  test('a book dealt in the opening hand is laid down immediately', () => {
    let found = 0;
    for (let seed = 1; seed < 20000 && found < 5; seed++) {
      const deck = shuffle(fullDeck(), makeRng(seed));
      const dealt = [[], []];
      for (let i = 0; i < 7; i++) { dealt[0].push(deck.pop()); dealt[1].push(deck.pop()); }
      for (const p of [0, 1]) {
        const full = RANKS.filter((r) => dealt[p].filter((c) => rankOf(c) === r).length === 4);
        if (!full.length) continue;
        found++;
        const g = createGame({ seed });
        assert.deepEqual(g.players[p].books, full);
        assert.equal(g.players[p].hand.length, 7 - 4 * full.length);
        assert.ok(g.log.some((e) => e.kind === 'book' && e.player === p && e.rank === full[0]));
        assert.deepEqual(checkInvariants(g), []);
      }
    }
    assert.ok(found > 0, 'expected to find a seed with an opening book');
  });

  test('sortHand groups by rank order then suit', () => {
    assert.deepEqual(sortHand(['KS', '2H', 'AS', '10D', '2S']), ['AS', '2S', '2H', '10D', 'KS']);
  });
});

describe('asking', () => {
  test('success: opponent hands over ALL matching cards and asker goes again', () => {
    const s = mkState({ hands: [['5S', '9C'], ['5H', '5D', 'KC']], stock: ['2S', '3S'] });
    const n = applyAction(s, ask(0, '5'));
    assert.deepEqual(sortHand(n.players[0].hand), sortHand(['5S', '9C', '5H', '5D']));
    assert.deepEqual(n.players[1].hand, ['KC']);
    assert.equal(n.turn, 0);
    assert.equal(n.stock.length, 2, 'no draw on a successful ask');
    assert.deepEqual(n.log.at(-1), { id: n.seq, kind: 'ask', player: 0, rank: '5', got: 2 });
  });

  test('go fish: asker draws the top card of the stock and turn passes', () => {
    const s = mkState({ hands: [['5S'], ['KC']], stock: ['2S', '9D'] });
    const n = applyAction(s, ask(0, '5'));
    assert.deepEqual(n.players[0].hand, ['5S', '9D']);
    assert.deepEqual(n.stock, ['2S']);
    assert.equal(n.turn, 1);
    assert.deepEqual(kinds(n), ['ask', 'fish', 'turn']);
    assert.equal(n.log[0].got, 0);
  });

  test('fish your wish OFF: drawing the asked rank still passes the turn', () => {
    const s = mkState({ hands: [['5S'], ['KC']], stock: ['5H'], fishYourWish: false });
    const n = applyAction(s, ask(0, '5'));
    assert.equal(n.turn, 1);
    assert.equal(n.log.find((e) => e.kind === 'fish').wish, false);
  });

  test('fish your wish ON: drawing the asked rank lets asker go again', () => {
    const s = mkState({ hands: [['5S'], ['KC']], stock: ['5H'], fishYourWish: true });
    const n = applyAction(s, ask(0, '5'));
    assert.equal(n.turn, 0);
    assert.equal(n.log.find((e) => e.kind === 'fish').wish, true);
    assert.ok(!kinds(n).includes('turn'));
  });

  test('fish your wish ON: drawing a different rank passes the turn', () => {
    const s = mkState({ hands: [['5S'], ['KC']], stock: ['6H'], fishYourWish: true });
    assert.equal(applyAction(s, ask(0, '5')).turn, 1);
  });

  test('completing a book by asking lays it down and asker goes again', () => {
    const s = mkState({ hands: [['7S', '7H', '2C'], ['7D', '7C', 'KC']], stock: ['3S'] });
    const n = applyAction(s, ask(0, '7'));
    assert.deepEqual(n.players[0].books, ['7']);
    assert.deepEqual(n.players[0].hand, ['2C']);
    assert.equal(n.turn, 0);
    assert.ok(n.log.some((e) => e.kind === 'book' && e.rank === '7' && e.player === 0));
  });

  test('completing a book with a draw (different rank) lets asker go again', () => {
    const s = mkState({ hands: [['5S', '9S', '9H', '9D'], ['KC']], stock: ['9C'] });
    const n = applyAction(s, ask(0, '5'));
    assert.deepEqual(n.players[0].books, ['9']);
    assert.deepEqual(n.players[0].hand, ['5S']);
    assert.equal(n.turn, 0);
  });

  test('completing a book with a draw of the asked rank (wish off) lets asker go again', () => {
    const s = mkState({ hands: [['5S', '5H', '5D'], ['KC']], stock: ['2S', '5C'] });
    const n = applyAction(s, ask(0, '5'));
    assert.deepEqual(n.players[0].books, ['5']);
    // hand emptied by the book -> automatic refill and the player continues
    assert.deepEqual(n.players[0].hand, ['2S']);
    assert.equal(n.turn, 0);
  });

  test('player 1 can ask on their turn', () => {
    const s = mkState({ hands: [['QS'], ['QH', '3C']], stock: ['4D'], turn: 1 });
    const n = applyAction(s, ask(1, 'Q'));
    assert.deepEqual(n.players[1].hand.slice().sort(), ['3C', 'QH', 'QS']);
    assert.equal(n.turn, 1);
    // player 0 now has an empty hand, but it's not their turn: no refill yet
    assert.deepEqual(n.players[0].hand, []);
  });

  test('legalRanks lists exactly the held ranks, only for the active player', () => {
    const s = mkState({ hands: [['KS', '2H', '2S', 'AS'], ['3C']], stock: [] });
    assert.deepEqual(legalRanks(s, 0), ['A', '2', 'K']);
    assert.deepEqual(legalRanks(s, 1), []);
  });
});

describe('validation', () => {
  const s = mkState({ hands: [['5S', '9C'], ['5H', 'KC']], stock: ['2S'] });
  const rejects = (state, action, re) =>
    assert.throws(() => applyAction(state, action), (e) => e instanceof GameError && re.test(e.message));

  test('out-of-turn action rejected', () => rejects(s, ask(1, 'K'), /not your turn/));
  test('unknown ranks rejected', () => {
    for (const r of ['1', 'X', '11', 'k', '', 5, null, undefined, {}, ['5'], '5S']) rejects(s, ask(0, r), /Unknown rank/);
  });
  test('rank not held rejected', () => rejects(s, ask(0, 'K'), /rank you hold/));
  test('unknown player rejected', () => {
    for (const p of [2, -1, '0', null, undefined, 0.5, true]) rejects(s, { type: 'ask', player: p, rank: '5' }, /Unknown player/);
  });
  test('malformed actions rejected', () => {
    for (const a of [null, undefined, 'ask', 42, true]) rejects(s, a, /Malformed/);
    rejects(s, {}, /Unknown player/);
    rejects(s, { type: 'draw', player: 0, rank: '5' }, /Unknown action/);
    rejects(s, { player: 0, rank: '5' }, /Unknown action/);
    rejects(s, [], /Unknown player/);
  });
  test('actions after game over rejected', () => {
    const over = { ...mkState({ hands: [[], []], books: [RANKS.slice(0, 7), RANKS.slice(7)] }), phase: 'over', winner: 0 };
    rejects(over, ask(0, 'A'), /over/);
    assert.deepEqual(legalRanks(over, 0), []);
  });
  test('rejected actions leave state untouched', () => {
    const before = JSON.stringify(s);
    try { applyAction(s, ask(0, 'K')); } catch { /* expected */ }
    assert.equal(JSON.stringify(s), before);
  });
});

describe('edge cases', () => {
  test('empty hand at start of turn draws from the stock', () => {
    // A takes B's only 5; then A goes fish and passes to B whose hand is empty.
    const s = mkState({ hands: [['5S', '6S'], ['5H']], stock: ['QD', '9C'] });
    let n = applyAction(s, ask(0, '5'));
    assert.deepEqual(n.players[1].hand, []);
    assert.equal(n.turn, 0);
    n = applyAction(n, ask(0, '6'));
    assert.equal(n.turn, 1);
    assert.deepEqual(n.players[1].hand, ['QD']);
    assert.deepEqual(n.stock, []);
    const refill = n.log.find((e) => e.kind === 'refill');
    assert.deepEqual({ ...refill, id: 0 }, { id: 0, kind: 'refill', player: 1, card: 'QD' });
    assert.deepEqual(legalRanks(n, 1), ['Q']);
  });

  test('hand emptied mid-turn by a book draws one card and continues', () => {
    const s = mkState({ hands: [['7S', '7H', '7D'], ['7C', '2S']], stock: ['3S', '4H'] });
    const n = applyAction(s, ask(0, '7'));
    assert.deepEqual(n.players[0].books, ['7']);
    assert.deepEqual(n.players[0].hand, ['4H']);
    assert.equal(n.turn, 0);
  });

  test('empty hand and empty stock: player is out and the turn passes', () => {
    const s = mkState({ hands: [['5S', '5H', '5D'], ['5C', '9S']], stock: [] });
    let n = applyAction(s, ask(0, '5'));
    assert.deepEqual(n.players[0].hand, []);
    assert.equal(n.turn, 1);
    assert.ok(n.log.some((e) => e.kind === 'out' && e.player === 0));
    // B asks, A has nothing, pond empty -> pass to A, who is out again -> back to B.
    n = applyAction(n, ask(1, '9'));
    assert.equal(n.turn, 1);
    assert.equal(n.phase, 'playing');
  });

  test('go fish with an empty stock simply passes the turn', () => {
    const s = mkState({ hands: [['5S'], ['6S']], stock: [] });
    const n = applyAction(s, ask(0, '5'));
    assert.equal(n.turn, 1);
    assert.deepEqual(n.players[0].hand, ['5S']);
    assert.deepEqual(kinds(n), ['ask', 'fish-empty', 'turn']);
  });

  test('the final book ends the game; most books wins', () => {
    const s = mkState({
      hands: [['KS', 'KH', 'KD'], ['KC']], stock: [],
      books: [RANKS.slice(0, 6), RANKS.slice(6, 12)],
    });
    const n = applyAction(s, ask(0, 'K'));
    assert.equal(n.phase, 'over');
    assert.equal(n.winner, 0);
    assert.equal(n.log.at(-1).kind, 'over');
    assert.equal(n.log.at(-1).player, 0);
    assert.throws(() => applyAction(n, ask(1, 'A')), GameError);
    assert.deepEqual(legalRanks(n, 0), []);
    assert.deepEqual(legalRanks(n, 1), []);
  });

  test('player making the last book can still lose on book count', () => {
    const s = mkState({
      hands: [['KS', 'KH', 'KD'], ['KC']], stock: [],
      books: [RANKS.slice(0, 5), RANKS.slice(5, 12)],
    });
    const n = applyAction(s, ask(0, 'K'));
    assert.equal(n.phase, 'over');
    assert.equal(n.winner, 1);
  });

  test('final book completed by a fished card ends the game', () => {
    const s = mkState({
      hands: [['KS', 'KH', 'KD'], []], stock: ['KC'],
      books: [RANKS.slice(0, 6), RANKS.slice(6, 12)],
    });
    const n = applyAction(s, ask(0, 'K'));
    assert.equal(n.phase, 'over');
    assert.equal(n.winner, 0);
    assert.equal(n.players[0].books.at(-1), 'K');
  });
});

describe('immutability', () => {
  test('applyAction never mutates its (deep-frozen) input', () => {
    for (let seed = 1; seed <= 200; seed++) {
      let g = createGame({ seed, fishYourWish: seed % 2 === 0 });
      const rng = makeRng(seed * 7 + 1);
      for (let step = 0; step < 400 && g.phase === 'playing'; step++) {
        const snap = JSON.stringify(g);
        deepFreeze(g);
        const legal = legalRanks(g, g.turn);
        const next = applyAction(g, ask(g.turn, legal[Math.floor(rng() * legal.length)]));
        assert.equal(JSON.stringify(g), snap);
        assert.notEqual(next, g);
        g = next;
      }
    }
  });

  test('viewFor does not share references with state', () => {
    const g = createGame({ seed: 9 });
    const v = viewFor(g, 0);
    v.hand.push('XX');
    v.books[0].push('Z');
    v.log[0].kind = 'hacked';
    v.options.fishYourWish = 'x';
    assert.deepEqual(checkInvariants(g), []);
    assert.equal(g.log[0].kind, 'start');
    assert.equal(g.options.fishYourWish, false);
  });
});

describe('redaction (viewFor)', () => {
  // Cards p legitimately knows: their own draws/refills and revealed wishes.
  function knownTo(state, p) {
    const k = new Set(state.players[p].hand);
    for (const e of state.log) if ('card' in e && (e.player === p || e.wish)) k.add(e.card);
    return k;
  }

  function assertRedacted(state, p) {
    const v = viewFor(state, p);
    const json = JSON.stringify(v);
    const known = knownTo(state, p);
    const hidden = [...state.players[1 - p].hand, ...state.stock].filter((c) => !known.has(c));
    for (const c of hidden) assert.ok(!json.includes(`"${c}"`), `view for ${p} leaks hidden card ${c}`);
    for (const c of state.stock) assert.ok(!json.includes(`"${c}"`), `view for ${p} leaks stock card ${c}`);
    assert.deepEqual(Object.keys(v).sort(),
      ['books', 'hand', 'legal', 'log', 'names', 'oppCount', 'options', 'phase', 'seq', 'stockCount', 'turn', 'winner', 'you']);
    assert.equal(v.oppCount, state.players[1 - p].hand.length);
    assert.equal(v.stockCount, state.stock.length);
    assert.deepEqual(v.hand, sortHand(state.players[p].hand));
    for (const e of v.log) if (e.player !== p && 'card' in e) assert.equal(e.wish, true, 'only wish cards revealed');
  }

  test('views across many random games never contain opponent cards or stock', () => {
    for (let seed = 1; seed <= 150; seed++) {
      let g = createGame({ seed, fishYourWish: seed % 2 === 1 });
      const rng = makeRng(seed + 1000);
      while (g.phase === 'playing') {
        assertRedacted(g, 0);
        assertRedacted(g, 1);
        const legal = legalRanks(g, g.turn);
        g = applyAction(g, ask(g.turn, legal[Math.floor(rng() * legal.length)]));
      }
      assertRedacted(g, 0);
      assertRedacted(g, 1);
    }
  });

  test("opponent's fished/refilled card is stripped; wish card is revealed", () => {
    const s = mkState({ hands: [['5S'], ['KC']], stock: ['8D', '9H'] });
    const n = applyAction(s, ask(0, '5'));
    const forOpp = viewFor(n, 1).log.find((e) => e.kind === 'fish');
    assert.ok(!('card' in forOpp));
    assert.equal(viewFor(n, 0).log.find((e) => e.kind === 'fish').card, '9H');

    const w = applyAction(mkState({ hands: [['5S'], ['KC']], stock: ['5H'], fishYourWish: true }), ask(0, '5'));
    assert.equal(viewFor(w, 1).log.find((e) => e.kind === 'fish').card, '5H');

    const r = applyAction(applyAction(mkState({ hands: [['5S', '6S'], ['5H']], stock: ['QD', '9C'] }), ask(0, '5')), ask(0, '6'));
    assert.ok(!('card' in viewFor(r, 0).log.find((e) => e.kind === 'refill')));
    assert.equal(viewFor(r, 1).log.find((e) => e.kind === 'refill').card, 'QD');
  });
});
