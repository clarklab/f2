import * as THREE from 'three';
import { clamp, clamp01, damp, lerp } from '../core/MathUtil.js';
import { SURFACE } from '../track/SurfaceMap.js';
import { TrackFrame } from '../track/TrackPath.js';
import { ENERGY, BOOST } from './Machines.js';

/**
 * Vehicle — the anti-gravity machine's simulation.
 *
 * The handling model keeps the machine's *heading* and its *velocity vector* as
 * separate quantities, and cornering is entirely about how fast one is rotated
 * onto the other. That single decision produces the whole feel:
 *
 *   gripped = (speed < slipSpeed) || throttle released
 *
 * Above the slip speed with the throttle pinned, the velocity vector barely
 * follows the nose, so the machine points into the corner and keeps travelling
 * straight — the characteristic understeer. Lift for a fraction of a second and
 * grip snaps back, the velocity swings onto the heading, and the acceleration
 * curve immediately restores the speed you gave up. Feathering the throttle
 * through corners is therefore not a trick layered on top of the physics, it is
 * the physics.
 *
 * The shoulder buttons are a lateral strafe, not a drift. They shift the
 * machine sideways without rotating it, at a small cost in speed.
 *
 * Runs at a fixed 120 Hz. All vectors are world space unless noted.
 */

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _right = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();

export class Vehicle {
  /**
   * @param {object} params  from machineParams()
   * @param {import('../track/TrackPath.js').TrackPath} path
   * @param {import('../track/TrackBuilder.js').TrackMesh} track
   */
  constructor(params, path, track, opts = {}) {
    this.params = params;
    this.path = path;
    this.track = track;
    this.isPlayer = opts.isPlayer ?? false;
    this.name = opts.name ?? params.name;
    this.index = opts.index ?? 0;

    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.heading = new THREE.Vector3(0, 0, 1);
    this.up = new THREE.Vector3(0, 1, 0);

    // Track-space coordinates, refreshed every tick.
    this.s = 0;
    this.d = 0;
    this.h = 0;
    this._proj = { s: 0, d: 0, h: 0, index: 0, width: 0 };

    this.speed = 0;            // forward speed along the heading
    this.energy = ENERGY.max;
    this.alive = true;
    this.finished = false;

    this.boostCharges = 0;
    this.boosting = false;
    this.boostTimer = 0;
    this.dashBonus = 0;        // temporary speed ceiling from a dash plate
    this.airborne = false;
    this.airTime = 0;

    // Brief invulnerability after a discrete hit. Mines sit close enough
    // together that a machine crossing a field diagonally can clip three in a
    // fifth of a second, which is an unreadable instant kill rather than a
    // penalty. The original solved this the same way, with a hurt timer.
    this.hurtTimer = 0;

    this.surface = SURFACE.ROAD;
    this.onRail = false;
    this.railIntensity = 0;
    this.slipping = false;
    this.gripped = true;

    // Presentation-only state.
    this.visualRoll = 0;
    this.visualPitch = 0;
    this.quat = new THREE.Quaternion();
    this.prevPos = new THREE.Vector3();
    this.prevQuat = new THREE.Quaternion();

    // Per-frame event flags, consumed and cleared by the renderer/audio.
    this.events = {
      impact: 0, mine: false, boostFired: false, jump: false,
      land: 0, scrape: 0, dash: false,
    };
  }

  /** Place the machine on the grid. */
  spawn(s, d) {
    const frame = this.path.sampleAt(s, this._tf ??= new TrackFrame());
    this.pos.copy(frame.pos)
      .addScaledVector(frame.side, d)
      .addScaledVector(frame.up, this.params.rideHeight);
    this.heading.copy(frame.tangent);
    this.up.copy(frame.up);
    this.vel.set(0, 0, 0);
    this.speed = 0;
    this.s = s;
    this.d = d;
    this.h = this.params.rideHeight;
    this.energy = ENERGY.max;
    this.alive = true;
    this.finished = false;
    this.boostCharges = 0;
    this.boosting = false;
    this.boostTimer = 0;
    this.dashBonus = 0;
    this._updateQuaternion();
    this.prevPos.copy(this.pos);
    this.prevQuat.copy(this.quat);
  }

