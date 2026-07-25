/**
 * Bake the supplied V-ZERO wordmark into a pixel-art sprite the game can draw.
 *
 * The source is a 2172x724 print-resolution image on a solid black field. The
 * game draws its UI at 270x480, so the logo has to come down by a factor of
 * nine and still read. Three things have to happen, in this order:
 *
 *  1. Key the background to transparency by flood-filling black inward from the
 *     borders. A simple "all black is transparent" test would punch holes in
 *     the letterforms, because the counters of the R and the gaps in the Z are
 *     black too and are part of the design. Flood filling only removes black
 *     that is connected to the outside.
 *
 *  2. Downscale with premultiplied alpha. Without premultiplying, every partly
 *     transparent edge pixel blends toward the black sitting underneath it and
 *     the wordmark ends up ringed in mud.
 *
 *  3. Quantise to 5 bits per channel with an ordered dither, matching what the
 *     renderer does to the 3D scene. The UI is a separate overlay canvas and
 *     does not pass through that shader, so without this step the logo would be
 *     the one smoothly shaded thing on screen.
 *
 * Output is a base64 PNG in a JS module, so the game still ships as a single
 * bundle with no separate asset request.
 *
 *   node tools/make-logo.mjs <source.png> [width]
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const src = process.argv[2];
const targetW = Number(process.argv[3] ?? 240);
if (!src) {
  console.error('usage: node tools/make-logo.mjs <source.png> [width]');
  process.exit(1);
}

const PY = String.raw`
import sys, base64, io
import numpy as np
from PIL import Image
from collections import deque

src, target_w = sys.argv[1], int(sys.argv[2])
img = Image.open(src).convert('RGB')
a = np.asarray(img).astype(np.int16)
h, w, _ = a.shape

# --- 1. key the background --------------------------------------------------
# Flood fill from every border pixel through anything dark enough to be the
# black field. Enclosed dark areas (letter counters, interior shadow) are never
# reached and stay opaque.
lum = (0.299 * a[:, :, 0] + 0.587 * a[:, :, 1] + 0.114 * a[:, :, 2])
is_bg = lum < 34
alpha = np.full((h, w), 255, dtype=np.uint8)
seen = np.zeros((h, w), dtype=bool)
q = deque()
for x in range(w):
    for y in (0, h - 1):
        if is_bg[y, x] and not seen[y, x]:
            seen[y, x] = True; q.append((y, x))
for y in range(h):
    for x in (0, w - 1):
        if is_bg[y, x] and not seen[y, x]:
            seen[y, x] = True; q.append((y, x))
while q:
    y, x = q.popleft()
    alpha[y, x] = 0
    for dy, dx in ((1,0),(-1,0),(0,1),(0,-1)):
        ny, nx = y + dy, x + dx
        if 0 <= ny < h and 0 <= nx < w and not seen[ny, nx] and is_bg[ny, nx]:
            seen[ny, nx] = True; q.append((ny, nx))

# --- 2. crop to content, then downscale in premultiplied space ---------------
ys, xs = np.nonzero(alpha)
y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
rgb = a[y0:y1, x0:x1].astype(np.float64)
al = alpha[y0:y1, x0:x1].astype(np.float64) / 255.0

pm = rgb * al[:, :, None]
target_h = max(1, int(round(target_w * pm.shape[0] / pm.shape[1])))

def resize(chan):
    return np.asarray(
        Image.fromarray(chan.astype(np.float32), mode='F')
             .resize((target_w, target_h), Image.LANCZOS),
        dtype=np.float64)

pm_s = np.dstack([resize(pm[:, :, i]) for i in range(3)])
al_s = np.clip(resize(al), 0.0, 1.0)

# Un-premultiply. Where alpha is tiny the colour is meaningless, so clamp.
safe = np.maximum(al_s, 1e-4)
rgb_s = np.clip(pm_s / safe[:, :, None], 0, 255)

# --- 3. quantise + dither ---------------------------------------------------
BAYER8 = np.array([
    [0,32,8,40,2,34,10,42],[48,16,56,24,50,18,58,26],
    [12,44,4,36,14,46,6,38],[60,28,52,20,62,30,54,22],
    [3,35,11,43,1,33,9,41],[51,19,59,27,49,17,57,25],
    [15,47,7,39,13,45,5,37],[63,31,55,23,61,29,53,21]], dtype=np.float64)
BAYER8 = (BAYER8 + 0.5) / 64.0
yy, xx = np.indices((target_h, target_w))
thr = BAYER8[yy % 8, xx % 8]

LEVELS = 31.0
q = np.floor(rgb_s / 255.0 * LEVELS + (thr[:, :, None] - 0.5) + 0.5)
rgb_q = np.clip(q, 0, LEVELS) / LEVELS * 255.0

# Hard alpha with a dithered boundary: a smooth alpha ramp is the one thing
# that would read as modern next to everything else on this screen.
alpha_q = np.where(al_s > (0.35 + (thr - 0.5) * 0.25), 255, 0).astype(np.uint8)
# Colour under fully transparent pixels must be black or PNG encoders will
# happily keep a coloured fringe that shows up if anything ever composites it.
rgb_q[alpha_q == 0] = 0

out = np.dstack([rgb_q.astype(np.uint8), alpha_q])
im = Image.fromarray(out, mode='RGBA')
buf = io.BytesIO()
im.save(buf, format='PNG', optimize=True)
data = buf.getvalue()
print(target_w); print(target_h); print(len(data)); print(base64.b64encode(data).decode())
`;

const out = execFileSync('python3', ['-c', PY, src, String(targetW)], {
  maxBuffer: 64 * 1024 * 1024,
}).toString().trim().split('\n');

const [w, h, bytes, b64] = out;

const module = `/**
 * The V-ZERO wordmark, baked to a pixel-art sprite at UI resolution.
 *
 * Generated by \`tools/make-logo.mjs\` from the supplied artwork: background
 * keyed out, downscaled with premultiplied alpha, then quantised to 5 bits per
 * channel with an ordered dither so it sits on the same palette as the rest of
 * the game. Inlined as a data URI so the build stays a single bundle with no
 * extra request, and so the title screen never flashes an empty logo while a
 * separate file loads.
 *
 * This is the one piece of art in the project that is not generated at runtime.
 */

export const LOGO_WIDTH = ${w};
export const LOGO_HEIGHT = ${h};

export const LOGO_DATA_URI =
  'data:image/png;base64,${b64}';

let _image = null;
let _ready = false;

/** Kick off decoding. Safe to call more than once. */
export function loadLogo() {
  if (_image) return _image;
  _image = new Image();
  _image.onload = () => { _ready = true; };
  _image.src = LOGO_DATA_URI;
  return _image;
}

/** The decoded image, or null until it is ready. */
export function logoImage() {
  return _ready ? _image : null;
}
`;

writeFileSync('src/ui/logo.js', module);
console.log(`logo: ${w}x${h}, ${(Number(bytes) / 1024).toFixed(1)} KB png, ${(b64.length / 1024).toFixed(1)} KB base64`);
