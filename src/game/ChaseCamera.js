import * as THREE from 'three';
import { clamp01, damp, lerp } from '../core/MathUtil.js';

/**
 * ChaseCamera.
 *
 * The important detail is that the camera's facing is its own state that eases
 * toward the machine's heading, rather than being derived from it directly.
 * The original game kept a separate "camera facing" byte for exactly this
 * reason, and it is what produces the signature whip: turn hard and the world
 * rotates late, then catches up as you straighten. Rigidly locking the camera
 * to the car's heading makes a fast racer feel weirdly inert.
 *
 * Everything else is speed-reactive garnish — the camera pulls back, drops, and
 * widens its field of view as you accelerate, so the sensation of speed grows
 * faster than the actual number does.
 */

const WORLD_UP = new THREE.Vector3(0, 1, 0);

export class ChaseCamera {
  constructor(camera) {
    this.camera = camera;

    this.pos = new THREE.Vector3();
    this.fwd = new THREE.Vector3(0, 0, 1);
    this.up = new THREE.Vector3(0, 1, 0);

    this._eye = new THREE.Vector3();
    this._look = new THREE.Vector3();
    this._tmp = new THREE.Vector3();
    this._targetUp = new THREE.Vector3();

    // Tuning.
    this.baseDistance = 18.0;
    this.speedDistance = 5.5;    // extra pull-back at full speed
    // Height and look-ahead together set how far the camera pitches down. Too
    // much of either and the view reads as isometric rather than as sitting in
    // the race.
    this.baseHeight = 6.8;
    this.speedHeight = -1.2;     // drops slightly as you go faster
    this.lookAhead = 48;
    this.lookHeight = 3.4;
    this.baseFov = 58;
    this.speedFov = 20;          // total FOV kick across the speed range
    this.yawLag = 6.5;           // lower = more lag = more whip
    this.posLag = 26;
    this.rollBlend = 0.42;       // how much of the track's banking to adopt

    this.shake = 0;
    this.shakeDecay = 5.5;
    this._shakeSeed = 0;

    this.reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

    this.initialised = false;
  }

  /** Jump the camera to the target with no easing (spawn, respawn, cuts). */
  snap(target) {
    this.pos.copy(target.position);
    this.fwd.copy(target.forward);
    this._resolveUp(target);
    this.up.copy(this._targetUp);
    this.initialised = true;
    this.shake = 0;
  }

  addShake(amount) {
    if (this.reducedMotion) amount *= 0.25;
    this.shake = Math.min(1.4, this.shake + amount);
  }

  _resolveUp(target) {
    // Adopt only a fraction of the track's roll. Full roll on a banked corner
    // is disorienting in a portrait viewport, and none at all makes banking
    // invisible.
    this._targetUp.copy(WORLD_UP).lerp(target.up, this.rollBlend).normalize();
  }

  /**
   * @param {{position:THREE.Vector3, forward:THREE.Vector3, up:THREE.Vector3,
   *          speed01:number, boosting?:boolean}} target
   * @param {number} dt
   */
  update(target, dt) {
    if (!this.initialised) this.snap(target);

    const speed01 = clamp01(target.speed01 ?? 0);

    // Position tracks tightly; facing deliberately lags.
    this.pos.lerp(target.position, 1 - Math.exp(-this.posLag * dt));
    this.fwd.lerp(target.forward, 1 - Math.exp(-this.yawLag * dt)).normalize();
    this._resolveUp(target);
    this.up.lerp(this._targetUp, 1 - Math.exp(-7 * dt)).normalize();

    const boost = target.boosting ? 1 : 0;
    const dist = this.baseDistance + this.speedDistance * speed01 + boost * 1.6;
    const height = this.baseHeight + this.speedHeight * speed01;

    this._eye.copy(this.pos)
      .addScaledVector(this.fwd, -dist)
      .addScaledVector(this.up, height);

    // Look at a point ahead of the machine, not at the machine itself: it puts
    // the car low in frame and gives the road the screen space it needs.
    this._look.copy(target.position)
      .addScaledVector(target.forward, this.lookAhead)
      .addScaledVector(this.up, this.lookHeight);

    if (this.shake > 0.001) {
      // Deterministic pseudo-random offset — no allocation, no Math.random, and
      // it settles predictably.
      this._shakeSeed += dt * 60;
      const s = this.shake * this.shake * 0.9;
      const ox = Math.sin(this._shakeSeed * 12.9898) * s;
      const oy = Math.sin(this._shakeSeed * 7.233 + 1.7) * s;
      this._tmp.crossVectors(this.fwd, this.up).normalize();
      this._eye.addScaledVector(this._tmp, ox).addScaledVector(this.up, oy);
      this.shake = Math.max(0, this.shake - this.shakeDecay * dt * (0.4 + this.shake));
    }

    this.camera.position.copy(this._eye);
    this.camera.up.copy(this.up);
    this.camera.lookAt(this._look);

    const fov = this.baseFov + this.speedFov * speed01 + boost * 6;
    if (Math.abs(this.camera.fov - fov) > 0.01) {
      this.camera.fov = damp(this.camera.fov, fov, 9, dt);
      this.camera.updateProjectionMatrix();
    }
  }
}
