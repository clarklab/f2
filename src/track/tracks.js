import { loop, resolveZones } from './LoopBuilder.js';

/**
 * Circuit definitions.
 *
 * Each track is described as a drive around it — straights in metres, corners
 * as an angle and a radius — and `loop()` turns that into control points with a
 * guaranteed-smooth join at the start line. Segments carry names so that
 * surface zones can say "the middle of the back straight" instead of "58.2% of
 * a lap", and stay correct when a corner is retuned.
 *
 * The layouts are original, but the design vocabulary is deliberately borrowed
 * from the 1990 original: a zero-grip coating on the corner that decides the
 * lap, a mid-lap pit that costs real time to use, mine fields with exactly one
 * clean lane through them, and a constant crosswind that is worse when slow.
 */

export const THEMES = {
  city: {
    name: 'MUTE CITY',
    // Deep night. The gradient never reaches daylight at the top, because the
    // brightest thing on this circuit should be the windows.
    sky: [[0, 0x04060f], [0.4, 0x0b1230], [0.72, 0x1b2a5c], [1, 0x35407e]],
    fog: 0x141c40,
    fogNear: 70,
    fogFar: 620,
    markerColor: 0xff6a92,
    ground: { color: 0x0c0f1e, y: -34, gridLines: true },
    env: 'city',
    track: {
      road: 0x9aa0ab, roadDark: 0x767c88, rung: 0x5c626e,
      stripe: 0xffffff, stripe2: 0x2a2f3d, shoulder: 0x0d0f18,
      shoulderLight: 0x1b1f30, seed: 3, rungEvery: 16,
    },
  },
  ocean: {
    name: 'BIG BLUE',
    // Low sun: the sky is warm at the horizon and cools upward, so the sun
    // billboard sits in colour that belongs to it.
    sky: [[0, 0x10214e], [0.34, 0x2f6aa8], [0.62, 0xf0a058], [1, 0xffd9a0]],
    fog: 0xe8a878,
    fogNear: 80,
    fogFar: 680,
    markerColor: 0xff8a3a,
    ground: { color: 0xd8b078, y: -11 },
    env: 'ocean',
    track: {
      road: 0xa8aec4, roadDark: 0x848aa4, rung: 0x666c88,
      stripe: 0xfff4d0, stripe2: 0x2a2038, shoulder: 0x120c22,
      shoulderLight: 0x231838, seed: 11, rungEvery: 16,
    },
  },
  desert: {
    name: 'SAND OCEAN',
    sky: [[0, 0x2a1436], [0.36, 0x8a3a52], [0.66, 0xdc8a5a], [1, 0xf6d9a0]],
    fog: 0xdc8a5a,
    fogNear: 60,
    fogFar: 620,
    markerColor: 0x6ad8ff,
    ground: { color: 0xb98a52, y: -22, dunes: true },
    env: 'desert',
    track: {
      road: 0x9c9184, roadDark: 0x7a7166, rung: 0x5e564d,
      stripe: 0xffe9b0, stripe2: 0x2c2118, shoulder: 0x140f0a,
      shoulderLight: 0x241a12, seed: 21, rungEvery: 16,
    },
  },
  grid: {
    name: 'SILENCE',
    // Cold vacuum blue. A space port reads as industrial only if the light is
    // colourless, so nothing here is warm except the hazard paint on the pipes.
    sky: [[0, 0x060c18], [0.42, 0x122234], [0.74, 0x27455a], [1, 0x437084]],
    fog: 0x1e3648,
    fogNear: 60,
    fogFar: 560,
    markerColor: 0x7dff9c,
    ground: { color: 0x2a2f38, y: -15, gridLines: true },
    env: 'grid',
    track: {
      road: 0x8790a0, roadDark: 0x646c7e, rung: 0x474e5e,
      stripe: 0x9dffb8, stripe2: 0x12261c, shoulder: 0x07110c,
      shoulderLight: 0x0f2018, seed: 33, rungEvery: 12,
    },
  },
  wind: {
    name: 'DEATH WIND',
    // Overcast forest: a pale sky so the canopy silhouettes read against it.
    sky: [[0, 0x243044], [0.4, 0x4c6072], [0.72, 0x8ca0a4], [1, 0xc8d4c4]],
    fog: 0x8ca0a4,
    fogNear: 55,
    fogFar: 500,
    markerColor: 0xffe14d,
    ground: { color: 0x2c4a2c, y: -11 },
    env: 'wind',
    track: {
      road: 0x93989e, roadDark: 0x70757c, rung: 0x53585f,
      stripe: 0xffe14d, stripe2: 0x2b2418, shoulder: 0x110e0c,
      shoulderLight: 0x201a16, seed: 44, rungEvery: 14,
    },
  },
  fire: {
    name: 'FIRE FIELD',
    sky: [[0, 0x1c0408], [0.34, 0x6e1010], [0.62, 0xc4401a], [1, 0xf5a83c]],
    fog: 0xc4401a,
    fogNear: 50,
    fogFar: 520,
    markerColor: 0x66f0ff,
    ground: { color: 0x5a2018, y: -22, lava: true },
    env: 'fire',
    track: {
      road: 0x8b8078, roadDark: 0x69605a, rung: 0x4c4540,
      stripe: 0xffd06a, stripe2: 0x2a1008, shoulder: 0x150604,
      shoulderLight: 0x2a100a, seed: 57, rungEvery: 12,
    },
  },
};

