import * as THREE from 'three';
import { clamp, clamp01, damp, lerp, makeRng } from '../core/MathUtil.js';
import { TrackFrame } from '../track/TrackPath.js';
import { SURFACE } from '../track/SurfaceMap.js';
import { BOOST } from './Machines.js';

/**
 * Driver — the AI that pilots an opponent machine.
 *
 * Steering is pure pursuit: aim at a point some distance ahead on the racing
 * line and steer proportionally to the bearing error. The lookahead distance
 * scales with speed, which is what stops the classic wobble — a fixed lookahead
 * either oscillates at speed or cuts corners when slow.
 *
 * Speed control scans the curvature ahead and computes the fastest speed the
 * corner can actually be taken at. Crucially, the throttle is *released* rather
 * than the brake applied, because releasing the throttle is what restores grip
 * in this handling model. The AI therefore feathers through corners for exactly
 * the same reason a good human player does, and looks like it is driving rather
 * than executing a script.
 *
 * Cost is a handful of curvature lookups per driver per tick, so a full grid is
 * nowhere near the frame budget.
 */

const _v = new THREE.Vector3();
const _target = new THREE.Vector3();
const _right = new THREE.Vector3();

/** Named opponent pilots, so the standings read like a championship. */
export const PILOTS = [
  'DR. VOSS', 'PICO', 'G. SABRE', 'OCTOMAN', 'M. BIRD', 'B. BEETLE',
  'GOMAR', 'SHIOH', 'J. GOMEZ', 'K. RYDER', 'ZODA', 'N. HAWK',
  'L. FERRO', 'T. KOMA', 'S. VANE', 'D. KANE', 'R. AXEL', 'V. NOMAD',
  'W. HALE', 'E. QUILL',
];

export class Driver {
  /**
   * @param {import('./Vehicle.js').Vehicle} vehicle
   * @param {number} seed  deterministic personality
   * @param {number} skill 0..1, scales with difficulty and grid position
   */
  constructor(vehicle, seed = 1, skill = 0.8) {
    this.v = vehicle;
    this.rng = makeRng(seed);
    this.skill = clamp01(skill);

    // Personality. Each driver corners at a slightly different limit, sits on
    // a slightly different line, and reacts at a slightly different rate — the
    // cheapest way to stop a grid looking like a train.
    const r = this.rng;
    this.corneringLimit = lerp(58, 92, this.skill) * lerp(0.9, 1.08, r());
    this.lineBias = (r() * 2 - 1) * 0.22;         // preferred offset from the ideal line
    this.reaction = lerp(0.16, 0.045, this.skill) * lerp(0.85, 1.2, r());
    this.aggression = lerp(0.3, 1.0, this.skill) * lerp(0.8, 1.15, r());
    this.wobbleAmp = lerp(0.16, 0.02, this.skill);
    this.wobbleRate = 0.5 + r() * 0.9;
    this.boostAppetite = lerp(0.35, 0.95, this.skill);
    // How slowly this driver is willing to creep across a coated surface.
    this.iceSpeed = lerp(48, 66, this.skill);

    this._steer = 0;
    this._throttle = 1;
    this._brake = 0;
    this._reactionTimer = 0;
    this._phase = r() * 100;
    this._frame = new TrackFrame();
    this._targetD = 0;

    this.ctrl = { steer: 0, throttle: 1, brake: 0, leanLeft: 0, leanRight: 0 };
  }

  /**
   * Where the racing line sits at arc length `s`, as a lateral offset in metres.
   * Corners pull the line toward the inside; straights let it drift back to
   * centre. Deliberately simple — a full apex-seeking line looks robotic at
   * this scale, and the curvature-weighted offset reads as natural.
   */
  lineOffset(path, s) {
    const k = path.curvatureAt(s);
    const halfWidth = path.widthAt(s) * 0.5;
    // Positive curvature turns right, so the inside is to the right.
    const strength = clamp(k * 90, -1, 1);
    return (strength * 0.5 + this.lineBias) * halfWidth * 0.86;
  }

