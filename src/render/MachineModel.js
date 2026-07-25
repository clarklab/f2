import * as THREE from 'three';
import { glowTexture } from './Textures.js';
import { shade } from './World.js';

/**
 * Procedural machine models.
 *
 * Every hull is assembled here from boxes and wedges with per-face colours
 * baked into vertex colours, then rendered with a single unlit material. There
 * are no lights in the scene at all: "lighting" is a fixed brightness per face
 * direction, which is both free and much closer to how sprite-era art actually
 * looked — a top face that is simply a lighter shade of the body colour rather
 * than a shaded gradient.
 *
 * The result is one draw call per machine plus a shared instanced pass for the
 * underglow.
 */

// Fixed shading by face direction. Slightly warmer on top, hard dark underneath
// so the hull reads as solid against the glow.
const FACE = {
  top: 1.0,
  bottom: 0.42,
  front: 0.86,
  back: 0.62,
  side: 0.74,
};

class HullBuilder {
  constructor() {
    this.pos = [];
    this.col = [];
    this.idx = [];
  }

  _push(x, y, z, r, g, b) {
    this.pos.push(x, y, z);
    this.col.push(r, g, b);
    return this.pos.length / 3 - 1;
  }

  _quad(a, b, c, d) {
    this.idx.push(a, b, c, a, c, d);
  }