  get speedKmh() { return this.speed * 3.6; }
  get energy01() { return clamp01(this.energy / ENERGY.max); }
  get speed01() { return clamp01(this.speed / this.params.topSpeed); }

  /** Current top speed, accounting for the low-energy clamp and dash plates. */
  get speedCap() {
    const p = this.params;
    const weak = this.energy01 < ENERGY.weakThreshold ? ENERGY.weakSpeedFactor : 1;
    return p.topSpeed * weak + this.dashBonus;
  }

  fireBoost() {
    if (this.boosting || this.boostCharges <= 0 || !this.alive) return false;
    this.boostCharges--;
    this.boosting = true;
    this.boostTimer = 0;
    this.events.boostFired = true;
    return true;
  }

  /**
   * @param {number} dt fixed timestep
   * @param {{steer:number, throttle:number, brake:number, leanLeft:number,
   *          leanRight:number, boost:boolean}} ctrl
   * @param {{x:number,z:number}} [wind]
   */
  update(dt, ctrl, wind) {
    if (!this.alive) return;
    const p = this.params;

    this.prevPos.copy(this.pos);
    this.prevQuat.copy(this.quat);
    if (this.hurtTimer > 0) this.hurtTimer = Math.max(0, this.hurtTimer - dt);

    // --- 1. where are we on the track --------------------------------
    this.path.project(this.pos.x, this.pos.y, this.pos.z, this.s, this._proj);
    this.s = this._proj.s;
    this.d = this._proj.d;
    this.h = this._proj.h;
    const frame = this.path.sampleAt(this.s, this._tf ??= new TrackFrame());
    const halfWidth = frame.width * 0.5;

    this.surface = this.track ? this.track.surfaceAt(this.s, this.d) : SURFACE.ROAD;
    const offTrack = Math.abs(this.d) > halfWidth;

    // Never allow the machine below the road surface. The hover spring's force
    // is proportional to compression, so a machine that somehow ends up a few
    // metres under the track gets launched with enormous force, overshoots
    // further on the way back down, and diverges to infinity within a second.
    // Clamping here makes that failure mode structurally impossible rather than
    // merely unlikely.
    if (this.h < 0) {
      this.pos.addScaledVector(frame.up, -this.h + 0.05);
      const into = this.vel.dot(frame.up);
      if (into < 0) this.vel.addScaledVector(frame.up, -into);
      this.h = 0.05;
    }

    // --- 2. attitude ---------------------------------------------------
    this.airborne = this.h > p.rideHeight * 2.4;
    const targetUp = this.airborne ? _v.set(0, 1, 0) : frame.up;
    this.up.lerp(targetUp, 1 - Math.exp(-(this.airborne ? 3 : 14) * dt)).normalize();

    // Keep the heading in the machine's own plane; without this it slowly tips
    // out of alignment on banked corners and the car appears to fly sideways.
    this.heading.addScaledVector(this.up, -this.heading.dot(this.up)).normalize();

    // --- 3. steering ---------------------------------------------------
    const speed01 = clamp01(this.speed / p.topSpeed);
    let yawRate = lerp(p.steerLow, p.steerHigh, speed01);
    if (this.boosting) yawRate *= p.steerBoost;
    if (this.surface === SURFACE.ICE) yawRate *= 1.12;   // nose swings freely
    const steer = clamp(ctrl.steer ?? 0, -1, 1);
    if (steer !== 0) {
      _q.setFromAxisAngle(this.up, -steer * yawRate * dt);
      this.heading.applyQuaternion(_q).normalize();
    }

    _right.crossVectors(this.heading, this.up).normalize();

    // --- 4. longitudinal forces ---------------------------------------
    const throttle = clamp01(ctrl.throttle ?? 0);
    const brake = clamp01(ctrl.brake ?? 0);
    const cap = this.speedCap;

    if (this.boosting) {
      this.boostTimer += dt;
      if (this.boostTimer >= BOOST.duration) {
        this.boosting = false;
      } else {
        // Sawtooth: decay from the peak back to top speed, then re-spike.
        // Applied as a strong *acceleration* rather than by assigning the
        // speed outright. Assigning it would make the boost override braking,
        // drag and the throttle entirely, which turns four seconds of boost
        // into four seconds of having no controls.
        const cycle = BOOST.duration / 6;
        const phase = (this.boostTimer % cycle) / cycle;
        const target = lerp(p.boostPeak, p.topSpeed, phase);
        if (this.speed < target) {
          this.speed = Math.min(target, this.speed + BOOST.accel * dt);
        }
      }
    }

    if (!this.airborne) {
      if (throttle > 0 && this.speed < cap) {
        this.speed += p.accelAt(this.speed) * throttle * dt;
      }
      if (brake > 0) this.speed -= p.brake * brake * dt;
    } else {
      // Airborne machines gather a little speed, as they did in the original.
      this.airTime += dt;
      if (this.airTime < 0.34 && this.speed < cap) this.speed += 11 * dt;
    }

    // Baseline drag is deliberately gentle. Top speed is set by the
    // acceleration curve tailing off against the hard speed clamp, not by drag
    // — which is both what the original did and what makes lifting off the
    // throttle a *grip* decision rather than a braking one. Strong drag would
    // silently cap every machine at the same speed and make their stats a lie.
    const v = Math.abs(this.speed);
    this.speed -= (p.rollingDrag + p.drag * v * v) * Math.sign(this.speed) * dt;

    // Rough ground and open desert slow you with an explicit deceleration, so
    // the penalty is predictable instead of scaling with the square of speed.
    if (this.surface === SURFACE.DIRT) this.speed -= p.dirtDecel * dt;
    if (offTrack) this.speed -= p.offTrackDecel * dt;

    // A dash plate lifts the ceiling past top speed, then it bleeds away. The
    // overspeed is deliberately short-lived: it should be a kick down a
    // straight, not a state you carry into the next corner.
    const onDash = this.surface === SURFACE.BOOST;
    if (onDash) {
      this.dashBonus = Math.max(this.dashBonus, p.topSpeed * 0.42);
      this.speed = Math.min(this.speed + 260 * dt, p.topSpeed + this.dashBonus);
      // Edge-triggered so the flash and the audio fire once per plate rather
      // than once per tick — the same discipline as the jump plates.
      if (!this._onDash) this.events.dash = true;
    }
    this._onDash = onDash;
    this.dashBonus = Math.max(0, this.dashBonus - p.topSpeed * 0.5 * dt);

    this.speed = clamp(this.speed, -14, Math.max(cap, p.boostPeak));

    // --- 5. grip: the core of the handling model ----------------------
    // Below the slip speed, or with the throttle released, the velocity vector
    // is pulled onto the heading. Above it with the throttle held, it is not.
    const throttleHeld = throttle > 0.55;
    this.gripped = (this.speed < p.slipSpeed) || !throttleHeld;
    if (this.surface === SURFACE.ICE) this.gripped = false;
    this.slipping = !this.gripped && Math.abs(steer) > 0.15;

    let gripRate = this.gripped ? p.gripRate : p.slipGripRate;
    // Momentum only. Not literally zero: a coated corner should be a corner
    // you have to respect, not one that is mathematically impossible to make.
    if (this.surface === SURFACE.ICE) gripRate = 0.4;
    if (this.airborne) gripRate *= 0.25;

    // Rebuild the velocity from its along-heading and lateral components so the
    // rotation is exact rather than an approximation that leaks energy.
    const along = this.vel.dot(this.heading);
    const lateral = this.vel.dot(_right);
    const decay = Math.exp(-gripRate * dt);
    const newLateral = lateral * decay;
    const vertical = this.vel.dot(this.up);

    _v.copy(this.heading).multiplyScalar(this.speed);
    _v.addScaledVector(_right, newLateral);
    _v.addScaledVector(this.up, vertical);
    this.vel.copy(_v);

    // The lateral velocity that grip removed is not free — sliding scrubs speed.
    if (Math.abs(lateral) > 1) {
      this.speed -= Math.abs(lateral - newLateral) * 0.16;
    }

    // --- 6. lean / strafe ---------------------------------------------
    const lean = (ctrl.leanRight ?? 0) - (ctrl.leanLeft ?? 0);
    if (lean !== 0) {
      this.vel.addScaledVector(_right, lean * p.slideRate * dt);
      this.speed -= Math.abs(lean) * p.slideCost * this.speed * dt;
    }

    // --- 7. wind -------------------------------------------------------
    // Applied as an acceleration, so it bites hardest when you are slow.
    if (wind) {
      this.vel.x += wind.x * dt;
      this.vel.z += wind.z * dt;
    }

    // --- 8. hover and gravity ------------------------------------------
    const vUp = this.vel.dot(frame.up);
    if (!this.airborne) {
      const compression = clamp(p.rideHeight - this.h, -3, 3);
      // Clamped so a bad landing or a geometry seam can never inject an
      // unbounded impulse.
      const spring = clamp(compression * p.hoverStiffness - vUp * p.hoverDamping, -700, 700);
      this.vel.addScaledVector(frame.up, spring * dt);
      if (this.airTime > 0.25) {
        this.events.land = clamp01(this.airTime * 0.6);
        // A hard landing costs momentum, softened by leaning back on approach.
        this.speed *= 1 - clamp01(this.airTime * 0.16);
      }
      this.airTime = 0;
    } else {
      this.vel.y -= p.gravity * dt;
    }

    // A jump plate throws the machine up and forward — once. Applying the
    // impulse for every tick spent on the plate stacks a dozen launches into
    // one and fires the machine a hundred metres into the sky, so it is armed
    // on entry and only re-arms after leaving.
    const onPlate = this.surface === SURFACE.JUMP;
    if (onPlate && !this._onJumpPlate && !this.airborne) {
      this.vel.addScaledVector(frame.up, 21);
      this.speed += 12;
      this.events.jump = true;
    }
    this._onJumpPlate = onPlate;

    // --- 9. integrate ---------------------------------------------------
    // Final safety net. Nothing in the model should ever produce a velocity
    // anywhere near this, so hitting it means something upstream misbehaved —
    // but a clamp keeps that as a visible glitch rather than a NaN that
    // silently poisons the whole simulation.
    const vmag = this.vel.length();
    if (!isFinite(vmag)) {
      this.vel.set(0, 0, 0);
      this.speed = 0;
    } else if (vmag > 400) {
      this.vel.multiplyScalar(400 / vmag);
    }
    this.pos.addScaledVector(this.vel, dt);

    // --- 10. edges -------------------------------------------------------
    this._resolveEdges(frame, halfWidth, dt);

    // --- 11. surface effects on energy -----------------------------------
    this._updateEnergy(dt, offTrack);

    // --- 12. presentation -------------------------------------------------
    const targetRoll = -steer * 0.42 - clamp(this.vel.dot(_right) * 0.012, -0.3, 0.3);
    this.visualRoll = damp(this.visualRoll, targetRoll, 7, dt);
    this.visualPitch = damp(this.visualPitch, this.airborne ? -0.16 : clamp(-this.speed * 0.0008, -0.1, 0.1), 5, dt);
    this._updateQuaternion();
  }

