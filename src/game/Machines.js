/**
 * Machine statistics.
 *
 * The parameter set mirrors the one the original game used, because it encodes
 * a specific and unusual handling model rather than a generic one. The two that
 * matter most:
 *
 *   slipSpeed  Above this, holding the throttle through a corner breaks grip.
 *              Critically it sits *below* top speed, so at racing pace every
 *              corner is a traction failure you are actively suppressing.
 *
 *   gripRate   How fast the velocity vector is rotated back onto the heading.
 *              This is the whole cornering model: the machine can point
 *              anywhere, but it only *goes* where its velocity vector points.
 *
 * Everything else follows from those. Acceleration is a decaying curve sampled
 * by current speed rather than a formula, which is why these cars pull hard off
 * a corner and then crawl toward their top speed.
 *
 * Speeds are in metres per second; the HUD multiplies by 3.6 for km/h.
 */

/**
 * Sample a decaying acceleration curve. `t` is speed as a fraction of top
 * speed. Strong low down, tailing to nothing at the limit — so top speed is an
 * emergent property of the curve as well as a hard clamp.
 */
function accelAt(t, peak, tail) {
  if (t >= 1) return 0;
  const shaped = Math.pow(1 - t, 1.7);
  return peak * (tail + (1 - tail) * shaped);
}

const BASE = {
  // Yaw authority falls off with speed — the original stored this as a
  // 19-entry table indexed by speed, and the falloff is why high-speed
  // corrections feel heavy while low-speed ones feel darty.
  steerLow: 2.15,      // rad/s at a standstill
  steerHigh: 0.62,     // rad/s at top speed
  steerBoost: 0.55,    // multiplier while boosting: much less authority
  gripRate: 3.6,       // rad/s, velocity onto heading, when gripping
  slipGripRate: 0.42,  // rad/s when traction is lost — near-pure understeer
  slideRate: 15.0,     // m/s^2 lateral strafe from the lean buttons
  slideCost: 0.055,    // fraction of speed shed per second while leaning
  brake: 48,
  drag: 0.00022,       // quadratic; ~3.9 m/s^2 at top speed, below every machine's accel tail
  rollingDrag: 0.5,    // linear
  dirtDecel: 26,       // rough ground
  offTrackDecel: 34,   // beyond the rails entirely
  rideHeight: 1.5,
  hoverStiffness: 190,
  hoverDamping: 21,
  gravity: 34,
};

export const MACHINES = [
  {
    id: 'blue-falcon',
    name: 'BLUE COMET',
    pilot: 'C. TALON',
    number: 111,
    colors: { body: 0x2f6bff, accent: 0xe8f2ff, trim: 0xff3b6b, glow: 0x4fd8ff },
    topSpeed: 126.9,
    weight: 1260,
    accelPeak: 52,
    accelTail: 0.11,
    slipSpeedFactor: 0.72,
    gripRate: 3.6,
    boostPeakFactor: 1.23,
    armour: 1.0,
    stats: { body: 3, boost: 3, grip: 3 },   // 1..5, shown in the select screen
    blurb: 'BALANCED. NO WEAKNESS, NO EXCUSE.',
  },
  {
    id: 'golden-fox',
    name: 'AMBER LANCE',
    pilot: 'DR. VOSS',
    number: 3,
    colors: { body: 0xf2b632, accent: 0x2a1a06, trim: 0xff6a2a, glow: 0xffd75e },
    topSpeed: 121.7,
    weight: 1020,
    accelPeak: 74,          // best acceleration in the field
    accelTail: 0.09,
    slipSpeedFactor: 0.63,  // and the earliest to let go
    gripRate: 2.9,
    boostPeakFactor: 1.28,
    armour: 0.66,           // stands up poorly to impact
    stats: { body: 1, boost: 4, grip: 2 },
    blurb: 'SAVAGE OFF THE LINE. FRAGILE EVERYWHERE ELSE.',
  },
  {
    id: 'wild-goose',
    name: 'IRON SKUA',
    pilot: 'PICO',
    number: 24,
    colors: { body: 0x3f8f5a, accent: 0x101c14, trim: 0xa8ff6a, glow: 0x8cff9c },
    topSpeed: 128.3,
    weight: 1620,
    accelPeak: 41,
    accelTail: 0.14,
    slipSpeedFactor: 0.75,
    gripRate: 3.9,
    boostPeakFactor: 1.19,
    armour: 1.55,           // built to be hit
    stats: { body: 5, boost: 2, grip: 4 },
    blurb: 'HEAVY. TAKES A BEATING AND GIVES ONE BACK.',
  },
  {
    id: 'fire-stingray',
    name: 'CRIMSON RAY',
    pilot: 'G. SABRE',
    number: 8,
    colors: { body: 0xe23a5c, accent: 0xffd0d8, trim: 0x2a1020, glow: 0xff7a9c },
    topSpeed: 132.8,        // fastest in the field
    weight: 1960,
    accelPeak: 33,          // and the slowest to get there
    accelTail: 0.16,
    slipSpeedFactor: 0.82,  // best grip: holds on far longer than anything else
    gripRate: 4.3,
    boostPeakFactor: 1.21,
    armour: 1.25,
    stats: { body: 4, boost: 5, grip: 5 },
    blurb: 'RELENTLESS TOP END. PATIENCE REQUIRED.',
  },
];

/** Resolve a machine id into a full parameter block. */
export function machineParams(id) {
  const m = MACHINES.find((x) => x.id === id) ?? MACHINES[0];
  const p = { ...BASE, ...m };
  p.slipSpeed = p.topSpeed * p.slipSpeedFactor;
  p.boostPeak = p.topSpeed * p.boostPeakFactor;
  p.gripRate = m.gripRate ?? BASE.gripRate;
  // Heavier machines shrug off contact and shove lighter ones around.
  p.massRatio = p.weight / 1260;
  p.accelAt = (speed) => accelAt(Math.max(0, speed) / p.topSpeed, p.accelPeak, p.accelTail);
  return p;
}

export function machineById(id) {
  return MACHINES.find((m) => m.id === id) ?? MACHINES[0];
}

/** Energy economy, shared by every machine. */
export const ENERGY = {
  max: 100,
  // Per second of continuous contact.
  railDrain: 26,
  dirtDrain: 7,
  offTrackDrain: 22,
  rechargeRate: 30,
  // One-off hits.
  mineHit: 32,
  crashHit: 14,
  grazeHit: 4,
  // Below this fraction the machine's top speed is clamped, which is the
  // original's quiet second failure state: you do not explode, you just stop
  // being competitive.
  weakThreshold: 0.26,
  weakSpeedFactor: 0.84,
};

/** Boost behaves as a repeating sawtooth rather than a flat speed buff. */
export const BOOST = {
  duration: 3.8,
  maxCharges: 3,
  accel: 130,               // m/s^2 while below the sawtooth target
  // Speed decays from the peak back to top speed, then re-spikes. It is what
  // makes a boost feel like a series of kicks instead of a smooth ramp.
  sawtoothDecay: 0.34,
  firstLap: false,          // no boost on the opening lap
};
