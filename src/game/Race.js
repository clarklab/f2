import * as THREE from 'three';
import { Vehicle } from './Vehicle.js';
import { Driver, PILOTS } from './Driver.js';
import { machineParams, MACHINES, BOOST, ENERGY } from './Machines.js';
import { MineField } from '../track/SurfaceMap.js';
import { makeRng, clamp, clamp01 } from '../core/MathUtil.js';

/**
 * Race — the director. Owns the grid, the clock, lap validation, ranking and
 * the qualification cut.
 *
 * Lap counting works on accumulated arc length rather than on crossing a line.
 * Every tick the machine's signed progress along the track is added to a
 * running total, so a lap is complete when you have genuinely travelled a lap's
 * worth of road. That makes cutting the course impossible by construction: you
 * cannot bank distance you did not cover, and driving backwards subtracts. A
 * line-crossing test would need a separate checkpoint system bolted on to
 * achieve the same thing, and would still be vulnerable to tunnelling at
 * 130 m/s.
 *
 * The qualification cut is the mechanic that gives a race its shape. You are
 * not racing the leader, you are racing a deadline that tightens every lap, and
 * on the last lap it demands a podium.
 */

export const RACE_STATE = {
  COUNTDOWN: 'countdown',
  RACING: 'racing',
  FINISHED: 'finished',
  RETIRED: 'retired',
};

/**
 * The qualifying cut, as a fraction of the field, tightening each lap.
 *
 * Stored as a proportion rather than an absolute rank because the field size
 * varies by mode. Clamping an absolute rank to `fieldSize - 1` — as an earlier
 * version did — collapses the lap-one cut to "do not be last" in a small field,
 * which disqualifies a back-of-the-grid start before the first corner.
 */
const QUALIFY_FRACTION = [0.85, 0.62, 0.45, 0.32, 0.2];

/** Championship points, by finishing position. */
const POINTS = [100, 76, 58, 44, 34, 26, 20, 15, 11, 8, 6, 4, 3, 2, 1];

const _v = new THREE.Vector3();

export class Race {
  /**
   * @param {object} opts
   *   path, surfaces, trackDef, machineId, opponents, laps, difficulty, mode
   */
  constructor(opts) {
    this.path = opts.path;
    this.surfaces = opts.surfaces;
    this.trackDef = opts.trackDef;
    this.laps = opts.laps ?? this.trackDef.laps ?? 3;
    this.mode = opts.mode ?? 'gp';          // 'gp' | 'race' | 'trial' | 'practice'
    this.difficulty = opts.difficulty ?? 1;  // 0 novice, 1 standard, 2 expert
    this.spares = opts.spares ?? 2;

    this.mines = new MineField(this.path, this.surfaces.zones, 99);

    this.time = 0;
    this.countdown = 3.6;
    this.state = RACE_STATE.COUNTDOWN;
    this.events = [];                       // consumed by audio/UI each frame

    this.vehicles = [];
    this.drivers = [];
    this.entries = [];

    this._buildGrid(opts);
    this._rankScratch = [];
  }

