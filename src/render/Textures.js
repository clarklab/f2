import * as THREE from 'three';

/**
 * Textures — every pixel in this game is generated here at runtime.
 *
 * Nothing is loaded from disk. Each texture is drawn into a small canvas at
 * exactly the resolution it will be sampled at, using integer coordinates and a
 * fixed palette, then handed to the GPU with nearest filtering and no mipmaps.
 * Drawing at final size is the whole discipline of pixel art: the moment you
 * draw big and let something downscale, you get anti-aliased mush.
 *
 * Textures are cached by key so a repeated request costs nothing.
 */

const cache = new Map();

// ---------------------------------------------------------------------------
// Noise
// ---------------------------------------------------------------------------

function hash2D(ix, iy, seed) {
  let h = Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(seed, 974521);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967296;
}

const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
const mix = (a, b, t) => a + (b - a) * t;
const wrapi = (v, p) => ((v % p) + p) % p;

/**
 * Value noise that tiles exactly over `period`. Tiling comes from hashing the
 * lattice coordinate modulo the period, so the left edge and the right edge
 * consult the same lattice points. Value noise rather than Perlin because it is
 * naturally blockier, which is what we want here.
 */
function valueNoise(x, y, pX, pY, seed = 0) {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const u = fade(x - x0), v = fade(y - y0);
  const xa = wrapi(x0, pX), xb = wrapi(x0 + 1, pX);
  const ya = wrapi(y0, pY), yb = wrapi(y0 + 1, pY);
  return mix(
    mix(hash2D(xa, ya, seed), hash2D(xb, ya, seed), u),
    mix(hash2D(xa, yb, seed), hash2D(xb, yb, seed), u),
    v,
  );
}

/** Tileable fBm. Each octave's period scales with its frequency to stay tileable. */
export function fbm(x, y, pX, pY, octaves = 3, seed = 0) {
  let amp = 0.5, freq = 1, sum = 0, norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise(x * freq, y * freq, pX * freq, pY * freq, seed + o * 101);
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}

// 4x4 Bayer, pre-normalised to texel centres.
const BAYER4 = [
  [0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5],
].map((row) => row.map((v) => (v + 0.5) / 16));

// ---------------------------------------------------------------------------
// Canvas helpers
// ---------------------------------------------------------------------------

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = false;
  return { canvas: c, ctx };
}

function toTexture(canvas, { repeat = true, aniso = 0 } = {}) {
  const tex = new THREE.CanvasTexture(canvas);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.wrapS = tex.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  // Canvas pixels are sRGB bytes. Without this they come out washed out, because
  // three.js otherwise assumes texture data is already in the linear working space.
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = aniso;
  tex.needsUpdate = true;
  return tex;
}

const hexToRgb = (hex) => [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255];

/** Blend two packed colours; t in 0..1. */
function mixHex(a, b, t) {
  const [ar, ag, ab] = hexToRgb(a);
  const [br, bg, bb] = hexToRgb(b);
  return [
    Math.round(mix(ar, br, t)),
    Math.round(mix(ag, bg, t)),
    Math.round(mix(ab, bb, t)),
  ];
}