  /**
   * Guide-beam rails run along both road edges. Contact clamps your speed and
   * drains energy, which is what makes a scrape compound: you lose the lap time
   * now and the top speed later.
   */
  _resolveEdges(frame, halfWidth, dt) {
    this.onRail = false;
    const overshoot = Math.abs(this.d) - halfWidth;
    if (overshoot <= 0) {
      this.railIntensity = damp(this.railIntensity, 0, 12, dt);
      return;
    }

    const sign = Math.sign(this.d);
    // Use the frame's own side vector. Recomputing it here is how the rail
    // correction ends up disagreeing with the axis `d` was measured along, and
    // a sign disagreement makes the "push back on track" step push outward
    // instead — doubling the error every tick until the machine is at 1e50 m.
    _right.copy(frame.side);

    // Push back onto the road and kill the outward velocity component.
    this.pos.addScaledVector(_right, -sign * overshoot);
    const outward = this.vel.dot(_right) * sign;
    if (outward > 0) {
      // Reflect with heavy loss rather than a clean bounce, so the rail is
      // never a faster line than the corner — but keep enough that a glancing
      // hit rebounds you back onto the racing line instead of pinning you.
      this.vel.addScaledVector(_right, -sign * outward * 1.35);
      this.events.impact = Math.max(this.events.impact, clamp01(outward / 40));
    }

    this.onRail = true;
    this.railIntensity = damp(this.railIntensity, 1, 18, dt);
    this.events.scrape = clamp01(this.speed / this.params.topSpeed);

    // Speed is clamped while in contact, not merely reduced.
    const railSpeed = this.params.topSpeed * 0.62;
    if (this.speed > railSpeed) this.speed = damp(this.speed, railSpeed, 7, dt);

    this.d = sign * halfWidth;
  }

