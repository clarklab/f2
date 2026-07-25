/**
 * LoopBuilder — a small turtle language for authoring closed circuits.
 *
 * Writing a racetrack as raw control-point coordinates is deceptively hard: the
 * shape is easy, but making the last point flow smoothly back into the first is
 * not, and getting it wrong produces a fold-back at the start line that reads as
 * a rendering bug rather than a data error.
 *
 * Instead a track is described the way a driver would describe it — "220 metres
 * straight, 45 degrees right at a 150 metre radius" — and this turns that into
 * control points. Two properties make it reliable:
 *
 *  1. The total turn must sum to exactly +/-360 degrees, which is asserted. A
 *     closed loop cannot do anything else, so a typo in a corner angle is
 *     caught immediately rather than becoming a mystery kink.
 *
 *  2. Any residual positional gap is closed by distributing the error along the
 *     loop in proportion to arc length. Because the heading already matches, the
 *     gap is small, and spreading it out is invisible — far better than leaving
 *     a discontinuity at one point.
 *
 * Segments can be named, and zones then reference a segment by name instead of
 * a hard-coded lap fraction. Retuning a corner therefore moves the boost pad
 * that sits on it, rather than silently sliding it into the next corner.
 */

const DEG = Math.PI / 180;

/**
 * @param {Array<object>} segments
 *   Straight: `{ s: metres }`
 *   Turn:     `{ turn: degrees, r: radius }`  (positive = right)
 *   Both accept `y` (elevation at the end of the segment, metres),
 *   `w` (road width at the end of the segment) and `name`.
 * @param {{spacing?:number, width?:number}} [opts]
 * @returns {{points: Array, segments: Map<string,{from:number,to:number}>, length: number}}
 */
export function loop(segments, opts = {}) {
  const spacing = opts.spacing ?? 34;
  const baseWidth = opts.width ?? 26;

  let totalTurn = 0;
  for (const seg of segments) totalTurn += seg.turn ?? 0;
  const closed = Math.abs(Math.abs(totalTurn) - 360) < 1e-6;
  if (!closed) {
    throw new Error(
      `loop(): segment turns sum to ${totalTurn} degrees, must be exactly +/-360. ` +
      `A closed circuit turns through one full revolution.`,
    );
  }

  // --- walk the turtle -------------------------------------------------
  let x = 0;
  let z = 0;
  let heading = 0;            // 0 = +Z; increasing = turning right (toward +X)
  let dist = 0;
  let y = 0;
  let width = baseWidth;

  const pts = [];             // {x, z, y, width, s}
  const ranges = new Map();

  const push = (px, pz, s) => pts.push({ x: px, z: pz, y: 0, width: 0, s });

  for (const seg of segments) {
    const startS = dist;

    if (seg.turn) {
      const sgn = Math.sign(seg.turn);
      const sweep = Math.abs(seg.turn) * DEG;
      const r = seg.r ?? 100;
      const arc = r * sweep;

      // Centre of the turn: to the driver's right for a right-hander.
      const rx = Math.cos(heading);
      const rz = -Math.sin(heading);
      const cx = x + sgn * r * rx;
      const cz = z + sgn * r * rz;

      // Sample often enough that Catmull-Rom through the points reproduces a
      // true arc rather than cutting the corner.
      const steps = Math.max(2, Math.ceil(Math.max(arc / spacing, sweep / (12 * DEG))));
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const phi = heading + sgn * sweep * t;
        const px = cx - sgn * r * Math.cos(phi);
        const pz = cz + sgn * r * Math.sin(phi);
        push(px, pz, dist + arc * t);
      }
      heading += sgn * sweep;
      x = cx - sgn * r * Math.cos(heading);
      z = cz + sgn * r * Math.sin(heading);
      dist += arc;
    } else {
      const len = seg.s ?? 0;
      const dx = Math.sin(heading);
      const dz = Math.cos(heading);
      const steps = Math.max(1, Math.round(len / spacing));
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        push(x + dx * len * t, z + dz * len * t, dist + len * t);
      }
      x += dx * len;
      z += dz * len;
      dist += len;
    }

    if (seg.name) ranges.set(seg.name, { from: startS, to: dist });

    // Elevation and width are held as targets reached by the end of the
    // segment, and resolved by interpolation in the pass below.
    seg._endS = dist;
    seg._y = seg.y ?? y;
    seg._w = seg.w ?? width;
    y = seg._y;
    width = seg._w;
  }

  const total = dist;

  // --- rotate so the emitted list starts at the origin ------------------
  // The turtle emits its first point one step in; shift so index 0 is the
  // true start of the lap.
  pts.unshift({ x: 0, z: 0, y: 0, width: 0, s: 0 });

  // --- close the loop ---------------------------------------------------
  // Heading already matches by construction, so only position can drift, and
  // only by accumulated floating-point error plus whatever the author's radii
  // did not quite reconcile. Spread it along the lap.
  const last = pts[pts.length - 1];
  const gapX = 0 - last.x;
  const gapZ = 0 - last.z;
  const gapLen = Math.hypot(gapX, gapZ);
  for (const p of pts) {
    const f = p.s / total;
    p.x += gapX * f;
    p.z += gapZ * f;
  }

  // --- resolve elevation and width --------------------------------------
  let prevS = 0;
  let prevY = segments[segments.length - 1]._y ?? 0;
  let prevW = segments[segments.length - 1]._w ?? baseWidth;
  const keyY = [{ s: 0, y: prevY, w: prevW }];
  for (const seg of segments) {
    keyY.push({ s: seg._endS, y: seg._y, w: seg._w });
    prevS = seg._endS;
  }
  for (const p of pts) {
    let a = keyY[0];
    let b = keyY[keyY.length - 1];
    for (let i = 0; i < keyY.length - 1; i++) {
      if (p.s >= keyY[i].s && p.s <= keyY[i + 1].s) { a = keyY[i]; b = keyY[i + 1]; }
    }
    const span = b.s - a.s || 1;
    let t = (p.s - a.s) / span;
    t = t * t * (3 - 2 * t);          // ease so grades blend instead of kinking
    p.y = a.y + (b.y - a.y) * t;
    p.width = a.w + (b.w - a.w) * t;
  }

  // The final point sits a hair short of the start; drop it so Catmull-Rom
  // does not see two nearly-coincident control points, which would produce a
  // tiny high-curvature spike right on the start line.
  if (pts.length > 2) {
    const dEnd = Math.hypot(pts[pts.length - 1].x, pts[pts.length - 1].z);
    if (dEnd < spacing * 0.5) pts.pop();
  }

  return {
    points: pts.map((p) => ({ x: p.x, y: p.y, z: p.z, width: p.width })),
    segments: ranges,
    length: total,
    closureGap: gapLen,
  };
}

/**
 * Resolve zone definitions that reference named segments into lap fractions.
 * `{ seg: 'backstretch', at: [0.3, 0.6] }` means "the middle of the back
 * straight", and stays correct if the straight's length changes.
 */
export function resolveZones(zones, built) {
  return zones.map((z) => {
    if (z.seg === undefined) return z;
    const range = built.segments.get(z.seg);
    if (!range) throw new Error(`resolveZones(): no segment named "${z.seg}"`);
    const [a, b] = z.at ?? [0, 1];
    const s0 = range.from + (range.to - range.from) * a;
    const s1 = range.from + (range.to - range.from) * b;
    const out = { ...z, from: s0 / built.length, to: s1 / built.length };
    delete out.seg;
    delete out.at;
    return out;
  });
}