const DEFS = [
  // ---------------------------------------------------------------------
  {
    id: 'neon-mile',
    name: 'NEON MILE',
    subtitle: 'MUTE CITY',
    theme: 'city',
    difficulty: 1,
    laps: 3,
    width: 30,
    // Wide and forgiving: two gentle rights onto a long backstretch carrying a
    // jump plate, a chicane on the far side, then square corners home.
    layout: [
      { s: 220, name: 'home-straight' },
      { turn: 45, r: 150, name: 't1' },
      { s: 90 },
      { turn: 45, r: 150, name: 't2' },
      { s: 300, name: 'backstretch', y: 7 },
      { turn: 90, r: 120, name: 't3', y: 0 },
      { s: 260, name: 'east-straight' },
      { turn: 55, r: 130, name: 'chicane-in' },
      { turn: -55, r: 150, name: 'chicane-out' },
      { s: 120, name: 'link' },
      { turn: 90, r: 110, name: 't4' },
      { s: 240, name: 'south-straight' },
      { turn: 90, r: 95, name: 'final-turn' },
      { s: 140, name: 'run-in' },
    ],
    zones: [
      { type: 'recharge', seg: 'home-straight', at: [0.18, 0.75], dMin: -1.0, dMax: -0.42 },
      { type: 'dirt', seg: 't1', at: [0.2, 0.9], dMin: -1.0, dMax: -0.5 },
      { type: 'boost', seg: 'backstretch', at: [0.12, 0.22], dMin: -0.3, dMax: 0.3 },
      { type: 'jump', seg: 'backstretch', at: [0.62, 0.7], dMin: -0.34, dMax: 0.34 },
      { type: 'dirt', seg: 'east-straight', at: [0.25, 0.6], dMin: 0.44, dMax: 1.0 },
      { type: 'dirt', seg: 'south-straight', at: [0.3, 0.7], dMin: -1.0, dMax: -0.46 },
      { type: 'boost', seg: 'run-in', at: [0.15, 0.55], dMin: -0.28, dMax: 0.28 },
    ],
  },

  // ---------------------------------------------------------------------
  {
    id: 'azure-drift',
    name: 'AZURE DRIFT',
    subtitle: 'BIG BLUE',
    theme: 'ocean',
    difficulty: 2,
    laps: 3,
    width: 32,
    // Broad and flowing over open water. Everything here is a setup for the
    // last corner, which is coated and has no grip at all — you arrive at full
    // speed and steer the nose while the machine keeps going straight.
    layout: [
      { s: 180, name: 'home-straight' },
      { turn: 70, r: 170, name: 't1', y: 4 },
      { s: 140, y: 8 },
      { turn: -40, r: 180, name: 'kink-a' },
      { turn: 40, r: 180, name: 'kink-b', y: 10 },
      { s: 220, name: 'north-straight', y: 12 },
      { turn: 90, r: 150, name: 't2', y: 8 },
      { s: 260, name: 'backstretch', y: 0 },
      { turn: 60, r: 140, name: 't3', y: -4 },
      { s: 100, name: 'link' },
      { turn: 50, r: 120, name: 't4', y: 0 },
      { s: 180, name: 'approach' },
      { turn: 90, r: 110, name: 'coated-corner' },
      { s: 160, name: 'run-in' },
    ],
    zones: [
      { type: 'recharge', seg: 'home-straight', at: [0.15, 0.8], dMin: -1.0, dMax: -0.44 },
      { type: 'dirt', seg: 't1', at: [0.25, 0.85], dMin: 0.46, dMax: 1.0 },
      { type: 'boost', seg: 'north-straight', at: [0.2, 0.32], dMin: -0.3, dMax: 0.3 },
      { type: 'dirt', seg: 'backstretch', at: [0.3, 0.62], dMin: -1.0, dMax: -0.48 },
      { type: 'boost', seg: 'backstretch', at: [0.75, 0.86], dMin: -0.3, dMax: 0.3 },
      { type: 'ice', seg: 'approach', at: [0.86, 1.0], dMin: -1.0, dMax: 1.0 },
      { type: 'ice', seg: 'coated-corner', at: [0.0, 0.78], dMin: -1.0, dMax: 1.0 },
    ],
  },

  // ---------------------------------------------------------------------
  {
    id: 'dune-sea',
    name: 'DUNE SEA',
    subtitle: 'SAND OCEAN',
    theme: 'desert',
    difficulty: 3,
    laps: 3,
    width: 28,
    // Long constant-radius sweepers over rolling dunes. No mines, no ice — a
    // pure cornering exam where the only punishment is losing momentum.
    layout: [
      { s: 200, name: 'home-straight' },
      { turn: 80, r: 200, name: 't1', y: 10 },
      { s: 180, name: 'rise', y: 16 },
      { turn: 70, r: 220, name: 't2', y: 12 },
      { s: 150, name: 'link-a' },
      { turn: -50, r: 200, name: 't3', y: 4 },
      { s: 120, name: 'link-b' },
      { turn: 50, r: 180, name: 't4', y: 0 },
      { s: 260, name: 'north-straight', y: -6 },
      { turn: 90, r: 160, name: 't5', y: -8 },
      { s: 300, name: 'backstretch', y: 0 },
      { turn: 120, r: 140, name: 'long-left', y: 6 },
      { s: 180, name: 'link-c' },
      { turn: -60, r: 170, name: 'chicane-in' },
      { turn: 60, r: 150, name: 'chicane-out', y: 0 },
      { s: 220, name: 'run-in' },
    ],
    zones: [
      { type: 'recharge', seg: 'home-straight', at: [0.15, 0.78], dMin: 0.44, dMax: 1.0 },
      { type: 'dirt', seg: 't1', at: [0.2, 0.75], dMin: -1.0, dMax: -0.44 },
      { type: 'boost', seg: 'rise', at: [0.25, 0.45], dMin: -0.3, dMax: 0.3 },
      { type: 'dirt', seg: 't3', at: [0.15, 0.85], dMin: 0.44, dMax: 1.0 },
      { type: 'jump', seg: 'north-straight', at: [0.55, 0.63], dMin: -0.34, dMax: 0.34 },
      { type: 'dirt', seg: 'backstretch', at: [0.25, 0.55], dMin: -1.0, dMax: -0.4 },
      { type: 'boost', seg: 'backstretch', at: [0.72, 0.82], dMin: -0.3, dMax: 0.3 },
      { type: 'dirt', seg: 'link-c', at: [0.2, 0.8], dMin: 0.4, dMax: 1.0 },
    ],
  },

  // ---------------------------------------------------------------------
  {
    id: 'silent-grid',
    name: 'SILENT GRID',
    subtitle: 'SILENCE',
    theme: 'grid',
    difficulty: 4,
    laps: 3,
    width: 24,
    // Square corners and narrow corridors. Each mine field leaves exactly one
    // clean lane, and it is never the lane you would take for the next corner.
    layout: [
      { s: 160, name: 'home-straight' },
      { turn: 90, r: 70, name: 'c1' },
      { s: 180, name: 'a' },
      { turn: 90, r: 65, name: 'c2' },
      { s: 120, name: 'b' },
      { turn: -90, r: 70, name: 'c3' },
      { s: 140, name: 'c' },
      { turn: -45, r: 80, name: 's-in' },
      { turn: 45, r: 70, name: 's-out' },
      { s: 200, name: 'd' },
      { turn: 90, r: 60, name: 'c4' },
      { s: 160, name: 'e' },
      { turn: 90, r: 60, name: 'c5' },
      { s: 130, name: 'f' },
      { turn: 90, r: 70, name: 'c6' },
      { s: 180, name: 'run-in' },
    ],
    zones: [
      { type: 'recharge', seg: 'home-straight', at: [0.15, 0.8], dMin: -1.0, dMax: -0.46 },
      { type: 'boost', seg: 'a', at: [0.2, 0.36], dMin: -0.3, dMax: 0.3 },
      { type: 'dirt', seg: 'b', at: [0.2, 0.8], dMin: 0.46, dMax: 1.0 },
      { type: 'mines', seg: 'c', at: [0.1, 0.9], dMin: -0.45, dMax: 1.0 },
      { type: 'boost', seg: 'd', at: [0.3, 0.44], dMin: -0.3, dMax: 0.3 },
      { type: 'dirt', seg: 'e', at: [0.25, 0.8], dMin: -1.0, dMax: -0.42 },
      { type: 'mines', seg: 'f', at: [0.1, 0.9], dMin: -1.0, dMax: 0.4 },
      { type: 'boost', seg: 'run-in', at: [0.2, 0.45], dMin: -0.28, dMax: 0.28 },
    ],
  },

  // ---------------------------------------------------------------------
  {
    id: 'gale-spine',
    name: 'GALE SPINE',
    subtitle: 'DEATH WIND',
    theme: 'wind',
    difficulty: 4,
    laps: 3,
    width: 22,
    // Geometrically the simplest circuit here — a rounded rectangle — made
    // difficult purely by a constant crosswind and a chain of dash plates that
    // have to be hit on line. The pit sits mid-lap, so using it costs you.
    layout: [
      { s: 300, name: 'home-straight' },
      { turn: 90, r: 120, name: 'c1', y: 10 },
      { s: 220, name: 'north', y: 14 },
      { turn: 90, r: 120, name: 'c2', y: 8 },
      { s: 300, name: 'backstretch', y: 0 },
      { turn: 90, r: 120, name: 'c3' },
      { s: 220, name: 'south' },
      { turn: 90, r: 120, name: 'c4' },
    ],
    // A constant lateral push in world space. Because it is an acceleration
    // rather than a drag, it hurts more the slower you are going — which is
    // exactly what makes recovering from a mistake here so punishing.
    wind: { x: 5.6, z: 1.0 },
    zones: [
      { type: 'dirt', seg: 'home-straight', at: [0.55, 0.85], dMin: -1.0, dMax: -0.42 },
      { type: 'boost', seg: 'north', at: [0.15, 0.34], dMin: -0.32, dMax: 0.32 },
      { type: 'boost', seg: 'north', at: [0.55, 0.74], dMin: -0.32, dMax: 0.32 },
      { type: 'recharge', seg: 'backstretch', at: [0.28, 0.72], dMin: 0.4, dMax: 1.0 },
      { type: 'dirt', seg: 'south', at: [0.2, 0.55], dMin: -1.0, dMax: -0.44 },
      { type: 'boost', seg: 'south', at: [0.7, 0.92], dMin: -0.32, dMax: 0.32 },
    ],
  },

  // ---------------------------------------------------------------------
  {
    id: 'ember-core',
    name: 'EMBER CORE',
    subtitle: 'FIRE FIELD',
    theme: 'fire',
    difficulty: 5,
    laps: 3,
    width: 26,
    // The finale: roughly half again as long as the opener and the only circuit
    // carrying every hazard class at once. Energy attrition, not lap time, is
    // the real opponent.
    layout: [
      { s: 220, name: 'home-straight' },
      { turn: 60, r: 170, name: 't1' },
      { s: 180, name: 'a' },
      { turn: 70, r: 150, name: 't2', y: 8 },
      { s: 240, name: 'b', y: 12 },
      { turn: -45, r: 160, name: 't3', y: 6 },
      { s: 140, name: 'c' },
      { turn: 45, r: 140, name: 't4', y: 0 },
      { s: 300, name: 'long-straight' },
      { turn: 90, r: 130, name: 't5', y: -6 },
      { s: 260, name: 'backstretch', y: 0 },
      { turn: 30, r: 120, name: 't6' },
      { s: 160, name: 'd' },
      { turn: -55, r: 150, name: 'chicane-in' },
      { turn: 55, r: 130, name: 'chicane-out' },
      { s: 220, name: 'e' },
      { turn: 55, r: 110, name: 't7' },
      { s: 180, name: 'f' },
      { turn: 55, r: 140, name: 't8' },
      { s: 200, name: 'run-in' },
    ],
    zones: [
      { type: 'mines', seg: 'a', at: [0.1, 0.85], dMin: -0.5, dMax: 0.5 },
      { type: 'boost', seg: 'b', at: [0.15, 0.28], dMin: -0.3, dMax: 0.3 },
      { type: 'dirt', seg: 'c', at: [0.1, 0.9], dMin: 0.42, dMax: 1.0 },
      { type: 'jump', seg: 'long-straight', at: [0.42, 0.5], dMin: -0.34, dMax: 0.34 },
      { type: 'dirt', seg: 'backstretch', at: [0.2, 0.55], dMin: -1.0, dMax: -0.44 },
      { type: 'ice', seg: 'd', at: [0.3, 1.0], dMin: -1.0, dMax: 1.0 },
      { type: 'ice', seg: 'chicane-in', at: [0.0, 0.6], dMin: -1.0, dMax: 1.0 },
      { type: 'mines', seg: 'e', at: [0.2, 0.6], dMin: -0.42, dMax: 0.42 },
      { type: 'boost', seg: 'f', at: [0.25, 0.45], dMin: -0.3, dMax: 0.3 },
      { type: 'recharge', seg: 'run-in', at: [0.05, 0.5], dMin: -1.0, dMax: -0.42 },
      { type: 'boost', seg: 'run-in', at: [0.62, 0.82], dMin: -0.3, dMax: 0.3 },
    ],
  },
];

/** Build every circuit once, at module load. */
export const TRACKS = DEFS.map((def) => {
  const built = loop(def.layout, { width: def.width, spacing: 32 });
  return {
    ...def,
    controlPoints: built.points,
    zones: resolveZones(def.zones, built),
    approxLength: built.length,
    closureGap: built.closureGap,
  };
});

export function trackById(id) {
  return TRACKS.find((t) => t.id === id) ?? TRACKS[0];
}

/** The championship running order, easiest first. */
export const GRAND_PRIX = {
  id: 'knight',
  name: 'KNIGHT CUP',
  trackIds: TRACKS.map((t) => t.id),
};
