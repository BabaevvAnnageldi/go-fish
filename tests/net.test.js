import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { HostSession, GuestSession, normalizeCode, randomCode } from '../src/net.js';
import { canSeat } from '../src/seat.js';
import { makeNetwork, waitFor, settle } from './helpers.js';

// ---------- Fixtures ----------
let cleanup = [];
afterEach(() => { for (const s of cleanup) s.destroy(); cleanup = []; });

function host(net, opts = {}) {
  const rec = { statuses: [], msgs: [] };
  const h = new HostSession({
    code: 'ABCD',
    PeerImpl: net.Peer,
    onStatus: (s) => rec.statuses.push(s),
    onMessage: (m) => rec.msgs.push(m),
    ...opts,
  });
  h.start();
  cleanup.push(h);
  return Object.assign(rec, { h });
}

function guest(net, clientId, { code = 'ABCD', autoHello = true } = {}) {
  const rec = { statuses: [], msgs: [], opens: 0 };
  const g = new GuestSession({
    code,
    PeerImpl: net.Peer,
    onStatus: (s) => rec.statuses.push(s),
    onMessage: (m) => rec.msgs.push(m),
    onOpen: () => { rec.opens++; if (autoHello) g.send({ type: 'hello', name: clientId, clientId }); },
  });
  g.start();
  cleanup.push(g);
  return Object.assign(rec, { g });
}

// Same wiring as main.js: the real canSeat policy, and the first guest's clientId is recorded once.
function seatPolicy() {
  let guestId = null;
  return (hello) => {
    const ok = canSeat(guestId, hello);
    if (ok && !guestId) guestId = hello.clientId;
    return ok;
  };
}

