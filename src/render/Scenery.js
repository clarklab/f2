import * as THREE from 'three';
import { makeRng, clamp } from '../core/MathUtil.js';
import { TrackFrame } from '../track/TrackPath.js';
import { shade } from './World.js';
import { windowTexture, foliageTexture, pipeTexture, sunTexture } from './Textures.js';

/**
 * Scenery — the world beside the road.
 *
 * Every circuit gets a hand-built environment rather than the same box field
 * recoloured: a night city of lit towers, a sunset beach with palms, a conifer
 * forest, an orbital pipe yard, an eroded desert of layered mesas, and a
 * volcanic basalt field. Each is a set of small prop *models*, not silhouettes.
 *
 * THE BUDGET is what shapes the design. This runs at 60 fps on a phone, so:
 *
 *   - Props are built once as vertex-coloured geometry and drawn with
 *     InstancedMesh, so a hundred trees cost one draw call.
 *   - Per-instance colour (`setColorAt`) supplies variety that would otherwise
 *     need separate meshes — the tint multiplies the baked vertex colours, so a
 *     single tree model yields a whole forest of slightly different greens.
 *   - Face brightness is baked into the vertex colours exactly as the machines
 *     do it. There are no lights in this game; "lighting" is a fixed shade per
 *     face direction, which is free and matches the sprite-era look.
 *
 * PLACEMENT is generated from the track itself, so scenery always frames the
 * road however the circuit was authored. Props are laid down at intervals along
 * the centreline, pushed out past the shoulder by a seeded jitter, and dropped
 * onto the ground plane rather than into the track's frame — otherwise a banked
 * corner produces leaning trees.
 */

// Fixed shading per face direction, matching MachineModel's convention.
const FACE = { top: 1.0, bottom: 0.45, front: 0.88, back: 0.7, side: 0.8 };

const _c = new THREE.Color();

class PropBuilder {
  constructor() {
    this.pos = [];
    this.col = [];
    this.uv = [];
    this.idx = [];
  }

  _v(x, y, z, c, u = 0, v = 0) {
    this.pos.push(x, y, z);
    this.col.push(c.r, c.g, c.b);
    this.uv.push(u, v);
    return this.pos.length / 3 - 1;
  }

  _quad(a, b, c, d) {
    this.idx.push(a, b, c, a, c, d);
  }

  _tint(color, f) {
    const c = new THREE.Color(color);
    c.multiplyScalar(f);
    c.convertSRGBToLinear();
    return c;
  }

  /**
   * A tapering box. `uvScale` lets a caller keep a tiled facade texture at a
   * consistent density on props of different sizes, which is how buildings of
   * four different heights share one window texture.
   */
  box({
    x = 0, y = 0, z = 0, w, h, l,
    wTop = null, lTop = null, color, topColor = null,
    uvScale = null, skipBottom = true, ry = 0,
  }) {
    const w0 = w * 0.5, l0 = l * 0.5;
    const w1 = (wTop ?? w) * 0.5, l1 = (lTop ?? l) * 0.5;
    const cs = Math.cos(ry), sn = Math.sin(ry);
    const P = (px, pz) => [x + px * cs - pz * sn, z + px * sn + pz * cs];

    const cTop = this._tint(topColor ?? color, FACE.top);
    const cBot = this._tint(color, FACE.bottom);
    const cSideA = this._tint(color, FACE.front);
    const cSideB = this._tint(color, FACE.side);

    const uw = uvScale ? w * uvScale : 1;
    const ul = uvScale ? l * uvScale : 1;
    const uh = uvScale ? h * uvScale : 1;

    // Corner helpers: (bottom, top) rings.
    const b = [P(-w0, -l0), P(w0, -l0), P(w0, l0), P(-w0, l0)];
    const t = [P(-w1, -l1), P(w1, -l1), P(w1, l1), P(-w1, l1)];

    // top
    this._quad(
      this._v(t[0][0], y + h, t[0][1], cTop, 0, 0),
      this._v(t[1][0], y + h, t[1][1], cTop, 1, 0),
      this._v(t[2][0], y + h, t[2][1], cTop, 1, 1),
      this._v(t[3][0], y + h, t[3][1], cTop, 0, 1),
    );
    if (!skipBottom) {
      this._quad(
        this._v(b[3][0], y, b[3][1], cBot, 0, 1),
        this._v(b[2][0], y, b[2][1], cBot, 1, 1),
        this._v(b[1][0], y, b[1][1], cBot, 1, 0),
        this._v(b[0][0], y, b[0][1], cBot, 0, 0),
      );
    }
    // four sides, alternating shade so corners read
    const sides = [[0, 1, uw], [1, 2, ul], [2, 3, uw], [3, 0, ul]];
    sides.forEach(([i, j, uspan], k) => {
      const c = k % 2 === 0 ? cSideA : cSideB;
      this._quad(
        this._v(b[i][0], y, b[i][1], c, 0, 0),
        this._v(b[j][0], y, b[j][1], c, uspan, 0),
        this._v(t[j][0], y + h, t[j][1], c, uspan, uh),
        this._v(t[i][0], y + h, t[i][1], c, 0, uh),
      );
    });
    return this;
  }

