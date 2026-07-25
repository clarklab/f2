import * as THREE from 'three';
import { clamp, clamp01, wrap, ringDelta } from '../core/MathUtil.js';

/**
 * TrackPath — the single source of truth for a circuit's shape.
 *
 * A track is authored as a short list of control points. This class turns that
 * into a densely, *uniformly arc-length sampled* table of frames which the rest
 * of the game reads: mesh generation, vehicle physics, AI, the minimap and the
 * camera all resolve to (s, d) — distance along the track and lateral offset
 * from the centreline — rather than raw world coordinates.
 *
 * Two details matter for correctness and are easy to get wrong:
 *
 * 1. Sampling is uniform in ARC LENGTH, not in curve parameter. A Catmull-Rom
 *    curve traverses long segments faster than short ones, so parameter-uniform
 *    samples bunch up on tight corners and stretch on straights. Every texture
 *    UV, every "metres ahead" AI lookahead and every physics query would inherit
 *    that distortion.
 *
 * 2. Frames come from a rotation-minimising frame (RMF) via the double
 *    reflection method (Wang, Jüttler, Zheng & Liu 2008), not a Frenet frame.
 *    Frenet frames are undefined on straights (zero curvature) and flip 180
 *    degrees through inflection points, which would tear the road mesh apart.
 *    RMF is stable everywhere. Because the track is a closed loop, the frame
 *    generally does not line up with itself after one lap, so the residual
 *    twist is measured and distributed evenly around the loop.
 */

const _v0 = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();

/** A resolved frame on the track. Reused; never hold onto one across calls. */
export class TrackFrame {
  constructor() {
    this.pos = new THREE.Vector3();
    this.tangent = new THREE.Vector3();
    this.up = new THREE.Vector3();
    this.side = new THREE.Vector3();
    this.width = 0;
    this.curvature = 0;
    this.s = 0;
  }
}

export class TrackPath {
  /**
   * @param {Array<{x:number,y:number,z:number,width?:number,bank?:number}>} controls
   *        Closed loop of control points; the last implicitly joins the first.
   * @param {{step?:number, defaultWidth?:number}} [opts]
   *        `step` is the target spacing of the sample table in metres. 1.25 m
   *        keeps a 3 km circuit around 2400 samples, which is cheap to build
   *        and gives sub-centimetre accuracy for physics queries.
   */
  constructor(controls, opts = {}) {
    this.controls = controls;
    this.targetStep = opts.step ?? 1.25;
    this.defaultWidth = opts.defaultWidth ?? 24;

    this.autoBank = opts.autoBank ?? 0;
    this.maxAutoBank = (opts.maxAutoBank ?? 26) * Math.PI / 180;

    this._buildSamples();
    this._buildFrames();
    // Curvature is measured before banking is folded in, so that banking can be
    // derived from it.
    this._buildCurvature();
    this._buildAttributes();
    this._buildSpatialGrid();
  }

  // ---------------------------------------------------------------------
  // Curve evaluation
  // ---------------------------------------------------------------------

  /**
   * Centripetal Catmull-Rom (alpha = 0.5) in the Barry-Goldman pyramid form.
   * Centripetal parameterisation is used rather than uniform because it is
   * provably free of cusps and self-intersections, which matters when a track
   * author places two control points close together on a hairpin.
   */
  _evalCR(u, out) {
    const P = this.controls;
    const n = P.length;
    const i = Math.floor(u);
    const f = u - i;
    const p0 = P[wrap(i - 1, n)];
    const p1 = P[wrap(i, n)];
    const p2 = P[wrap(i + 1, n)];
    const p3 = P[wrap(i + 2, n)];

    const d = (a, b) => {
      const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
      // alpha = 0.5 -> distance^0.5 -> sqrt(sqrt(d2))
      return Math.max(1e-4, Math.sqrt(Math.sqrt(dx * dx + dy * dy + dz * dz)));
    };

    const t0 = 0;
    const t1 = t0 + d(p0, p1);
    const t2 = t1 + d(p1, p2);
    const t3 = t2 + d(p2, p3);
    const t = t1 + (t2 - t1) * f;

    // Three levels of linear interpolation over the knot intervals.
    const mix = (a, b, ta, tb, tt, o) => {
      const w = (tb - tt) / (tb - ta);
      const w2 = 1 - w;
      o.x = a.x * w + b.x * w2;
      o.y = a.y * w + b.y * w2;
      o.z = a.z * w + b.z * w2;
      return o;
    };

    const A1 = mix(p0, p1, t0, t1, t, _v0);
    const A2 = mix(p1, p2, t1, t2, t, _v1);
    const A3 = mix(p2, p3, t2, t3, t, _v2);
    const B1 = mix(A1, A2, t0, t2, t, _v3);
    // _v0 is free again after B1 consumed A1.
    const B2 = mix(A2, A3, t1, t3, t, _v0);
    return mix(B1, B2, t1, t2, t, out);
  }