  /**
   * Fastest speed the upcoming stretch can be taken at.
   *
   * Two independent limits apply and the tighter one wins:
   *
   *   Lateral grip:  v = sqrt(a_lat / k)
   *   Steering rate: the machine's yaw authority falls off with speed, so above
   *                  a certain speed it simply cannot rotate fast enough to
   *                  follow a curve of radius 1/k no matter how hard you pull.
   *
   * Ignoring the second is what makes an AI pin full lock and plough straight
   * into the outside rail: the grip maths says the corner is takeable, and the
   * machine physically cannot point that way.
   */
  cornerSpeed(path, s, speed) {
    const p = this.v.params;
    // Scan far enough ahead to start lifting before the corner, scaled by speed
    // so it always corresponds to roughly the same number of seconds.
    const horizon = clamp(speed * 1.9, 60, 560);
    let worst = 0;
    const STEPS = 12;
    for (let i = 1; i <= STEPS; i++) {
      const k = Math.abs(path.curvatureAt(s + (horizon * i) / STEPS));
      // Weight near curvature more heavily; a distant hairpin should not make
      // the machine crawl down a straight.
      const w = 1 - (i / STEPS) * 0.4;
      worst = Math.max(worst, k * w);
    }
    if (worst < 1e-5) return Infinity;

    return this._limitFor(worst);
  }

  /** Both speed limits for a given curvature; the tighter one wins. */
  _limitFor(k) {
    if (k < 1e-5) return Infinity;
    const p = this.v.params;
    const gripLimit = Math.sqrt(this.corneringLimit / k);

    // Fixed-point solve for the speed at which yaw authority exactly matches
    // the required turn rate. Two iterations converge well inside our tolerance.
    let vSteer = p.steerHigh / k;
    for (let i = 0; i < 2; i++) {
      const yaw = lerp(p.steerLow, p.steerHigh, clamp01(vSteer / p.topSpeed));
      vSteer = yaw / k;
    }
    return Math.min(gripLimit, vSteer * 0.9);
  }

  /**
   * The tightest corner anywhere in the next `distance` metres, unweighted.
   *
   * Used for the boost decision, which needs a completely different horizon
   * from the braking decision: braking is about the next second or two, but
   * firing a boost commits the machine to roughly four seconds of being very
   * hard to slow down. Judging that with the braking horizon means the AI
   * happily lights the afterburner 200 m before a hairpin it cannot see yet.
   */
  worstCornerWithin(path, s, distance) {
    let limit = Infinity;
    const STEPS = 20;
    for (let i = 1; i <= STEPS; i++) {
      const k = Math.abs(path.curvatureAt(s + (distance * i) / STEPS));
      limit = Math.min(limit, this._limitFor(k));
    }
    return limit;
  }

  /**
   * The slowest speed any coated (zero-grip) surface in the next `distance`
   * metres demands, or Infinity if the road ahead is dry.
   *
   * Ice is invisible to a curvature scan — the corner radius does not change,
   * only the machine's ability to follow it — so a driver that only reads
   * geometry arrives at a coated corner at full pace and understeers straight
   * into the outside rail. Every single time.
   */
  iceSpeedLimit(path, s, distance) {
    const surfaces = this.v.track;
    if (!surfaces?.surfaceAt) return Infinity;
    const STEPS = 10;
    for (let i = 1; i <= STEPS; i++) {
      const ahead = s + (distance * i) / STEPS;
      if (surfaces.surfaceAt(ahead, this._targetD) === SURFACE.ICE) {
        // Scale with how soon it arrives, so the machine eases down rather than
        // stamping on the brakes the instant a coated corner comes into view.
        const nearness = 1 - (i - 1) / STEPS;
        return lerp(this.v.params.topSpeed * 0.62, this.iceSpeed, nearness);
      }
    }
    return Infinity;
  }

