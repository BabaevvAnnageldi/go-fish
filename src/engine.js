// Go Fish rules engine — pure, deterministic, no DOM or network.
// Rules: Bicycle Cards official Go Fish (2 players, 7 cards each).

export const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
export const SUITS = ['S', 'H', 'D', 'C'];
export const HAND_SIZE = 7;
export const TOTAL_BOOKS = RANKS.length;
const LOG_LIMIT = 60;

export class GameError extends Error {}

export const rankOf = (card) => card.slice(0, -1);
export const suitOf = (card) => card.slice(-1);

export function fullDeck() {
  const deck = [];
  for (const s of SUITS) for (const r of RANKS) deck.push(r + s);
  return deck;
}

// mulberry32: tiny seeded PRNG.
export function makeRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle(cards, rng) {
  const a = cards.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function sortHand(hand) {
  const suitIdx = (c) => SUITS.indexOf(suitOf(c));
  return hand.slice().sort((x, y) =>
    RANKS.indexOf(rankOf(x)) - RANKS.indexOf(rankOf(y)) || suitIdx(x) - suitIdx(y));
}

export function createGame({ names = ['Player 1', 'Player 2'], seed = Date.now(), starter = 0, fishYourWish = false } = {}) {
  const deck = shuffle(fullDeck(), makeRng(seed));
  const state = {
    seq: 0,
    options: { fishYourWish: !!fishYourWish },
    players: [0, 1].map((i) => ({ name: String(names[i] ?? `Player ${i + 1}`), hand: [], books: [] })),
    stock: [],
    turn: starter === 1 ? 1 : 0,
    starter: starter === 1 ? 1 : 0, // who went first; rematch alternates it (the log is capped)
    phase: 'playing',
    winner: null,
    log: [],
  };
  for (let i = 0; i < HAND_SIZE; i++) {
    state.players[0].hand.push(deck.pop());
    state.players[1].hand.push(deck.pop());
  }
  state.stock = deck;
  pushLog(state, { kind: 'start', player: state.turn });
  for (const p of [0, 1]) for (const r of RANKS) layBook(state, p, r);
  settle(state);
  return state;
}

function pushLog(state, entry) {
  state.seq += 1;
  state.log.push({ id: state.seq, ...entry });
  if (state.log.length > LOG_LIMIT) state.log.splice(0, state.log.length - LOG_LIMIT);
}

// If player holds all four of `rank`, move them to their books. Returns true if a book was made.
function layBook(state, p, rank) {
  const pl = state.players[p];
  if (pl.hand.filter((c) => rankOf(c) === rank).length < 4) return false;
  pl.hand = pl.hand.filter((c) => rankOf(c) !== rank);
  pl.books.push(rank);
  pushLog(state, { kind: 'book', player: p, rank });
  return true;
}

function totalBooks(state) {
  return state.players[0].books.length + state.players[1].books.length;
}

function passTurn(state) {
  state.turn = 1 - state.turn;
  pushLog(state, { kind: 'turn', player: state.turn });
}

// Resolve automatic steps: game end, and empty-hand draws/skips for the active player.
function settle(state) {
  for (let guard = 0; guard < 8; guard++) {
    if (state.phase === 'over') return;
    if (totalBooks(state) === TOTAL_BOOKS) {
      state.phase = 'over';
      const [a, b] = state.players.map((pl) => pl.books.length);
      state.winner = a === b ? null : a > b ? 0 : 1;
      pushLog(state, { kind: 'over', player: state.winner });
      return;
    }
    const p = state.turn;
    const pl = state.players[p];
    if (pl.hand.length > 0) return;
    if (state.stock.length > 0) {
      const card = state.stock.pop();
      pl.hand.push(card);
      pushLog(state, { kind: 'refill', player: p, card });
      return; // a single card can't form a book
    }
    // Empty hand and empty stock: this player is out; opponent plays.
    pushLog(state, { kind: 'out', player: p });
    state.turn = 1 - p;
  }
  throw new GameError('Game could not settle (corrupt state)');
}

export function legalRanks(state, p) {
  if (state.phase !== 'playing' || state.turn !== p) return [];
  const held = new Set(state.players[p].hand.map(rankOf));
  return RANKS.filter((r) => held.has(r));
}

export function applyAction(state, action) {
  if (!action || typeof action !== 'object') throw new GameError('Malformed action');
  if (state.phase !== 'playing') throw new GameError('The game is over');
  const p = action.player;
  if (p !== 0 && p !== 1) throw new GameError('Unknown player');
  if (p !== state.turn) throw new GameError("It's not your turn");

  if (action.type !== 'ask') throw new GameError('Unknown action');
  const rank = action.rank;
  if (!RANKS.includes(rank)) throw new GameError('Unknown rank');

  const s = structuredClone(state);
  const me = s.players[p];
  const opp = s.players[1 - p];
  if (!me.hand.some((c) => rankOf(c) === rank)) throw new GameError('You can only ask for a rank you hold');

  const given = opp.hand.filter((c) => rankOf(c) === rank);
  if (given.length > 0) {
    opp.hand = opp.hand.filter((c) => rankOf(c) !== rank);
    me.hand.push(...given);
    pushLog(s, { kind: 'ask', player: p, rank, got: given.length });
    layBook(s, p, rank);
    // Successful ask: same player goes again.
  } else {
    pushLog(s, { kind: 'ask', player: p, rank, got: 0 });
    if (s.stock.length === 0) {
      pushLog(s, { kind: 'fish-empty', player: p });
      passTurn(s);
    } else {
      const card = s.stock.pop();
      me.hand.push(card);
      const wish = rankOf(card) === rank;
      pushLog(s, { kind: 'fish', player: p, card, wish: wish && s.options.fishYourWish });
      const booked = layBook(s, p, rankOf(card));
      if (!(booked || (wish && s.options.fishYourWish))) passTurn(s);
    }
  }
  settle(s);
  return s;
}

// Redacted view for one player: never contains the opponent's cards or stock order.
export function viewFor(state, p) {
  const me = state.players[p];
  const opp = state.players[1 - p];
  return {
    you: p,
    seq: state.seq,
    names: state.players.map((pl) => pl.name),
    hand: sortHand(me.hand),
    oppCount: opp.hand.length,
    books: [me.books.slice(), opp.books.slice()],
    stockCount: state.stock.length,
    turn: state.turn,
    phase: state.phase,
    winner: state.winner,
    options: { ...state.options },
    legal: legalRanks(state, p),
    log: state.log.map((e) => {
      if (!('card' in e) || e.player === p) return { ...e };
      const { card, ...rest } = e;
      // Opponent's fished card stays secret, unless it was a revealed "fish your wish".
      return e.wish ? { ...rest, card } : rest;
    }),
  };
}
