import * as THREE from 'three';
import { skyTexture, groundTexture } from './Textures.js';
import { buildEnvironment, updateSun } from './Scenery.js';

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
   * Hand the track to the environment builder for this theme. Each circuit gets
   * its own set of prop models — see Scenery.js — rather than the same box
   * field recoloured.
   */
  buildScenery(path) {
    const env = buildEnvironment(this.theme.env ?? this.theme.scenery, path, this.group, this.groundY ?? 0);
    this._disposables.push(...env.disposables);
    this.sceneryMeshes = env.meshes;
    this.sun = env.sun;
  }

  /** Keep the sky, sun and ground centred on the camera. */
  update(camera) {
    updateSun(this.sun, camera);
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
