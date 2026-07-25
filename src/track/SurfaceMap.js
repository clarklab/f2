import { makeRng } from '../core/MathUtil.js';

/**
 * SurfaceMap — "what am I driving on at (s, d)?"
 *
 * Kept separate from TrackMesh so the physics can be exercised headlessly. The
 * mesh builder needs a DOM to rasterise its textures; the simulation needs
 * none of that, and the two should not be welded together just because they
 * read the same zone list.
 *
 * Zones are bucketed by arc length so a lookup touches only the handful that
 * could possibly overlap the query, rather than every zone on the circuit.
 */

export const SURFACE = {
  ROAD: 0,
  BOOST: 1,
  RECHARGE: 2,
  DIRT: 3,
  ICE: 4,
  JUMP: 5,
  MINES: 6,
};

export const SURFACE_NAME = ['ROAD', 'BOOST', 'RECHARGE', 'DIRT', 'ICE', 'JUMP', 'MINES'];

const BUCKET = 40;   // metres per bucket

export class SurfaceMap {
  /**
   * @param {import('./TrackPath.js').TrackPath} path
   * @param {Array<{type:string, from:number, to:number, dMin?:number, dMax?:number}>} zones
   *        `from`/`to` are fractions of a lap.
   */
  constructor(path, zones = []) {
    this.path = path;
    this.zones = zones.map((z) => ({
      type: z.type,
      surface: SURFACE[z.type.toUpperCase()] ?? SURFACE.ROAD,
      s0: z.from * path.length,
      s1: z.to * path.length,
      dMin: z.dMin ?? -1,
      dMax: z.dMax ?? 1,
    }));

    this.bucketCount = Math.max(1, Math.ceil(path.length / BUCKET));
    this.buckets = Array.from({ length: this.bucketCount }, () => []);
    for (let i = 0; i < this.zones.length; i++) {
      const z = this.zones[i];
      const b0 = Math.floor(z.s0 / BUCKET);
      const b1 = Math.floor(z.s1 / BUCKET);
      for (let b = b0; b <= b1; b++) {
        this.buckets[b % this.bucketCount].push(i);
      }
    }
  }

  /**
   * @param {number} s arc length
   * @param {number} d lateral offset in metres
   */
  surfaceAt(s, d) {
    const path = this.path;
    s = path.wrapS(s);
    const halfWidth = path.widthAt(s) * 0.5 || 1;
    const nd = d / halfWidth;
    const bucket = this.buckets[Math.floor(s / BUCKET) % this.bucketCount];
    for (let k = 0; k < bucket.length; k++) {
      const z = this.zones[bucket[k]];
      if (s < z.s0 || s > z.s1) continue;
      if (nd < z.dMin || nd > z.dMax) continue;
      return z.surface;
    }
    return SURFACE.ROAD;
  }

  /** All zones of a given type, for placing props like mines. */
  zonesOfType(type) {
    return this.zones.filter((z) => z.type === type);
  }
}

/**
 * MineField — discrete mines generated deterministically from the mine zones.
 *
 * Mines are objects rather than a surface property because they need to be hit
 * once, disappear, and be drawn individually. Placement is seeded, so the same
 * circuit always has the same minefield and a player can learn it.
 *
 * The zone's lateral range is what leaves a clean lane: a field declared over
 * `dMin: -0.45, dMax: 1.0` fills the right-hand three quarters of the road and
 * leaves a threadable gap hard against the left rail. That is deliberate — a
 * minefield with no line through it is a toll, not a decision.
 */
export class MineField {
  constructor(path, zones, seed = 99) {
    this.path = path;
    this.mines = [];
    const rng = makeRng(seed);

    for (const z of zones) {
      if (z.surface !== SURFACE.MINES) continue;
      const spacing = 11;
      const rows = Math.max(1, Math.floor((z.s1 - z.s0) / spacing));
      for (let r = 0; r <= rows; r++) {
        const s = z.s0 + (r / Math.max(1, rows)) * (z.s1 - z.s0);
        const halfWidth = path.widthAt(s) * 0.5;
        const lo = z.dMin * halfWidth;
        const hi = z.dMax * halfWidth;
        const count = Math.max(1, Math.round((hi - lo) / 7));
        for (let i = 0; i < count; i++) {
          // Stagger alternate rows so there is no straight corridor through the
          // field other than the one the zone bounds deliberately leave open.
          const t = (i + 0.5 + (r % 2 ? 0.5 : 0)) / count;
          if (t > 1) continue;
          this.mines.push({
            s,
            d: lo + (hi - lo) * t + (rng() - 0.5) * 1.5,
            alive: true,
          });
        }
      }
    }

    // Bucketed by arc length so a hit test touches only nearby mines.
    this.bucketCount = Math.max(1, Math.ceil(path.length / BUCKET));
    this.buckets = Array.from({ length: this.bucketCount }, () => []);
    this.mines.forEach((m, i) => {
      this.buckets[Math.floor(m.s / BUCKET) % this.bucketCount].push(i);
    });
  }

  /** Index of a live mine within `radius` of (s, d), or -1. */
  hit(s, d, radius = 3.2) {
    const b = Math.floor(this.path.wrapS(s) / BUCKET) % this.bucketCount;
    for (let k = -1; k <= 1; k++) {
      const bucket = this.buckets[((b + k) % this.bucketCount + this.bucketCount) % this.bucketCount];
      for (let i = 0; i < bucket.length; i++) {
        const m = this.mines[bucket[i]];
        if (!m.alive) continue;
        const ds = this.path.deltaS(s, m.s);
        const dd = d - m.d;
        if (ds * ds + dd * dd < radius * radius) return bucket[i];
      }
    }
    return -1;
  }

  reset() {
    for (const m of this.mines) m.alive = true;
  }
}