  /** A cylinder along an arbitrary axis. The workhorse for pipes and trunks. */
  tube({ from, to, r, rEnd = null, seg = 6, color, caps = true }) {
    const a = new THREE.Vector3(...from);
    const bv = new THREE.Vector3(...to);
    const axis = new THREE.Vector3().subVectors(bv, a);
    const len = axis.length();
    if (len < 1e-4) return this;
    axis.normalize();
    // Any perpendicular will do; pick the one least parallel to the axis.
    const ref = Math.abs(axis.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    const u = new THREE.Vector3().crossVectors(ref, axis).normalize();
    const v = new THREE.Vector3().crossVectors(axis, u);
    const r2 = rEnd ?? r;

    const ring = (centre, radius, shadeMul) => {
      const out = [];
      for (let i = 0; i < seg; i++) {
        const th = (i / seg) * Math.PI * 2;
        const cx = Math.cos(th), sy = Math.sin(th);
        // Brightness by facing: the side pointing "up" in world terms is lit.
        const nx = u.x * cx + v.x * sy, ny = u.y * cx + v.y * sy, nz = u.z * cx + v.z * sy;
        const lit = FACE.side + (Math.max(0, ny) * 0.24) - (Math.max(0, -ny) * 0.2);
        const c = this._tint(color, lit * shadeMul);
        out.push(this._v(
          centre.x + nx * radius, centre.y + ny * radius, centre.z + nz * radius,
          c, i / seg, centre === a ? 0 : 1,
        ));
      }
      return out;
    };

    const r0 = ring(a, r, 1);
    const r1 = ring(bv, r2, 1);
    for (let i = 0; i < seg; i++) {
      const j = (i + 1) % seg;
      this._quad(r0[i], r0[j], r1[j], r1[i]);
    }
    if (caps) {
      const cCap = this._tint(color, FACE.top);
      const centreB = this._v(bv.x, bv.y, bv.z, cCap, 0.5, 0.5);
      for (let i = 0; i < seg; i++) {
        const j = (i + 1) % seg;
        this.idx.push(r1[i], r1[j], centreB);
      }
      const cCap2 = this._tint(color, FACE.bottom);
      const centreA = this._v(a.x, a.y, a.z, cCap2, 0.5, 0.5);
      for (let i = 0; i < seg; i++) {
        const j = (i + 1) % seg;
        this.idx.push(r0[j], r0[i], centreA);
      }
    }
    return this;
  }

  /** A cone, base at y, apex at y+h. Conifer canopies and spires. */
  cone({ x = 0, y = 0, z = 0, r, h, seg = 7, color }) {
    const apex = this._v(x, y + h, z, this._tint(color, FACE.top), 0.5, 1);
    const ring = [];
    for (let i = 0; i < seg; i++) {
      const th = (i / seg) * Math.PI * 2;
      const f = FACE.side + Math.cos(th - 0.6) * 0.16;
      ring.push(this._v(
        x + Math.cos(th) * r, y, z + Math.sin(th) * r,
        this._tint(color, f), i / seg, 0,
      ));
    }
    for (let i = 0; i < seg; i++) this.idx.push(ring[i], ring[(i + 1) % seg], apex);
    const cBot = this._tint(color, FACE.bottom);
    const centre = this._v(x, y, z, cBot, 0.5, 0.5);
    for (let i = 0; i < seg; i++) this.idx.push(ring[(i + 1) % seg], ring[i], centre);
    return this;
  }

  /** Two crossed vertical quads — the cheapest convincing bush or frond. */
  cross({ x = 0, y = 0, z = 0, w, h, color, ry = 0 }) {
    const c = this._tint(color, 0.95);
    const c2 = this._tint(color, 0.72);
    for (let k = 0; k < 2; k++) {
      const a = ry + k * Math.PI * 0.5;
      const dx = Math.cos(a) * w * 0.5, dz = Math.sin(a) * w * 0.5;
      const cc = k === 0 ? c : c2;
      this._quad(
        this._v(x - dx, y, z - dz, cc, 0, 0),
        this._v(x + dx, y, z + dz, cc, 1, 0),
        this._v(x + dx, y + h, z + dz, cc, 1, 1),
        this._v(x - dx, y + h, z - dz, cc, 0, 1),
      );
    }
    return this;
  }

  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

// ---------------------------------------------------------------------------
// Prop models
// ---------------------------------------------------------------------------

/**
 * A night tower block. Height classes exist so the window texture can tile at
 * a constant density: a single box geometry stretched to four different heights
 * would stretch its windows with it.
 */
function towerProp(h, w, style) {
  const b = new PropBuilder();
  const body = 0xffffff;                     // instance colour supplies the hue
  const uvScale = 0.09;
  if (style === 'stepped') {
    b.box({ y: 0, w, h: h * 0.62, l: w * 0.92, color: body, uvScale });
    b.box({ y: h * 0.62, w: w * 0.72, h: h * 0.3, l: w * 0.66, color: body, uvScale });
    b.box({ y: h * 0.92, w: w * 0.3, h: h * 0.08, l: w * 0.3, color: 0x8899bb });
  } else if (style === 'spire') {
    b.box({ y: 0, w, h: h * 0.8, l: w, wTop: w * 0.7, lTop: w * 0.7, color: body, uvScale });
    b.cone({ y: h * 0.8, r: w * 0.5, h: h * 0.2, seg: 6, color: 0x9fb0d0 });
    // Aircraft beacon: reads as a red dot on the skyline.
    b.box({ y: h, w: 0.9, h: 1.2, l: 0.9, color: 0xff3b5c });
  } else {
    b.box({ y: 0, w, h, l: w * 0.86, color: body, uvScale });
    b.box({ y: h, w: w * 0.5, h: 1.6, l: w * 0.5, color: 0x7788aa });
    b.box({ x: w * 0.22, y: h + 1.6, w: 0.5, h: h * 0.09, l: 0.5, color: 0x8899bb });
  }
  return b.build();
}

/** A palm: leaning trunk with a crown of drooping fronds. */
function palmProp() {
  const b = new PropBuilder();
  const trunk = 0x6b5236;
  const lean = 0.16;
  const H = 13;
  let px = 0, py = 0, pz = 0;
  const SEGS = 4;
  for (let i = 0; i < SEGS; i++) {
    const t0 = i / SEGS, t1 = (i + 1) / SEGS;
    const nx = Math.sin(t1 * 1.6) * lean * H;
    const ny = t1 * H;
    b.tube({
      from: [px, py, pz], to: [nx, ny, 0],
      r: 0.62 - t0 * 0.22, rEnd: 0.62 - t1 * 0.22, seg: 5,
      color: shade(trunk, t0 * 0.18), caps: false,
    });
    px = nx; py = ny; pz = 0;
  }
  // Fronds: eight tapered blades radiating from the crown and drooping.
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + 0.3;
    const len = 4.4 + (i % 3) * 0.7;
    const tipY = py + 1.1 - len * 0.42;
    b.tube({
      from: [px, py + 0.8, pz],
      to: [px + Math.cos(a) * len, tipY, pz + Math.sin(a) * len],
      r: 0.75, rEnd: 0.08, seg: 4,
      color: i % 2 ? 0x3f9a4e : 0x56b862, caps: false,
    });
  }
  b.box({ y: py + 0.5, w: 1.5, h: 1.0, l: 1.5, color: 0x8a6b3f });
  return b.build();
}

/** A conifer: bare trunk with three stacked canopy cones. */
function coniferProp() {
  const b = new PropBuilder();
  const H = 19;
  b.tube({ from: [0, 0, 0], to: [0, H * 0.42, 0], r: 0.85, rEnd: 0.5, seg: 5, color: 0x4a3524 });
  b.cone({ y: H * 0.26, r: 4.6, h: H * 0.34, seg: 7, color: 0x2b6f39 });
  b.cone({ y: H * 0.5, r: 3.5, h: H * 0.3, seg: 7, color: 0x358045 });
  b.cone({ y: H * 0.72, r: 2.3, h: H * 0.3, seg: 6, color: 0x429551 });
  return b.build();
}

/** A broadleaf: forked trunk under a lumpy canopy of stacked boxes. */
function broadleafProp() {
  const b = new PropBuilder();
  const H = 15;
  b.tube({ from: [0, 0, 0], to: [0, H * 0.45, 0], r: 1.0, rEnd: 0.65, seg: 5, color: 0x53412c });
  b.tube({ from: [0, H * 0.4, 0], to: [-2.0, H * 0.66, 0.6], r: 0.42, rEnd: 0.2, seg: 4, color: 0x53412c });
  b.tube({ from: [0, H * 0.4, 0], to: [1.9, H * 0.62, -0.7], r: 0.42, rEnd: 0.2, seg: 4, color: 0x53412c });
  const leaf = 0x4fa348;
  b.box({ x: 0, y: H * 0.5, w: 8.4, h: 4.4, l: 7.6, wTop: 6.4, lTop: 5.8, color: leaf });
  b.box({ x: -2.4, y: H * 0.62, w: 5.0, h: 3.4, l: 4.6, wTop: 3.2, lTop: 3.0, color: shade(leaf, 0.1) });
  b.box({ x: 2.2, y: H * 0.66, w: 4.4, h: 3.0, l: 4.2, wTop: 2.8, lTop: 2.6, color: shade(leaf, -0.12) });
  b.box({ x: 0, y: H * 0.78, w: 4.0, h: 2.6, l: 3.8, wTop: 1.6, lTop: 1.6, color: shade(leaf, 0.16) });
  return b.build();
}

/** A dead snag: the thing that stops a forest looking like wallpaper. */
function snagProp() {
  const b = new PropBuilder();
  b.tube({ from: [0, 0, 0], to: [0.5, 11, 0.3], r: 0.8, rEnd: 0.28, seg: 5, color: 0x554433 });
  b.tube({ from: [0.2, 5.4, 0.1], to: [3.0, 7.4, -0.6], r: 0.3, rEnd: 0.08, seg: 4, color: 0x4a3a2c });
  b.tube({ from: [0.3, 7.6, 0.2], to: [-2.4, 9.4, 0.9], r: 0.26, rEnd: 0.07, seg: 4, color: 0x4a3a2c });
  return b.build();
}

/**
 * A pipe stack: the space-port vocabulary. Horizontal runs on stilts, an elbow,
 * a valve wheel and a vertical riser — the "twisted metal tubes" silhouette.
 */
function pipeRigProp(variant) {
  const b = new PropBuilder();
  const metal = 0xb3bece;
  const dark = 0x7b8698;
  const warn = 0xffc043;
  if (variant === 0) {
    // Long horizontal run on two legs, with an elbow turning up at one end.
    b.tube({ from: [-14, 7, 0], to: [10, 7, 0], r: 1.5, seg: 7, color: metal });
    b.tube({ from: [10, 7, 0], to: [14, 7, 0], r: 1.6, seg: 7, color: warn });
    b.tube({ from: [14, 7, 0], to: [14, 18, 0], r: 1.5, seg: 7, color: metal });
    b.tube({ from: [14, 18, 0], to: [14, 20, 3.5], r: 1.2, rEnd: 1.6, seg: 7, color: dark });
    b.box({ x: -10, y: 0, w: 2.2, h: 7, l: 2.2, color: dark });
    b.box({ x: 5, y: 0, w: 2.2, h: 7, l: 2.2, color: dark });
    b.tube({ from: [-2, 7, 0], to: [-2, 11.5, 0], r: 0.5, seg: 5, color: dark });
    b.box({ x: -2, y: 11.5, w: 3.0, h: 0.6, l: 3.0, color: warn });
  } else if (variant === 1) {
    // Tank battery: three cylinders and a catwalk.
    for (let i = 0; i < 3; i++) {
      b.tube({ from: [i * 7 - 7, 0, 0], to: [i * 7 - 7, 12 - i * 1.5, 0], r: 3.0, seg: 8, color: metal });
      b.tube({
        from: [i * 7 - 7, 12 - i * 1.5, 0], to: [i * 7 - 7, 13.4 - i * 1.5, 0],
        r: 3.0, rEnd: 1.4, seg: 8, color: dark,
      });
    }
    b.box({ x: 0, y: 12.6, w: 22, h: 0.5, l: 2.4, color: warn });
    b.box({ x: -11, y: 0, w: 1.0, h: 12.6, l: 1.0, color: dark });
    b.box({ x: 11, y: 0, w: 1.0, h: 12.6, l: 1.0, color: dark });
  } else {
    // A twisted knot of small pipes — the greeble that sells "port", not "farm".
    const seq = [
      [[-8, 2, -2], [-2, 5, 2]], [[-2, 5, 2], [5, 4, -3]],
      [[5, 4, -3], [9, 10, 1]], [[9, 10, 1], [2, 13, 3]],
      [[2, 13, 3], [-6, 11, -1]], [[-6, 11, -1], [-8, 5, -3]],
    ];
    seq.forEach(([f, t], i) => {
      b.tube({ from: f, to: t, r: 0.9, seg: 6, color: i % 3 === 1 ? dark : metal });
    });
    b.box({ x: 0, y: 0, w: 9, h: 2.4, l: 7, color: dark });
    b.box({ x: 3.4, y: 2.4, w: 1.6, h: 5, l: 1.6, color: warn });
  }
  return b.build();
}

/** A layered mesa. Strata are separate boxes so the banding is real geometry. */
function mesaProp(seed) {
  const b = new PropBuilder();
  const rng = makeRng(seed);
  const layers = 5 + Math.floor(rng() * 3);
  let y = 0;
  let w = 30 + rng() * 22;
  const bands = [0xb98a52, 0xa8763f, 0xc49a63, 0x8f5f36, 0xb07c46];
  for (let i = 0; i < layers; i++) {
    const h = 5 + rng() * 7;
    const shrink = 0.82 + rng() * 0.12;
    b.box({
      y, w, h, l: w * (0.8 + rng() * 0.4),
      wTop: w * shrink, lTop: w * shrink * 0.9,
      color: bands[i % bands.length], ry: rng() * 0.4,
    });
    y += h;
    w *= shrink;
  }
  return b.build();
}

/** A saguaro-ish column cactus, for scale against the mesas. */
function cactusProp() {
  const b = new PropBuilder();
  const green = 0x3f7a44;
  b.tube({ from: [0, 0, 0], to: [0, 9, 0], r: 1.1, rEnd: 0.9, seg: 7, color: green });
  b.tube({ from: [-0.6, 4.2, 0], to: [-3.2, 5.2, 0], r: 0.55, seg: 5, color: green, caps: false });
  b.tube({ from: [-3.2, 5.0, 0], to: [-3.2, 8.0, 0], r: 0.55, seg: 5, color: green });
  b.tube({ from: [0.6, 5.6, 0], to: [2.6, 6.4, 0], r: 0.5, seg: 5, color: green, caps: false });
  b.tube({ from: [2.6, 6.2, 0], to: [2.6, 8.6, 0], r: 0.5, seg: 5, color: green });
  return b.build();
}

/** Basalt columns: hexagonal volcanic pillars, some snapped short. */
function basaltProp(seed) {
  const b = new PropBuilder();
  const rng = makeRng(seed);
  const n = 5 + Math.floor(rng() * 4);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const rad = 2.4 + rng() * 4.2;
    const x = Math.cos(a) * rad, z = Math.sin(a) * rad;
    const h = 6 + rng() * 20;
    const hot = rng() < 0.28;
    b.tube({
      from: [x, 0, z], to: [x, h, z],
      r: 1.5 + rng() * 0.9, seg: 6,
      color: hot ? 0x6b2418 : 0x3a3038,
    });
    if (hot) b.box({ x, y: h, w: 2.0, h: 0.7, l: 2.0, color: 0xff7a2a });
  }
  return b.build();
}

