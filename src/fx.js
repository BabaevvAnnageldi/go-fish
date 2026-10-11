// Visual effects and phone niceties. Every browser API is feature-checked so the game
// still works (and tests still run) where something isn't supported.

import { cardEl } from './ui.js';
import { playDraw } from './sound.js';

const doc = () => globalThis.document;
const reducedMotion = () => Boolean(globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
const hasRect = (n) => typeof n?.getBoundingClientRect === 'function';
const FLIGHT_MS = 650;

// ---------- Card flying from the pond ----------

// Animate one card from the pond to `target` (an element already rendered in its final place).
// faceCard: card id to flip face-up mid-flight (your own draws), or null to stay face-down.
function flyFromPond(target, faceCard, delay) {
  const d = doc();
  const pond = d?.querySelector?.('.pond-card');
  if (!hasRect(pond) || !hasRect(target) || !d.body || typeof d.body.animate !== 'function') return;
  const from = pond.getBoundingClientRect();
  const to = target.getBoundingClientRect();
  if (!to.width || !from.width) return;

  target.style.visibility = 'hidden';
  const flyer = d.createElement('div');
  flyer.className = 'flyer';
  Object.assign(flyer.style, { left: `${to.left}px`, top: `${to.top}px`, width: `${to.width}px`, height: `${to.height}px` });
  const flip = d.createElement('div');
  flip.className = 'flip';
  const back = d.createElement('div');
  back.className = 'card back';
  flip.append(back);
  if (faceCard) {
    const front = cardEl(faceCard);
    front.classList.add('front');
    flip.append(front);
  }
  flyer.append(flip);
  d.body.append(flyer);

  const dx = from.left + from.width / 2 - (to.left + to.width / 2);
  const dy = from.top + from.height / 2 - (to.top + to.height / 2);
  const s = from.width / to.width;
  const duration = FLIGHT_MS;
  const timing = { duration, delay, easing: 'cubic-bezier(.3,.7,.4,1)', fill: 'both' };
  const move = flyer.animate([
    { transform: `translate(${dx}px, ${dy}px) scale(${s})` },
    { transform: `translate(${dx * 0.45}px, ${dy * 0.45 - 40}px) scale(1.25)`, offset: 0.5 },
    { transform: 'translate(0, 0) scale(1)' },
  ], timing);
  if (faceCard) {
    flip.animate([{ transform: 'rotateY(0deg)' }, { transform: 'rotateY(0deg)', offset: 0.25 }, { transform: 'rotateY(180deg)' }], timing);
  }
  const finish = () => {
    target.style.visibility = '';
    flyer.remove();
  };
  move.onfinish = finish;
  move.oncancel = finish;
}

// Play a draw animation for each pond draw among `entries` (fresh engine log entries).
export function animateDraws(entries, you) {
  const d = doc();
  const still = reducedMotion();
  const draws = entries.filter((e) => e.kind === 'fish' || e.kind === 'refill');
  draws.forEach((e, i) => {
    const delay = 250 + i * 450;
    playDraw(delay, still ? 0 : FLIGHT_MS);
    if (still) return;
    if (e.player === you) {
      // Your card lands on its spot in your hand (or on your books if it completed one).
      const target = (e.card && d.querySelector(`#myHand [data-card="${e.card}"]`)) || d.querySelector('#myBooks .book:last-child');
      flyFromPond(target, e.card ?? null, delay);
    } else {
      flyFromPond(d.querySelector('#oppHand .card:last-child') || d.querySelector('#oppBooks .book:last-child'), null, delay);
    }
  });
}

export function buzz(ms = 30) {
  try { globalThis.navigator?.vibrate?.(ms); } catch { /* not supported */ }
}

// ---------- Full screen ----------

export function canFullscreen() {
  const d = doc();
  return Boolean(d?.fullscreenEnabled || d?.webkitFullscreenEnabled);
}

export function isFullscreen() {
  const d = doc();
  return Boolean(d?.fullscreenElement || d?.webkitFullscreenElement || isStandalone());
}

export function isStandalone() {
  return Boolean(globalThis.matchMedia?.('(display-mode: fullscreen), (display-mode: standalone)').matches
    || globalThis.navigator?.standalone);
}

export const isPhone = () => Boolean(globalThis.matchMedia?.('(pointer: coarse)').matches);

export async function enterFullscreen() {
  const root = doc()?.documentElement;
  if (!root || isFullscreen()) return;
  try {
    if (root.requestFullscreen) await root.requestFullscreen({ navigationUI: 'hide' });
    else if (root.webkitRequestFullscreen) root.webkitRequestFullscreen();
    await globalThis.screen?.orientation?.lock?.('portrait');
  } catch { /* user or browser declined; the game works fine windowed */ }
}

export async function exitFullscreen() {
  const d = doc();
  try {
    if (d.fullscreenElement) await d.exitFullscreen();
    else if (d.webkitFullscreenElement) d.webkitExitFullscreen();
  } catch { /* ignore */ }
}

// ---------- Keep the screen awake during a game (a sleeping phone drops the connection) ----------

let wakeLock = null;
let wantAwake = false;

export async function keepAwake(on) {
  wantAwake = on;
  try {
    if (on && !wakeLock && globalThis.navigator?.wakeLock && doc()?.visibilityState === 'visible') {
      wakeLock = await globalThis.navigator.wakeLock.request('screen');
      wakeLock.addEventListener?.('release', () => { wakeLock = null; });
    } else if (!on && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch { wakeLock = null; }
}

doc()?.addEventListener?.('visibilitychange', () => {
  if (wantAwake && doc().visibilityState === 'visible') keepAwake(true);
});