  /**
   * A box that can taper along its length, which is enough to describe almost
   * every part of a craft like this: fuselages, pods, fins and canopies.
   * @param {object} o  {x,y,z} centre, {w,h,l} size, {wFront,hFront} taper,
   *                    color, shear (nose droop)
   */
  box({ x = 0, y = 0, z = 0, w, h, l, wFront = null, hFront = null, color, yFront = 0, skipBottom = false }) {
    const w0 = w * 0.5;
    const w1 = (wFront ?? w) * 0.5;
    const h0 = h * 0.5;
    const h1 = (hFront ?? h) * 0.5;
    const zb = z + l * 0.5;    // back
    const zf = z - l * 0.5;    // front (-Z is forward)

    const tint = (f) => {
      const c = new THREE.Color(shade(color, 0));
      // Vertex colours are consumed in the linear working space, so convert.
      c.multiplyScalar(f);
      c.convertSRGBToLinear();
      return c;
    };

    const V = (px, py, pz, c) => this._push(px, py, pz, c.r, c.g, c.b);

    const cTop = tint(FACE.top);
    const cBot = tint(FACE.bottom);
    const cFr = tint(FACE.front);
    const cBk = tint(FACE.back);
    const cSd = tint(FACE.side);

    const yb0 = y - h0, yb1 = y + h0;
    const yf0 = y - h1 + yFront, yf1 = y + h1 + yFront;

    // Each face gets its own vertices so colours stay flat rather than blending.
    // top
    this._quad(
      V(x - w0, yb1, zb, cTop), V(x + w0, yb1, zb, cTop),
      V(x + w1, yf1, zf, cTop), V(x - w1, yf1, zf, cTop),
    );
    // bottom
    if (!skipBottom) {
      this._quad(
        V(x - w1, yf0, zf, cBot), V(x + w1, yf0, zf, cBot),
        V(x + w0, yb0, zb, cBot), V(x - w0, yb0, zb, cBot),
      );
    }
    // front
    this._quad(
      V(x - w1, yf0, zf, cFr), V(x + w1, yf0, zf, cFr),
      V(x + w1, yf1, zf, cFr), V(x - w1, yf1, zf, cFr),
    );
    // back
    this._quad(
      V(x + w0, yb0, zb, cBk), V(x - w0, yb0, zb, cBk),
      V(x - w0, yb1, zb, cBk), V(x + w0, yb1, zb, cBk),
    );
    // left (-X)
    this._quad(
      V(x - w0, yb0, zb, cSd), V(x - w0, yb1, zb, cSd),
      V(x - w1, yf1, zf, cSd), V(x - w1, yf0, zf, cSd),
    );
    // right (+X)
    this._quad(
      V(x + w1, yf0, zf, cSd), V(x + w1, yf1, zf, cSd),
      V(x + w0, yb1, zb, cSd), V(x + w0, yb0, zb, cSd),
    );
    return this;
  }

  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

/**
 * Build a machine hull. Silhouettes differ per machine so that a glance at the
 * grid tells you who is who, which matters more than fine detail at this
 * resolution.
 */
export function buildMachineGeometry(machine) {
  const c = machine.colors;
  const b = new HullBuilder();
  // Engine intakes glow even unlit, because they are drawn in a colour brighter
  // than anything else on the hull. At this resolution that is enough — no
  // bloom pass required.
  const ENGINE = 0xdff6ff;

  const shapes = {
    'blue-falcon': () => {
      // Long central fuselage with a drooping nose, twin outboard pods, and a
      // raised rear wing. The classic silhouette.
      b.box({ z: 0.1, w: 1.55, h: 0.6, l: 5.6, wFront: 0.3, hFront: 0.3, color: c.body, yFront: -0.18 });
      b.box({ x: -1.95, z: 0.35, w: 1.2, h: 0.72, l: 4.2, wFront: 0.62, hFront: 0.46, color: c.body, yFront: -0.06 });
      b.box({ x: 1.95, z: 0.35, w: 1.2, h: 0.72, l: 4.2, wFront: 0.62, hFront: 0.46, color: c.body, yFront: -0.06 });
      b.box({ z: 0.3, w: 4.5, h: 0.2, l: 4.8, color: shade(c.body, -0.34) });                  // underbody
      b.box({ z: -1.3, w: 4.6, h: 0.2, l: 1.5, wFront: 3.4, color: shade(c.body, -0.22) });   // front wing
      b.box({ z: 1.9, w: 4.8, h: 0.22, l: 0.9, color: shade(c.body, -0.22) });                 // rear wing
      b.box({ y: 0.46, z: 0.5, w: 0.92, h: 0.44, l: 2.0, wFront: 0.46, hFront: 0.2, color: c.accent });
      b.box({ x: -1.95, y: 0.02, z: 2.42, w: 0.86, h: 0.5, l: 0.3, color: ENGINE });
      b.box({ x: 1.95, y: 0.02, z: 2.42, w: 0.86, h: 0.5, l: 0.3, color: ENGINE });
      b.box({ x: -2.5, y: 0.42, z: 1.95, w: 0.2, h: 0.55, l: 0.7, color: c.trim });            // fins
      b.box({ x: 2.5, y: 0.42, z: 1.95, w: 0.2, h: 0.55, l: 0.7, color: c.trim });
    },
    'golden-fox': () => {
      // Short, wide and stubby — reads instantly as the nimble one.
      b.box({ z: 0.1, w: 2.0, h: 0.56, l: 4.4, wFront: 0.5, hFront: 0.28, color: c.body, yFront: -0.14 });
      b.box({ x: -1.85, z: 0.2, w: 1.3, h: 0.6, l: 3.8, wFront: 0.85, hFront: 0.4, color: shade(c.body, -0.14) });
      b.box({ x: 1.85, z: 0.2, w: 1.3, h: 0.6, l: 3.8, wFront: 0.85, hFront: 0.4, color: shade(c.body, -0.14) });
      b.box({ z: 0.2, w: 4.4, h: 0.2, l: 4.2, color: shade(c.body, -0.34) });                  // underbody
      b.box({ z: -1.5, w: 4.9, h: 0.2, l: 1.0, wFront: 4.2, color: c.trim });
      b.box({ y: 0.42, z: 0.3, w: 1.05, h: 0.42, l: 1.7, wFront: 0.56, hFront: 0.22, color: c.accent });
      b.box({ x: -1.85, y: 0.0, z: 2.16, w: 0.95, h: 0.42, l: 0.3, color: ENGINE });
      b.box({ x: 1.85, y: 0.0, z: 2.16, w: 0.95, h: 0.42, l: 0.3, color: ENGINE });
    },
    'wild-goose': () => {
      // Heavy and slab-sided. Visibly the widest thing on the grid.
      b.box({ z: 0, w: 2.3, h: 0.95, l: 5.0, wFront: 0.85, hFront: 0.5, color: c.body, yFront: -0.1 });
      b.box({ x: -2.1, z: 0.3, w: 1.35, h: 0.95, l: 4.2, wFront: 1.0, hFront: 0.65, color: shade(c.body, -0.2) });
      b.box({ x: 2.1, z: 0.3, w: 1.35, h: 0.95, l: 4.2, wFront: 1.0, hFront: 0.65, color: shade(c.body, -0.2) });
      b.box({ z: 0.2, w: 5.0, h: 0.22, l: 4.6, color: shade(c.body, -0.34) });                 // underbody
      b.box({ y: 0.66, z: 0.4, w: 1.2, h: 0.46, l: 1.8, wFront: 0.68, hFront: 0.24, color: c.accent });
      b.box({ y: 0.62, z: 2.1, w: 3.0, h: 0.5, l: 0.5, color: c.trim });
      b.box({ x: -2.1, y: 0.0, z: 2.36, w: 1.0, h: 0.6, l: 0.3, color: ENGINE });
      b.box({ x: 2.1, y: 0.0, z: 2.36, w: 1.0, h: 0.6, l: 0.3, color: ENGINE });
    },
    'fire-stingray': () => {
      // Long, low and knife-nosed: the top-speed machine.
      b.box({ z: 0.2, w: 1.4, h: 0.5, l: 6.2, wFront: 0.2, hFront: 0.2, color: c.body, yFront: -0.2 });
      b.box({ x: -1.9, z: 0.6, w: 1.05, h: 0.55, l: 3.8, wFront: 0.4, hFront: 0.32, color: c.body });
      b.box({ x: 1.9, z: 0.6, w: 1.05, h: 0.55, l: 3.8, wFront: 0.4, hFront: 0.32, color: c.body });
      b.box({ z: 0.6, w: 4.6, h: 0.18, l: 2.6, wFront: 2.6, color: shade(c.body, -0.3) });     // delta wing
      b.box({ y: 0.36, z: 0.8, w: 0.82, h: 0.38, l: 2.0, wFront: 0.36, hFront: 0.16, color: c.accent });
      b.box({ x: -1.9, y: -0.02, z: 2.3, w: 0.8, h: 0.4, l: 0.3, color: ENGINE });
      b.box({ x: 1.9, y: -0.02, z: 2.3, w: 0.8, h: 0.4, l: 0.3, color: ENGINE });
      b.box({ x: -1.9, y: 0.44, z: 2.1, w: 0.22, h: 0.66, l: 0.7, color: c.trim });
      b.box({ x: 1.9, y: 0.44, z: 2.1, w: 0.22, h: 0.66, l: 0.7, color: c.trim });
    },
  };
  (shapes[machine.id] ?? shapes['blue-falcon'])();
  return b.build();
}

/**
 * MachineView — the renderable half of a Vehicle.
 *
 * Holds the hull, the ground underglow, and the thruster flare, and reads the
 * simulation state each frame. Interpolation between the previous and current
 * physics states happens here so the simulation stays authoritative.
 */
export class MachineView {
  constructor(scene, machine) {
    this.scene = scene;
    this.machine = machine;
    this.group = new THREE.Group();

    const geo = buildMachineGeometry(machine);
    const mat = new THREE.MeshBasicMaterial({ vertexColors: true, fog: true });
    this.hull = new THREE.Mesh(geo, mat);
    this.group.add(this.hull);

    // A higher power concentrates the light under the hull instead of spraying
    // dithered speckle across half the road.
    const glowTex = glowTexture({ size: 32, bands: 4, color: 0xffffff, power: 2.6 });

    // Underglow: a flat additive quad that lies under the machine. Additive
    // blending means it brightens the road rather than tinting it, which is
    // what makes a hovering craft read as hovering.
    const glowMat = new THREE.MeshBasicMaterial({
      map: glowTex,
      color: machine.colors.glow,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
      fog: false,
    });
    const glowGeo = new THREE.PlaneGeometry(5.4, 6.2);
    glowGeo.rotateX(-Math.PI / 2);
    this.underglow = new THREE.Mesh(glowGeo, glowMat);
    this.underglow.position.y = -0.62;
    this.underglow.renderOrder = 3;
    this.group.add(this.underglow);

    // Thruster flare behind the machine.
    const thrustMat = new THREE.MeshBasicMaterial({
      map: glowTex,
      color: machine.colors.glow,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
      fog: false,
    });
    const thrustGeo = new THREE.PlaneGeometry(3.0, 2.4);
    this.thrust = new THREE.Mesh(thrustGeo, thrustMat);
    this.thrust.position.set(0, 0.15, 2.5);
    this.thrust.renderOrder = 3;
    this.group.add(this.thrust);

    this._disposables = [geo, mat, glowGeo, glowMat, thrustGeo, thrustMat];
    scene.add(this.group);
    this._phase = Math.random() * 10;
  }