/** A rounded beach boulder. */
function boulderProp(seed) {
  const b = new PropBuilder();
  const rng = makeRng(seed);
  const base = 0x9a8b74;
  let y = 0;
  let w = 5 + rng() * 4;
  for (let i = 0; i < 3; i++) {
    const h = 1.6 + rng() * 1.8;
    b.box({
      y, w, h, l: w * (0.8 + rng() * 0.35),
      wTop: w * 0.74, lTop: w * 0.7,
      color: shade(base, (rng() - 0.5) * 0.3), ry: rng() * 1.2,
    });
    y += h; w *= 0.76;
  }
  return b.build();
}


/** A low street block with a rooftop plant deck — mass at street level. */
function blockProp() {
  const b = new PropBuilder();
  const body = 0xffffff;
  b.box({ y: 0, w: 26, h: 16, l: 22, color: body, uvScale: 0.09 });
  b.box({ x: 6, y: 16, w: 10, h: 5, l: 9, color: body, uvScale: 0.09 });
  b.box({ x: -7, y: 16, w: 5, h: 2.4, l: 5, color: 0x6b7488 });
  return b.build();
}

/** A lattice mast with a strobe: the vertical accent a flat yard needs. */
function mastProp() {
  const b = new PropBuilder();
  const metal = 0x9aa6ba;
  const H = 46;
  for (const [dx, dz] of [[-2.2, -2.2], [2.2, -2.2], [2.2, 2.2], [-2.2, 2.2]]) {
    b.tube({ from: [dx, 0, dz], to: [dx * 0.28, H, dz * 0.28], r: 0.5, rEnd: 0.28, seg: 4, color: metal });
  }
  for (let i = 1; i < 7; i++) {
    const y = (i / 7) * H;
    const k = 1 - (i / 7) * 0.72;
    b.box({ y, w: 4.6 * k, h: 0.5, l: 4.6 * k, color: metal });
  }
  b.box({ y: H, w: 1.4, h: 2.2, l: 1.4, color: 0xff4a4a });
  return b.build();
}

