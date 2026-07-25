import * as THREE from 'three';
import { TrackFrame } from './TrackPath.js';
import { trackAtlas, BAND, bandU } from './TrackAtlas.js';
import { boostTexture, rechargeTexture, dirtTexture, checkerTexture, glowTexture } from '../render/Textures.js';
import { SurfaceMap, SURFACE } from './SurfaceMap.js';

/**
 * TrackBuilder — turns a TrackPath plus a theme into renderable geometry.
 *
 * The road is emitted as chunks of fixed arc length. Chunking buys three things:
 * a tight bounding sphere per chunk so frustum culling actually works, the
 * ability to skip far chunks by arc-length distance before three.js even looks
 * at them, and UV magnitudes that restart near zero in every chunk instead of
 * climbing into the thousands where 32-bit varying interpolation starts to
 * visibly swim.
 *
 * The full cross-section — road, edge stripes, shoulders — is one interleaved
 * strip sharing the banded atlas, so a chunk is a single draw call.
 */

export { SURFACE, SURFACE_NAME } from './SurfaceMap.js';

// Cross-section, as offsets from the road edge in metres.
const STRIPE_W = 0.9;      // bright edge line
const SHOULDER_W = 3.4;    // dark band the edge markers sit on
const SHOULDER_DROP = 0.18; // outer shoulder edge sits slightly lower

const METRES_PER_TILE = 8;  // how much track one vertical repeat of the atlas covers

export class TrackMesh {
  /**
   * @param {import('./TrackPath.js').TrackPath} path
   * @param {object} theme
   * @param {Array<{type:string, from:number, to:number, dMin?:number, dMax?:number}>} zones
   *        `from`/`to` are fractions of a lap, so zones stay put if the control
   *        points are retuned and the circuit changes length.
   */
  constructor(path, theme, zones = []) {
    this.path = path;
    this.theme = theme;
    this.surfaces = new SurfaceMap(path, zones);
    this.zones = this.surfaces.zones;

    this.group = new THREE.Group();
    this.group.name = 'track';
    this.chunks = [];
    this._frame = new TrackFrame();
    this._disposables = [];

    this.chunkLength = 110;
    this.chunkCount = Math.max(1, Math.round(path.length / this.chunkLength));
    this.chunkLength = path.length / this.chunkCount;

    this._buildRoad();
    this._buildEdgeMarkers();
    this._buildZoneOverlays();
    this._buildStartLine();
  }

  // -------------------------------------------------------------------
  // Road ribbon
  // -------------------------------------------------------------------

  _buildRoad() {
    const tex = trackAtlas(this.theme.track);
    this._disposables.push(tex);
    const material = new THREE.MeshBasicMaterial({
      map: tex,
      fog: true,
      side: THREE.DoubleSide,   // banked and inverted sections must not vanish
    });
    this.roadMaterial = material;
    this._disposables.push(material);

    // ~2.2 m between cross-sections. Dense enough that banking reads as a
    // smooth curve, coarse enough that a whole circuit stays cheap.
    const stepEvery = Math.max(1, Math.round(2.2 / this.path.step));

    for (let c = 0; c < this.chunkCount; c++) {
      const s0 = c * this.chunkLength;
      const s1 = s0 + this.chunkLength;
      const geo = this._buildRoadChunk(s0, s1, stepEvery);
      const mesh = new THREE.Mesh(geo, material);
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      mesh.userData.chunkIndex = c;
      mesh.userData.sMid = (s0 + s1) * 0.5;
      this.group.add(mesh);
      this.chunks.push(mesh);
      this._disposables.push(geo);
    }
  }

