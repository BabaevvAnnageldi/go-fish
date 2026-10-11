// Drives src/main.js (the app controller) with a tiny fake DOM and the in-memory fake PeerJS.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { HostSession, GuestSession } from '../src/net.js';
import { makeNetwork, waitFor, settle } from './helpers.js';

function fakeEl() {
  return {
    hidden: false, value: '', checked: false, textContent: '', className: '', disabled: false, style: {},
    listeners: {},
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); },
    click() { for (const fn of this.listeners.click ?? []) fn({}); },
    focus() {}, append() {}, replaceChildren() {}, setAttribute() {},
  };
}

function fakeStorage(init = {}) {
  const m = new Map(Object.entries(init).map(([k, v]) => [k, JSON.stringify(v)]));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    raw: m,
  };
}

let loads = 0;
const sessions = [];
afterEach(async () => {
  for (const s of sessions) s.destroy();
  sessions.length = 0;
  for (const id of ['leaveBtn']) globalThis.document?.getElementById(id).click(); // stop the app instance
  await settle(200);
});

// Boots a fresh instance of main.js. Returns the fake DOM and storages.
async function boot(net, { session = null, local = {} } = {}) {
  const els = new Map();
  const $ = (id) => { if (!els.has(id)) els.set(id, fakeEl()); return els.get(id); };
  const def = (k, v) => Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  def('document', { getElementById: $, querySelector: () => fakeEl(), createElement: () => fakeEl(), addEventListener() {} });
  def('window', { addEventListener() {} });
  def('location', { href: 'http://localhost/', search: '', pathname: '/' });
  def('history', { replaceState() {} });
  def('localStorage', fakeStorage(local));
  def('sessionStorage', fakeStorage(session ? { 'gofish:session': session } : {}));
  def('Peer', net.Peer);
  await import(`../src/main.js?instance=${++loads}`);
  return { $ };
}

test('host refresh before the guest joins reclaims the same code (not a random one)', async () => {
  const net = makeNetwork();
  const stale = new net.Peer('gofish-v1-ABCD'); // our previous registration, still alive on the broker
  await settle();
  const { $ } = await boot(net, { session: { role: 'host', code: 'ABCD', name: 'Anna' } });
  await waitFor(() => $('status').textContent === 'Reclaiming room…', 2000, 'reclaiming');
  stale.destroy();
  await waitFor(() => $('status').textContent === 'Waiting for opponent', 5000, 'host registered');
  assert.equal($('roomCode').textContent, 'ABCD');
  assert.ok(net.peers.has('gofish-v1-ABCD'));
  assert.equal(JSON.parse(sessionStorage.getItem('gofish:session')).code, 'ABCD');
});

test("leaving during 'Reclaiming room…' cancels the retry (no crash, no zombie host)", async () => {
  const net = makeNetwork();
  const stale = new net.Peer('gofish-v1-ABCD');
  await settle();
  const { $ } = await boot(net, { session: { role: 'host', code: 'ABCD', name: 'Anna' } });
  await waitFor(() => $('status').textContent === 'Reclaiming room…', 2000, 'reclaiming');
  $('leaveBtn').click();
  stale.destroy();
  await settle(2500); // past the 2s retry: an uncancelled timer would throw on session === null
  assert.ok(!net.peers.has('gofish-v1-ABCD'), 'no host registered after leaving');
  assert.equal($('lobby').hidden, false);
});

test("guest is told when the host leaves: status 'Opponent left', no more retries", async () => {
  const net = makeNetwork();
  const seen = [];
  const H = new HostSession({ code: 'ABCD', PeerImpl: net.Peer, onStatus() {}, onMessage: (m) => seen.push(m) });
  H.start();
  sessions.push(H);
  await settle();
  const { $ } = await boot(net, { session: { role: 'guest', code: 'ABCD', name: 'Ben' } });
  await waitFor(() => seen.some((m) => m.type === 'hello'), 2000, 'hello');
  H.leave();
  await waitFor(() => $('status').textContent === 'Opponent left', 2000, 'opponent left');
  assert.match($('toast').textContent, /left/);
  assert.equal(sessionStorage.getItem('gofish:session'), null, 'room forgotten, a refresh will not rejoin');
  await settle(3500); // longer than any guest retry
  assert.equal($('status').textContent, 'Opponent left', 'not stuck in a retry loop');
  assert.equal($('leaveBtn').hidden, false, 'Leave is available to get back to the lobby');
  assert.equal(net.peers.size, 0, 'guest peer destroyed');
});

test("host Leave sends 'bye'; a stranger can't take a disconnected guest's seat", async () => {
  const net = makeNetwork();
  const { $ } = await boot(net, { local: { 'gofish:client': 'host-client' } });
  $('nameInput').value = 'Anna';
  $('createBtn').click();
  await waitFor(() => $('status').textContent === 'Waiting for opponent', 2000, 'host waiting');
  const code = $('roomCode').textContent;
  const mkGuest = (clientId) => {
    const rec = { msgs: [] };
    rec.g = new GuestSession({
      code, PeerImpl: net.Peer, onStatus() {}, onMessage: (m) => rec.msgs.push(m),
      onOpen: () => rec.g.send({ type: 'hello', name: clientId, clientId }),
    });
    rec.g.start();
    sessions.push(rec.g);
    return rec;
  };
  const A = mkGuest('A');
  await waitFor(() => A.msgs.some((m) => m.type === 'view'), 2000, 'A seated');
  A.g.destroy();
  await waitFor(() => $('status').textContent === 'Opponent disconnected', 2000, 'guest-left');
  const B = mkGuest('B');
  await waitFor(() => B.msgs.some((m) => m.type === 'full'), 2000, 'stranger refused');
  assert.ok(!B.msgs.some((m) => m.type === 'view'), 'stranger never sees a view');
  B.g.destroy();
  const A2 = mkGuest('A');
  await waitFor(() => A2.msgs.some((m) => m.type === 'view'), 2000, 'A reseated');
  $('leaveBtn').click();
  await waitFor(() => A2.msgs.some((m) => m.type === 'bye'), 2000, 'bye');
});