  _updateEnergy(dt, offTrack) {
    if (!this.alive) return;
    const armour = this.params.armour || 1;
    let drain = 0;

    if (this.onRail) drain += ENERGY.railDrain;
    if (offTrack) drain += ENERGY.offTrackDrain;
    if (this.surface === SURFACE.DIRT) drain += ENERGY.dirtDrain;

    if (drain > 0) this.energy -= (drain / armour) * dt;

    // Recharge is proportional to *time* spent on the strip, so crossing it at
    // racing speed is nearly worthless — you have to give up lap time for it.
    if (this.surface === SURFACE.RECHARGE) {
      this.energy = Math.min(ENERGY.max, this.energy + ENERGY.rechargeRate * dt);
    }

    if (this.energy <= 0) {
      this.energy = 0;
      this.alive = false;
      this.events.impact = 1;
    }
  }

  /**
   * Apply a discrete hit (mine, collision).
   * @param {boolean} [major] Major hits respect and then re-arm the
   *        invulnerability window; continuous drains bypass it entirely.
   */
  damage(amount, impactScale = 0.6, major = false) {
    if (!this.alive) return;
    if (major) {
      if (this.hurtTimer > 0) return;
      this.hurtTimer = 0.7;
    }
    this.energy -= amount / (this.params.armour || 1);
    this.events.impact = Math.max(this.events.impact, impactScale);
    if (this.energy <= 0) {
      this.energy = 0;
      this.alive = false;
    }
  }