  /** Periodic uniform Catmull-Rom over a scalar array (width, bank, ...). */
  _evalScalar(arr, u) {
    const n = arr.length;
    const i = Math.floor(u);
    const f = u - i;
    const p0 = arr[wrap(i - 1, n)];
    const p1 = arr[wrap(i, n)];
    const p2 = arr[wrap(i + 1, n)];
    const p3 = arr[wrap(i + 2, n)];
    const f2 = f * f;
    const f3 = f2 * f;
    return 0.5 * (
      2 * p1 +
      (-p0 + p2) * f +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * f2 +
      (-p0 + 3 * p1 - 3 * p2 + p3) * f3
    );
  }

  // ---------------------------------------------------------------------
  // Build passes
  // ---------------------------------------------------------------------

  _buildSamples() {
    const n = this.controls.length;
    // Pass 1: dense parameter-uniform samples to measure arc length.
    const SUB = 48;
    const total = n * SUB;
    const uLut = new Float64Array(total + 1);
    const lenLut = new Float64Array(total + 1);
    const p = new THREE.Vector3();
    const prev = new THREE.Vector3();
    this._evalCR(0, prev);
    uLut[0] = 0;
    lenLut[0] = 0;
    for (let k = 1; k <= total; k++) {
      const u = (k / total) * n;
      this._evalCR(u, p);
      lenLut[k] = lenLut[k - 1] + p.distanceTo(prev);
      uLut[k] = u;
      prev.copy(p);
    }
    const length = lenLut[total];

    // Pass 2: resample at a step that divides the loop exactly, so sample 0 and
    // sample N are genuinely coincident and s wraps cleanly at `length`.
    const count = Math.max(16, Math.round(length / this.targetStep));
    const step = length / count;

    this.length = length;
    this.count = count;
    this.step = step;
    this.invStep = 1 / step;

    const px = new Float32Array(count);
    const py = new Float32Array(count);
    const pz = new Float32Array(count);
    const uAt = new Float32Array(count);

    let cursor = 0;
    for (let i = 0; i < count; i++) {
      const target = i * step;
      while (cursor < total && lenLut[cursor + 1] < target) cursor++;
      const l0 = lenLut[cursor];
      const l1 = lenLut[Math.min(cursor + 1, total)];
      const frac = l1 > l0 ? (target - l0) / (l1 - l0) : 0;
      const u = uLut[cursor] + (uLut[Math.min(cursor + 1, total)] - uLut[cursor]) * frac;
      this._evalCR(u, p);
      px[i] = p.x; py[i] = p.y; pz[i] = p.z;
      uAt[i] = u;
    }

    this.px = px; this.py = py; this.pz = pz; this.uAt = uAt;
  }

