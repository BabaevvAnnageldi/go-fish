// PeerJS networking. The host is authoritative; the guest only sends intents and renders views.

const PREFIX = 'gofish-v1-';
const PEER_OPTIONS = {
  debug: 0,
  config: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun.cloudflare.com:3478' },
    ],
  },
};
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I/O to avoid confusion

export function randomCode() {
  let s = '';
  for (let i = 0; i < 4; i++) s += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  return s;
}

export function normalizeCode(raw) {
  const c = String(raw ?? '').toUpperCase().replace(/[^A-Z]/g, '');
  return c.length === 4 ? c : null;
}

const defaultPeer = () => globalThis.Peer;

export class HostSession {
  constructor({ code, onMessage, onStatus, canSeat = () => true, PeerImpl = defaultPeer() }) {
    Object.assign(this, { code, onMessage, onStatus, canSeat, PeerImpl });
    this.conn = null;
    this.destroyed = false;
  }

  start() {
    const peer = new this.PeerImpl(PREFIX + this.code, PEER_OPTIONS);
    this.peer = peer;
    peer.on('open', () => !this.destroyed && this.onStatus(this.conn?.open ? 'connected' : 'waiting'));
    peer.on('connection', (conn) => this.#accept(conn));
    peer.on('disconnected', () => {
      if (this.destroyed) return;
      this.onStatus('broker-lost');
      setTimeout(() => !this.destroyed && !peer.destroyed && peer.reconnect(), 1500);
    });
    peer.on('error', (err) => {
      if (this.destroyed) return;
      if (err.type === 'unavailable-id') this.onStatus('code-taken');
      else if (err.type === 'network' || err.type === 'server-error') this.onStatus('broker-lost');
      else console.warn('[host]', err.type, err);
    });
  }

  // A connection only takes the guest seat once its 'hello' is accepted by canSeat(hello).
  #accept(conn) {
    conn.on('data', (msg) => {
      if (this.destroyed) return;
      if (conn === this.conn) return this.onMessage(msg);
      if (msg?.type !== 'hello') return;
      if (!this.canSeat(msg, Boolean(this.conn?.open))) {
        conn.send({ type: 'full' });
        setTimeout(() => conn.close(), 500);
        return;
      }
      const old = this.conn;
      this.conn = conn;
      old?.close();
      this.onStatus('connected');
      this.onMessage(msg);
    });
    const drop = () => {
      if (conn !== this.conn) return;
      this.conn = null;
      if (!this.destroyed) this.onStatus('guest-left');
    };
    conn.on('close', drop);
    conn.on('error', drop);
  }

  send(msg) {
    if (this.conn?.open) this.conn.send(msg);
  }

  destroy() {
    this.destroyed = true;
    this.peer?.destroy();
  }

  // Host leaving on purpose: tell the guest, then tear down once the message has had time to flush.
  leave(flushMs = 150) {
    this.send({ type: 'bye' });
    this.destroyed = true;
    const peer = this.peer;
    setTimeout(() => peer?.destroy(), flushMs);
  }
}

export class GuestSession {
  constructor({ code, onMessage, onStatus, onOpen, PeerImpl = defaultPeer() }) {
    Object.assign(this, { code, onMessage, onStatus, onOpen, PeerImpl });
    this.conn = null;
    this.destroyed = false;
    this.retryTimer = null;
  }

  start() {
    const peer = new this.PeerImpl(undefined, PEER_OPTIONS);
    this.peer = peer;
    this.onStatus('connecting');
    peer.on('open', () => { if (!this.conn?.open) this.#connect(); }); // also fires after reconnect()
    peer.on('disconnected', () => {
      if (!this.destroyed) setTimeout(() => !this.destroyed && !peer.destroyed && peer.reconnect(), 1500);
    });
    peer.on('error', (err) => {
      if (err.type === 'peer-unavailable') {
        this.onStatus('host-missing');
        this.#retry(3000);
      } else if (err.type === 'network' || err.type === 'server-error') {
        this.onStatus('reconnecting');
      } else {
        console.warn('[guest]', err.type, err);
      }
    });
  }

  #connect() {
    if (this.destroyed) return;
    clearTimeout(this.retryTimer);
    const conn = this.peer.connect(PREFIX + this.code, { reliable: true });
    this.conn = conn;
    const openTimeout = setTimeout(() => {
      if (!conn.open && conn === this.conn) {
        conn.close();
        this.#retry(1000);
      }
    }, 12000);
    conn.on('open', () => {
      clearTimeout(openTimeout);
      this.onStatus('connected');
      this.onOpen();
    });
    conn.on('data', (msg) => this.onMessage(msg));
    const drop = () => {
      clearTimeout(openTimeout);
      if (conn !== this.conn || this.destroyed) return;
      this.conn = null;
      this.onStatus('reconnecting');
      this.#retry(2000);
    };
    conn.on('close', drop);
    conn.on('error', drop);
  }

  #retry(ms) {
    if (this.destroyed) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      if (this.destroyed) return;
      if (this.peer.destroyed) this.start(); // the peer died for good: start over with a fresh one
      else if (this.peer.disconnected) this.peer.reconnect();
      else if (this.peer.open) this.#connect();
    }, ms);
  }

  send(msg) {
    if (this.conn?.open) this.conn.send(msg);
  }

  destroy() {
    this.destroyed = true;
    clearTimeout(this.retryTimer);
    this.peer?.destroy();
  }
}
