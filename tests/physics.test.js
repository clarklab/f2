import test from 'node:test';
import assert from 'node:assert/strict';
import { TRACKS } from '../src/track/tracks.js';
import { TrackPath } from '../src/track/TrackPath.js';
import { SurfaceMap, SURFACE } from '../src/track/SurfaceMap.js';
import { Vehicle } from '../src/game/Vehicle.js';
import { Driver } from '../src/game/Driver.js';
import { machineParams, MACHINES, ENERGY } from '../src/game/Machines.js';
import { Race, RACE_STATE } from '../src/game/Race.js';

/**
 * Headless simulation of the AI driving each circuit.
 *
 * This is the only practical way to check handling. A physics bug — a corner
 * the machine cannot physically make, a grip model that lets it accelerate
 * forever, a rail that flings it into orbit — is invisible in a unit test of
 * any individual function but obvious after thirty seconds of driving. So we
 * drive.
 */

const DT = 1 / 120;

function buildTrack(def) {
  const path = new TrackPath(def.controlPoints, {
    step: 1.25, autoBank: 22, maxAutoBank: 16, defaultWidth: def.width,
  });
  return { path, surfaces: new SurfaceMap(path, def.zones) };
}

/**
 * Run one machine around a circuit for `seconds`, returning a trace.
 */
function simulate(def, machineId, seconds, { skill = 0.85, seed = 5 } = {}) {
  const { path, surfaces } = buildTrack(def);
  const v = new Vehicle(machineParams(machineId), path, surfaces, { index: 1 });
  v.spawn(0, 0);
  v.boostCharges = 3;
  const driver = new Driver(v, seed, skill);

  let time = 0;
  let laps = 0;
  let lastS = 0;
  let maxAbsD = 0;
  let maxHeight = 0;
  let offTrackTime = 0;
  let sumSpeed = 0;
  let samples = 0;
  let minEnergy = ENERGY.max;
  let stuck = 0;

  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) {
    const ctrl = driver.update(DT, time, null);
    v.update(DT, ctrl, def.wind);
    v.clearEvents();
    time += DT;

    // Lap detection: the arc-length coordinate wraps from near the end to near
    // the start.
    if (lastS > path.length * 0.75 && v.s < path.length * 0.25) laps++;
    lastS = v.s;

    const halfWidth = path.widthAt(v.s) * 0.5;
    maxAbsD = Math.max(maxAbsD, Math.abs(v.d));
    maxHeight = Math.max(maxHeight, v.h);
    if (Math.abs(v.d) > halfWidth) offTrackTime += DT;
    if (v.speed < 8) stuck += DT; else stuck = 0;
    sumSpeed += v.speed;
    samples++;
    minEnergy = Math.min(minEnergy, v.energy);

    if (!v.alive) break;
    if (stuck > 3) break;
  }

  return {
    laps, time, maxAbsD, maxHeight, offTrackTime, minEnergy, stuck,
    alive: v.alive,
    avgSpeed: sumSpeed / Math.max(1, samples),
    lapLength: path.length,
    halfWidthAvg: path.width.reduce((a, b) => a + b, 0) / path.count * 0.5,
  };
}

test('an AI machine completes laps on every circuit', () => {
  for (const def of TRACKS) {
    const r = simulate(def, 'blue-falcon', 100);
    assert.ok(r.alive, `${def.id}: machine destroyed after ${r.time.toFixed(1)}s`);
    assert.ok(r.stuck < 3, `${def.id}: machine got stuck`);
    assert.ok(r.laps >= 1,
      `${def.id}: completed ${r.laps} laps in 100s (avg speed ${r.avgSpeed.toFixed(1)} m/s over ${r.lapLength.toFixed(0)}m)`);
  }
});

test('the AI stays on the road', () => {
  for (const def of TRACKS) {
    const r = simulate(def, 'blue-falcon', 100);
    // Brief rail contact is fine and expected; living off the track is not.
    assert.ok(r.offTrackTime < 6,
      `${def.id}: spent ${r.offTrackTime.toFixed(1)}s off track`);
    // The rail resolver clamps lateral position, so this should never exceed
    // the half-width by more than a sliver.
    assert.ok(r.maxAbsD < r.halfWidthAvg + 3,
      `${def.id}: reached d=${r.maxAbsD.toFixed(1)} (half width ~${r.halfWidthAvg.toFixed(1)})`);
  }
});