  hitMine() {
    if (!this.alive || this.hurtTimer > 0) return;
    this.damage(ENERGY.mineHit, 1, true);
    this.events.mine = true;
    this.speed *= 0.55;
    // Mines throw the machine off line rather than simply slowing it.
    _right.crossVectors(this.heading, this.up).normalize();
    const kick = (this.index % 2 === 0 ? 1 : -1) * 16;
    this.vel.addScaledVector(_right, kick);
  }

  _updateQuaternion() {
    _right.crossVectors(this.heading, this.up).normalize();
    _v2.crossVectors(_right, this.heading).normalize();
    // Model space: +X right, +Y up, -Z forward, matching three.js convention.
    _m.makeBasis(_right, _v2, _v.copy(this.heading).negate());
    this.quat.setFromRotationMatrix(_m);
    if (this.visualRoll || this.visualPitch) {
      _q.setFromAxisAngle(_v.set(0, 0, 1), this.visualRoll);
      this.quat.multiply(_q);
      _q.setFromAxisAngle(_v.set(1, 0, 0), this.visualPitch);
      this.quat.multiply(_q);
    }
  }

  clearEvents() {
    const e = this.events;
    e.impact = 0; e.mine = false; e.boostFired = false;
    e.jump = false; e.land = 0; e.scrape = 0; e.dash = false;
  }
}
