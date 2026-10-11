// Round-trip-time helpers for the ping indicator (pure; no DOM or network).

export const PING_EVERY_MS = 3000;
export const STALE_MS = 10000; // no reply for this long: hide the reading rather than show a stale one

export function median(samples) {
  if (!samples.length) return NaN;
  const s = [...samples].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// Keep the last `keep` plausible samples (a median of 5 ignores one-off spikes).
export function addSample(samples, rtt, keep = 5) {
  if (!Number.isFinite(rtt) || rtt < 0 || rtt > 30000) return samples;
  return [...samples.slice(-(keep - 1)), rtt];
}

export function pingQuality(ms) {
  return ms < 150 ? 'good' : ms < 300 ? 'fair' : 'poor';
}