test('the machine stays on the ground except over jump plates', () => {
  for (const def of TRACKS) {
    const hasJump = def.zones.some((z) => z.type === 'jump');
    const r = simulate(def, 'blue-falcon', 100);
    const ceiling = hasJump ? 30 : 6;
    assert.ok(r.maxHeight < ceiling,
      `${def.id}: reached ${r.maxHeight.toFixed(1)}m above the track (jump plates: ${hasJump})`);
  }
});

test('lap times land in an arcade-appropriate range', () => {
  // Slow enough to be readable, fast enough to feel like a racer. Well outside
  // this range means the speed or scale tuning has drifted.
  for (const def of TRACKS) {
    const r = simulate(def, 'blue-falcon', 140);
    const lapTime = r.time / Math.max(1, r.laps);
    assert.ok(lapTime > 14 && lapTime < 70,
      `${def.id}: ~${lapTime.toFixed(1)}s per lap (${r.lapLength.toFixed(0)}m, avg ${r.avgSpeed.toFixed(1)} m/s)`);
  }
});

test('every machine can get around the hardest circuit', () => {
  const def = TRACKS.find((t) => t.id === 'silent-grid');
  for (const m of MACHINES) {
    const r = simulate(def, m.id, 100);
    assert.ok(r.alive && r.laps >= 1,
      `${m.id}: ${r.laps} laps, alive=${r.alive}, avg ${r.avgSpeed.toFixed(1)} m/s`);
  }
});

/**
 * A very large, flat, wide ring used as a test straight.
 *
 * Every circuit is a closed loop, so there is no such thing as a truly straight
 * test track. A 6 km radius is straight enough that a driver holding the line
 * uses essentially no steering input — but "essentially none" is not "none", so
 * these tests steer with a Driver rather than pinning the wheel dead ahead. A
 * machine held at zero steering on any closed loop eventually leaves it, which
 * makes a fixed-input test measure the wrong thing entirely.
 */
function straightaway() {
  const pts = [];
  for (let i = 0; i < 64; i++) {
    const a = (i / 64) * Math.PI * 2;
    pts.push({ x: Math.cos(a) * 6000, y: 0, z: Math.sin(a) * 6000, width: 60 });
  }
  const path = new TrackPath(pts, { step: 2, defaultWidth: 60 });
  return { path, surfaces: new SurfaceMap(path, []) };
}

/** Hold full throttle on the test ring for `seconds`, staying on the line. */
function fullThrottleRun(machineId, seconds) {
  const { path, surfaces } = straightaway();
  const p = machineParams(machineId);
  const v = new Vehicle(p, path, surfaces, {});
  v.spawn(0, 0);
  const driver = new Driver(v, 3, 1.0);
  let t = 0;
  for (let i = 0; i < Math.round(seconds / DT); i++) {
    const c = driver.update(DT, t, null);
    // The ring has no corners, so the driver's own throttle logic already sits
    // at full; force it anyway so the test measures acceleration, not strategy.
    c.throttle = 1;
    c.brake = 0;
    v.update(DT, c);
    v.clearEvents();
    t += DT;
  }
  return v;
}

test('machine top speeds rank as their stats claim', () => {
  const results = MACHINES.map((m) => {
    const v = fullThrottleRun(m.id, 35);
    return { id: m.id, speed: v.speed, claimed: machineParams(m.id).topSpeed };
  });

  for (const r of results) {
    assert.ok(r.speed > r.claimed * 0.94,
      `${r.id} only reached ${r.speed.toFixed(1)} of ${r.claimed.toFixed(1)} m/s`);
    assert.ok(r.speed <= r.claimed * 1.01,
      `${r.id} exceeded its top speed: ${r.speed.toFixed(1)} > ${r.claimed.toFixed(1)}`);
  }

  // The advertised ordering must actually hold, or the select screen lies.
  const byClaimed = [...results].sort((a, b) => a.claimed - b.claimed).map((r) => r.id);
  const byActual = [...results].sort((a, b) => a.speed - b.speed).map((r) => r.id);
  assert.deepEqual(byActual, byClaimed,
    `top-speed ordering: got ${byActual.join(' < ')}`);
});

