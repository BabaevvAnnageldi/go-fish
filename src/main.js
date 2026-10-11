import { createGame, applyAction, viewFor, GameError, RANKS } from './engine.js';
import { HostSession, GuestSession, randomCode, normalizeCode } from './net.js';
import { canSeat, seatId } from './seat.js';
import { $, showScreen, showToast, setStatus, renderTable, resetHandMemory, rankName } from './ui.js';
import { soundOn, setSound, unlock as unlockAudio, playPop } from './sound.js';
import { median, addSample, pingQuality, PING_EVERY_MS, STALE_MS } from './ping.js';
import { cleanText, isValidMessage, makeMessage, appendMessage, renderChat, renderQuick } from './chat.js';
import { animateDraws, buzz, canFullscreen, enterFullscreen, exitFullscreen, isFullscreen, isPhone, isStandalone, keepAwake } from './fx.js';

const SESSION_KEY = 'gofish:session';
const NAME_KEY = 'gofish:name';
const CLIENT_KEY = 'gofish:client';
const hostKey = (code) => `gofish:host:${code}`;

const store = {
  get(area, key) {
    try { return JSON.parse(globalThis[area].getItem(key)); } catch { return null; }
  },
  set(area, key, value) {
    try { globalThis[area].setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
  },
  del(area, key) {
    try { globalThis[area].removeItem(key); } catch { /* storage unavailable */ }
  },
};

const cleanName = (raw, fallback) => String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, 20) || fallback;

// App state
let session = null;   // { role, code, name, fishYourWish }
let net = null;       // HostSession | GuestSession
let game = null;      // host only: authoritative engine state
let view = null;      // latest view for this player
let selected = null;  // selected rank in my hand
let lastSeq = 0;      // last log entry already toasted
let hostRetries = 0;
let guestId = null;   // host only: clientId of the seated guest
let reclaimTimer = null; // host only: pending 'Reclaiming room…' retry
let reclaiming = false;  // host only: the room code is committed (resumed or registered), so retry it, never pick a new one
let chat = [];           // chat history (host is authoritative, guest mirrors it)
let chatOpen = false;
let unread = 0;
let bubbleTimer = null;
let pingTimer = null;
let rtts = [];         // recent round-trip samples to the opponent (ms)
let lastPong = 0;
let myClientId = null;   // cached so it stays stable for the page even if localStorage throws

// ---------- Rendering ----------

function render() {
  if (!view) return;
  showScreen('table');
  if (selected && !view.legal.includes(selected)) selected = null;
  renderTable(view, { selected, onSelect: (r) => { selected = selected === r ? null : r; render(); } });
  keepAwake(view.phase === 'playing'); // a sleeping phone drops the connection
  announce();
}

function announce() {
  const fresh = view.log.filter((e) => e.id > lastSeq);
  if (lastSeq === 0) { lastSeq = view.seq; return; }
  lastSeq = view.seq;
  const me = view.you;
  animateDraws(fresh, me);
  if (fresh.some((e) => (e.kind === 'turn' && e.player === me) || (e.kind === 'ask' && e.got > 0 && e.player !== me))) buzz();
  if (view.phase === 'over') return; // the game-over dialog says it all
  const book = fresh.findLast((e) => e.kind === 'book');
  const ask = fresh.findLast((e) => e.kind === 'ask');
  if (book) showToast(`${book.player === me ? 'You' : view.names[book.player]} made a book of ${rankName(book.rank)}!`);
  else if (ask && ask.got === 0) showToast(ask.player === me ? 'Go fish! 🐟' : `${view.names[ask.player]} has to go fish! 🐟`, ask.player === me ? '' : 'info');
  else if (ask && ask.player !== me) showToast(`${view.names[ask.player]} took your ${rankName(ask.rank)}`, 'info');
}

function setView(v) {
  view = v;
  render();
}

const STATUS = {
  waiting: ['Waiting for opponent', 'warn'],
  connecting: ['Connecting…', 'warn'],
  connected: ['Connected', 'ok'],
  reconnecting: ['Reconnecting…', 'warn'],
  'guest-left': ['Opponent disconnected', 'bad'],
  'host-missing': ['Looking for host…', 'warn'],
  'broker-lost': ['Network trouble — retrying', 'warn'],
};

function onStatus(s) {
  if (s === 'code-taken') return onCodeTaken();
  if (session?.role === 'host' && (s === 'waiting' || s === 'connected')) reclaiming = true; // code may already be shared
  const [text, tone] = STATUS[s] ?? [s, ''];
  setStatus(text, tone);
  if (s === 'connected') setTimeout(sendPing, 300);
  showPing();
  if (s === 'host-missing' && !view) {
    $('waitingTitle').textContent = 'Looking for that game…';
    $('waitingNote').textContent = `Make sure your opponent created room ${session.code} and keeps the page open.`;
  }
}