  _buildFrames() {
    const { count, px, py, pz } = this;
    const tx = new Float32Array(count);
    const ty = new Float32Array(count);
    const tz = new Float32Array(count);

    // Tangents by central difference. Valid because samples are arc-uniform.
    for (let i = 0; i < count; i++) {
      const a = wrap(i - 1, count);
      const b = wrap(i + 1, count);
      let dx = px[b] - px[a], dy = py[b] - py[a], dz = pz[b] - pz[a];
      const len = Math.hypot(dx, dy, dz) || 1;
      tx[i] = dx / len; ty[i] = dy / len; tz[i] = dz / len;
    }

    // RMF propagation by double reflection.
    const rx = new Float32Array(count);
    const ry = new Float32Array(count);
    const rz = new Float32Array(count);

    // Seed the reference vector as "world up, made perpendicular to tangent"
    // so a flat track starts out with an up vector that really is up.
    let sx = 0, sy = 1, sz = 0;
    let dot = tx[0] * sx + ty[0] * sy + tz[0] * sz;
    if (Math.abs(dot) > 0.99) { sx = 1; sy = 0; sz = 0; dot = tx[0]; }
    sx -= tx[0] * dot; sy -= ty[0] * dot; sz -= tz[0] * dot;
    let sl = Math.hypot(sx, sy, sz) || 1;
    rx[0] = sx / sl; ry[0] = sy / sl; rz[0] = sz / sl;

    for (let i = 0; i < count; i++) {
      const j = wrap(i + 1, count);
      // v1 = x_{i+1} - x_i  (first reflection plane)
      const v1x = px[j] - px[i], v1y = py[j] - py[i], v1z = pz[j] - pz[i];
      const c1 = v1x * v1x + v1y * v1y + v1z * v1z || 1e-9;
      const d1r = v1x * rx[i] + v1y * ry[i] + v1z * rz[i];
      const rLx = rx[i] - (2 / c1) * d1r * v1x;
      const rLy = ry[i] - (2 / c1) * d1r * v1y;
      const rLz = rz[i] - (2 / c1) * d1r * v1z;
      const d1t = v1x * tx[i] + v1y * ty[i] + v1z * tz[i];
      const tLx = tx[i] - (2 / c1) * d1t * v1x;
      const tLy = ty[i] - (2 / c1) * d1t * v1y;
      const tLz = tz[i] - (2 / c1) * d1t * v1z;
      // v2 = t_{i+1} - tL  (second reflection plane)
      const v2x = tx[j] - tLx, v2y = ty[j] - tLy, v2z = tz[j] - tLz;
      const c2 = v2x * v2x + v2y * v2y + v2z * v2z || 1e-9;
      const d2 = v2x * rLx + v2y * rLy + v2z * rLz;
      let nx = rLx - (2 / c2) * d2 * v2x;
      let ny = rLy - (2 / c2) * d2 * v2y;
      let nz = rLz - (2 / c2) * d2 * v2z;
      const nl = Math.hypot(nx, ny, nz) || 1;
      nx /= nl; ny /= nl; nz /= nl;
      if (j !== 0) { rx[j] = nx; ry[j] = ny; rz[j] = nz; }
      else { this._closeR = [nx, ny, nz]; }
    }

    // Closed-loop twist: the frame carried once around usually does not match
    // the seed frame. Measure the mismatch about the tangent and unwind it
    // linearly around the loop so the mesh joins seamlessly at the start line.
    let twist = 0;
    if (this._closeR) {
      const [cx, cy, cz] = this._closeR;
      const bx = ty[0] * rz[0] - tz[0] * ry[0];
      const by = tz[0] * rx[0] - tx[0] * rz[0];
      const bz = tx[0] * ry[0] - ty[0] * rx[0];
      const cosA = clamp(cx * rx[0] + cy * ry[0] + cz * rz[0], -1, 1);
      const sinA = cx * bx + cy * by + cz * bz;
      twist = Math.atan2(sinA, cosA);
    }
    this.residualTwist = twist;

    const ux = new Float32Array(count);
    const uy = new Float32Array(count);
    const uz = new Float32Array(count);
    const kx = new Float32Array(count);
    const ky = new Float32Array(count);
    const kz = new Float32Array(count);

    for (let i = 0; i < count; i++) {
      const a = -twist * (i / count);
      const ca = Math.cos(a), sa = Math.sin(a);
      // Rotate r about the tangent by `a` (Rodrigues, r perpendicular to t).
      const bx = ty[i] * rz[i] - tz[i] * ry[i];
      const by = tz[i] * rx[i] - tx[i] * rz[i];
      const bz = tx[i] * ry[i] - ty[i] * rx[i];
      ux[i] = rx[i] * ca + bx * sa;
      uy[i] = ry[i] * ca + by * sa;
      uz[i] = rz[i] * ca + bz * sa;
      // side = tangent x up, which is the driver's RIGHT.
      // Right = forward x up in a right-handed, Y-up system: with forward = +Z
      // and up = +Y this gives -X, and -X is indeed on your right when you face
      // +Z. Getting this backwards is silent — the frame stays orthonormal and
      // the road still renders — but it inverts banking, the sign of curvature,
      // and every lateral offset in the game.
      kx[i] = ty[i] * uz[i] - tz[i] * uy[i];
      ky[i] = tz[i] * ux[i] - tx[i] * uz[i];
      kz[i] = tx[i] * uy[i] - ty[i] * ux[i];
    }

    this.tx = tx; this.ty = ty; this.tz = tz;
    this.ux = ux; this.uy = uy; this.uz = uz;
    this.sx = kx; this.sy = ky; this.sz = kz;
  }