/** A tuft of grass or scrub: three crossed billboards, ~12 triangles. */
function grassProp() {
  const b = new PropBuilder();
  for (let i = 0; i < 3; i++) {
    const a = i * 1.1;
    b.cross({
      x: Math.cos(a) * 1.1, z: Math.sin(a) * 1.1,
      w: 2.6 + i * 0.5, h: 2.2 + i * 0.7, color: 0xffffff, ry: a,
    });
  }
  return b.build();
}

/** An arch that straddles the road: two legs, a span, and a lit sign panel. */
function gantryProp(accent, metal) {
  const b = new PropBuilder();
  const HALF = 36, H = 24;
  b.box({ x: -HALF, y: 0, w: 3.4, h: H, l: 3.4, wTop: 2.2, lTop: 2.2, color: metal });
  b.box({ x: HALF, y: 0, w: 3.4, h: H, l: 3.4, wTop: 2.2, lTop: 2.2, color: metal });
  b.box({ x: 0, y: H, w: HALF * 2 + 4, h: 3.0, l: 3.0, color: metal });
  // Sign: a dark bezel with three lit panels inside it. One solid rectangle of
  // accent colour reads as a painted board; the gaps are what make it a screen.
  b.box({ x: 0, y: H + 2.6, w: 28, h: 7.2, l: 1.6, color: shade(metal, -0.4) });
  for (let i = -1; i <= 1; i++) {
    b.box({ x: i * 8.4, y: H + 3.4, w: 7.2, h: 5.4, l: 1.9, color: accent });
  }
  b.box({ x: -HALF, y: H, w: 5.0, h: 4.2, l: 5.0, color: shade(metal, 0.2) });
  b.box({ x: HALF, y: H, w: 5.0, h: 4.2, l: 5.0, color: shade(metal, 0.2) });
  // Downlights on the span, so the arch is legible before its silhouette is.
  for (let i = -2; i <= 2; i++) {
    if (i === 0) continue;
    b.box({ x: i * 13, y: H - 1.2, w: 1.8, h: 1.2, l: 1.8, color: 0xfff0c0 });
  }
  return b.build();
}

