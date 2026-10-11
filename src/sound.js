// Card sounds synthesized with the Web Audio API (no audio files). Silently does nothing where unsupported.

const KEY = 'gofish:sound';
let ctx = null;
let noise = null;
let enabled = true;
try { enabled = globalThis.localStorage?.getItem(KEY) !== 'off'; } catch { /* storage unavailable */ }

export const soundOn = () => enabled;

export function setSound(on) {
  enabled = on;
  try { globalThis.localStorage?.setItem(KEY, on ? 'on' : 'off'); } catch { /* storage unavailable */ }
  if (on) unlock();
}

// Browsers only allow audio after a user gesture, so this runs on the first tap anywhere.
export function unlock() {
  const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!AC) return;
  try {
    ctx ??= new AC();
    if (ctx.state === 'suspended') ctx.resume();
    if (!noise) {
      noise = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.4), ctx.sampleRate);
      const d = noise.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
  } catch { ctx = null; }
}

function burst(t, { dur, from, to, type = 'bandpass', q = 1, gain }) {
  const src = ctx.createBufferSource();
  src.buffer = noise;
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.Q.value = q;
  f.frequency.setValueAtTime(from, t);
  f.frequency.exponentialRampToValueAtTime(to, t + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.015);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f).connect(g).connect(ctx.destination);
  src.start(t);
  src.stop(t + dur + 0.02);
}

function thump(t, gain) {
  const o = ctx.createOscillator();
  o.type = 'sine';
  o.frequency.setValueAtTime(220, t);
  o.frequency.exponentialRampToValueAtTime(90, t + 0.07);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.08);
  o.connect(g).connect(ctx.destination);
  o.start(t);
  o.stop(t + 0.1);
}

// A card sliding off the pond (swish) and landing in a hand (tap), `delayMs` from now.
export function playDraw(delayMs = 0, flightMs = 650) {
  if (!enabled || !ctx || ctx.state !== 'running' || !noise) return;
  try {
    const t = ctx.currentTime + delayMs / 1000;
    burst(t, { dur: 0.22, from: 1400, to: 5200, q: 0.9, gain: 0.32 });
    const land = t + flightMs / 1000 - 0.03;
    burst(land, { dur: 0.06, from: 2600, to: 1800, type: 'highpass', q: 0.7, gain: 0.25 });
    thump(land, 0.22);
  } catch { /* ignore audio glitches */ }
}