  _buildGrid(opts) {
    const rng = makeRng(20260725);
    // Time Trial is genuinely solo. Practice keeps the full grid but drops the
    // qualification cut, which makes it useful for learning a circuit under
    // race conditions rather than a lonely lap around an empty track.
    const fieldSize = this.mode === 'trial' ? 1 : (opts.opponents ?? 11) + 1;

    // The player starts at the back. Working forward through a field is more
    // satisfying than defending a lead, and it makes the qualification cut
    // matter from the first corner.
    for (let i = 0; i < fieldSize; i++) {
      const isPlayer = i === fieldSize - 1;
      const machine = isPlayer
        ? MACHINES.find((m) => m.id === opts.machineId) ?? MACHINES[0]
        : MACHINES[Math.floor(rng() * MACHINES.length)];

      const v = new Vehicle(machineParams(machine.id), this.path, this.surfaces, {
        isPlayer,
        index: i,
        name: isPlayer ? 'YOU' : PILOTS[i % PILOTS.length],
      });

      // Two-abreast grid, staggered, running back from the line.
      const row = Math.floor(i / 2);
      const side = i % 2 === 0 ? -1 : 1;
      const halfWidth = this.path.widthAt(0) * 0.5;
      const s = this.path.wrapS(-14 - row * 11);
      v.spawn(s, side * halfWidth * 0.34);

      this.vehicles.push(v);

      if (isPlayer) {
        // A driver is built for the player too. It is unused during normal
        // play, but it powers the attract-mode demo on the title screen and
        // makes it possible to exercise a full race headlessly.
        this.playerDriver = new Driver(v, 7, 0.88);
      }

      if (!isPlayer) {
        // Skill spreads across the grid so the front runners are genuinely
        // quicker, and rises with difficulty.
        const base = [0.62, 0.76, 0.9][clamp(this.difficulty, 0, 2)];
        const spread = 0.16;
        const skill = clamp01(base + spread * (1 - i / fieldSize) - rng() * 0.08);
        this.drivers.push(new Driver(v, 1000 + i * 37, skill));
      } else {
        this.drivers.push(null);
        this.player = v;
      }

      this.entries.push({
        vehicle: v,
        machine,
        name: isPlayer ? 'YOU' : PILOTS[i % PILOTS.length],
        isPlayer,
        // Unwrapped distance travelled; the single source of truth for both
        // lap count and race order.
        distance: 0,
        lap: 0,
        rank: i + 1,
        lapTimes: [],
        lastLapStart: 0,
        finished: false,
        finishTime: 0,
        retired: false,
        points: 0,
      });
    }

    this.playerEntry = this.entries.find((e) => e.isPlayer);
    this.fieldSize = fieldSize;
    this._lastS = this.vehicles.map((v) => v.s);
  }

  get bestLap() {
    let best = Infinity;
    for (const t of this.playerEntry.lapTimes) best = Math.min(best, t);
    return isFinite(best) ? best : null;
  }

  get currentLapTime() {
    return this.time - this.playerEntry.lastLapStart;
  }

  /** Rank the player must be holding at the end of the current lap. */
  get qualifyRank() {
    if (this.mode === 'trial' || this.mode === 'practice') return null;
    if (this.fieldSize < 4) return null;
    const idx = clamp(this.playerEntry.lap, 0, QUALIFY_FRACTION.length - 1);
    // Novice gives one extra place of slack at every stage.
    const slack = this.difficulty === 0 ? 1 : 0;
    return clamp(Math.round(this.fieldSize * QUALIFY_FRACTION[idx]) + slack,
      2, this.fieldSize - 1);
  }

  emit(type, data) {
    this.events.push({ type, ...data });
  }

  clearEvents() {
    this.events.length = 0;
  }

  /**
   * @param {number} dt fixed timestep
   * @param {object} playerCtrl controls from Input
   */
  update(dt, playerCtrl) {
    if (this.state === RACE_STATE.COUNTDOWN) {
      const before = Math.ceil(this.countdown);
      this.countdown -= dt;
      const after = Math.ceil(this.countdown);
      if (after !== before && after >= 0) this.emit('countdown', { n: after });
      if (this.countdown <= 0) {
        this.state = RACE_STATE.RACING;
        this.emit('go');
      }
      // Machines are held on the line, but the player can still pre-load the
      // throttle for a launch.
      return;
    }

    this.time += dt;

    for (let i = 0; i < this.vehicles.length; i++) {
      const v = this.vehicles[i];
      const e = this.entries[i];
      if (e.retired) continue;

      let ctrl;
      if (v.isPlayer) {
        if (e.finished) ctrl = { steer: 0, throttle: 0, brake: 1 };
        else if (this.autopilot) ctrl = this.playerDriver.update(dt, this.time, this.vehicles);
        else ctrl = playerCtrl;
      } else {
        ctrl = this.drivers[i].update(dt, this.time, this.vehicles);
      }

      v.update(dt, ctrl, this.trackDef.wind);
      this._trackProgress(i, e, v);
      this._checkMines(v);
    }

    this._resolveContacts(dt);
    this._updateRanks();
    this._collectEvents();
  }