/** A pipe bridge vaulting the road — the space port's version of the gantry. */
function pipeArchProp() {
  const b = new PropBuilder();
  const metal = 0xb3bece, dark = 0x7b8698, warn = 0xffc043;
  const HALF = 38, H = 22;
  // Two stepped legs, then three parallel pipes over the top.
  for (const sx of [-1, 1]) {
    b.box({ x: sx * HALF, y: 0, w: 6, h: H * 0.6, l: 6, wTop: 4.4, lTop: 4.4, color: dark });
    b.tube({ from: [sx * HALF, H * 0.6, 0], to: [sx * HALF, H, 0], r: 2.0, seg: 7, color: metal });
  }
  for (let i = 0; i < 3; i++) {
    const z = (i - 1) * 3.4;
    const r = 1.5 - Math.abs(i - 1) * 0.35;
    b.tube({ from: [-HALF, H, z], to: [-HALF * 0.55, H + 5, z], r, seg: 6, color: metal });
    b.tube({ from: [-HALF * 0.55, H + 5, z], to: [HALF * 0.55, H + 5, z], r, seg: 6, color: i === 1 ? warn : metal });
    b.tube({ from: [HALF * 0.55, H + 5, z], to: [HALF, H, z], r, seg: 6, color: metal });
  }
  b.box({ x: 0, y: H + 6.4, w: 10, h: 1.6, l: 8, color: warn });
  return b.build();
}

