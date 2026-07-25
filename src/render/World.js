import * as THREE from 'three';
import { skyTexture, groundTexture, metalTexture, fbm } from './Textures.js';
import { makeRng } from '../core/MathUtil.js';
import { TrackFrame } from '../track/TrackPath.js';

/**
 * World — everything that is not the track or the racers: sky, ground and
 * roadside scenery.
 *
 * Two tricks carry most of the weight here. The sky dome and the ground plane
 * both follow the camera rather than existing at fixed world positions, so a
 * circuit that spans 600 metres never runs out of either. The ground's position
 * is snapped to a whole number of texture tiles, which makes a plane that is
 * actually moving with you look completely stationary.
 */

const GROUND_SIZE = 2200;
const GROUND_TILE = 24;      // metres per texture repeat

export class World {
  constructor(scene, theme) {
    this.scene = scene;
    this.theme = theme;
    this.group = new THREE.Group();
    scene.add(this.group);
    this._disposables = [];

    this._buildSky();
    this._buildGround();
  }

  _buildSky() {
    const tex = skyTexture({ height: 128, bands: 16, stops: this.theme.sky });
    // Sky is a lit backdrop, never fogged, and must never write depth or it
    // will occlude the world at the far plane.
    const mat = new THREE.MeshBasicMaterial({
      map: tex, side: THREE.BackSide, fog: false, depthWrite: false,
    });
    // Few segments: the gradient is vertical, so horizontal tessellation buys
    // nothing, and the dithered bands hide the faceting entirely.
    // Comfortably inside the camera's far plane; the dome follows the camera so
    // it never needs to be large enough to contain the circuit.
    const geo = new THREE.SphereGeometry(520, 12, 10);
    this.sky = new THREE.Mesh(geo, mat);
    this.sky.renderOrder = -1000;
    this.sky.frustumCulled = false;
    this.sky.matrixAutoUpdate = false;
    this.group.add(this.sky);
    this._disposables.push(geo, mat);
  }

  _buildGround() {
    const g = this.theme.ground;
    if (!g) return;

    const tex = groundTexture({
      size: 64,
      a: g.color,
      b: shade(g.color, -0.34),
      seed: 7,
      stripe: g.gridLines ? 16 : 0,
    });
    tex.repeat.set(GROUND_SIZE / GROUND_TILE, GROUND_SIZE / GROUND_TILE);

    const mat = new THREE.MeshBasicMaterial({ map: tex, fog: true });
    const geo = new THREE.PlaneGeometry(GROUND_SIZE, GROUND_SIZE, 1, 1);
    geo.rotateX(-Math.PI / 2);
    this.ground = new THREE.Mesh(geo, mat);
    this.ground.position.y = g.y;
    this.ground.frustumCulled = false;
    this.ground.matrixAutoUpdate = false;
    this.ground.renderOrder = -900;
    this.group.add(this.ground);
    this._disposables.push(geo, mat);
    this.groundY = g.y;
  }

  /**
   * Scenery is generated from the track itself so it always frames the road.
   * Objects are placed just beyond the shoulder on both sides at deterministic
   * intervals, then pushed outward by a seeded jitter.
   */
  buildScenery(path) {
    const kind = this.theme.scenery;
    if (!kind) return;
    const rng = makeRng(1337);
    const frame = new TrackFrame();

    const specs = {
      towers: { count: 260, spacing: 11, near: 26, far: 190, minH: 30, maxH: 150, w: 14 },
      spires: { count: 200, spacing: 15, near: 22, far: 220, minH: 12, maxH: 74, w: 11 },
      pylons: { count: 190, spacing: 16, near: 18, far: 120, minH: 20, maxH: 60, w: 5 },
      buoys: { count: 150, spacing: 22, near: 30, far: 180, minH: 5, maxH: 16, w: 7 },
    };
    const spec = specs[kind] ?? specs.spires;

    const geo = new THREE.BoxGeometry(1, 1, 1);
    // Pivot at the base so scaling grows upward from the ground.
    geo.translate(0, 0.5, 0);
    const tex = metalTexture({
      base: shade(this.theme.ground?.color ?? 0x445566, 0.28),
      dark: shade(this.theme.ground?.color ?? 0x223344, -0.42),
      seed: 13,
    });
    const mat = new THREE.MeshBasicMaterial({ map: tex, fog: true });
    this._disposables.push(geo, mat);

    const mesh = new THREE.InstancedMesh(geo, mat, spec.count);
    mesh.frustumCulled = false;
    mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);

    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    const baseY = this.groundY ?? 0;
    let i = 0;

    for (let k = 0; k < spec.count; k++) {
      const s = (k * spec.spacing * 1.7) % path.length;
      path.sampleAt(s, frame);
      const side = rng() < 0.5 ? -1 : 1;
      const lateral = spec.near + rng() * (spec.far - spec.near);
      const d = (frame.width * 0.5 + lateral) * side;

      // Place scenery on the horizontal plane rather than in the track's frame,
      // so banked and elevated sections do not produce leaning buildings.
      pos.set(
        frame.pos.x + frame.side.x * d,
        baseY,
        frame.pos.z + frame.side.z * d,
      );

      const h = spec.minH + Math.pow(rng(), 1.6) * (spec.maxH - spec.minH);
      const w = spec.w * (0.6 + rng() * 0.9);
      scl.set(w, h, w * (0.7 + rng() * 0.6));
      q.setFromAxisAngle(up, rng() * Math.PI);
      m.compose(pos, q, scl);
      mesh.setMatrixAt(i++, m);
    }
    mesh.count = i;
    mesh.instanceMatrix.needsUpdate = true;
    this.group.add(mesh);
    this.scenery = mesh;
  }

  /** Keep the sky and ground centred on the camera. */
  update(camera) {
    if (this.sky) {
      this.sky.position.copy(camera.position);
      this.sky.updateMatrix();
    }
    if (this.ground) {
      // Snapping to a whole tile is what sells the illusion: the plane moves,
      // but its texture lands on exactly the same world alignment every frame,
      // so it reads as infinite stationary ground.
      this.ground.position.x = Math.round(camera.position.x / GROUND_TILE) * GROUND_TILE;
      this.ground.position.z = Math.round(camera.position.z / GROUND_TILE) * GROUND_TILE;
      this.ground.updateMatrix();
    }
  }

  dispose() {
    for (const d of this._disposables) d.dispose?.();
    this._disposables.length = 0;
    this.scene.remove(this.group);
    this.group.clear();
  }
}

/** Lighten (t > 0) or darken (t < 0) a packed colour. */
export function shade(hex, t) {
  let r = (hex >> 16) & 255;
  let g = (hex >> 8) & 255;
  let b = hex & 255;
  if (t >= 0) {
    r += (255 - r) * t; g += (255 - g) * t; b += (255 - b) * t;
  } else {
    r *= 1 + t; g *= 1 + t; b *= 1 + t;
  }
  return (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b);
}