  /**
   * @param {import('../game/Vehicle.js').Vehicle} v
   * @param {number} alpha interpolation factor between physics states
   * @param {number} time
   */
  update(v, alpha, time) {
    this.group.visible = v.alive;
    if (!v.alive) return;

    this.group.position.lerpVectors(v.prevPos, v.pos, alpha);
    this.group.quaternion.copy(v.prevQuat).slerp(v.quat, alpha);

    // A slow bob so a stationary machine still looks like it is floating.
    const bob = Math.sin(time * 2.4 + this._phase) * 0.06;
    this.hull.position.y = bob;

    const throttle = v.speed01;
    const boosting = v.boosting;

    const ride = Math.max(0.2, v.h);
    // Sit the pool of light on the road rather than under the hull, so it reads
    // as light cast onto the surface instead of a panel bolted to the machine.
    this.underglow.position.y = -ride + 0.12;
    // Higher off the ground spreads the pool wider and dims it, which is the
    // cue that tells you the machine has left the surface.
    const lift = Math.max(0, ride - v.params.rideHeight);
    const spread = 1 + lift * 0.22;
    this.underglow.scale.set(spread, 1, spread);
    const glow = (0.4 + throttle * 0.34 + (boosting ? 0.45 : 0)) / (1 + lift * 0.5);
    this.underglow.material.opacity = Math.min(0.92, glow);

    const flare = 0.35 + throttle * 0.8 + (boosting ? 1.5 : 0);
    this.thrust.scale.set(flare * 0.9, flare, 1);
    this.thrust.material.opacity = Math.min(1, 0.3 + throttle * 0.6 + (boosting ? 0.6 : 0));
    this.thrust.material.color.set(boosting ? 0xffffff : this.machine.colors.glow);
  }

  dispose() {
    this.scene.remove(this.group);
    for (const d of this._disposables) d.dispose?.();
  }
}