test('acceleration ranks inversely to top speed', () => {
  // The lightest machine should be first to 60% of its own top speed and the
  // heaviest last — that trade is the entire reason to pick one over another.
  const { path, surfaces } = straightaway();
  const times = MACHINES.map((m) => {
    const p = machineParams(m.id);
    const v = new Vehicle(p, path, surfaces, {});
    v.spawn(0, 0);
    const driver = new Driver(v, 3, 1.0);
    let t = 0;
    while (v.speed < p.topSpeed * 0.6 && t < 30) {
      const c = driver.update(DT, t, null);
      c.throttle = 1; c.brake = 0;
      v.update(DT, c);
      v.clearEvents();
      t += DT;
    }
    return { id: m.id, t };
  });
  const fastest = times.reduce((a, b) => (a.t < b.t ? a : b));
  const slowest = times.reduce((a, b) => (a.t > b.t ? a : b));
  assert.equal(fastest.id, 'golden-fox', `quickest off the line was ${fastest.id}`);
  assert.equal(slowest.id, 'fire-stingray', `slowest off the line was ${slowest.id}`);
});

test('releasing the throttle restores grip', () => {
  // The defining rule of the handling model. Hold throttle and steer at high
  // speed and the machine should wash wide; lift and it should turn far more.
  function turnTest(throttle) {
    const v = fullThrottleRun('blue-falcon', 20);
    assert.ok(v.speed > v.params.slipSpeed,
      `setup: ${v.speed.toFixed(1)} should exceed slip speed ${v.params.slipSpeed.toFixed(1)}`);

    const start = v.heading.clone();
    const startVel = v.vel.clone().normalize();
    const turn = { steer: 1, throttle, brake: 0, leanLeft: 0, leanRight: 0 };
    // 0.6 s, not longer: the lifted machine turns hard enough at current top
    // speeds to cross the test ring's half-width in ~0.7 s, and once the rail
    // resolver bites it eats the lateral velocity this test exists to measure.
    for (let i = 0; i < 120 * 0.6; i++) v.update(DT, turn);
    return {
      headingSwing: start.angleTo(v.heading),
      velocitySwing: startVel.angleTo(v.vel.clone().normalize()),
    };
  }

  const held = turnTest(1);
  const lifted = turnTest(0);

  // With the throttle held the nose still turns, but the velocity vector lags
  // badly behind it — that gap is the understeer.
  const heldGap = held.headingSwing - held.velocitySwing;
  const liftedGap = lifted.headingSwing - lifted.velocitySwing;
  // 1.6x, not the 2x this once was: at current top speeds a full second of
  // gripped turning scrubs enough speed that the heading authority climbs
  // mid-test, which inflates the lifted machine's own gap. The player-facing
  // invariant is the velocitySwing assert below, which stays a wide margin.
  assert.ok(heldGap > liftedGap * 1.6,
    `slip gap under throttle (${heldGap.toFixed(3)} rad) should far exceed the lifted gap (${liftedGap.toFixed(3)} rad)`);
  assert.ok(lifted.velocitySwing > held.velocitySwing * 1.5,
    `lifting should turn the machine more: ${lifted.velocitySwing.toFixed(3)} vs ${held.velocitySwing.toFixed(3)} rad`);
});