  /**
   * Pick the best lane to be in a short distance ahead.
   *
   * Samples the surface across the road at a lookahead point and scores each
   * candidate, then nudges the target line toward the best one. Without this
   * the AI drives the geometric racing line straight through mine fields and
   * rough patches, because curvature is all it can see — on the hazard-heavy
   * circuits that is fatal within a lap, and it also means the AI ignores every
   * boost pad on the track.
   *
   * Scoring is relative to the line the driver already wants, so it weaves
   * around hazards rather than abandoning the racing line entirely.
   */
  chooseLane(path, s, desiredD) {
    const surfaces = this.v.track;
    if (!surfaces?.surfaceAt) return desiredD;

    const lookahead = clamp(this.v.speed * 0.55, 22, 170);
    // Three samples, and the near one matters most. With only far samples, a
    // machine already inside a mine field sees clear road beyond it and steers
    // back onto the racing line — straight through the mines it has left.
    const sNear = s + Math.max(6, this.v.speed * 0.14);
    const sA = s + lookahead * 0.55;
    const sB = s + lookahead;
    const halfWidth = path.widthAt(sB) * 0.5;

    const COST = {
      [SURFACE.ROAD]: 0,
      [SURFACE.BOOST]: -14,        // actively worth deviating for
      [SURFACE.RECHARGE]: 0,
      [SURFACE.JUMP]: -2,
      [SURFACE.DIRT]: 26,
      [SURFACE.ICE]: 18,
      [SURFACE.MINES]: 150,        // never worth it
    };

    let bestD = desiredD;
    let bestScore = Infinity;
    const LANES = 9;
    for (let i = 0; i < LANES; i++) {
      const d = (-1 + (2 * i) / (LANES - 1)) * halfWidth * 0.88;
      let score = (COST[surfaces.surfaceAt(sNear, d)] ?? 0) * 1.6
        + (COST[surfaces.surfaceAt(sA, d)] ?? 0) * 0.8
        + (COST[surfaces.surfaceAt(sB, d)] ?? 0) * 0.5;
      // Prefer staying near the intended line; deviating costs lap time.
      score += Math.abs(d - desiredD) * 0.55;
      if (score < bestScore) { bestScore = score; bestD = d; }
    }
    return bestD;
  }

  update(dt, time, opponents) {
    const v = this.v;
    const path = v.path;
    if (!v.alive) {
      this.ctrl.throttle = 0;
      return this.ctrl;
    }

    // Reaction delay: recompute intent at a human-ish rate, then hold it.
    this._reactionTimer -= dt;
    if (this._reactionTimer <= 0) {
      this._reactionTimer = this.reaction;
      this._recompute(path, time, opponents);
    }

    // Smooth toward the last decision so the machine does not twitch between
    // reaction ticks.
    this.ctrl.steer = damp(this.ctrl.steer, this._steer, 12, dt);
    this.ctrl.throttle = damp(this.ctrl.throttle, this._throttle, 10, dt);
    this.ctrl.brake = damp(this.ctrl.brake, this._brake, 12, dt);
    return this.ctrl;
  }

