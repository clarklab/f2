// Small numeric helpers used all over the game. Kept dependency-free and
// allocation-free so they are safe to call inside the fixed-step update.

export const TAU = Math.PI * 2;

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, v) => (b === a ? 0 : (v - a) / (b - a));
export const smoothstep = (t) => {
  t = clamp01(t);
  return t * t * (3 - 2 * t);
};
export const smootherstep = (t) => {
  t = clamp01(t);
  return t * t * t * (t * (t * 6 - 15) + 10);
};

/** Signed shortest angular difference, result in (-PI, PI]. */
export function angleDelta(a, b) {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d <= -Math.PI) d += TAU;
  return d;
}

/**
 * Frame-rate independent exponential approach. `rate` is roughly "how many
 * e-foldings per second"; higher = snappier. This is the standard
 * `1 - exp(-rate*dt)` formulation, which stays stable at any dt unlike a raw
 * `lerp(a, b, k)` that changes meaning when the timestep changes.
 */
export function damp(a, b, rate, dt) {
  return lerp(a, b, 1 - Math.exp(-rate * dt));
}

export function dampAngle(a, b, rate, dt) {
  return a + angleDelta(a, b) * (1 - Math.exp(-rate * dt));
}

/** Move `a` toward `b` by at most `maxDelta`. */
export function moveTowards(a, b, maxDelta) {
  const d = b - a;
  if (Math.abs(d) <= maxDelta) return b;
  return a + Math.sign(d) * maxDelta;
}

/** Wrap v into [0, m). Correct for negative inputs, unlike `%`. */
export const wrap = (v, m) => ((v % m) + m) % m;

/** Shortest signed distance from a to b on a ring of circumference m. */
export function ringDelta(a, b, m) {
  let d = wrap(b - a, m);
  if (d > m * 0.5) d -= m;
  return d;
}

/**
 * Mulberry32 — small, fast, seedable PRNG. Deterministic tracks and AI
 * personalities matter for reproducible demos, so nothing uses Math.random.
 */
export function makeRng(seed = 1) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Cheap 1D value noise built on a seeded hash — used for scenery scatter. */
export function hash1(n) {
  let x = Math.sin(n * 127.1) * 43758.5453;
  return x - Math.floor(x);
}

export function formatTime(seconds) {
  if (!isFinite(seconds) || seconds < 0) return "--'--\"--";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  const cs = Math.floor((seconds * 100) % 100);
  return `${m}'${String(s).padStart(2, '0')}"${String(cs).padStart(2, '0')}`;
}

/** The aspect ratio every camera FOV in the game was tuned against. */
export const REF_ASPECT = 270 / 480;

/**
 * Convert a vertical FOV tuned at REF_ASPECT into the vertical FOV that gives
 * the same *horizontal* field at some other aspect ratio.
 *
 * A perspective camera holds its vertical FOV fixed, so a taller-than-9:16
 * frame — which is every phone — silently narrows the horizontal field and the
 * track comes out wider on screen than it was tuned to be. Pinning the
 * horizontal field instead keeps the composition identical and spends the extra
 * rows on seeing further ahead.
 */
export function fitFov(tunedDeg, aspect) {
  if (Math.abs(aspect - REF_ASPECT) < 1e-4) return tunedDeg;
  const halfH = Math.atan(Math.tan((tunedDeg * Math.PI) / 360) * REF_ASPECT);
  return (Math.atan(Math.tan(halfH) / aspect) * 360) / Math.PI;
}
