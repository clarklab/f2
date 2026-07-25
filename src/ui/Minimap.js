import { TrackFrame } from '../track/TrackPath.js';

/**
 * Minimap — top-down renderings of a circuit, used both for the in-race corner
 * map and for the previews in the track picker.
 *
 * The outline is rendered once into an offscreen canvas and cached, because the
 * shape never changes; only the moving dots are drawn per frame. Redrawing a
 * few thousand path samples every frame for a decoration in the corner of the
 * screen would be a silly way to spend the budget.
 */

const cache = new Map();

/**
 * Fit a circuit's XZ bounds into a w x h box, returning a projection function.
 * Returns integer-snapped coordinates so the map lands on the pixel grid.
 */
function makeProjection(path, w, h, pad) {
  const b = path.bounds;
  const spanX = Math.max(1, b.maxX - b.minX);
  const spanZ = Math.max(1, b.maxZ - b.minZ);
  const scale = Math.min((w - pad * 2) / spanX, (h - pad * 2) / spanZ);
  const offX = (w - spanX * scale) / 2 - b.minX * scale;
  const offZ = (h - spanZ * scale) / 2 - b.minZ * scale;
  return {
    scale,
    x: (wx) => Math.round(wx * scale + offX),
    y: (wz) => Math.round(wz * scale + offZ),
  };
}

/**
 * Render a circuit outline. Cached by (track id, size, colours).
 * @returns {{canvas: HTMLCanvasElement, project: object}}
 */
export function trackPreview(trackId, path, w, h, opts = {}) {
  const {
    road = '#e8ecff', edge = '#2a3050', start = '#ff4d7a',
    pad = 8, width = 4,
  } = opts;
  const key = `${trackId}|${w}x${h}|${road}|${edge}|${width}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;

  const project = makeProjection(path, w, h, pad);

  // Decimate: a preview a few dozen pixels across cannot resolve 2000 samples.
  const stride = Math.max(1, Math.floor(path.count / 320));
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  const trace = () => {
    ctx.beginPath();
    for (let i = 0; i <= path.count; i += stride) {
      const k = i % path.count;
      const px = project.x(path.px[k]);
      const py = project.y(path.pz[k]);
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath();
  };

  // Dark casing under a lighter ribbon reads as a road at any size.
  ctx.strokeStyle = edge;
  ctx.lineWidth = width + 2;
  trace();
  ctx.stroke();

  ctx.strokeStyle = road;
  ctx.lineWidth = width;
  trace();
  ctx.stroke();

  // Start line marker.
  const f = new TrackFrame();
  path.sampleAt(0, f);
  ctx.fillStyle = start;
  ctx.fillRect(project.x(f.pos.x) - 2, project.y(f.pos.z) - 2, 4, 4);

  const result = { canvas, project };
  cache.set(key, result);
  return result;
}

/**
 * Draw the in-race minimap: cached outline plus a dot per racer.
 * @param {Array<{vehicle:object, isPlayer:boolean, machine:object}>} entries
 */
export function drawMinimap(ctx, trackId, path, x, y, w, h, entries, opts = {}) {
  const preview = trackPreview(trackId, path, w, h, {
    road: opts.road ?? '#cfd8ff',
    edge: opts.edge ?? '#141a30',
    start: opts.start ?? '#ff4d7a',
    width: opts.width ?? 3,
    pad: opts.pad ?? 6,
  });

  ctx.drawImage(preview.canvas, Math.round(x), Math.round(y));

  const p = preview.project;
  for (const e of entries) {
    const v = e.vehicle;
    if (!v || (!v.alive && !e.isPlayer)) continue;
    const dx = x + p.x(v.pos.x);
    const dy = y + p.y(v.pos.z);
    if (e.isPlayer) {
      // The player gets a larger, outlined dot so it is findable instantly.
      ctx.fillStyle = '#0b0e1a';
      ctx.fillRect(dx - 2, dy - 2, 5, 5);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(dx - 1, dy - 1, 3, 3);
    } else {
      ctx.fillStyle = e.machine?.colors?.glow
        ? `#${(e.machine.colors.body >>> 0).toString(16).padStart(6, '0')}`
        : '#8892c0';
      ctx.fillRect(dx - 1, dy - 1, 2, 2);
    }
  }
}

export function clearMinimapCache() {
  cache.clear();
}