  _buildAttributes() {
    const { count, uAt } = this;
    const widths = this.controls.map((c) => c.width ?? this.defaultWidth);
    const banks = this.controls.map((c) => (c.bank ?? 0) * Math.PI / 180);

    const width = new Float32Array(count);
    const bank = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      width[i] = Math.max(4, this._evalScalar(widths, uAt[i]));
      bank[i] = this._evalScalar(banks, uAt[i]);
    }

    // Optional curvature-derived banking. Hand-authoring a plausible bank angle
    // for every control point is tedious and easy to get subtly wrong; deriving
    // it from the corner it actually belongs to is both less work and more
    // consistent. Authored values still add on top, so a track can deliberately
    // off-camber a corner.
    if (this.autoBank > 0) {
      const auto = new Float32Array(count);
      for (let i = 0; i < count; i++) {
        auto[i] = clamp(this.curvature[i] * this.autoBank, -this.maxAutoBank, this.maxAutoBank);
      }
      // Wide smoothing: banking must ease in before the corner and out after
      // it, or the car gets a step change in the surface normal at the apex.
      const W = Math.max(1, Math.round(18 / this.step));
      const sm = new Float32Array(count);
      for (let i = 0; i < count; i++) {
        let acc = 0;
        for (let k = -W; k <= W; k++) acc += auto[wrap(i + k, count)];
        sm[i] = acc / (2 * W + 1);
      }
      for (let i = 0; i < count; i++) bank[i] += sm[i];
    }

    this.width = width;
    this.bank = bank;

