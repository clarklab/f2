import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { TrackPath, TrackFrame } from '../src/track/TrackPath.js';
import { makeRng } from '../src/core/MathUtil.js';

/** A deliberately nasty loop: hills, varying width and heavy banking. */
function gnarlyOval() {
  const pts = [];
  const N = 16;
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    pts.push({
      x: Math.cos(a) * 200,
      y: Math.sin(a * 2) * 14,
      z: Math.sin(a) * 140,
      width: 24 + 8 * Math.sin(a * 3),
      bank: 18 * Math.sin(a),
    });
  }
  return new TrackPath(pts, { step: 1.25 });
}

test('frames stay orthonormal around the whole loop', () => {
  const tp = gnarlyOval();
  let maxOrtho = 0;
  let maxUnit = 0;
  for (let i = 0; i < tp.count; i++) {
    const t = new THREE.Vector3(tp.tx[i], tp.ty[i], tp.tz[i]);
    const u = new THREE.Vector3(tp.ux[i], tp.uy[i], tp.uz[i]);
    const s = new THREE.Vector3(tp.sx[i], tp.sy[i], tp.sz[i]);
    maxOrtho = Math.max(maxOrtho, Math.abs(t.dot(u)), Math.abs(t.dot(s)), Math.abs(u.dot(s)));
    maxUnit = Math.max(maxUnit, Math.abs(t.length() - 1), Math.abs(u.length() - 1), Math.abs(s.length() - 1));
  }
  assert.ok(maxOrtho < 1e-3, `orthogonality drift ${maxOrtho}`);
  assert.ok(maxUnit < 1e-3, `unit-length drift ${maxUnit}`);
});

test('the loop closes seamlessly in both position and roll', () => {
  const tp = gnarlyOval();
  const a = new TrackFrame();
  const b = new TrackFrame();
  tp.sampleAt(0, a);
  tp.sampleAt(tp.length - 0.001, b);
  assert.ok(a.pos.distanceTo(b.pos) < 0.01, 'position seam');
  // Without residual-twist correction this angle is typically many degrees and
  // the road mesh visibly tears at the start line.
  assert.ok(a.up.angleTo(b.up) < 0.01, 'roll seam');
});

test('samples are uniform in arc length, not curve parameter', () => {
  const tp = gnarlyOval();
  let mn = Infinity;
  let mx = -Infinity;
  for (let i = 0; i < tp.count; i++) {
    const j = (i + 1) % tp.count;
    const d = Math.hypot(tp.px[j] - tp.px[i], tp.py[j] - tp.py[i], tp.pz[j] - tp.pz[i]);
    mn = Math.min(mn, d);
    mx = Math.max(mx, d);
  }
  // Chord length is always slightly under arc length on curves; a few percent
  // spread is expected, an order of magnitude is not.
  assert.ok(mx / mn < 1.05, `spacing spread ${mn} .. ${mx}`);
});

/** Worst-case round-trip error of toWorld -> project for a given sample step. */
function roundTripError(step) {
  const pts = [];
  const N = 16;
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    pts.push({
      x: Math.cos(a) * 200, y: Math.sin(a * 2) * 14, z: Math.sin(a) * 140,
      width: 24 + 8 * Math.sin(a * 3), bank: 18 * Math.sin(a),
    });
  }
  const tp = new TrackPath(pts, { step });
  const rng = makeRng(7);
  const w = new THREE.Vector3();
  const out = {};
  let s_ = 0, d_ = 0, h_ = 0;
  for (let k = 0; k < 3000; k++) {
    const s = rng() * tp.length;
    const d = (rng() * 2 - 1) * 10;
    const h = rng() * 4;
    tp.toWorld(s, d, h, w);
    tp.project(w.x, w.y, w.z, null, out);
    s_ = Math.max(s_, Math.abs(tp.deltaS(s, out.s)));
    d_ = Math.max(d_, Math.abs(out.d - d));
    h_ = Math.max(h_, Math.abs(out.h - h));
  }
  return { s: s_, d: d_, h: h_ };
}

test('project() inverts toWorld() to within the sampling resolution', () => {
  const step = 1.25;
  const e = roundTripError(step);
  // The sample table is a polyline, so `s` can only ever be resolved to a
  // fraction of the step; lateral and height error come from interpolating the
  // frame across a banking change. Both are far below anything a 24 m wide
  // road cares about.
  assert.ok(e.s < step * 0.1, `arc-length error ${e.s} vs step ${step}`);
  assert.ok(e.d < 0.01, `lateral error ${e.d}`);
  assert.ok(e.h < 0.01, `height error ${e.h}`);
});

test('round-trip error converges as the sample step shrinks', () => {
  // Guards against a future "optimisation" that trades accuracy for speed
  // silently: error must actually track the discretisation, not plateau at
  // some floor that would indicate a real bug.
  const coarse = roundTripError(2.5);
  const fine = roundTripError(0.625);
  assert.ok(fine.s < coarse.s * 0.4, `s error ${coarse.s} -> ${fine.s}`);
  assert.ok(fine.d < coarse.d * 0.5, `d error ${coarse.d} -> ${fine.d}`);
});

test('hinted projection agrees with the grid search', () => {
  const tp = gnarlyOval();
  const rng = makeRng(11);
  const w = new THREE.Vector3();
  let worst = 0;
  for (let k = 0; k < 3000; k++) {
    const s = rng() * tp.length;
    const d = (rng() * 2 - 1) * 10;
    tp.toWorld(s, d, 1, w);
    const o1 = {};
    const o2 = {};
    tp.project(w.x, w.y, w.z, null, o1);
    tp.project(w.x, w.y, w.z, s + (rng() * 2 - 1) * 8, o2);
    worst = Math.max(worst, Math.abs(o1.d - o2.d), Math.abs(tp.deltaS(o1.s, o2.s)));
  }
  assert.ok(worst < 0.05, `hint disagreement ${worst}`);
});

test('curvature matches a known circle', () => {
  const pts = [];
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    pts.push({ x: Math.cos(a) * 100, y: 0, z: Math.sin(a) * 100 });
  }
  const tp = new TrackPath(pts, { step: 1 });
  assert.ok(Math.abs(tp.length - 2 * Math.PI * 100) < 2, `length ${tp.length}`);
  let acc = 0;
  for (let i = 0; i < tp.count; i++) acc += Math.abs(tp.curvature[i]);
  const mean = acc / tp.count;
  assert.ok(Math.abs(mean - 0.01) < 0.0015, `mean curvature ${mean} expected ~0.01`);
});

test('hinted projection is fast enough for a full grid every tick', () => {
  const tp = gnarlyOval();
  const o = {};
  const t0 = performance.now();
  const ITER = 200000;
  for (let k = 0; k < ITER; k++) {
    tp.project(50 + (k % 37), 2, 20 + (k % 53), (k * 0.37) % tp.length, o);
  }
  const ms = performance.now() - t0;
  // 20 racers at 60 Hz is 1200 calls/second; this budget is enormously
  // conservative but catches accidental O(n) regressions in the hint path.
  assert.ok(ms < 4000, `200k projections took ${ms.toFixed(0)}ms`);
});
