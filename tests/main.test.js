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

const submitChat = ($, text) => {
  $('chatInput').value = text;
  for (const fn of $('chatForm').listeners.submit ?? []) fn({ preventDefault() {} });
};

test('chat: host and guest exchange messages; host persists history and replays it on reconnect', async () => {
  const net = makeNetwork();
  const { $ } = await boot(net, { local: { 'gofish:client': 'host-client' } });
  $('nameInput').value = 'Anna';
  $('createBtn').click();
  await waitFor(() => $('status').textContent === 'Waiting for opponent', 2000, 'host waiting');
  const code = $('roomCode').textContent;
  const join = () => {
    const rec = { msgs: [] };
    rec.g = new GuestSession({
      code, PeerImpl: net.Peer, onStatus() {}, onMessage: (m) => rec.msgs.push(m),
      onOpen: () => rec.g.send({ type: 'hello', name: 'Mia', clientId: 'mia' }),
    });
    rec.g.start();
    sessions.push(rec.g);
    return rec;
  };
  const G = join();
  await waitFor(() => G.msgs.some((m) => m.type === 'chat-history'), 2000, 'history on join');
  assert.deepEqual(G.msgs.find((m) => m.type === 'chat-history').messages, []);

  // Guest -> host: cleaned, numbered, shown as unread + bubble.
  G.g.send({ type: 'chat', text: '  hi   <b>Anna</b> ' });
  await waitFor(() => $('chatBadge').textContent === '1', 2000, 'unread badge');
  assert.equal($('chatBadge').hidden, false);
  assert.equal($('chatBubble').textContent, 'Mia: hi <b>Anna</b>');
  await waitFor(() => G.msgs.some((m) => m.type === 'chat'), 2000, 'echo to guest');
  const echo = G.msgs.find((m) => m.type === 'chat');
  assert.deepEqual({ id: echo.message.id, from: echo.message.from, text: echo.message.text }, { id: 1, from: 1, text: 'hi <b>Anna</b>' });

  // Junk from the guest is ignored.
  G.g.send({ type: 'chat', text: '   ' });
  G.g.send({ type: 'chat', text: { evil: true } });

  // Opening the chat clears unread; host -> guest.
  $('chatBtn').click();
  assert.equal($('chatBadge').hidden, true);
  submitChat($, 'hello back');
  assert.equal($('chatInput').value, '', 'input cleared after send');
  await waitFor(() => G.msgs.some((m) => m.type === 'chat' && m.message.from === 0), 2000, 'host message delivered');
  assert.equal(G.msgs.filter((m) => m.type === 'chat').at(-1).message.text, 'hello back');

  const saved = JSON.parse(localStorage.getItem(`gofish:host:${code}`));
  assert.deepEqual(saved.chat.map((m) => [m.id, m.from, m.text]), [[1, 1, 'hi <b>Anna</b>'], [2, 0, 'hello back']]);

  // Guest reconnects (e.g. refreshed): gets the full history.
  G.g.destroy();
  const G2 = join();
  await waitFor(() => G2.msgs.some((m) => m.type === 'chat-history'), 2000, 'history on rejoin');
  assert.deepEqual(G2.msgs.find((m) => m.type === 'chat-history').messages.map((m) => m.text), ['hi <b>Anna</b>', 'hello back']);
});

test('chat: guest app sends via the form, mirrors host history, and ignores replays', async () => {
  const net = makeNetwork();
  const seen = [];
  let H;
  H = new HostSession({ code: 'ABCD', PeerImpl: net.Peer, onStatus() {}, onMessage: (m) => {
    seen.push(m);
    if (m.type === 'hello') {
      H.send({ type: 'view', view: { you: 1, seq: 1, names: ['Anna', 'Mia'], hand: ['7H'], oppCount: 7, books: [[], []],
        stockCount: 38, turn: 0, phase: 'playing', winner: null, options: {}, legal: [], log: [] } });
      H.send({ type: 'chat-history', messages: [{ id: 1, from: 0, text: 'welcome!', ts: 1 }, { id: 2, from: 9, text: 'bad', ts: 1 }] });
    }
  } });
  H.start();
  sessions.push(H);
  await settle();
  const { $ } = await boot(net, { session: { role: 'guest', code: 'ABCD', name: 'Mia' } });
  await waitFor(() => seen.some((m) => m.type === 'hello'), 2000, 'hello');
  await settle(100);
  assert.equal($('chatBadge').hidden, true, 'history on first join is not counted as unread');

  H.send({ type: 'chat', message: { id: 3, from: 0, text: 'your turn soon', ts: 2 } });
  await waitFor(() => $('chatBadge').textContent === '1', 2000, 'unread');
  H.send({ type: 'chat', message: { id: 3, from: 0, text: 'your turn soon', ts: 2 } }); // replay
  H.send({ type: 'chat', message: { id: 4, from: 0, text: '', ts: 2 } }); // invalid
  await settle(100);
  assert.equal($('chatBadge').textContent, '1', 'replayed / invalid messages ignored');

  submitChat($, '  on my way  ');
  await waitFor(() => seen.some((m) => m.type === 'chat'), 2000, 'guest chat sent');
  assert.equal(seen.find((m) => m.type === 'chat').text, 'on my way');
});