  _recompute(path, time, opponents) {
    const v = this.v;

    // --- lateral target, including avoidance ---
    let targetD = this.lineOffset(path, v.s + 25);
    // A slow sinusoid keeps the machine visibly alive on long straights.
    targetD += Math.sin(time * this.wobbleRate + this._phase) * this.wobbleAmp * path.widthAt(v.s);

    if (opponents) {
      for (let i = 0; i < opponents.length; i++) {
        const o = opponents[i];
        if (o === v || !o.alive) continue;
        const ahead = path.deltaS(v.s, o.s);
        if (ahead < 2 || ahead > 60) continue;
        if (Math.abs(o.d - v.d) > 6.5) continue;
        // Pick the side with more road and commit to it.
        const halfWidth = path.widthAt(o.s) * 0.5;
        const roomLeft = o.d + halfWidth;
        const roomRight = halfWidth - o.d;
        const side = roomRight > roomLeft ? 1 : -1;
        const urgency = 1 - ahead / 60;
        targetD = o.d + side * (7.5 * (0.6 + urgency));
        break;
      }
    }

    // The player gets a bigger bubble than other traffic, in both directions.
    // Racing the AI should mean being raced against, not being boxed in and
    // ground on — and the contact impulses make every touch cost real time, so
    // the AI has its own reasons to stay clear too.
    const pv = this.keepClearOf;
    if (pv && pv.alive && pv !== v) {
      const along = path.deltaS(v.s, pv.s);       // + means the player is ahead
      if (Math.abs(along) < 44 && Math.abs(pv.d - v.d) < 10) {
        const halfWidth = path.widthAt(v.s) * 0.5;
        const away = Math.sign(v.d - pv.d) || (pv.d > 0 ? -1 : 1);
        const urgency = 1 - Math.abs(along) / 44;
        targetD = clamp(
          pv.d + away * (9 + 4 * urgency),
          -halfWidth * 0.94, halfWidth * 0.94,
        );
      }
    }

    // Hazard avoidance runs after the racing line and after traffic, so a
    // mine field overrides both.
    targetD = this.chooseLane(path, v.s, targetD);

    const halfWidth = path.widthAt(v.s) * 0.5;
    targetD = clamp(targetD, -halfWidth * 0.94, halfWidth * 0.94);
    this._targetD = targetD;

    // --- pure pursuit steering ---
    const lookahead = clamp(v.speed * 0.42, 14, 130);
    path.toWorld(v.s + lookahead, targetD, v.params.rideHeight, _target);
    _v.subVectors(_target, v.pos);
    _v.addScaledVector(v.up, -_v.dot(v.up));      // flatten into the surface plane
    _right.crossVectors(v.heading, v.up).normalize();
    const bearing = Math.atan2(_v.dot(_right), _v.dot(v.heading));
    this._steer = clamp(bearing * 2.1, -1, 1);

    // --- speed control ---
    const limit = this.cornerSpeed(path, v.s, v.speed);
    const p = v.params;

    // Above the slip speed the machine will not actually change direction, so
    // a corner that needs turning also needs the throttle released regardless
    // of what the cornering-limit maths says.
    const needsTurning = Math.abs(this._steer) > 0.25;
    const slipCeiling = needsTurning ? p.slipSpeed * 1.02 : Infinity;
    const iceLimit = this.iceSpeedLimit(path, v.s, clamp(v.speed * 1.6, 70, 430));
    const target = Math.min(limit, slipCeiling, iceLimit) * lerp(0.86, 1.0, this.skill);

    this._overspeed = v.speed / Math.max(1, target);

    if (v.speed > target * 1.06) {
      // Well over the corner's limit: lift and brake. Braking scales hard,
      // because a dash plate can hand the machine 40% more speed than the next
      // corner will accept and it has very little road to shed it in.
      this._throttle = 0;
      this._brake = clamp01((this._overspeed - 1.06) * 3.4);
    } else if (v.speed > target * 0.99) {
      // The feathering band: lift, do not brake. Releasing the throttle is what
      // restores grip in this model, so this is where the AI is quickest.
      this._throttle = 0;
      this._brake = 0;
    } else {
      this._throttle = 1;
      this._brake = 0;
    }

    // --- boost ---
    // Only worth spending on road that is straight for a long way ahead, and
    // only when already up to the corner limit rather than mid-braking.
    if (v.boostCharges > 0 && !v.boosting && this._overspeed < 1.0) {
      // Look ahead over the distance the boost will actually carry us.
      const reach = p.boostPeak * BOOST.duration * 0.85;
      const clearRoad = this.worstCornerWithin(path, v.s, reach) > p.topSpeed * 1.02;
      if (clearRoad && this.rng() < this.boostAppetite * 0.4) v.fireBoost();
    }
  }
}
