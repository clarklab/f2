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
