// Shared test helpers (not a test file itself).
import { EventEmitter } from 'node:events';
import { RANKS, rankOf, fullDeck } from '../src/engine.js';

// Hand-crafted state matching the createGame() shape. stock.pop() is the "top" card.
export function mkState({ hands, stock = [], books = [[], []], turn = 0, fishYourWish = false, names = ['Anna', 'Ben'] }) {
  return {
    seq: 0,
    options: { fishYourWish },
    players: [0, 1].map((i) => ({ name: names[i], hand: hands[i].slice(), books: books[i].slice() })),
    stock: stock.slice(),
    turn,
    phase: 'playing',
    winner: null,
    log: [],
  };
}

export function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

// All cards still physically present (hands + stock) plus 4 per book.
export function checkInvariants(s) {
  const loose = [...s.players[0].hand, ...s.players[1].hand, ...s.stock];
  const books = [...s.players[0].books, ...s.players[1].books];
  const errs = [];
  if (loose.length + books.length * 4 !== 52) errs.push(`card count ${loose.length + books.length * 4} != 52`);
  if (new Set(loose).size !== loose.length) errs.push('duplicate cards');
  const deck = new Set(fullDeck());
  for (const c of loose) if (!deck.has(c)) errs.push(`bogus card ${c}`);
  if (new Set(books).size !== books.length) errs.push('duplicate book rank');
  for (const r of books) {
    if (!RANKS.includes(r)) errs.push(`bogus book ${r}`);
    if (loose.some((c) => rankOf(c) === r)) errs.push(`book ${r} is incomplete (card of that rank still loose)`);
  }
  for (const p of [0, 1]) {
    const counts = {};
    for (const c of s.players[p].hand) counts[rankOf(c)] = (counts[rankOf(c)] ?? 0) + 1;
    for (const [r, n] of Object.entries(counts)) if (n >= 4) errs.push(`player ${p} holds 4 ${r}s without booking`);
  }
  if (s.turn !== 0 && s.turn !== 1) errs.push(`bad turn ${s.turn}`);
  if (s.phase === 'playing' && s.players[s.turn].hand.length === 0) errs.push('active player has empty hand while playing');
  return errs;
}

// ---------- Fake in-memory PeerJS ----------
export function makeNetwork() {
  const peers = new Map();
  let anon = 0;
  const tick = (fn) => setImmediate(fn);
  const err = (type) => Object.assign(new Error(type), { type });

  class FakeConn extends EventEmitter {
    constructor(peer) {
      super();
      this.peer = peer;
      this.open = false;
      this.closed = false;
      this.remote = null;
      this.sent = [];
    }
    send(msg) {
      if (!this.open) throw new Error('send on a connection that is not open');
      this.sent.push(msg);
      const r = this.remote;
      const data = structuredClone(msg);
      tick(() => { if (r.open) r.emit('data', data); });
    }
    close() {
      if (this.closed) return;
      this.closed = true;
      this.open = false;
      this.emit('close');
      const r = this.remote;
      if (r && !r.closed) tick(() => r.close());
    }
  }

  class FakePeer extends EventEmitter {
    constructor(id) {
      super();
      this.id = id ?? `anon-${++anon}`;
      this.open = false;
      this.destroyed = false;
      this.disconnected = false;
      this.conns = [];
      tick(() => {
        if (this.destroyed) return;
        if (peers.has(this.id)) return this.emit('error', err('unavailable-id'));
        peers.set(this.id, this);
        this.open = true;
        this.emit('open', this.id);
      });
    }
    connect(target) {
      const local = new FakeConn(this);
      this.conns.push(local);
      tick(() => {
        const host = peers.get(target);
        if (!host || host.destroyed) return this.emit('error', err('peer-unavailable'));
        const remote = new FakeConn(host);
        host.conns.push(remote);
        local.remote = remote;
        remote.remote = local;
        host.emit('connection', remote);
        tick(() => {
          if (local.closed || remote.closed) return;
          local.open = remote.open = true;
          remote.emit('open');
          local.emit('open');
        });
      });
      return local;
    }
    reconnect() { this.disconnected = false; }
    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.open = false;
      if (peers.get(this.id) === this) peers.delete(this.id);
      for (const c of this.conns) c.close();
    }
  }
  return { Peer: FakePeer, peers };
}

export async function waitFor(cond, ms = 2000, what = 'condition') {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 2));
  }
}
export const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));