/** Blend two packed colours and pack the result back. */
function mixHexOut(a, b, t) {
  const [r, g, bl] = mixHex(a, b, t);
  return (r << 16) | (g << 8) | bl;
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/**
 * Road surface. A dithered noise base plus the horizontal seam lines that run
 * across the track in the reference material — those rungs are most of what
 * sells the sensation of speed, because they are the only high-frequency
 * feature streaming toward the camera.
 */
export function roadTexture({
  size = 64, base = 0x8a8f96, dark = 0x6d727a, seed = 3,
  rung = 0x5a5f66, rungEvery = 16, rungHeight = 1, grain = 0.5,
} = {}) {
  const key = `road:${size}:${base}:${dark}:${rung}:${rungEvery}:${seed}:${grain}`;
  if (cache.has(key)) return cache.get(key);

  const { canvas, ctx } = makeCanvas(size, size);
  const img = ctx.createImageData(size, size);
  const buf = img.data;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const n = fbm((x / size) * 8, (y / size) * 8, 8, 8, 3, seed);
      // Quantise into a handful of dithered steps so the surface reads as
      // deliberate pixel shading rather than photographic grain.
      const t = BAYER4[y & 3][x & 3];
      const banded = Math.floor((n * grain + (t - 0.5) * 0.35) * 4) / 4;
      let [r, g, b] = mixHex(dark, base, Math.max(0, Math.min(1, 0.45 + banded)));

      if (y % rungEvery < rungHeight) {
        [r, g, b] = mixHex((r << 16) | (g << 8) | b, rung, 0.75);
      }

      const i = (y * size + x) * 4;
      buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = toTexture(canvas);
  cache.set(key, tex);
  return tex;
}

/**
 * Boost pad — forward chevrons on a bright field. Drawn as explicit filled
 * rectangles so every edge lands on an integer pixel.
 */
export function boostTexture({ size = 32, bg = 0x11203a, a = 0x36f2ff, b = 0xffffff } = {}) {
  const key = `boost:${size}:${bg}:${a}:${b}`;
  if (cache.has(key)) return cache.get(key);

  const { canvas, ctx } = makeCanvas(size, size);
  ctx.fillStyle = `#${bg.toString(16).padStart(6, '0')}`;
  ctx.fillRect(0, 0, size, size);

  // Two chevrons per tile, pointing along +V (the direction of travel).
  const drawChevron = (cy, color, thickness) => {
    ctx.fillStyle = `#${color.toString(16).padStart(6, '0')}`;
    const half = size / 2;
    for (let i = 0; i < half; i++) {
      const y = cy + i;
      if (y < 0 || y >= size) continue;
      for (let t = 0; t < thickness; t++) {
        ctx.fillRect(half - i - 1, y - t, 1, 1);
        ctx.fillRect(half + i, y - t, 1, 1);
      }
    }
  };
  drawChevron(2, a, 3);
  drawChevron(2 + size / 2, a, 3);
  drawChevron(1, b, 1);
  drawChevron(1 + size / 2, b, 1);

  const tex = toTexture(canvas);
  cache.set(key, tex);
  return tex;
}

/** Recharge strip — the pit lane. Pulsing bars in a warning colour. */
export function rechargeTexture({ size = 32, bg = 0x0d2b16, a = 0x4dff88, b = 0xd8ffe4 } = {}) {
  const key = `recharge:${size}:${bg}:${a}:${b}`;
  if (cache.has(key)) return cache.get(key);

  const { canvas, ctx } = makeCanvas(size, size);
  ctx.fillStyle = `#${bg.toString(16).padStart(6, '0')}`;
  ctx.fillRect(0, 0, size, size);
  for (let y = 0; y < size; y += 8) {
    ctx.fillStyle = `#${a.toString(16).padStart(6, '0')}`;
    ctx.fillRect(0, y, size, 4);
    ctx.fillStyle = `#${b.toString(16).padStart(6, '0')}`;
    ctx.fillRect(0, y, size, 1);
  }
  const tex = toTexture(canvas);
  cache.set(key, tex);
  return tex;
}

/** Rough shoulder / dirt — high-contrast noise that visibly slows you down. */
export function dirtTexture({ size = 64, base = 0x6b4a2f, dark = 0x3d2a1a, seed = 9 } = {}) {
  const key = `dirt:${size}:${base}:${dark}:${seed}`;
  if (cache.has(key)) return cache.get(key);

  const { canvas, ctx } = makeCanvas(size, size);
  const img = ctx.createImageData(size, size);
  const buf = img.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const n = fbm((x / size) * 12, (y / size) * 12, 12, 12, 2, seed);
      const t = BAYER4[y & 3][x & 3];
      const banded = Math.round((n + (t - 0.5) * 0.5) * 3) / 3;
      const [r, g, b] = mixHex(dark, base, banded);
      const i = (y * size + x) * 4;
      buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = toTexture(canvas);
  cache.set(key, tex);
  return tex;
}

/** Start/finish chequerboard. */
export function checkerTexture({ size = 32, cell = 4, a = 0xf4f6ff, b = 0x14161f } = {}) {
  const key = `check:${size}:${cell}:${a}:${b}`;
  if (cache.has(key)) return cache.get(key);
  const { canvas, ctx } = makeCanvas(size, size);
  for (let y = 0; y < size; y += cell) {
    for (let x = 0; x < size; x += cell) {
      ctx.fillStyle = ((x / cell + y / cell) % 2 === 0)
        ? `#${a.toString(16).padStart(6, '0')}`
        : `#${b.toString(16).padStart(6, '0')}`;
      ctx.fillRect(x, y, cell, cell);
    }
  }
  const tex = toTexture(canvas);
  cache.set(key, tex);
  return tex;
}

/**
 * Radial glow, used for underglow, thruster flare and boost pad bloom.
 * The falloff is quantised into hard dithered bands: a smooth radial gradient
 * is the single clearest giveaway that a "pixel art" game is not really one.
 */
export function glowTexture({ size = 32, bands = 5, color = 0xffffff, power = 2.0 } = {}) {
  const key = `glow:${size}:${bands}:${color}:${power}`;
  if (cache.has(key)) return cache.get(key);

  const { canvas, ctx } = makeCanvas(size, size);
  const img = ctx.createImageData(size, size);
  const buf = img.data;
  const [cr, cg, cb] = hexToRgb(color);
  const c = (size - 1) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x - c) / (size / 2);
      const dy = (y - c) / (size / 2);
      let f = 1 - Math.min(1, Math.hypot(dx, dy));
      f = Math.pow(f, power);
      const s = f * bands;
      const bi = Math.floor(s);
      const stepped = (bi + (s - bi > BAYER4[y & 3][x & 3] ? 1 : 0)) / bands;
      const i = (y * size + x) * 4;
      buf[i] = cr; buf[i + 1] = cg; buf[i + 2] = cb;
      buf[i + 3] = Math.round(Math.max(0, Math.min(1, stepped)) * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = toTexture(canvas, { repeat: false });
  cache.set(key, tex);
  return tex;
}

/**
 * Sky gradient strip, sampled vertically. Dithered between a small number of
 * bands so the sky matches the console-era look rather than showing a smooth
 * modern gradient.
 */
export function skyTexture({ height = 128, bands = 14, stops = [] } = {}) {
  const key = `sky:${height}:${bands}:${stops.map((s) => s[0] + ':' + s[1]).join(',')}`;
  if (cache.has(key)) return cache.get(key);

  const { canvas, ctx } = makeCanvas(8, height);
  const img = ctx.createImageData(8, height);
  const buf = img.data;

  const sample = (t) => {
    let lo = stops[0], hi = stops[stops.length - 1];
    for (let i = 0; i < stops.length - 1; i++) {
      if (t >= stops[i][0] && t <= stops[i + 1][0]) { lo = stops[i]; hi = stops[i + 1]; break; }
    }
    const span = hi[0] - lo[0] || 1;
    return mixHex(lo[1], hi[1], (t - lo[0]) / span);
  };

  for (let y = 0; y < height; y++) {
    const t = y / (height - 1);
    // Snap to a band, with the dither deciding which side of the boundary each
    // pixel falls on. This is what produces the stippled sky in the references.
    const s = t * bands;
    const bi = Math.floor(s);
    for (let x = 0; x < 8; x++) {
      const stepped = (bi + (s - bi > BAYER4[y & 3][x & 3] ? 1 : 0)) / bands;
      const [r, g, b] = sample(Math.min(1, stepped));
      const i = (y * 8 + x) * 4;
      buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = toTexture(canvas, { repeat: false });
  cache.set(key, tex);
  return tex;
}

/** Brushed/panelled metal for guardrails and structures. */
export function metalTexture({ size = 32, base = 0x7a8296, dark = 0x3d4354, seed = 5 } = {}) {
  const key = `metal:${size}:${base}:${dark}:${seed}`;
  if (cache.has(key)) return cache.get(key);
  const { canvas, ctx } = makeCanvas(size, size);
  const img = ctx.createImageData(size, size);
  const buf = img.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Stretched noise reads as a brushed finish.
      const n = fbm((x / size) * 16, (y / size) * 3, 16, 3, 2, seed);
      const t = BAYER4[y & 3][x & 3];
      let v = Math.floor((n + (t - 0.5) * 0.4) * 4) / 4;
      if (y % 8 === 0) v -= 0.35;              // panel seam
      const [r, g, b] = mixHex(dark, base, Math.max(0, Math.min(1, v)));
      const i = (y * size + x) * 4;
      buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = toTexture(canvas);
  cache.set(key, tex);
  return tex;
}

/** Flat tiling ground cover (the grass/plain either side of the road). */
export function groundTexture({ size = 64, a = 0x2f7a3a, b = 0x1f5a2b, seed = 21, stripe = 0 } = {}) {
  const key = `ground:${size}:${a}:${b}:${seed}:${stripe}`;
  if (cache.has(key)) return cache.get(key);
  const { canvas, ctx } = makeCanvas(size, size);
  const img = ctx.createImageData(size, size);
  const buf = img.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const n = fbm((x / size) * 6, (y / size) * 6, 6, 6, 3, seed);
      const t = BAYER4[y & 3][x & 3];
      let v = Math.floor((n + (t - 0.5) * 0.4) * 3) / 3;
      if (stripe && (y % stripe) < stripe / 2) v += 0.18;
      const [r, g, bl] = mixHex(b, a, Math.max(0, Math.min(1, v)));
      const i = (y * size + x) * 4;
      buf[i] = r; buf[i + 1] = g; buf[i + 2] = bl; buf[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = toTexture(canvas);
  cache.set(key, tex);
  return tex;
}

/**
 * A night facade: a dark wall with a scatter of lit windows.
 *
 * Two details do the work. Windows are lit in vertical *runs* rather than
 * independently — real buildings light a stairwell or a whole floor of an
 * office, and independent dice produce an even static that reads as noise
 * instead of occupancy. And lit windows get a slightly brighter top row, which
 * at this scale is enough to suggest a ceiling light rather than a flat panel.
 */
export function windowTexture({
  size = 32, wall = 0x2a3350, lit = 0xffd98a, density = 0.45, seed = 3,
} = {}) {
  const key = `win:${size}:${wall}:${lit}:${density}:${seed}`;
  if (cache.has(key)) return cache.get(key);
  const { canvas, ctx } = makeCanvas(size, size);
  const img = ctx.createImageData(size, size);
  const buf = img.data;
  const CELL = 4;               // 4px grid: 2px window, 2px mullion
  const cells = size / CELL;
  const put = (x, y, hex, mul = 1) => {
    const i = (y * size + x) * 4;
    buf[i] = ((hex >> 16) & 255) * mul;
    buf[i + 1] = ((hex >> 8) & 255) * mul;
    buf[i + 2] = (hex & 255) * mul;
    buf[i + 3] = 255;
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const n = hash2D(x >> 2, y >> 2, seed + 7);
      put(x, y, wall, 0.82 + n * 0.36);
    }
  }
  // Vertical runs of lit windows.
  for (let cx = 0; cx < cells; cx++) {
    let y = 0;
    while (y < cells) {
      const on = hash2D(cx, y, seed) < density;
      const run = 1 + Math.floor(hash2D(cx, y, seed + 3) * 4);
      if (on) {
        for (let k = 0; k < run && y + k < cells; k++) {
          const cy = y + k;
          const dim = 0.55 + hash2D(cx, cy, seed + 11) * 0.5;
          for (let py = 0; py < 2; py++) {
            for (let px = 0; px < 2; px++) {
              put(cx * CELL + px + 1, cy * CELL + py + 1, lit, py === 0 ? dim : dim * 0.72);
            }
          }
        }
      }
      y += run;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = toTexture(canvas);
  cache.set(key, tex);
  return tex;
}

/**
 * Leaf-clump modulation for tree canopies.
 *
 * Deliberately near-neutral. This is used as a `map` on vertex-coloured props,
 * and `map * vertexColor` means a *coloured* texture would fight the colour the
 * geometry already carries — a green map over green vertices comes out black,
 * which is exactly what a first attempt at this looked like. So the texture
 * only supplies light and shade, and every hue in the scene comes from the
 * vertex colours and the per-instance tint.
 */
export function foliageTexture({ size = 32, seed = 5, contrast = 0.42, base = 0 } = {}) {
  const key = `foliage:${size}:${seed}:${contrast}`;
  if (cache.has(key)) return cache.get(key);
  const { canvas, ctx } = makeCanvas(size, size);
  const img = ctx.createImageData(size, size);
  const buf = img.data;
  const lo = Math.round(255 * (1 - contrast));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const n = fbm((x / size) * 7, (y / size) * 7, 7, 7, 3, seed);
      const t = BAYER4[y & 3][x & 3];
      const v = Math.floor((n + (t - 0.5) * 0.5) * 3) / 3;
      const g = lo + Math.round((255 - lo) * Math.max(0, Math.min(1, v)));
      const i = (y * size + x) * 4;
      buf[i] = g; buf[i + 1] = g; buf[i + 2] = g; buf[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = toTexture(canvas);
  cache.set(key, tex);
  return tex;
}

/**
 * Industrial plating: weld seams, rivets and corrosion blooms.
 *
 * Neutral for the same reason as the foliage above — it modulates the prop's
 * own colour rather than replacing it. The corrosion is a *darkening* keyed off
 * a second noise field so it clumps into patches instead of speckling.
 */
export function pipeTexture({ size = 32, seed = 4 } = {}) {
  const key = `pipe:${size}:${seed}`;
  if (cache.has(key)) return cache.get(key);
  const { canvas, ctx } = makeCanvas(size, size);
  const img = ctx.createImageData(size, size);
  const buf = img.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const n = fbm((x / size) * 5, (y / size) * 5, 5, 5, 2, seed);
      const t = BAYER4[y & 3][x & 3];
      let v = 0.72 + Math.floor((n * 0.5 + (t - 0.5) * 0.4) * 4) / 4 * 0.36;
      if (x % 8 === 0) v -= 0.26;                      // weld seam
      if (x % 8 === 4 && y % 8 === 2) v += 0.2;        // rivet highlight
      const rn = fbm((x / size) * 3 + 11, (y / size) * 3 + 5, 3, 3, 2, seed + 31);
      if (rn > 0.66) v -= Math.min(0.3, (rn - 0.66) * 1.4);
      const g = Math.round(255 * Math.max(0.24, Math.min(1.12, v)) / 1.12);
      const i = (y * size + x) * 4;
      buf[i] = g; buf[i + 1] = g; buf[i + 2] = g; buf[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = toTexture(canvas);
  cache.set(key, tex);
  return tex;
}

/**
 * A sun: a hard-edged disc inside a banded halo.
 *
 * The disc edge is deliberately hard and the halo is quantised into rings. A
 * smooth radial gradient is the single clearest way to break a pixel-art scene,
 * and this is the largest object on the screen when it is visible.
 */
export function sunTexture({ size = 64, color = 0xffd070 } = {}) {
  const key = `sun:${size}:${color}`;
  if (cache.has(key)) return cache.get(key);
  const { canvas, ctx } = makeCanvas(size, size);
  const img = ctx.createImageData(size, size);
  const buf = img.data;
  const c = size / 2;
  const core = mixHexOut(color, 0xffffff, 0.5);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5 - c) / c, dy = (y + 0.5 - c) / c;
      const d = Math.sqrt(dx * dx + dy * dy);
      const t = BAYER4[y & 3][x & 3];
      const i = (y * size + x) * 4;
      if (d < 0.34) {
        // Solid disc, banded from white-hot centre to the stated colour.
        const k = Math.floor((d / 0.34) * 3) / 3;
        const [r, g, b] = mixHex(core, color, k);
        buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = 255;
      } else if (d < 1.0) {
        // Halo: quantised rings, dithered out to nothing at the rim.
        const f = 1 - (d - 0.34) / 0.66;
        const band = Math.floor(f * 5) / 5;
        const a = band * band * 0.72;
        const on = a > t * 0.9;
        buf[i] = (color >> 16) & 255;
        buf[i + 1] = (color >> 8) & 255;
        buf[i + 2] = color & 255;
        buf[i + 3] = on ? Math.round(a * 255) : 0;
      } else {
        buf[i + 3] = 0;
      }
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = toTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  cache.set(key, tex);
  return tex;
}

/** Free every cached texture. Called on teardown. */
export function disposeTextures() {
  for (const t of cache.values()) t.dispose();
  cache.clear();
}
