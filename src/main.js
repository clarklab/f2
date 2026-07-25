import './style.css';
import * as THREE from 'three';
import { Display } from './core/Display.js';
import { Loop } from './core/Loop.js';
import { Input } from './core/Input.js';
import { PixelRenderer } from './render/PixelRenderer.js';
import { World } from './render/World.js';
import { MachineView } from './render/MachineModel.js';
import { TrackPath } from './track/TrackPath.js';
import { TrackMesh } from './track/TrackBuilder.js';
import { TRACKS, THEMES, trackById } from './track/tracks.js';
import { ChaseCamera } from './game/ChaseCamera.js';
import { Vehicle } from './game/Vehicle.js';
import { MACHINES, machineParams, machineById } from './game/Machines.js';

/**
 * Entry point. Owns the display, the loop and the active scene, and routes the
 * fixed-step update into whatever mode is running.
 */

class Game {
  constructor() {
    this.display = new Display();
    this.input = new Input(this.display);
    this.renderer = new PixelRenderer(this.display.sceneCanvas);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(
      62, this.display.width / this.display.height, 0.6, 1100,
    );
    this.chaseCam = new ChaseCamera(this.camera);

    this.time = 0;
    this.machineId = MACHINES[0].id;

    this.loadTrack(TRACKS[0].id);

    this.loop = new Loop({
      hz: 120,
      update: (dt) => this.update(dt),
      render: (alpha, frameDt) => this.render(alpha, frameDt),
    });
    this.loop.start();
  }

  loadTrack(id) {
    this.trackDef = trackById(id);
    this.theme = THEMES[this.trackDef.theme];

    if (this.trackMesh) { this.scene.remove(this.trackMesh.group); this.trackMesh.dispose(); }
    if (this.world) this.world.dispose();
    if (this.playerView) this.playerView.dispose();

    this.path = new TrackPath(this.trackDef.controlPoints, {
      step: 1.25,
      // Gentle: a 100 m radius corner comes out around 13 degrees. True
      // physical banking at these speeds would be near-vertical, which reads as
      // a wall rather than a racetrack.
      autoBank: 22,
      maxAutoBank: 16,
      defaultWidth: this.trackDef.width,
    });

    this.scene.fog = new THREE.Fog(this.theme.fog, this.theme.fogNear, this.theme.fogFar);
    this.scene.background = new THREE.Color(this.theme.fog);

    this.world = new World(this.scene, this.theme);
    this.world.buildScenery(this.path);

    this.trackMesh = new TrackMesh(this.path, this.theme, this.trackDef.zones);
    this.scene.add(this.trackMesh.group);

    const machine = machineById(this.machineId);
    this.player = new Vehicle(machineParams(this.machineId), this.path, this.trackMesh, {
      isPlayer: true, index: 0,
    });
    this.player.spawn(0, 0);
    this.player.boostCharges = 3;
    this.playerView = new MachineView(this.scene, machine);

    this.chaseCam.initialised = false;
  }

  update(dt) {
    this.time += dt;
    this.input.update(dt);

    if (this.input.boostPressed) this.player.fireBoost();

    this.player.update(dt, {
      steer: this.input.steer,
      throttle: this.input.throttle,
      brake: this.input.brake,
      leanLeft: this.input.leanLeft,
      leanRight: this.input.leanRight,
    }, this.trackDef.wind);

    // Respawn if the machine is destroyed, so the prototype keeps running.
    if (!this.player.alive) {
      this.player.spawn(this.player.s, 0);
      this.player.boostCharges = 3;
    }
  }

  render(alpha, frameDt = 1 / 60) {
    const p = this.player;

    this.playerView.update(p, alpha, this.time);

    this._camTarget ??= {
      position: new THREE.Vector3(),
      forward: new THREE.Vector3(),
      up: new THREE.Vector3(),
      speed01: 0,
      boosting: false,
    };
    this._camTarget.position.copy(this.playerView.group.position).addScaledVector(p.up, 1.2);
    this._camTarget.forward.copy(p.heading);
    this._camTarget.up.copy(p.up);
    this._camTarget.speed01 = p.speed01;
    this._camTarget.boosting = p.boosting;

    this.chaseCam.update(this._camTarget, Math.min(frameDt, 0.05));

    if (p.events.impact > 0) this.chaseCam.addShake(p.events.impact * 0.55);
    p.clearEvents();

    this.world.update(this.camera);
    this.trackMesh.update(p.s, this.theme.fogFar);

    this.renderer.render(this.scene, this.camera);
    this.input.endFrame();
  }
}

const game = new Game();
// Handy for poking at things from the console and for automated screenshots.
window.__game = game;
window.__THREE = THREE;