  /**
   * Accumulate genuine distance travelled. Because this integrates signed
   * progress, a shortcut cannot manufacture a lap and reversing subtracts.
   */
  _trackProgress(i, e, v) {
    const prev = this._lastS[i];
    let delta = this.path.deltaS(prev, v.s);

    // A single tick cannot legitimately cover more than a machine's top speed
    // times dt; anything larger is a projection glitch (typically the machine
    // passing close to another part of the circuit) and must be discarded
    // rather than banked as progress.
    const maxStep = v.params.boostPeak * (1 / 60) + 4;
    if (Math.abs(delta) > maxStep) delta = 0;

    e.distance += delta;
    this._lastS[i] = v.s;

    const lapNow = Math.floor(e.distance / this.path.length);
    if (lapNow > e.lap && !e.finished) {
      const lapTime = this.time - e.lastLapStart;
      e.lapTimes.push(lapTime);
      e.lastLapStart = this.time;
      e.lap = lapNow;

      if (v.isPlayer) {
        this.emit('lap', { lap: lapNow, time: lapTime, total: this.laps });
        // A boost charge is granted per completed lap, capped — and never on
        // the opening lap, so the first one is raced on pace alone.
        if (v.boostCharges < BOOST.maxCharges) v.boostCharges++;
      } else if (v.boostCharges < BOOST.maxCharges) {
        v.boostCharges++;
      }

      if (lapNow >= this.laps) {
        e.finished = true;
        e.finishTime = this.time;
        v.finished = true;
        if (v.isPlayer) this._finishRace();
      } else if (v.isPlayer) {
        this._checkQualification();
      }
    }
  }

  _checkMines(v) {
    if (!v.alive) return;
    const idx = this.mines.hit(v.s, v.d);
    if (idx >= 0) {
      this.mines.mines[idx].alive = false;
      v.hitMine();
      if (v.isPlayer) this.emit('mine');
    }
  }

  /**
   * Machine-to-machine contact. Momentum transfers by mass ratio, so being
   * rear-ended by something heavy is a genuine push forward — which makes a
   * crowded first corner an opportunity rather than only a hazard.
   */
  _resolveContacts(dt) {
    const n = this.vehicles.length;
    for (let i = 0; i < n; i++) {
      const a = this.vehicles[i];
      if (!a.alive || this.entries[i].retired) continue;
      for (let j = i + 1; j < n; j++) {
        const b = this.vehicles[j];
        if (!b.alive || this.entries[j].retired) continue;

        const ds = this.path.deltaS(a.s, b.s);
        if (Math.abs(ds) > 6) continue;
        const dd = b.d - a.d;
        if (Math.abs(dd) > 5) continue;

        // Separate laterally; the road is the only place either can go.
        const push = (5 - Math.abs(dd)) * 0.5;
        const dir = Math.sign(dd) || 1;
        const massA = a.params.massRatio;
        const massB = b.params.massRatio;
        const total = massA + massB;
        _v.copy(a.up).cross(a.heading).normalize();   // lateral axis, either machine
        a.pos.addScaledVector(_v, -dir * push * (massB / total) * dt * 60);
        b.pos.addScaledVector(_v, dir * push * (massA / total) * dt * 60);

        // Longitudinal exchange: the one behind gives up speed, the one in
        // front gains it. Being rear-ended is a genuine shove forward, which is
        // what makes a crowded first corner an opportunity as well as a hazard.
        const behind = ds > 0 ? a : b;
        const ahead = ds > 0 ? b : a;
        const closing = behind.speed - ahead.speed;
        if (closing > 0) {
          const transfer = Math.min(6, closing * 0.35);
          behind.speed -= transfer * (ahead.params.massRatio / total);
          ahead.speed += transfer * (behind.params.massRatio / total);
        }

        // Damage scales with how much the two machines are actually moving
        // against each other. Two cars running side by side at the same speed
        // are touching, not grinding, and must cost nothing — otherwise a
        // tightly packed field drains itself to destruction over one lap purely
        // by existing, which is exactly what an earlier flat-rate version did.
        const rub = clamp01(Math.abs(closing) / 18);
        if (rub > 0.02) {
          a.damage(ENERGY.grazeHit * rub * dt, 0.05);
          b.damage(ENERGY.grazeHit * rub * dt, 0.05);
        }

        if (Math.abs(closing) > 11 && this.time - (a._lastHit ?? -9) > 0.5) {
          const force = clamp01((Math.abs(closing) - 11) / 30);
          a._lastHit = this.time;
          b._lastHit = this.time;
          a.damage(ENERGY.crashHit * force, force * 0.6, true);
          b.damage(ENERGY.crashHit * force, force * 0.6, true);
        }
      }
    }
  }

