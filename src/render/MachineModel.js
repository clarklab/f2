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
// Flat sides are what makes these read as painted models rather than as lit
// geometry, but the falloff has to stay shallow: the reference art is brightly
// saturated all over, and a side face at 0.74 of a mid-tone green comes out
// near-black once a part is also darkened to sit under something else.
const FACE = {
  top: 1.0,
  bottom: 0.46,
  front: 0.88,
  back: 0.70,
  side: 0.82,
};

const _m = new THREE.Matrix4();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();

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
   * A tapering, shearable, rotatable box. It sounds like a lot of knobs for one
   * primitive, but between them they describe every part of a craft like this:
   *
   *   wFront/hFront   nose cones, knife edges, flared exhaust bells
   *   xFront/yFront   pods that lean in toward the nose, drooping noses
   *   rx/ry/rz        dihedral on winglets, swept leading-edge trim, canted fins
   *   faces           per-face brightness, which is how canopy glass gets its
   *                   blown-out highlight without a second material
   *
   * Forward is -Z. Rotations are applied about the part's own centre, then the
   * part is translated into place, so `rz` on a wing at x = +2 tilts the wing
   * rather than swinging it around the hull.
   */
  box({
    x = 0, y = 0, z = 0, w, h, l,
    wFront = null, hFront = null, xFront = 0, yFront = 0,
    rx = 0, ry = 0, rz = 0,
    color, faces = null, skipBottom = false,
  }) {
    const w0 = w * 0.5;
    const w1 = (wFront ?? w) * 0.5;
    const h0 = h * 0.5;
    const h1 = (hFront ?? h) * 0.5;
    const zb = l * 0.5;    // back
    const zf = -l * 0.5;   // front

    const base = shade(color, 0);
    const tint = (key) => {
      const c = new THREE.Color(base);
      // Vertex colours are consumed in the linear working space, so convert.
      // A factor above 1 is deliberate and clips to white at the blit — that is
      // the glint on a canopy.
      c.multiplyScalar(faces?.[key] ?? FACE[key]);
      c.convertSRGBToLinear();
      return c;
    };

    const rotated = rx !== 0 || ry !== 0 || rz !== 0;
    if (rotated) _m.makeRotationFromEuler(_e.set(rx, ry, rz, 'ZYX'));

    const V = (px, py, pz, c) => {
      if (rotated) {
        _v.set(px, py, pz).applyMatrix4(_m);
        return this._push(_v.x + x, _v.y + y, _v.z + z, c.r, c.g, c.b);
      }
      return this._push(px + x, py + y, pz + z, c.r, c.g, c.b);
    };

    const cTop = tint('top');
    const cBot = tint('bottom');
    const cFr = tint('front');
    const cBk = tint('back');
    const cSd = tint('side');

    const yb0 = -h0, yb1 = h0;
    const yf0 = -h1 + yFront, yf1 = h1 + yFront;
    const xf0 = -w1 + xFront, xf1 = w1 + xFront;

    // Each face gets its own vertices so colours stay flat rather than blending.
    // top
    this._quad(
      V(-w0, yb1, zb, cTop), V(w0, yb1, zb, cTop),
      V(xf1, yf1, zf, cTop), V(xf0, yf1, zf, cTop),
    );
    // bottom
    if (!skipBottom) {
      this._quad(
        V(xf0, yf0, zf, cBot), V(xf1, yf0, zf, cBot),
        V(w0, yb0, zb, cBot), V(-w0, yb0, zb, cBot),
      );
    }
    // front
    this._quad(
      V(xf0, yf0, zf, cFr), V(xf1, yf0, zf, cFr),
      V(xf1, yf1, zf, cFr), V(xf0, yf1, zf, cFr),
    );
    // back
    this._quad(
      V(w0, yb0, zb, cBk), V(-w0, yb0, zb, cBk),
      V(-w0, yb1, zb, cBk), V(w0, yb1, zb, cBk),
    );
    // left (-X)
    this._quad(
      V(-w0, yb0, zb, cSd), V(-w0, yb1, zb, cSd),
      V(xf0, yf1, zf, cSd), V(xf0, yf0, zf, cSd),
    );
    // right (+X)
    this._quad(
      V(xf1, yf0, zf, cSd), V(xf1, yf1, zf, cSd),
      V(w0, yb1, zb, cSd), V(w0, yb0, zb, cSd),
    );
    return this;
  }

  /**
   * Mirror a part across the centreline. Almost everything on these craft comes
   * in pairs, and writing each one twice is how a pod ends up 0.05 out of line
   * on one side only.
   */
  pair(o) {
    this.box({ ...o, x: -o.x, xFront: -(o.xFront ?? 0), ry: -(o.ry ?? 0), rz: -(o.rz ?? 0) });
    this.box(o);
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
  const DARK = 0x0a0d14;                 // intake mouths and shadow gaps
  const dk = (n) => shade(c.body, -n);
  // The canopy is the one part that has to read as a different *material*
  // rather than a different colour, so its top face is pushed past white. It
  // clips at the blit, which is exactly the blown-out glint the reference art
  // paints in by hand.
  const GLASS = { top: 1.45, front: 1.1, side: 0.95 };

  const shapes = {
    'blue-falcon': () => {
      // The archetype: a long central gondola drawn to a spear point, twin
      // outboard booms leaning in toward the nose, canopy raised proud of the
      // spine, and everything swept back to a pair of flared exhaust bells.
      b.box({ z: 0.9, w: 1.7, h: 0.78, l: 3.0, wFront: 1.5, hFront: 0.68, color: c.body });
      b.box({ z: -1.3, w: 1.5, h: 0.68, l: 2.2, wFront: 0.4, hFront: 0.28, color: c.body, yFront: -0.16 });
      b.box({ z: -3.0, w: 0.38, h: 0.26, l: 1.7, wFront: 0.05, hFront: 0.05, color: c.trim, yFront: -0.1 });
      b.box({ y: -0.34, z: 0.4, w: 4.3, h: 0.26, l: 4.8, color: dk(0.3) });           // ventral plate

      // Booms. `xFront` is what makes them converge on the nose instead of
      // running parallel, which is the single most recognisable thing about
      // this silhouette.
      b.pair({ x: 2.0, z: 0.4, w: 1.15, h: 0.82, l: 4.6, wFront: 0.6, hFront: 0.44, xFront: -0.3, color: c.body });
      b.pair({ x: 2.0, y: 0.44, z: 0.5, w: 0.46, h: 0.08, l: 4.0, wFront: 0.24, xFront: -0.24, color: c.accent });
      b.pair({ x: 2.0, y: 0.3, z: -1.2, w: 0.66, h: 0.12, l: 0.9, color: DARK });     // intake slots

      // Canopy: an opaque frame with the glass sitting inside it, so the
      // silhouette still has a hard edge when the glass blows out to white.
      b.box({ y: 0.52, z: -0.2, w: 1.16, h: 0.44, l: 2.4, wFront: 0.6, hFront: 0.2, color: dk(0.32) });
      b.box({ y: 0.64, z: -0.28, w: 0.9, h: 0.34, l: 2.0, wFront: 0.42, hFront: 0.12, color: c.glass, faces: GLASS });

      b.pair({ x: 1.5, y: 0.02, z: -1.9, w: 1.7, h: 0.14, l: 1.3, wFront: 1.0, xFront: 0.2, rz: 0.2, color: dk(0.2) });  // canards
      b.pair({ x: 1.4, y: 0.42, z: 2.3, w: 0.2, h: 0.5, l: 0.5, color: DARK });       // wing pylons
      b.box({ y: 0.66, z: 2.3, w: 4.4, h: 0.16, l: 0.9, wFront: 4.0, color: dk(0.22) });
      b.pair({ x: 2.35, y: 0.55, z: 2.0, w: 0.22, h: 0.9, l: 1.3, hFront: 0.5, rz: 0.24, color: c.trim });               // tail fins
      // Exhaust: a dark cowl with a small bright nozzle poking just past its
      // back face. A big flat panel of engine colour reads as a white block
      // from behind; a bright core inside a dark ring reads as a jet.
      b.pair({ x: 2.0, y: 0.05, z: 2.45, w: 1.14, h: 0.76, l: 0.6, color: dk(0.34) });
      b.pair({ x: 2.0, y: 0.05, z: 2.62, w: 0.58, h: 0.32, l: 0.4, wFront: 0.5, hFront: 0.28, color: ENGINE });
    },

    'golden-fox': () => {
      // A flat chisel. Almost all of its mass is a single wide wedge, the
      // canopy is set low and far forward, and the livery does the rest: it
      // should read as the light, darty one before you have parsed any detail.
      // Gold is the one body colour that will not survive being darkened to
      // separate the parts — it goes straight to brown. So the wing, hull and
      // pods all sit at full body colour and the *shape* does the separating.
      b.box({ z: 0.5, w: 5.0, h: 0.2, l: 3.8, wFront: 2.2, color: c.body });          // wing plate
      b.box({ z: 0.3, w: 3.5, h: 0.52, l: 5.2, wFront: 0.8, hFront: 0.24, color: c.body, yFront: -0.12 });
      b.box({ z: -2.55, w: 1.15, h: 0.3, l: 1.5, wFront: 0.36, hFront: 0.12, color: c.trim, yFront: -0.06 });
      b.box({ y: -0.26, z: 0.4, w: 4.4, h: 0.24, l: 4.4, color: dk(0.3) });           // ventral plate

      // One swept chevron per side, its `ry` set to the wing's own leading-edge
      // angle so the stripe runs along the edge instead of wandering off it.
      // The reference paints on several; at this resolution a second stripe
      // stops reading as livery and starts reading as a crack across the wing.
      b.pair({ x: 1.6, y: 0.16, z: 0.5, w: 0.28, h: 0.07, l: 3.4, ry: 0.35, color: c.trim });

      b.box({ y: 0.4, z: -0.9, w: 1.4, h: 0.36, l: 2.1, wFront: 0.66, hFront: 0.16, color: c.accent });
      b.box({ y: 0.5, z: -0.98, w: 1.12, h: 0.28, l: 1.85, wFront: 0.46, hFront: 0.1, color: c.glass, faces: GLASS });

      b.pair({ x: 1.9, z: 0.95, w: 1.25, h: 0.66, l: 3.3, wFront: 0.85, hFront: 0.4, xFront: -0.12, color: c.body });
      b.pair({ x: 1.9, y: 0.3, z: 0.1, w: 0.72, h: 0.1, l: 1.3, color: c.accent });   // pod vents
      b.pair({ x: 2.5, y: 0.18, z: -0.2, w: 0.36, h: 0.12, l: 1.5, wFront: 0.18, xFront: 0.14, rz: 0.3, color: c.trim });  // winglets
      b.pair({ x: 1.7, y: 0.3, z: 2.25, w: 0.18, h: 0.42, l: 0.4, color: c.accent });
      b.box({ y: 0.53, z: 2.25, w: 4.1, h: 0.16, l: 0.7, color: c.trim });            // spoiler
      b.pair({ x: 1.9, y: 0.0, z: 2.3, w: 1.22, h: 0.68, l: 0.55, color: dk(0.28) });
      b.pair({ x: 1.9, y: 0.0, z: 2.46, w: 0.6, h: 0.3, l: 0.4, wFront: 0.52, hFront: 0.26, color: ENGINE });
    },

    'wild-goose': () => {
      // Military hardware rather than a racer: a blunt armoured hull with
      // stepped shoulder plating, a bumper across the nose, a roll bar over the
      // engine deck and intakes big enough to see from the back of the grid.
      b.box({ z: 0.1, w: 2.5, h: 1.05, l: 5.0, wFront: 1.5, hFront: 0.66, color: c.body, yFront: -0.04 });
      b.box({ z: -2.6, w: 1.55, h: 0.62, l: 0.9, wFront: 1.25, hFront: 0.44, color: dk(0.18) });
      b.box({ z: -3.0, w: 2.5, h: 0.28, l: 0.42, wFront: 2.2, color: c.trim });        // bumper
      b.box({ y: -0.44, z: 0.2, w: 5.2, h: 0.34, l: 4.8, color: dk(0.3) });            // skirt

      b.pair({ x: 2.2, z: 0.35, w: 1.5, h: 1.05, l: 4.2, wFront: 1.1, hFront: 0.66, color: dk(0.1) });
      b.pair({ x: 2.2, y: 0.6, z: 0.6, w: 1.3, h: 0.3, l: 3.0, wFront: 1.0, color: c.body });  // shoulder step
      // Armour ribs. Three is the fewest that reads as plating rather than as a
      // stray line, and they are what make this thing look welded together.
      for (let i = 0; i < 3; i++) {
        b.pair({ x: 2.2, y: 0.77, z: -0.4 + i * 0.9, w: 1.24, h: 0.1, l: 0.24, color: c.accent });
      }
      b.pair({ x: 2.2, y: 0.12, z: -1.6, w: 1.05, h: 0.52, l: 0.55, color: DARK });    // intakes

      b.box({ y: 0.68, z: 0.0, w: 1.5, h: 0.52, l: 2.0, wFront: 1.0, hFront: 0.28, color: dk(0.28) });
      b.box({ y: 0.8, z: -0.08, w: 1.2, h: 0.4, l: 1.7, wFront: 0.76, hFront: 0.18, color: c.glass, faces: GLASS });

      b.pair({ x: 1.35, y: 0.78, z: 1.55, w: 0.3, h: 0.72, l: 0.36, color: dk(0.2) });  // roll bar
      b.box({ y: 1.02, z: 1.55, w: 2.95, h: 0.28, l: 0.42, color: c.trim });
      b.pair({ x: 2.2, y: 0.02, z: 2.3, w: 1.44, h: 0.98, l: 0.6, color: dk(0.28) });
      b.pair({ x: 2.2, y: 0.02, z: 2.47, w: 0.74, h: 0.44, l: 0.4, wFront: 0.64, hFront: 0.38, color: ENGINE });
    },

    'fire-stingray': () => {
      // A manta. One enormous flat delta carrying a knife nose, with the canopy
      // sunk flush into the wing rather than perched on it — no vertical mass
      // anywhere except the wingtip fins.
      b.box({ z: 0.7, w: 5.4, h: 0.24, l: 4.6, wFront: 0.9, color: c.body });
      b.box({ y: -0.16, z: 0.85, w: 4.9, h: 0.2, l: 4.0, wFront: 0.8, color: dk(0.28) });
      b.box({ z: 0.2, w: 1.6, h: 0.58, l: 5.4, wFront: 0.34, hFront: 0.18, color: c.body, yFront: -0.14 });
      // Nose and fins take the *pale* colour, not the dark one. A near-black
      // spear on a red delta does not read as a nose cone, it reads as a gap.
      b.box({ z: -3.2, w: 0.36, h: 0.2, l: 1.9, wFront: 0.03, hFront: 0.03, color: c.accent, yFront: -0.06 });

      // Trim swept along the leading edge, following the wing rather than the
      // hull. This is the detail that stops the delta reading as a flat slab.
      b.pair({ x: 1.5, y: 0.18, z: 0.7, w: 0.26, h: 0.08, l: 4.6, ry: 0.45, color: c.trim });

      b.box({ y: 0.36, z: -0.6, w: 1.3, h: 0.32, l: 2.5, wFront: 0.5, hFront: 0.12, color: dk(0.26) });
      b.box({ y: 0.45, z: -0.68, w: 1.02, h: 0.26, l: 2.25, wFront: 0.34, hFront: 0.08, color: c.glass, faces: GLASS });

      b.pair({ x: 1.75, z: 1.4, w: 1.15, h: 0.58, l: 2.4, wFront: 0.72, hFront: 0.36, color: c.body });
      b.pair({ x: 1.75, y: 0.28, z: 0.7, w: 0.6, h: 0.1, l: 1.1, color: c.trim });
      b.pair({ x: 2.6, y: 0.34, z: 1.2, w: 0.22, h: 0.85, l: 1.6, hFront: 0.34, rz: 0.28, color: c.accent });  // wingtip fins
      b.box({ y: 0.44, z: 2.45, w: 3.2, h: 0.14, l: 0.6, color: c.trim });
      b.pair({ x: 1.75, y: 0.0, z: 2.35, w: 1.2, h: 0.74, l: 0.55, color: dk(0.28) });
      b.pair({ x: 1.75, y: 0.0, z: 2.52, w: 0.6, h: 0.32, l: 0.4, wFront: 0.52, hFront: 0.28, color: ENGINE });
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
    // Behind the nozzles, which now protrude to ~2.8. In front of them the
    // flare would be depth-tested away by the very thing it is meant to be
    // coming out of.
    this.thrust.position.set(0, 0.12, 2.95);
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