// ---------- Host ----------

function startHost(resume) {
  reclaimTimer = null;
  if (!session) return; // left while a reclaim retry was pending
  if (resume) reclaiming = true;
  showScreen('waiting');
  $('hostInfo').hidden = false;
  $('waitingTitle').textContent = 'Waiting for your opponent…';
  $('roomCode').textContent = session.code;
  $('inviteLink').textContent = inviteUrl();
  $('waitingNote').textContent = 'Keep this page open. The game starts as soon as they join.';
  if (resume) {
    const saved = store.get('localStorage', hostKey(session.code));
    if (saved?.game) ({ game, guestId = null } = saved);
    if (Array.isArray(saved?.chat)) chat = saved.chat.filter(isValidMessage);
  }
  startPing();
  net = new HostSession({ code: session.code, onMessage: onGuestMessage, onStatus, canSeat: (hello) => canSeat(guestId, hello) });
  net.start();
  if (game) setView(viewFor(game, 0));
}

function onCodeTaken() {
  net?.destroy();
  if (reclaiming || game) {
    // Resuming: our old registration may still be alive on the broker for a few seconds.
    if (hostRetries++ < 15) {
      setStatus('Reclaiming room…', 'warn');
      reclaimTimer = setTimeout(() => startHost(false), 2000);
      return;
    }
    setStatus('Room unavailable', 'bad');
    return;
  }
  session.code = randomCode();
  saveSession();
  startHost(false);
}

function inviteUrl() {
  const u = new URL(location.href);
  u.search = `?room=${session.code}`;
  u.hash = '';
  return u.toString();
}

function onGuestMessage(msg) {
  if (!msg || typeof msg !== 'object') return;
  hostRetries = 0;
  if (msg.type === 'hello') {
    if (!guestId) guestId = seatId(msg); // first guest owns the seat for this room
    const guestName = cleanName(msg.name, 'Player 2');
    if (!game) newGame(guestName, 0);
    else game = { ...game, players: [game.players[0], { ...game.players[1], name: guestName }] };
    broadcast();
    net.send({ type: 'chat-history', messages: chat });
  } else if (msg.type === 'action') {
    if (!game) return;
    act(1, msg.rank);
  } else if (msg.type === 'rematch') {
    if (game?.phase === 'over') rematch();
  } else if (msg.type === 'ping') {
    net.send({ type: 'pong', t: msg.t });
  } else if (msg.type === 'pong') {
    onPong(msg.t);
  } else if (msg.type === 'chat') {
    const text = cleanText(msg.text);
    if (text && game) hostPost(1, text);
  }
}

function hostPost(from, text) {
  const m = makeMessage(chat, from, text);
  chat = appendMessage(chat, m);
  persist();
  net.send({ type: 'chat', message: m });
  showChat(m);
}

function newGame(guestName, starter) {
  game = createGame({
    names: [session.name, guestName],
    seed: (Math.random() * 2 ** 32) >>> 0,
    starter,
    fishYourWish: session.fishYourWish,
  });
  lastSeq = 0;
  resetHandMemory();
}

function rematch() {
  newGame(game.players[1].name, 1 - (game.starter ?? 0)); // the log is capped, so don't search it
  broadcast();
}

function persist() {
  store.set('localStorage', hostKey(session.code), { game, guestId, chat });
}

function broadcast() {
  persist();
  net.send({ type: 'view', view: viewFor(game, 1) });
  setView(viewFor(game, 0));
}

function act(player, rank) {
  if (typeof rank !== 'string' || !RANKS.includes(rank)) return reject(player, 'Unknown rank');
  try {
    game = applyAction(game, { type: 'ask', player, rank });
  } catch (err) {
    if (!(err instanceof GameError)) throw err;
    return reject(player, err.message);
  }
  broadcast();
}

function reject(player, message) {
  if (player === 1) net.send({ type: 'error', message });
  else showToast(message, 'info');
}

// ---------- Guest ----------