    // Fold banking into the stored frame. Positive bank tilts `up` toward the
    // driver's right, which raises the left edge — correct banking for a
    // right-hand turn, and positive curvature is a right-hand turn.
    const { ux, uy, uz, sx, sy, sz } = this;
    for (let i = 0; i < count; i++) {
      const a = bank[i];
      if (a === 0) continue;
      const ca = Math.cos(a), sa = Math.sin(a);
      const nux = ux[i] * ca + sx[i] * sa;
      const nuy = uy[i] * ca + sy[i] * sa;
      const nuz = uz[i] * ca + sz[i] * sa;
      const nsx = sx[i] * ca - ux[i] * sa;
      const nsy = sy[i] * ca - uy[i] * sa;
      const nsz = sz[i] * ca - uz[i] * sa;
      ux[i] = nux; uy[i] = nuy; uz[i] = nuz;
      sx[i] = nsx; sy[i] = nsy; sz[i] = nsz;
    }
  }

  _buildCurvature() {
    const { count, tx, ty, tz, sx, sy, sz, step } = this;
    const curv = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const a = wrap(i - 1, count);
      const b = wrap(i + 1, count);
      const dx = tx[b] - tx[a], dy = ty[b] - ty[a], dz = tz[b] - tz[a];
      const mag = Math.hypot(dx, dy, dz) / (2 * step);
      // Sign it by which way the tangent is swinging: + means turning right.
      const sgn = Math.sign(dx * sx[i] + dy * sy[i] + dz * sz[i]) || 1;
      curv[i] = mag * sgn;
    }
    // Light smoothing — raw curvature from finite differences is noisy enough
    // to make AI braking chatter.
    const sm = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      let acc = 0;
      for (let k = -3; k <= 3; k++) acc += curv[wrap(i + k, count)];
      sm[i] = acc / 7;
    }
    this.curvature = sm;
  }

  _buildSpatialGrid() {
    // Uniform bucket grid over XZ for O(1) "which sample am I near" lookups
    // when no previous-frame hint is available (spawning, camera cuts, respawn).
    const cell = 16;
    const grid = new Map();
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < this.count; i++) {
      const cx = Math.floor(this.px[i] / cell);
      const cz = Math.floor(this.pz[i] / cell);
      const key = cx * 73856093 ^ cz * 19349663;
      let bucket = grid.get(key);
      if (!bucket) grid.set(key, (bucket = []));
      bucket.push(i);
      if (this.px[i] < minX) minX = this.px[i];
      if (this.px[i] > maxX) maxX = this.px[i];
      if (this.pz[i] < minZ) minZ = this.pz[i];
      if (this.pz[i] > maxZ) maxZ = this.pz[i];
    }
    this._grid = grid;
    this._cell = cell;
    this.bounds = { minX, maxX, minZ, maxZ };
  }

  // ---------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------

  /** Wrap an arc-length coordinate into [0, length). */
  wrapS(s) { return wrap(s, this.length); }

  /** Shortest signed distance from s0 to s1 around the loop. */
  deltaS(s0, s1) { return ringDelta(s0, s1, this.length); }

  /** Fill `out` with the interpolated frame at arc length `s`. */
  sampleAt(s, out) {
    const { count, invStep } = this;
    s = this.wrapS(s);
    const f = s * invStep;
    const i0 = Math.floor(f) % count;
    const i1 = (i0 + 1) % count;
    const t = f - Math.floor(f);
    const it = 1 - t;

    out.pos.set(
      this.px[i0] * it + this.px[i1] * t,
      this.py[i0] * it + this.py[i1] * t,
      this.pz[i0] * it + this.pz[i1] * t,
    );
    out.tangent.set(
      this.tx[i0] * it + this.tx[i1] * t,
      this.ty[i0] * it + this.ty[i1] * t,
      this.tz[i0] * it + this.tz[i1] * t,
    ).normalize();
    out.up.set(
      this.ux[i0] * it + this.ux[i1] * t,
      this.uy[i0] * it + this.uy[i1] * t,
      this.uz[i0] * it + this.uz[i1] * t,
    ).normalize();
    // Re-derive the basis from the interpolated pair to guarantee orthonormality.
    out.side.crossVectors(out.tangent, out.up).normalize();
    out.up.crossVectors(out.side, out.tangent).normalize();
    out.width = this.width[i0] * it + this.width[i1] * t;
    out.curvature = this.curvature[i0] * it + this.curvature[i1] * t;
    out.s = s;
    return out;
  }

  widthAt(s) {
    const f = this.wrapS(s) * this.invStep;
    const i0 = Math.floor(f) % this.count;
    const i1 = (i0 + 1) % this.count;
    const t = f - Math.floor(f);
    return this.width[i0] * (1 - t) + this.width[i1] * t;
  }

  curvatureAt(s) {
    const f = this.wrapS(s) * this.invStep;
    const i0 = Math.floor(f) % this.count;
    const i1 = (i0 + 1) % this.count;
    const t = f - Math.floor(f);
    return this.curvature[i0] * (1 - t) + this.curvature[i1] * t;
  }

  /**
   * Nearest sample index using the spatial grid (no hint required).
   *
   * Rings are expanded until the closest point any *unvisited* cell could
   * possibly hold is farther than the best candidate found so far. Stopping as
   * soon as a ring yields any hit is wrong: the query point can sit near a cell
   * boundary with a far sample in its own cell and the true nearest one cell
   * over. Distances are compared in 3D so tracks that cross over themselves
   * do not snap to the wrong deck; the ring bound stays valid because the XZ
   * distance to a cell is a lower bound on the 3D distance to anything in it.
   */
  _nearestByGrid(x, y, z) {
    const cell = this._cell;
    const cx = Math.floor(x / cell);
    const cz = Math.floor(z / cell);
    let best = -1;
    let bestD = Infinity;
    const MAX_R = 64;
    for (let r = 0; r <= MAX_R; r++) {
      if (best >= 0 && (r - 1) * cell > Math.sqrt(bestD)) break;
      for (let ox = -r; ox <= r; ox++) {
        for (let oz = -r; oz <= r; oz++) {
          // Only walk the ring at radius r; inner cells were done already.
          if (r > 0 && Math.abs(ox) !== r && Math.abs(oz) !== r) continue;
          const key = (cx + ox) * 73856093 ^ (cz + oz) * 19349663;
          const bucket = this._grid.get(key);
          if (!bucket) continue;
          for (let k = 0; k < bucket.length; k++) {
            const i = bucket[k];
            const dx = this.px[i] - x, dy = this.py[i] - y, dz = this.pz[i] - z;
            const d = dx * dx + dy * dy + dz * dz;
            if (d < bestD) { bestD = d; best = i; }
          }
        }
      }
    }
    if (best < 0) {
      // Degenerate fallback: linear scan. Only reachable if the query is
      // absurdly far from the circuit, which is a bug somewhere else.
      for (let i = 0; i < this.count; i++) {
        const dx = this.px[i] - x, dy = this.py[i] - y, dz = this.pz[i] - z;
        const d = dx * dx + dy * dy + dz * dz;
        if (d < bestD) { bestD = d; best = i; }
      }
    }
    return best;
  }

  /**
   * Project a world position into track space.
   * @param {number} x @param {number} y @param {number} z
   * @param {number} hintS Previous frame's `s`, if known. Turns the search into
   *        a short local scan, which is what makes this cheap enough to run for
   *        every racer every tick.
   * @param {object} out Reused result object {s, d, h, index}.
   */
  project(x, y, z, hintS, out) {
    const { count } = this;
    let best = -1;
    let bestD = Infinity;

    if (hintS !== null && hintS !== undefined) {
      const centre = Math.round(this.wrapS(hintS) * this.invStep) % count;
      const W = 28;
      for (let k = -W; k <= W; k++) {
        const i = wrap(centre + k, count);
        const dx = this.px[i] - x, dy = this.py[i] - y, dz = this.pz[i] - z;
        const d = dx * dx + dy * dy + dz * dz;
        if (d < bestD) { bestD = d; best = i; }
      }
      // If the winner sits on the window edge the true minimum may be outside;
      // fall back to the grid rather than tracking a wrong segment.
      const off = Math.abs(ringDelta(centre, best, count));
      if (off >= W - 1) best = -1;
    }

    if (best < 0) best = this._nearestByGrid(x, y, z);

    // Refine against the two adjoining segments for sub-sample precision.
    let bestS = best * this.step;
    let bestSq = Infinity;
    for (let k = -1; k <= 0; k++) {
      const i = wrap(best + k, count);
      const j = wrap(i + 1, count);
      const ax = this.px[i], ay = this.py[i], az = this.pz[i];
      const bx = this.px[j] - ax, by = this.py[j] - ay, bz = this.pz[j] - az;
      const len2 = bx * bx + by * by + bz * bz || 1e-9;
      let u = ((x - ax) * bx + (y - ay) * by + (z - az) * bz) / len2;
      u = clamp01(u);
      const cx = ax + bx * u, cy = ay + by * u, cz = az + bz * u;
      const dx = x - cx, dy = y - cy, dz = z - cz;
      const sq = dx * dx + dy * dy + dz * dz;
      if (sq < bestSq) {
        bestSq = sq;
        bestS = (i + u) * this.step;
      }
    }

    const f = this._frameScratch || (this._frameScratch = new TrackFrame());
    this.sampleAt(bestS, f);
    const rx = x - f.pos.x, ry = y - f.pos.y, rz = z - f.pos.z;
    out.s = f.s;
    out.d = rx * f.side.x + ry * f.side.y + rz * f.side.z;
    out.h = rx * f.up.x + ry * f.up.y + rz * f.up.z;
    out.index = Math.round(f.s * this.invStep) % count;
    out.width = f.width;
    return out;
  }

  /** Convert (s, d, h) back to world space. */
  toWorld(s, d, h, out) {
    const f = this._frameScratch2 || (this._frameScratch2 = new TrackFrame());
    this.sampleAt(s, f);
    out.copy(f.pos)
      .addScaledVector(f.side, d)
      .addScaledVector(f.up, h);
    return out;
  }
}
