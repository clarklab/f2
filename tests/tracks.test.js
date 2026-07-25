import test from 'node:test';
import assert from 'node:assert/strict';
import { TRACKS, THEMES } from '../src/track/tracks.js';
import { TrackPath } from '../src/track/TrackPath.js';

/**
 * Geometry validation for every authored circuit.
 *
 * Bad track geometry is miserable to debug visually — a road that folds through
 * itself on a hairpin looks like a rendering bug, and a circuit that passes
 * within a car's width of itself looks like a physics bug. Catching both here
 * costs milliseconds.
 */

const VALID_ZONES = new Set(['boost', 'recharge', 'dirt', 'ice', 'jump', 'mines']);
const SHOULDER_TOTAL = 4.3;   // stripe + shoulder, from TrackBuilder

const built = TRACKS.map((def) => ({
  def,
  path: new TrackPath(def.controlPoints, { step: 1.25, autoBank: 260 }),
}));

test('every track references a theme that exists', () => {
  for (const { def } of built) {
    assert.ok(THEMES[def.theme], `${def.id} -> unknown theme ${def.theme}`);
  }
});

test('track ids are unique', () => {
  const ids = TRACKS.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('circuits are a sensible length', () => {
  for (const { def, path } of built) {
    assert.ok(path.length > 600 && path.length < 5000,
      `${def.id} is ${path.length.toFixed(0)}m`);
  }
});

test('no corner is tighter than the road is wide', () => {
  // If the radius of curvature drops below the half-width of the ribbon, the
  // inner edge of the road turns inside out and the mesh self-folds.
  for (const { def, path } of built) {
    let worst = Infinity;
    let worstAt = 0;
    for (let i = 0; i < path.count; i++) {
      const k = Math.abs(path.curvature[i]);
      if (k < 1e-6) continue;
      const radius = 1 / k;
      const need = path.width[i] * 0.5 + SHOULDER_TOTAL;
      const ratio = radius / need;
      if (ratio < worst) { worst = ratio; worstAt = i * path.step; }
    }
    assert.ok(worst > 1.25,
      `${def.id}: radius/half-width = ${worst.toFixed(2)} at s=${worstAt.toFixed(0)}m`);
  }
});

test('the circuit never passes through itself', () => {
  // Compare every pair of samples that are far apart along the track but close
  // together in space. Anything closer than both half-widths combined would
  // overlap on screen and confuse track-space projection.
  for (const { def, path } of built) {
    const stride = Math.max(1, Math.round(3 / path.step));
    let worstGap = Infinity;
    let where = null;
    for (let i = 0; i < path.count; i += stride) {
      for (let j = i + stride; j < path.count; j += stride) {
        const alongTrack = Math.abs(path.deltaS(i * path.step, j * path.step));
        if (alongTrack < 90) continue;   // neighbours along the ribbon are fine
        const dx = path.px[i] - path.px[j];
        const dy = path.py[i] - path.py[j];
        const dz = path.pz[i] - path.pz[j];
        const dist = Math.hypot(dx, dy, dz);
        const need = (path.width[i] + path.width[j]) * 0.5 + SHOULDER_TOTAL * 2;
        const gap = dist - need;
        if (gap < worstGap) { worstGap = gap; where = [i * path.step, j * path.step]; }
      }
    }
    assert.ok(worstGap > 0,
      `${def.id}: sections overlap by ${(-worstGap).toFixed(1)}m near s=${where?.[0].toFixed(0)} and ${where?.[1].toFixed(0)}`);
  }
});

test('elevation changes are drivable', () => {
  for (const { def, path } of built) {
    let steepest = 0;
    let at = 0;
    for (let i = 0; i < path.count; i++) {
      const grade = Math.abs(path.ty[i]);   // sin of the pitch angle
      if (grade > steepest) { steepest = grade; at = i * path.step; }
    }
    assert.ok(steepest < 0.42,
      `${def.id}: ${(Math.asin(steepest) * 180 / Math.PI).toFixed(0)}deg gradient at s=${at.toFixed(0)}m`);
  }
});

test('zones are well formed and inside the lap', () => {
  for (const { def } of built) {
    for (const z of def.zones) {
      assert.ok(VALID_ZONES.has(z.type), `${def.id}: unknown zone type "${z.type}"`);
      assert.ok(z.from >= 0 && z.to <= 1, `${def.id}: zone ${z.type} outside 0..1`);
      assert.ok(z.to > z.from, `${def.id}: zone ${z.type} is inverted or empty`);
      const dMin = z.dMin ?? -1;
      const dMax = z.dMax ?? 1;
      assert.ok(dMin >= -1 && dMax <= 1 && dMax > dMin,
        `${def.id}: zone ${z.type} has a bad lateral range`);
    }
  }
});

test('zones of the same type do not overlap each other', () => {
  for (const { def } of built) {
    const byType = new Map();
    for (const z of def.zones) {
      if (!byType.has(z.type)) byType.set(z.type, []);
      byType.get(z.type).push(z);
    }
    for (const [type, list] of byType) {
      list.sort((a, b) => a.from - b.from);
      for (let i = 1; i < list.length; i++) {
        assert.ok(list[i].from >= list[i - 1].to,
          `${def.id}: two "${type}" zones overlap at ${list[i].from}`);
      }
    }
  }
});

test('every circuit has somewhere to recharge', () => {
  // Without a pit strip the energy economy has no counterweight and long
  // circuits become unwinnable rather than difficult.
  for (const { def } of built) {
    assert.ok(def.zones.some((z) => z.type === 'recharge'),
      `${def.id} has no recharge strip`);
  }
});

test('the start line is clear of hazards', () => {
  // Cars are placed in a grid behind s=0; spawning them on a mine field or a
  // patch of ice would be a cruel joke.
  for (const { def, path } of built) {
    const gridStart = 1 - (140 / path.length);
    for (const z of def.zones) {
      if (z.type === 'boost' || z.type === 'recharge') continue;
      const overlapsStart = z.from < 0.04 || z.to > gridStart;
      assert.ok(!overlapsStart,
        `${def.id}: "${z.type}" zone at ${z.from}..${z.to} sits on the starting grid`);
    }
  }
});