// ---------- Tests ----------
describe('HostSession / GuestSession', () => {
  test("host reports 'waiting' once registered", async () => {
    const net = makeNetwork();
    const H = host(net);
    await waitFor(() => H.statuses.includes('waiting'));
    assert.ok(net.peers.has('gofish-v1-ABCD'));
  });

  test("guest gets 'connecting' then 'connected', and onOpen fires", async () => {
    const net = makeNetwork();
    host(net);
    await settle();
    const G = guest(net, 'c1');
    assert.equal(G.statuses[0], 'connecting');
    await waitFor(() => G.opens === 1, 2000, 'onOpen');
    assert.ok(G.statuses.includes('connected'));
  });

  test("host only seats a connection after its 'hello' passes canSeat", async () => {
    const net = makeNetwork();
    const calls = [];
    let allow = false;
    const H = host(net, { canSeat: (hello, taken) => { calls.push([hello, taken]); return allow; } });
    await settle();

    // Raw connection that never says hello: not seated, data ignored.
    const raw = new net.Peer();
    await settle();
    const c = raw.connect('gofish-v1-ABCD');
    await waitFor(() => c.open);
    c.send({ type: 'action', rank: '5' });
    await settle();
    assert.equal(H.h.conn, null);
    assert.deepEqual(H.msgs, [], 'non-hello data from an unseated connection is ignored');
    assert.ok(!H.statuses.includes('connected'));
    H.h.send({ type: 'view', view: {} });
    assert.equal(c.remote.sent.length, 0, 'host does not send to unseated connections');

    // hello refused by canSeat -> 'full', then closed, still not seated.
    const got = [];
    c.on('data', (m) => got.push(m));
    c.send({ type: 'hello', name: 'x', clientId: 'x' });
    await waitFor(() => got.length === 1);
    assert.deepEqual(got[0], { type: 'full' });
    assert.equal(H.h.conn, null);
    assert.deepEqual(calls.at(-1), [{ type: 'hello', name: 'x', clientId: 'x' }, false]);
    await waitFor(() => c.closed, 2000, 'refused connection closed');
    assert.ok(!H.statuses.includes('guest-left'), 'refused stranger is not reported as guest-left');

    // Now allowed: seated, 'connected' reported, hello forwarded.
    allow = true;
    const G = guest(net, 'ok');
    await waitFor(() => H.msgs.length === 1);
    assert.equal(H.msgs[0].clientId, 'ok');
    assert.ok(H.h.conn);
    assert.ok(H.statuses.includes('connected'));
    H.h.send({ type: 'view', view: { n: 1 } });
    await waitFor(() => G.msgs.length === 1);
    assert.deepEqual(G.msgs[0], { type: 'view', view: { n: 1 } });
    raw.destroy();
  });

  test("a second stranger gets {type:'full'} when canSeat refuses", async () => {
    const net = makeNetwork();
    const H = host(net, { canSeat: seatPolicy() });
    await settle();
    const A = guest(net, 'A');
    await waitFor(() => H.msgs.length === 1);
    const B = guest(net, 'B');
    await waitFor(() => B.msgs.some((m) => m.type === 'full'), 2000, 'full');
    assert.equal(H.msgs.length, 1, 'stranger hello not forwarded');
    H.h.send({ type: 'view', view: 'for A' });
    await waitFor(() => A.msgs.length === 1);
    await settle();
    assert.ok(!B.msgs.some((m) => m.type === 'view'), 'stranger never receives views');
    assert.ok(H.h.conn.open);
    B.g.destroy(); // main.js leave()s on 'full'
  });

  test('a returning client takes over the seat and the old connection is closed', async () => {
    const net = makeNetwork();
    const H = host(net, { canSeat: seatPolicy() });
    await settle();
    const A1 = guest(net, 'A');
    await waitFor(() => H.msgs.length === 1);
    const oldConn = H.h.conn;
    const A2 = guest(net, 'A');
    await waitFor(() => H.msgs.length === 2, 2000, 'second hello');
    assert.notEqual(H.h.conn, oldConn);
    assert.ok(oldConn.closed, 'old host-side connection closed');
    await waitFor(() => A1.statuses.includes('reconnecting'), 2000, 'old guest notices close');
    A1.g.destroy();
    assert.ok(!H.statuses.includes('guest-left'), 'takeover is not reported as guest-left');
    H.h.send({ type: 'view', view: 2 });
    await waitFor(() => A2.msgs.length === 1);
    assert.equal(A2.msgs[0].view, 2);
  });

  test("when the guest connection closes, the host reports 'guest-left'", async () => {
    const net = makeNetwork();
    const H = host(net);
    await settle();
    const G = guest(net, 'g');
    await waitFor(() => H.msgs.length === 1);
    G.g.destroy();
    await waitFor(() => H.statuses.includes('guest-left'), 2000, 'guest-left');
    assert.equal(H.h.conn, null);
  });

  test('guest messages after seating are forwarded to the host', async () => {
    const net = makeNetwork();
    const H = host(net);
    await settle();
    const G = guest(net, 'g');
    await waitFor(() => H.msgs.length === 1);
    G.g.send({ type: 'action', rank: '7' });
    await waitFor(() => H.msgs.length === 2);
    assert.deepEqual(H.msgs[1], { type: 'action', rank: '7' });
  });

  test("a second host with the same code reports 'code-taken'", async () => {
    const net = makeNetwork();
    host(net);
    await settle();
    const H2 = host(net);
    await waitFor(() => H2.statuses.includes('code-taken'));
  });

  test("guest started before host reports 'host-missing', then connects when host appears", async () => {
    const net = makeNetwork();
    const G = guest(net, 'early');
    await waitFor(() => G.statuses.includes('host-missing'));
    const H = host(net);
    await waitFor(() => H.msgs.length === 1, 6000, 'retry connects');
    assert.ok(G.statuses.includes('connected'));
  });

  test('destroyed sessions do not report status', async () => {
    const net = makeNetwork();
    const H = host(net);
    await settle();
    const G = guest(net, 'g');
    await waitFor(() => H.msgs.length === 1);
    const before = G.statuses.length;
    H.h.destroy();
    G.g.destroy();
    await settle(50);
    assert.ok(!H.statuses.includes('guest-left'));
    assert.equal(G.statuses.length, before);
  });
});