function startGuest() {
  showScreen('waiting');
  $('hostInfo').hidden = true;
  $('waitingTitle').textContent = `Joining room ${session.code}…`;
  $('waitingNote').textContent = '';
  startPing();
  net = new GuestSession({
    code: session.code,
    onStatus,
    onOpen: () => net.send({ type: 'hello', name: session.name, clientId: clientId() }),
    onMessage: (msg) => {
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'view' && msg.view && Array.isArray(msg.view.hand)) {
        if (view && msg.view.seq < view.seq) { lastSeq = 0; resetHandMemory(); } // rematch started
        setView(msg.view);
      } else if (msg.type === 'ping') {
        net.send({ type: 'pong', t: msg.t });
      } else if (msg.type === 'pong') {
        onPong(msg.t);
      } else if (msg.type === 'chat-history' && Array.isArray(msg.messages)) {
        const lastId = chat.at(-1)?.id ?? 0;
        chat = msg.messages.filter(isValidMessage).slice(-100);
        const fresh = chat.filter((m) => m.id > lastId && m.from !== 1);
        if (!chatOpen && lastId > 0) unread += fresh.length; // after a page refresh, old history isn't "new"
        refreshChat();
      } else if (msg.type === 'chat' && isValidMessage(msg.message)) {
        if (msg.message.id <= (chat.at(-1)?.id ?? 0)) return;
        chat = appendMessage(chat, msg.message);
        showChat(msg.message);
      } else if (msg.type === 'error') {
        showToast(String(msg.message ?? 'Error'), 'info');
      } else if (msg.type === 'full') {
        leave();
        lobbyError('That game already has two players.');
      } else if (msg.type === 'bye') {
        // Host left: stop retrying, forget the room, and leave the way back (Leave button) open.
        net.destroy();
        stopPing();
        store.del('sessionStorage', SESSION_KEY);
        setStatus('Opponent left', 'bad');
        showToast(`${view?.names[0] ?? 'Your opponent'} left the game`, 'info');
        if (!view) $('waitingTitle').textContent = 'Your opponent left the game';
        $('waitingNote').textContent = 'Press Leave to return to the lobby.';
      }
    },
  });
  net.start();
}

// ---------- Actions ----------

function askSelected() {
  if (!view || !selected) return;
  const rank = selected;
  selected = null;
  if (session.role === 'host') act(0, rank);
  else net.send({ type: 'action', rank });
}

function playAgain() {
  if (session.role === 'host') rematch();
  else net.send({ type: 'rematch' });
}

// ---------- Ping ----------

const now = () => globalThis.performance?.now() ?? Date.now();

function sendPing() {
  if (net?.conn?.open) net.send({ type: 'ping', t: now() });
  showPing();
}

function startPing() {
  clearInterval(pingTimer);
  pingTimer = setInterval(sendPing, PING_EVERY_MS);
  pingTimer.unref?.(); // Node (tests): don't keep the process alive
}

function stopPing() {
  clearInterval(pingTimer);
  pingTimer = null;
  rtts = [];
  lastPong = 0;
  showPing();
}

function onPong(t) {
  if (typeof t !== 'number') return;
  const rtt = now() - t;
  const next = addSample(rtts, rtt);
  if (next === rtts) return;
  rtts = next;
  lastPong = now();
  showPing();
}

function showPing() {
  const el = $('ping');
  const live = Boolean(net?.conn?.open) && rtts.length > 0 && now() - lastPong < STALE_MS;
  el.hidden = !live;
  if (!live) return;
  const ms = Math.round(median(rtts));
  el.textContent = `📶 ${ms} ms`;
  el.className = `pill ping ${pingQuality(ms)}`;
}

// ---------- Chat ----------

const myIndex = () => (session?.role === 'host' ? 0 : 1);

function refreshChat() {
  if (view) renderChat(chat, { you: myIndex(), names: view.names });
  $('chatBadge').textContent = unread > 9 ? '9+' : String(unread);
  $('chatBadge').hidden = unread === 0;
}

// A message was added to `chat`: render it, and nudge the reader if it's from the opponent.
function showChat(m) {
  if (m.from !== myIndex()) {
    if (!chatOpen) {
      unread += 1;
      const b = $('chatBubble');
      b.textContent = `${view?.names[m.from] ?? 'Opponent'}: ${m.text}`;
      b.hidden = false;
      clearTimeout(bubbleTimer);
      bubbleTimer = setTimeout(() => { b.hidden = true; }, 4000);
    }
    playPop();
    buzz(20);
  }
  refreshChat();
}

function sendChat(raw) {
  const text = cleanText(raw);
  if (!text || !session) return false;
  if (session.role === 'host') {
    if (!game) return false;
    hostPost(0, text);
  } else {
    if (!net?.conn?.open) { showToast('Not connected — message not sent', 'info'); return false; }
    net.send({ type: 'chat', text });
  }
  return true;
}

function openChat() {
  chatOpen = true;
  unread = 0;
  $('chat').hidden = false;
  $('chatBubble').hidden = true;
  refreshChat();
  if (!isPhone()) $('chatInput').focus();
}

function closeChat() {
  chatOpen = false;
  $('chat').hidden = true;
}

function clientId() {
  myClientId ??= store.get('localStorage', CLIENT_KEY);
  if (!myClientId) {
    myClientId = Math.random().toString(36).slice(2) + Date.now().toString(36);
    store.set('localStorage', CLIENT_KEY, myClientId);
  }
  return myClientId;
}

function saveSession() {
  store.set('sessionStorage', SESSION_KEY, session);
}