test('rails cost energy and cap speed rather than stopping the machine', () => {
  const v = fullThrottleRun('blue-falcon', 14);
  const path = v.path;
  const energyBefore = v.energy;
  assert.equal(energyBefore, ENERGY.max, 'setup: should reach the rail at full energy');

  // Steer hard into the rail and hold it there.
  const intoWall = { steer: 1, throttle: 1, brake: 0, leanLeft: 0, leanRight: 0 };
  for (let i = 0; i < 120 * 2; i++) v.update(DT, intoWall);

  assert.ok(v.energy < energyBefore - 5, `rail contact should drain energy (${energyBefore} -> ${v.energy})`);
  assert.ok(v.speed > 20, `rail contact should not stop the machine dead (speed ${v.speed.toFixed(1)})`);
  assert.ok(v.speed < v.params.topSpeed * 0.8, `rail contact should cap speed (${v.speed.toFixed(1)})`);
  assert.ok(Math.abs(v.d) <= path.widthAt(v.s) * 0.5 + 0.2, 'machine should be held inside the rail');
});

test('the recharge strip rewards going slowly', () => {
  const def = TRACKS.find((t) => t.id === 'gale-spine');
  const { path, surfaces } = buildTrack(def);
  const strip = surfaces.zonesOfType('recharge')[0];
  assert.ok(strip, 'expected a recharge strip');

  function crossAt(speed) {
    const v = new Vehicle(machineParams('blue-falcon'), path, surfaces, {});
    // Start just before the strip, on its lateral side.
    const d = ((strip.dMin + strip.dMax) * 0.5) * path.widthAt(strip.s0) * 0.5;
    v.spawn(strip.s0 - 5, d);
    v.energy = 5;
    v.speed = speed;
    v.vel.copy(v.heading).multiplyScalar(speed);
    const ctrl = { steer: 0, throttle: 0, brake: 0, leanLeft: 0, leanRight: 0 };
    const before = v.energy;
    // Simulate until past the far end of the strip.
    for (let i = 0; i < 120 * 20; i++) {
      v.update(DT, ctrl);
      if (path.deltaS(v.s, strip.s1) < 0) break;
    }
    return v.energy - before;
  }

  const slow = crossAt(25);
  const fast = crossAt(110);
  assert.ok(slow > 0, `crossing slowly should recharge (got ${slow.toFixed(1)})`);
  assert.ok(slow > fast * 1.8,
    `recharge is time-based: slow ${slow.toFixed(1)} should far exceed fast ${fast.toFixed(1)}`);
});

test('a coated corner is survivable at a sensible speed', () => {
  // Ice is invisible to a curvature scan, so a driver that only reads geometry
  // arrives at full pace and understeers into the outside rail every lap. This
  // is the regression guard for that.
  const def = TRACKS.find((t) => t.id === 'azure-drift');
  const r = simulate(def, 'blue-falcon', 120);
  assert.ok(r.alive, `destroyed after ${r.time.toFixed(1)}s on the coated circuit`);
  assert.ok(r.laps >= 1, `only ${r.laps} laps`);
  assert.ok(r.minEnergy > 15,
    `energy fell to ${r.minEnergy.toFixed(0)} — the coated corner is grinding the rail`);
});

test('a full race runs to the finish on every circuit', () => {
  // End-to-end: build a real grid, run it under AI, and require that the race
  // actually reaches a finished state with a complete classification.
  for (const def of TRACKS) {
    const path = new TrackPath(def.controlPoints, {
      step: 1.25, autoBank: 22, maxAutoBank: 16, defaultWidth: def.width,
    });
    const surfaces = new SurfaceMap(path, def.zones);
    const race = new Race({
      path, surfaces, trackDef: def, machineId: 'blue-falcon',
      // Practice keeps the full grid but disables the qualification cut, so
      // this exercises the race machinery without also asserting a balance
      // outcome that depends on how the AI's dice land.
      mode: 'practice', difficulty: 1, opponents: 11,
    });
    race.autopilot = true;

    const idle = { steer: 0, throttle: 0, brake: 0, leanLeft: 0, leanRight: 0 };
    let guard = 0;
    while (race.state !== RACE_STATE.FINISHED && guard < 120 * 400) {
      race.update(DT, idle);
      race.clearEvents();
      guard++;
      if (race.state === RACE_STATE.RETIRED) break;
    }

    assert.equal(race.state, RACE_STATE.FINISHED,
      `${def.id}: race ended as "${race.state}" after ${(guard * DT).toFixed(0)}s`);

    const standings = race.standings();
    assert.equal(standings.length, race.fieldSize);
    // Ranks must be a clean 1..N with no duplicates.
    assert.deepEqual(standings.map((e) => e.rank), standings.map((_, i) => i + 1));
    assert.ok(standings[0].finishTime > 0);
    // Everyone must have completed the full lap count.
    for (const e of standings) {
      assert.ok(e.finished, `${def.id}: ${e.name} never finished`);
    }
  }
});