describe('regressions', () => {
  test('canSeat: once a guestId is recorded only that client may sit, even if the seat is empty', () => {
    assert.equal(canSeat(null, { clientId: 'A' }), true);
    assert.equal(canSeat('A', { clientId: 'A' }), true);
    assert.equal(canSeat('A', { clientId: 'B' }), false);
    assert.equal(canSeat('A', { name: 'no id' }), false);
    assert.equal(canSeat('A'.repeat(40), { clientId: 'A'.repeat(50) }), true, 'compared after the same 40-char clamp');
  });

  test("a stranger can't take a disconnected guest's seat; the original guest can", async () => {
    const net = makeNetwork();
    const H = host(net, { canSeat: seatPolicy() });
    await settle();
    const A1 = guest(net, 'A');
    await waitFor(() => H.msgs.length === 1);
    A1.g.destroy();
    await waitFor(() => H.statuses.includes('guest-left'), 2000, 'guest-left');
    const B = guest(net, 'B');
    await waitFor(() => B.msgs.some((m) => m.type === 'full'), 2000, 'full');
    assert.equal(H.h.conn, null, 'stranger not seated in the empty seat');
    B.g.destroy();
    const A2 = guest(net, 'A');
    await waitFor(() => H.msgs.length === 2, 2000, 'original guest reseated');
    assert.equal(H.msgs[1].clientId, 'A');
    assert.ok(!A2.msgs.some((m) => m.type === 'full'));
  });

  test("host.leave() sends {type:'bye'} to the guest, then destroys the peer quietly", async () => {
    const net = makeNetwork();
    const H = host(net);
    await settle();
    const G = guest(net, 'g');
    await waitFor(() => H.msgs.length === 1);
    H.h.leave();
    await waitFor(() => G.msgs.some((m) => m.type === 'bye'), 2000, 'bye');
    await waitFor(() => !net.peers.has('gofish-v1-ABCD'), 2000, 'host peer destroyed');
    G.g.send({ type: 'action', rank: '7' });
    await settle();
    assert.equal(H.msgs.length, 1, 'no messages forwarded after leave');
    assert.ok(!H.statuses.includes('guest-left'));
  });

  test("guest peer 'open' again (after reconnect) does not open a duplicate connection", async () => {
    const net = makeNetwork();
    const H = host(net);
    await settle();
    const G = guest(net, 'g');
    await waitFor(() => H.msgs.length === 1);
    const conns = G.g.peer.conns.length;
    const conn = G.g.conn;
    G.g.peer.emit('open', G.g.peer.id);
    await settle(50);
    assert.equal(G.g.peer.conns.length, conns, 'no new connection');
    assert.equal(G.g.conn, conn);
    assert.equal(H.msgs.length, 1, 'no second hello');
  });

  test('guest retry recovers when its peer was destroyed underneath it', async () => {
    const net = makeNetwork();
    const H = host(net);
    await settle();
    const G = guest(net, 'g');
    await waitFor(() => H.msgs.length === 1);
    const oldPeer = G.g.peer;
    oldPeer.destroy(); // e.g. PeerJS aborting on a fatal error
    await waitFor(() => H.msgs.length === 2, 6000, 'rejoined with a fresh peer');
    assert.notEqual(G.g.peer, oldPeer);
    assert.equal(G.opens, 2);
  });
});

describe('room codes', () => {
  test('randomCode: 4 letters from the unambiguous alphabet', () => {
    for (let i = 0; i < 2000; i++) {
      const c = randomCode();
      assert.match(c, /^[A-HJ-NP-Z]{4}$/);
      assert.equal(normalizeCode(c), c);
    }
  });

  test('normalizeCode', () => {
    assert.equal(normalizeCode('abcd'), 'ABCD');
    assert.equal(normalizeCode(' a-b c d '), 'ABCD');
    assert.equal(normalizeCode('wxyz'), 'WXYZ');
    assert.equal(normalizeCode('abc'), null);
    assert.equal(normalizeCode('abcde'), null);
    assert.equal(normalizeCode(''), null);
    assert.equal(normalizeCode(null), null);
    assert.equal(normalizeCode(undefined), null);
    assert.equal(normalizeCode(1234), null);
  });
});
