import * as THREE from 'three';
import { fbm } from '../render/Textures.js';

/**
 * The track's cross-section is drawn from a single texture whose U axis is
 * split into bands: road, edge stripe, shoulder. Because the bands are laid out
 * horizontally and V still tiles cleanly, the entire road ribbon — surface,
 * stripes and shoulders — renders as one mesh with one material and therefore
 * one draw call per chunk, instead of three.
 *
 *   U:  0.000 -------- 0.500 --- 0.750 --- 1.000
 *       |    road      | stripe  | shoulder |
 *
 * UVs are inset half a texel from each band boundary. Nearest filtering still
 * bleeds at band edges without that inset, because a UV of exactly 0.5 sits on
 * the boundary between two texels and floating point decides arbitrarily which
 * one wins.
 */

export const BAND = {
  ROAD: { u0: 0.0, u1: 0.5 },
  STRIPE: { u0: 0.5, u1: 0.75 },
  SHOULDER: { u0: 0.75, u1: 1.0 },
};

const SIZE = 64;
const cache = new Map();

const hexToRgb = (h) => [(h >> 16) & 255, (h >> 8) & 255, h & 255];
const mix = (a, b, t) => a + (b - a) * t;
const BAYER4 = [
  [0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5],
].map((r) => r.map((v) => (v + 0.5) / 16));

function blend(a, b, t) {
  const [ar, ag, ab] = hexToRgb(a);
  const [br, bg, bb] = hexToRgb(b);
  return [
    Math.round(mix(ar, br, t)), Math.round(mix(ag, bg, t)), Math.round(mix(ab, bb, t)),
  ];
}

/**
 * @param {object} p Palette for this circuit.
 *   road / roadDark  base surface colours
 *   rung             colour of the horizontal seams that stream toward the camera
 *   stripe / stripe2 the bright edge line
 *   shoulder         the dark band the edge markers sit on
 */
export function trackAtlas(p) {
  const key = JSON.stringify(p);
  if (cache.has(key)) return cache.get(key);

  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  const img = ctx.createImageData(SIZE, SIZE);
  const buf = img.data;

  const roadW = SIZE * 0.5;          // 32 px
  const stripeW = SIZE * 0.25;       // 16 px

  for (let y = 0; y < SIZE; y++) {
    const dith = BAYER4[y & 3];
    for (let x = 0; x < SIZE; x++) {
      let rgb;

      if (x < roadW) {
        // --- road surface ---
        const n = fbm((x / roadW) * 6, (y / SIZE) * 6, 6, 6, 3, p.seed ?? 3);
        const t = dith[x & 3];
        const banded = Math.floor((n + (t - 0.5) * 0.35) * 4) / 4;
        // Deliberately narrow range. The road wants to read as one flat colour
        // with the seams providing all the detail; strong surface noise turns
        // into mush at distance and fights the sensation of speed.
        rgb = blend(p.roadDark, p.road, Math.max(0, Math.min(1, 0.62 + banded * 0.3)));
        // Horizontal seams. These are the highest-frequency feature on the
        // track and do most of the work of conveying speed.
        if (y % (p.rungEvery ?? 16) === 0) rgb = blend((rgb[0] << 16) | (rgb[1] << 8) | rgb[2], p.rung, 0.8);
      } else if (x < roadW + stripeW) {
        // --- edge stripe: alternating dashes so it strobes past at speed ---
        const on = (y % 16) < 10;
        rgb = hexToRgb(on ? p.stripe : (p.stripe2 ?? p.shoulder));
      } else {
        // --- shoulder: near-black with just enough noise to not look flat ---
        const n = fbm((x / SIZE) * 8, (y / SIZE) * 8, 8, 8, 2, (p.seed ?? 3) + 17);
        const t = dith[x & 3];
        const banded = Math.floor((n + (t - 0.5) * 0.4) * 3) / 3;
        rgb = blend(p.shoulder, p.shoulderLight ?? p.shoulder, Math.max(0, Math.min(1, banded)));
      }

      const i = (y * SIZE + x) * 4;
      buf[i] = rgb[0]; buf[i + 1] = rgb[1]; buf[i + 2] = rgb[2]; buf[i + 3] = 255;
    }
  }

  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  // V must tile along the track; U stays inside its band so wrapping in U never
  // actually happens, but RepeatWrapping is required for V.
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;

  cache.set(key, tex);
  return tex;
}

/** Half-texel inset so nearest sampling cannot pick up the neighbouring band. */
export const INSET = 0.5 / SIZE;

export function bandU(band, t) {
  return THREE.MathUtils.lerp(band.u0 + INSET, band.u1 - INSET, t);
}

export function disposeAtlases() {
  for (const t of cache.values()) t.dispose();
  cache.clear();
}