// ---------------------------------------------------------------------------
// Environments
// ---------------------------------------------------------------------------

/**
 * Each environment is a list of layers, and every layer becomes exactly one
 * InstancedMesh.
 *
 *   prop     builds the geometry (called once)
 *   texture  optional map — buildings get windows, canopies get leaf noise
 *   count    how many copies
 *   every    metres of track between placements
 *   near/far lateral distance out from the shoulder
 *   scale    [min, max] uniform scale
 *   tints    per-instance colours, multiplied into the baked vertex colours
 *   arch     straddle the centreline instead of standing beside the road
 *   onRoad   sit at road height rather than on the distant ground plane
 */
const ENVIRONMENTS = {
  // ---- MUTE CITY: a night skyline of lit towers -------------------------
  city: {
    layers: [
      {
        prop: () => blockProp(),
        texture: () => windowTexture({ lit: 0xffe0a0, seed: 21, density: 0.55 }),
        count: 96, every: 21, near: 14, far: 54, scale: [0.7, 1.8],
        tints: [0x5a6498, 0x4d5684, 0x6a75ab, 0x424a74],
      },
      {
        prop: () => towerProp(70, 15, 'plain'),
        texture: () => windowTexture({ lit: 0xffd98a, seed: 3, density: 0.5 }),
        count: 120, every: 22, near: 26, far: 110, scale: [0.55, 1.6],
        tints: [0x565f92, 0x464e78, 0x6570a4, 0x3a4168],
      },
      {
        prop: () => towerProp(110, 20, 'stepped'),
        texture: () => windowTexture({ lit: 0xa8d8ff, seed: 9, density: 0.34 }),
        count: 86, every: 40, near: 120, far: 340, scale: [0.9, 2.3],
        tints: [0x3e4574, 0x353b63, 0x4a5286],
      },
      {
        prop: () => towerProp(150, 17, 'spire'),
        texture: () => windowTexture({ lit: 0xffc46a, seed: 17, density: 0.26 }),
        count: 28, every: 110, near: 150, far: 380, scale: [1.0, 2.0],
        tints: [0x404776, 0x4c548a],
      },
      {
        prop: () => gantryProp(0xff4d7a, 0x2b3152),
        count: 10, every: 230, arch: true, onRoad: true,
        tints: [0xffffff],
      },
    ],
  },

  // ---- BIG BLUE: a sunset beach ------------------------------------------
  ocean: {
    sun: { color: 0xffd070, size: 210, height: 0.13, bearing: 2.2 },
    layers: [
      {
        prop: () => palmProp(),
        texture: () => foliageTexture({ seed: 5 }),
        count: 190, every: 13, near: 12, far: 64, scale: [0.75, 1.6],
        tints: [0xffffff, 0xe8ffd8, 0xd8f0c0, 0xfff0d0],
      },
      {
        prop: () => boulderProp(4),
        count: 96, every: 25, near: 18, far: 92, scale: [0.7, 1.9],
        tints: [0xffe8c8, 0xf0d8b0, 0xffd8a8],
      },
      {
        prop: () => grassProp(),
        texture: () => foliageTexture({ seed: 33, contrast: 0.3 }),
        count: 150, every: 15, near: 10, far: 42, scale: [0.8, 1.8],
        tints: [0xd8c890, 0xc8b878, 0xe8d8a0],
      },
      {
        prop: () => palmProp(),
        texture: () => foliageTexture({ seed: 12 }),
        count: 96, every: 36, near: 110, far: 270, scale: [1.6, 3.2],
        tints: [0xc8d8b0, 0xb8c8a0],
      },
    ],
  },

  // ---- SAND OCEAN: eroded desert of layered mesas -------------------------
  desert: {
    sun: { color: 0xff9a4a, size: 170, height: 0.09, bearing: 4.1 },
    layers: [
      {
        prop: () => mesaProp(7),
        count: 48, every: 56, near: 62, far: 250, scale: [0.8, 2.4],
        tints: [0xffffff, 0xf0d8b8, 0xffe0c0, 0xe8c8a0],
      },
      {
        prop: () => mesaProp(19),
        count: 34, every: 92, near: 230, far: 470, scale: [1.8, 3.8],
        tints: [0xd8b898, 0xc8a888],
      },
      {
        prop: () => cactusProp(),
        count: 140, every: 16, near: 12, far: 60, scale: [0.7, 1.7],
        tints: [0xffffff, 0xd8f0c8, 0xe8ffd0],
      },
      {
        prop: () => boulderProp(21),
        count: 110, every: 20, near: 14, far: 80, scale: [0.6, 1.6],
        tints: [0xffdcb0, 0xf0c898],
      },
    ],
  },

  // ---- SILENCE: an orbital pipe yard --------------------------------------
  grid: {
    layers: [
      {
        prop: () => pipeRigProp(0),
        texture: () => pipeTexture({ seed: 4 }),
        count: 92, every: 23, near: 16, far: 80, scale: [0.8, 1.8],
        tints: [0xffffff, 0xdce6f5, 0xc2cede, 0xe8d0b0],
      },
      {
        prop: () => pipeRigProp(1),
        texture: () => pipeTexture({ seed: 11 }),
        count: 58, every: 41, near: 55, far: 175, scale: [1.0, 2.3],
        tints: [0xffffff, 0xd0dcee, 0xe4ecf8],
      },
      {
        prop: () => pipeRigProp(2),
        texture: () => pipeTexture({ seed: 23 }),
        count: 104, every: 18, near: 12, far: 64, scale: [0.7, 1.6],
        tints: [0xffffff, 0xd4e0f0, 0xf0d8b8],
      },
      {
        prop: () => mastProp(),
        texture: () => pipeTexture({ seed: 51 }),
        count: 34, every: 66, near: 40, far: 210, scale: [0.8, 2.0],
        tints: [0xffffff, 0xd8e2f0],
      },
      {
        prop: () => pipeRigProp(1),
        texture: () => pipeTexture({ seed: 31 }),
        count: 40, every: 76, near: 190, far: 400, scale: [2.4, 4.4],
        tints: [0xb6c2d6, 0xa4b0c4],
      },
      {
        prop: () => pipeArchProp(),
        texture: () => pipeTexture({ seed: 41 }),
        count: 12, every: 190, arch: true, onRoad: true,
        tints: [0xffffff],
      },
    ],
  },

  // ---- DEATH WIND: a conifer forest ---------------------------------------
  wind: {
    layers: [
      {
        prop: () => coniferProp(),
        texture: () => foliageTexture({ seed: 7 }),
        count: 240, every: 9, near: 11, far: 72, scale: [0.8, 2.0],
        tints: [0xffffff, 0xd8e8c0, 0xc0d8a8, 0xe8f0d0, 0xb8cc98],
      },
      {
        prop: () => broadleafProp(),
        texture: () => foliageTexture({ seed: 15 }),
        count: 130, every: 17, near: 14, far: 84, scale: [0.8, 1.8],
        tints: [0xffffff, 0xe0f0c8, 0xc8dcb0, 0xf0e8b8],
      },
      {
        prop: () => snagProp(),
        count: 62, every: 34, near: 12, far: 62, scale: [0.8, 1.7],
        tints: [0xd8c8b0, 0xc0b098],
      },
      {
        prop: () => grassProp(),
        texture: () => foliageTexture({ seed: 44, contrast: 0.34 }),
        count: 160, every: 14, near: 9, far: 40, scale: [0.9, 2.0],
        tints: [0x9ec27e, 0x88ae6c, 0xb2d090],
      },
      {
        prop: () => coniferProp(),
        texture: () => foliageTexture({ seed: 27 }),
        count: 150, every: 25, near: 90, far: 310, scale: [2.0, 4.2],
        tints: [0xa8bc98, 0x98ac88, 0xb8c8a8],
      },
    ],
  },

  // ---- FIRE FIELD: a basalt plain ----------------------------------------
  fire: {
    layers: [
      {
        prop: () => basaltProp(5),
        count: 120, every: 15, near: 12, far: 76, scale: [0.7, 1.9],
        tints: [0xffffff, 0xd8c0c0, 0xffb0a0, 0xc0b0b8],
      },
      {
        prop: () => basaltProp(13),
        count: 76, every: 36, near: 85, far: 290, scale: [1.8, 3.8],
        tints: [0xe0a8a0, 0xc89890, 0xffc0a8],
      },
      {
        prop: () => boulderProp(9),
        count: 84, every: 22, near: 14, far: 72, scale: [0.7, 1.7],
        tints: [0x9a8078, 0x806868, 0xb08880],
      },
    ],
  },
};

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