function lobbyError(text) {
  const e = $('lobbyError');
  e.textContent = text;
  e.hidden = !text;
}

function begin(role) {
  lobbyError('');
  const name = cleanName($('nameInput').value, role === 'host' ? 'Player 1' : 'Player 2');
  store.set('localStorage', NAME_KEY, name);
  let code;
  if (role === 'host') {
    code = randomCode();
  } else {
    code = normalizeCode($('codeInput').value);
    if (!code) return lobbyError('Enter the 4-letter room code.');
  }
  if (!globalThis.Peer) return lobbyError('Could not load the networking library. Check your connection and reload.');
  session = { role, code, name, fishYourWish: $('wishInput').checked };
  if (isPhone()) enterFullscreen(); // still inside the tap, which browsers require
  saveSession();
  role === 'host' ? startHost(false) : startGuest();
}

function leave() {
  clearTimeout(reclaimTimer);
  if (session?.role === 'host') net?.leave(); // tells the guest 'bye' before tearing down
  else net?.destroy();
  if (session?.role === 'host') store.del('localStorage', hostKey(session.code));
  store.del('sessionStorage', SESSION_KEY);
  history.replaceState(null, '', location.pathname);
  session = net = game = view = selected = guestId = reclaimTimer = null;
  lastSeq = hostRetries = 0;
  reclaiming = false;
  resetHandMemory();
  keepAwake(false);
  chat = [];
  unread = 0;
  closeChat();
  stopPing();
  $('overlay').hidden = true;
  setStatus(null);
  showScreen('lobby');
}

// ---------- Boot ----------

function boot() {
  $('nameInput').value = store.get('localStorage', NAME_KEY) ?? '';
  const room = normalizeCode(new URLSearchParams(location.search).get('room'));
  if (room) $('codeInput').value = room;

  $('createBtn').addEventListener('click', () => begin('host'));
  $('joinBtn').addEventListener('click', () => begin('guest'));
  $('codeInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') begin('guest'); });
  $('askBtn').addEventListener('click', askSelected);
  $('againBtn').addEventListener('click', playAgain);
  $('leaveBtn').addEventListener('click', leave);
  $('overLeaveBtn').addEventListener('click', leave);
  $('rulesBtn').addEventListener('click', () => { $('rules').hidden = false; $('rulesClose').focus(); });
  $('rulesClose').addEventListener('click', () => { $('rules').hidden = true; });
  $('copyBtn').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(inviteUrl());
      showToast('Link copied!', 'info');
    } catch {
      showToast('Copy failed — share the code instead', 'info');
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { $('rules').hidden = $('install').hidden = true; closeChat(); }
  });
  $('fsBtn').hidden = isStandalone();
  $('fsBtn').addEventListener('click', () => {
    if (isFullscreen()) exitFullscreen();
    else if (canFullscreen()) enterFullscreen();
    else $('install').hidden = false; // iPhone Safari: only Add to Home Screen gives full screen
  });
  $('installClose').addEventListener('click', () => { $('install').hidden = true; });
  const showSound = () => {
    $('soundIcon').textContent = soundOn() ? '🔊' : '🔇';
    $('soundBtn').setAttribute('aria-pressed', String(soundOn()));
  };
  showSound();
  $('soundBtn').addEventListener('click', () => { setSound(!soundOn()); showSound(); });
  $('chatBtn').addEventListener('click', () => (chatOpen ? closeChat() : openChat()));
  $('overChatBtn').addEventListener('click', openChat);
  $('chatBubble').addEventListener('click', openChat);
  $('chatClose').addEventListener('click', closeChat);
  $('chatForm').addEventListener('submit', (e) => {
    e.preventDefault?.();
    if (sendChat($('chatInput').value)) $('chatInput').value = '';
  });
  renderQuick((q) => sendChat(q));
  // iPhone: keep the chat sheet above the on-screen keyboard.
  const vv = globalThis.visualViewport;
  const lift = () => { $('chat').style.bottom = `${Math.max(0, innerHeight - vv.height - vv.offsetTop)}px`; };
  vv?.addEventListener('resize', lift);
  vv?.addEventListener('scroll', lift);
  document.addEventListener('pointerdown', unlockAudio, { passive: true }); // audio needs a user gesture first
  document.addEventListener('keydown', unlockAudio);

  const saved = store.get('sessionStorage', SESSION_KEY);
  if (saved?.code && (saved.role === 'host' || saved.role === 'guest')) {
    session = saved;
    const resume = () => {
      if (!globalThis.Peer) return leave(), lobbyError('Could not load the networking library. Check your connection and reload.');
      saved.role === 'host' ? startHost(true) : startGuest();
    };
    if (globalThis.Peer) resume();
    else window.addEventListener('load', resume, { once: true });
  } else {
    showScreen('lobby');
    if (room) $('nameInput').focus();
  }
}

boot();