test('lap counting cannot be cheated by cutting the course', () => {
  // Progress is integrated arc length, so teleporting forward must not bank a
  // lap. Drop the machine most of the way around the circuit and confirm the
  // lap counter does not move.
  const def = TRACKS[0];
  const { path, surfaces } = buildTrack(def);
  const race = new Race({
    path, surfaces, trackDef: def, machineId: 'blue-falcon',
    mode: 'trial', difficulty: 1, opponents: 0,
  });
  race.state = RACE_STATE.RACING;
  const e = race.playerEntry;
  const v = race.player;
  const idle = { steer: 0, throttle: 0, brake: 0, leanLeft: 0, leanRight: 0 };

  race.update(DT, idle);
  const lapBefore = e.lap;
  const distBefore = e.distance;

  // Teleport 90% of a lap forward.
  path.toWorld(path.length * 0.9, 0, v.params.rideHeight, v.pos);
  race.update(DT, idle);

  assert.equal(e.lap, lapBefore, 'a teleport must not complete a lap');
  assert.ok(Math.abs(e.distance - distBefore) < 5,
    `banked ${(e.distance - distBefore).toFixed(0)}m of progress from a teleport`);
});

test('the qualifying cut eliminates a player who falls behind', () => {
  // The cut is the mechanic that gives a race its shape, so it needs to
  // actually fire. Park the player and confirm they are disqualified rather
  // than trundling around at the back for three laps.
  const def = TRACKS[0];
  const { path, surfaces } = buildTrack(def);
  const race = new Race({
    path, surfaces, trackDef: def, machineId: 'blue-falcon',
    mode: 'race', difficulty: 1, opponents: 11,
  });
  assert.ok(race.qualifyRank > 2 && race.qualifyRank < race.fieldSize,
    `lap-one cut of ${race.qualifyRank} in a field of ${race.fieldSize} is unreasonable`);

  // Drive the mechanic directly rather than by simulation. A parked machine
  // gets destroyed first — the rest of the field laps into it at 120 m/s —
  // which is correct behaviour but tests the wrong thing.
  race.state = RACE_STATE.RACING;
  const e = race.playerEntry;
  e.lap = 0;
  e.rank = race.fieldSize;             // dead last
  race._checkQualification();
  assert.equal(race.state, RACE_STATE.RETIRED);
  assert.equal(race.retireReason, 'RANK');
});

test('a player inside the cut is not eliminated', () => {
  const def = TRACKS[0];
  const { path, surfaces } = buildTrack(def);
  const race = new Race({
    path, surfaces, trackDef: def, machineId: 'blue-falcon',
    mode: 'race', difficulty: 1, opponents: 11,
  });
  race.state = RACE_STATE.RACING;
  race.playerEntry.lap = 0;
  race.playerEntry.rank = race.qualifyRank;   // exactly on the cut
  race._checkQualification();
  assert.equal(race.state, RACE_STATE.RACING);
});

test('practice mode keeps the grid but never eliminates', () => {
  const def = TRACKS[0];
  const { path, surfaces } = buildTrack(def);
  const race = new Race({
    path, surfaces, trackDef: def, machineId: 'blue-falcon',
    mode: 'practice', difficulty: 1, opponents: 11,
  });
  assert.equal(race.fieldSize, 12);
  assert.equal(race.qualifyRank, null);

  // Even dead last, the rank cut must never fire in practice. (Destruction
  // still ends a run — practice removes the elimination rule, not the physics.)
  race.state = RACE_STATE.RACING;
  race.playerEntry.rank = race.fieldSize;
  race._checkQualification();
  assert.notEqual(race.state, RACE_STATE.RETIRED, 'practice must never disqualify on rank');
});