  _updateRanks() {
    const order = this._rankScratch;
    order.length = 0;
    for (const e of this.entries) order.push(e);
    order.sort((x, y) => {
      // Finishers always outrank non-finishers, in the order they finished.
      if (x.finished !== y.finished) return x.finished ? -1 : 1;
      if (x.finished && y.finished) return x.finishTime - y.finishTime;
      if (x.retired !== y.retired) return x.retired ? 1 : -1;
      return y.distance - x.distance;
    });
    for (let i = 0; i < order.length; i++) order[i].rank = i + 1;
  }

  _checkQualification() {
    const need = this.qualifyRank;
    if (need === null) return;
    if (this.playerEntry.rank > need) {
      this.retire('RANK');
    }
  }

  _finishRace() {
    this.state = RACE_STATE.FINISHED;
    // Settle the rest of the field so the results screen has a full order
    // rather than freezing mid-race.
    this._settleField();
    this._awardPoints();
    this.emit('finish', { rank: this.playerEntry.rank });
  }

  /**
   * Fast-forward the AI to plausible finishing times instead of making the
   * player watch the rest of the field trickle in.
   */
  _settleField() {
    for (const e of this.entries) {
      if (e.finished || e.retired) continue;
      const remaining = this.laps * this.path.length - e.distance;
      const pace = e.lapTimes.length
        ? e.lapTimes.reduce((a, b) => a + b, 0) / e.lapTimes.length / this.path.length
        : 0.02;
      e.finished = true;
      e.finishTime = this.time + remaining * pace;
    }
    this._updateRanks();
  }

  _awardPoints() {
    for (const e of this.entries) {
      e.points = e.retired ? 0 : (POINTS[e.rank - 1] ?? 0);
    }
  }

  /** Player is out: destroyed, or failed to hold the qualifying rank. */
  retire(reason) {
    if (this.state === RACE_STATE.RETIRED) return;
    this.playerEntry.retired = true;
    this.state = RACE_STATE.RETIRED;
    this.retireReason = reason;
    this.emit('retire', { reason });
  }

  _collectEvents() {
    const p = this.player;
    if (!p) return;
    if (!p.alive && this.state === RACE_STATE.RACING) this.retire('DESTROYED');
    if (p.events.boostFired) this.emit('boost');
    if (p.events.jump) this.emit('jump');
    if (p.events.impact > 0.35) this.emit('impact', { force: p.events.impact });
    if (p.events.land > 0.2) this.emit('land', { force: p.events.land });
  }

  /** Ordered standings for the results screen. */
  standings() {
    return [...this.entries].sort((a, b) => a.rank - b.rank);
  }
}

export { QUALIFY_FRACTION, POINTS };