/**
 * Build the scenery for one theme and add it to `group`.
 *
 * @returns {{meshes: THREE.Mesh[], disposables: object[], sun: THREE.Mesh|null}}
 */
export function buildEnvironment(themeName, path, group, groundY) {
  const env = ENVIRONMENTS[themeName];
  const out = { meshes: [], disposables: [], sun: null };
  if (!env) return out;

  const rng = makeRng(20260726);
  const frame = new TrackFrame();

  for (const layer of env.layers) {
    if (!layer.count) continue;
    const geo = layer.prop();
    const map = layer.texture ? layer.texture() : null;
    const mat = new THREE.MeshBasicMaterial({ vertexColors: true, fog: true, map });
    const mesh = new THREE.InstancedMesh(geo, mat, layer.count);
    mesh.frustumCulled = false;
    mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    out.disposables.push(geo, mat);

    const tints = layer.tints ?? [0xffffff];
    const [sMin, sMax] = layer.scale ?? [1, 1];
    let placed = 0;

    for (let k = 0; k < layer.count; k++) {
      // Prime-ish stride so a layer never lines up with the one beside it.
      const s = path.wrapS(k * layer.every + (layer.arch ? 0 : rng() * layer.every * 0.7));
      path.sampleAt(s, frame);

      if (layer.arch) {
        // Straddling props sit on the centreline with their span across the
        // road. A Y-rotation by t maps local +X to (cos t, 0, -sin t), and the
        // span has to lie along the track's lateral axis, so t follows from
        // frame.side directly. Getting this backwards points the arch down the
        // road instead of over it, which looks like a bridge to nowhere.
        _p.copy(frame.pos);
        _q.setFromAxisAngle(_up, Math.atan2(-frame.side.z, frame.side.x));
        _s.set(1, 1, 1);
      } else {
        const side = rng() < 0.5 ? -1 : 1;
        // Squared distribution: most props hug the road, a few sit far out,
        // which is what gives a field depth instead of a wall.
        const t = rng() * rng();
        const lateral = layer.near + t * (layer.far - layer.near);
        const d = (frame.width * 0.5 + lateral) * side;
        _p.set(
          frame.pos.x + frame.side.x * d,
          layer.onRoad ? frame.pos.y : groundY,
          frame.pos.z + frame.side.z * d,
        );
        _q.setFromAxisAngle(_up, rng() * Math.PI * 2);
        const sc = sMin + Math.pow(rng(), 1.4) * (sMax - sMin);
        _s.set(sc, sc * (0.85 + rng() * 0.35), sc);
      }

      _m.compose(_p, _q, _s);
      mesh.setMatrixAt(placed, _m);
      _c.set(tints[Math.floor(rng() * tints.length)]);
      mesh.setColorAt(placed, _c);
      placed++;
    }

    mesh.count = placed;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    group.add(mesh);
    out.meshes.push(mesh);
  }

  // A sun sits at a fixed compass bearing and follows the camera, so it stays
  // on the horizon however far the circuit wanders. Drawn just after the sky
  // and never fogged, so haze cannot swallow it.
  if (env.sun) {
    const tex = sunTexture({ color: env.sun.color });
    const mat = new THREE.MeshBasicMaterial({
      map: tex, transparent: true, depthWrite: false, depthTest: false, fog: false,
    });
    const geo = new THREE.PlaneGeometry(env.sun.size, env.sun.size);
    const sun = new THREE.Mesh(geo, mat);
    sun.renderOrder = -950;
    sun.frustumCulled = false;
    sun.matrixAutoUpdate = false;
    sun.userData.sun = env.sun;
    group.add(sun);
    out.sun = sun;
    out.disposables.push(geo, mat);
  }

  return out;
}

/** Keep a sun pinned to its bearing on the horizon, facing the camera. */
export function updateSun(sun, camera) {
  if (!sun) return;
  const cfg = sun.userData.sun;
  const dist = 430;
  sun.position.set(
    camera.position.x + Math.cos(cfg.bearing) * dist,
    camera.position.y + cfg.height * dist,
    camera.position.z + Math.sin(cfg.bearing) * dist,
  );
  sun.quaternion.copy(camera.quaternion);
  sun.updateMatrix();
}