  _buildRoadChunk(s0, s1, stepEvery) {
    const path = this.path;
    const step = path.step * stepEvery;
    // One extra row so neighbouring chunks share an exact seam.
    const rows = Math.max(2, Math.ceil((s1 - s0) / step) + 1);

    const LANES = 10;                  // see _emitRow
    const pos = new Float32Array(rows * LANES * 3);
    const uv = new Float32Array(rows * LANES * 2);
    const idx = [];
    const f = this._frame;

    for (let r = 0; r < rows; r++) {
      const s = Math.min(s1, s0 + r * step);
      path.sampleAt(s, f);
      this._emitRow(f, s, pos, uv, r * LANES);

      if (r > 0) {
        const a = (r - 1) * LANES;
        const b = r * LANES;
        // Five quad strips: shoulder-L, stripe-L, road, stripe-R, shoulder-R.
        for (let q = 0; q < 5; q++) {
          const i0 = a + q * 2, i1 = a + q * 2 + 1;
          const j0 = b + q * 2, j1 = b + q * 2 + 1;
          idx.push(i0, i1, j0, i1, j1, j0);
        }
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeBoundingSphere();
    return geo;
  }

  /**
   * Writes one cross-section. Lateral positions are duplicated at each band
   * boundary because the two sides of a boundary need different U coordinates.
   */
  _emitRow(f, s, pos, uv, base) {
    const hw = f.width * 0.5;
    const si = hw + STRIPE_W;
    const so = hw + STRIPE_W + SHOULDER_W;
    const v = s / METRES_PER_TILE;

    const lanes = [
      [-so, bandU(BAND.SHOULDER, 1), -SHOULDER_DROP],
      [-si, bandU(BAND.SHOULDER, 0), 0],
      [-si, bandU(BAND.STRIPE, 1), 0],
      [-hw, bandU(BAND.STRIPE, 0), 0],
      [-hw, bandU(BAND.ROAD, 0), 0],
      [hw, bandU(BAND.ROAD, 1), 0],
      [hw, bandU(BAND.STRIPE, 0), 0],
      [si, bandU(BAND.STRIPE, 1), 0],
      [si, bandU(BAND.SHOULDER, 0), 0],
      [so, bandU(BAND.SHOULDER, 1), -SHOULDER_DROP],
    ];

    for (let i = 0; i < lanes.length; i++) {
      const [d, u, h] = lanes[i];
      const p = (base + i) * 3;
      pos[p] = f.pos.x + f.side.x * d + f.up.x * h;
      pos[p + 1] = f.pos.y + f.side.y * d + f.up.y * h;
      pos[p + 2] = f.pos.z + f.side.z * d + f.up.z * h;
      const q = (base + i) * 2;
      uv[q] = u;
      uv[q + 1] = v;
    }
  }

  // -------------------------------------------------------------------
  // Edge markers — the glowing pods that line both shoulders
  // -------------------------------------------------------------------

  _buildEdgeMarkers() {
    const spacing = 7;
    const count = Math.floor(this.path.length / spacing) * 2;

    // A squashed low-poly dome. At the distances these are seen, six segments
    // is plenty, and it keeps a thousand of them under 20k triangles.
    const geo = new THREE.SphereGeometry(1, 6, 3);
    geo.scale(1.35, 0.55, 0.95);
    const mat = new THREE.MeshBasicMaterial({
      color: this.theme.markerColor ?? 0xff7a9c,
      fog: true,
    });
    this._disposables.push(geo, mat);

    const mesh = new THREE.InstancedMesh(geo, mat, count);
    mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    // Instances span the whole circuit, so a single bounding sphere would be
    // useless for culling and would only risk popping the entire set out of
    // view. Cheaper and safer to submit all of them; they are tiny.
    mesh.frustumCulled = false;

    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const scale = new THREE.Vector3(1, 1, 1);
    const posv = new THREE.Vector3();
    const basis = new THREE.Matrix4();
    const f = this._frame;
    let i = 0;

    for (let k = 0; k < count / 2; k++) {
      const s = k * spacing;
      this.path.sampleAt(s, f);
      const d = f.width * 0.5 + STRIPE_W + SHOULDER_W * 0.5;
      for (const sign of [-1, 1]) {
        posv.copy(f.pos).addScaledVector(f.side, d * sign).addScaledVector(f.up, 0.35);
        basis.makeBasis(f.side, f.up, f.tangent);
        q.setFromRotationMatrix(basis);
        m.compose(posv, q, scale);
        mesh.setMatrixAt(i++, m);
      }
    }
    mesh.count = i;
    mesh.instanceMatrix.needsUpdate = true;
    this.group.add(mesh);
    this.edgeMarkers = mesh;
  }

  // -------------------------------------------------------------------
  // Surface zones
  // -------------------------------------------------------------------

  _buildZoneOverlays() {
    const byType = new Map();
    for (const z of this.zones) {
      if (z.surface === SURFACE.ROAD) continue;
      if (!byType.has(z.surface)) byType.set(z.surface, []);
      byType.get(z.surface).push(z);
    }

    const texFor = {
      [SURFACE.BOOST]: () => boostTexture({ bg: this.theme.boostBg ?? 0x11203a }),
      [SURFACE.RECHARGE]: () => rechargeTexture(),
      [SURFACE.DIRT]: () => dirtTexture({ base: this.theme.dirt ?? 0x6b4a2f }),
      [SURFACE.ICE]: () => rechargeTexture({ bg: 0x14304a, a: 0x9fe8ff, b: 0xffffff }),
      [SURFACE.JUMP]: () => boostTexture({ bg: 0x2a1030, a: 0xff6ad5, b: 0xffffff }),
      // Mine fields get a hazard-marked floor; the mines themselves are
      // separate objects placed on top of it.
      [SURFACE.MINES]: () => dirtTexture({ base: 0x4a2038, dark: 0x1c0c1a, size: 32 }),
    };

    for (const [surface, list] of byType) {
      const tex = texFor[surface]?.();
      if (!tex) continue;
      const mat = new THREE.MeshBasicMaterial({
        map: tex,
        fog: true,
        side: THREE.DoubleSide,
        // The overlay sits a few centimetres above the road; polygon offset
        // stops the two coplanar-ish surfaces from z-fighting at distance.
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      });
      this._disposables.push(mat);

      const geos = [];
      for (const z of list) geos.push(this._buildZoneGeometry(z));
      const merged = mergeSimple(geos);
      geos.forEach((g) => g.dispose());
      if (!merged) continue;
      const mesh = new THREE.Mesh(merged, mat);
      mesh.matrixAutoUpdate = false;
      mesh.renderOrder = 1;
      this.group.add(mesh);
      this._disposables.push(merged);
    }
  }

  _buildZoneGeometry(z) {
    const path = this.path;
    const step = 2.0;
    const len = z.s1 - z.s0;
    const rows = Math.max(2, Math.ceil(len / step) + 1);
    const pos = new Float32Array(rows * 2 * 3);
    const uv = new Float32Array(rows * 2 * 2);
    const idx = [];
    const f = this._frame;

    for (let r = 0; r < rows; r++) {
      const s = z.s0 + Math.min(len, r * step);
      path.sampleAt(s, f);
      const hw = f.width * 0.5;
      const dMin = (z.dMin ?? -1) * hw;
      const dMax = (z.dMax ?? 1) * hw;
      const v = (s - z.s0) / 6;
      for (let i = 0; i < 2; i++) {
        const d = i === 0 ? dMin : dMax;
        const p = (r * 2 + i) * 3;
        pos[p] = f.pos.x + f.side.x * d + f.up.x * 0.06;
        pos[p + 1] = f.pos.y + f.side.y * d + f.up.y * 0.06;
        pos[p + 2] = f.pos.z + f.side.z * d + f.up.z * 0.06;
        const q = (r * 2 + i) * 2;
        uv[q] = i;
        uv[q + 1] = v;
      }
      if (r > 0) {
        const a = (r - 1) * 2, b = r * 2;
        idx.push(a, a + 1, b, a + 1, b + 1, b);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeBoundingSphere();
    return geo;
  }

  _buildStartLine() {
    const tex = checkerTexture({ size: 32, cell: 4 });
    const mat = new THREE.MeshBasicMaterial({
      map: tex, fog: true, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
    });
    this._disposables.push(mat);
    const geo = this._buildZoneGeometry({ s0: 0, s1: 6, dMin: -1, dMax: 1 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.matrixAutoUpdate = false;
    mesh.renderOrder = 2;
    this.group.add(mesh);
    this._disposables.push(geo);
  }

  // -------------------------------------------------------------------
  // Runtime
  // -------------------------------------------------------------------

  /**
   * Hide chunks that are too far along the track to matter. This runs before
   * three.js's own frustum culling and removes them from consideration
   * entirely, which matters more than the frustum test because most hidden
   * chunks are behind the camera in arc-length terms, not off to the side.
   */
  update(playerS, viewDistance = 460) {
    const L = this.path.length;
    const half = this.chunkLength * 0.5 + viewDistance;
    for (const chunk of this.chunks) {
      const d = Math.abs(ringDelta(playerS, chunk.userData.sMid, L));
      chunk.visible = d < half;
    }
  }

  /** Which surface is under a point in track space. */
  surfaceAt(s, d) {
    return this.surfaces.surfaceAt(s, d);
  }

  dispose() {
    for (const d of this._disposables) d.dispose?.();
    this._disposables.length = 0;
    this.group.clear();
  }
}

function ringDelta(a, b, m) {
  let d = ((b - a) % m + m) % m;
  if (d > m * 0.5) d -= m;
  return d;
}

/**
 * Minimal geometry merge for position+uv indexed geometries. three.js ships
 * BufferGeometryUtils for this, but pulling in the addon for one call would add
 * a chunk to the bundle for no benefit — these geometries all have identical,
 * known attribute layouts.
 */
function mergeSimple(geos) {
  const list = geos.filter((g) => g && g.getAttribute('position'));
  if (list.length === 0) return null;
  let vTotal = 0;
  let iTotal = 0;
  for (const g of list) {
    vTotal += g.getAttribute('position').count;
    iTotal += g.getIndex().count;
  }
  const pos = new Float32Array(vTotal * 3);
  const uv = new Float32Array(vTotal * 2);
  const idx = vTotal > 65535 ? new Uint32Array(iTotal) : new Uint16Array(iTotal);
  let vo = 0;
  let io = 0;
  for (const g of list) {
    const p = g.getAttribute('position');
    const u = g.getAttribute('uv');
    const i = g.getIndex();
    pos.set(p.array, vo * 3);
    uv.set(u.array, vo * 2);
    for (let k = 0; k < i.count; k++) idx[io + k] = i.array[k] + vo;
    vo += p.count;
    io += i.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  out.computeBoundingSphere();
  return out;
}
