import './style.css';
import * as THREE from 'three';
import { Display } from './core/Display.js';
import { Loop } from './core/Loop.js';
import { Input, Action } from './core/Input.js';
import { Save } from './core/Save.js';
import { clamp, clamp01, damp, formatTime } from './core/MathUtil.js';
import { PixelRenderer } from './render/PixelRenderer.js';
import { World } from './render/World.js';
import { MachineView } from './render/MachineModel.js';
import { TrackPath, TrackFrame } from './track/TrackPath.js';
import { TrackMesh } from './track/TrackBuilder.js';
import { SurfaceMap, SURFACE } from './track/SurfaceMap.js';
import { TRACKS, THEMES, trackById, GRAND_PRIX } from './track/tracks.js';
import { ChaseCamera } from './game/ChaseCamera.js';
import { Race, RACE_STATE } from './game/Race.js';
import { MACHINES, machineById } from './game/Machines.js';
import { UI, PAL } from './ui/UI.js';
import { Audio } from './audio/Audio.js';
import { TITLE_SONG, songForTheme } from './audio/songs.js';

/**
 * Game — the state machine and the wiring between every subsystem.
 *
 * Screens are immediate mode: `_screen` decides which update/draw pair runs.
 * The 3D scene stays live behind the menus (the title runs a camera flight
 * around the first circuit, machine select renders the actual machine you are
 * choosing), which costs nothing extra and is far more alive than a static
 * background.
 */

const SCREEN = {
  TITLE: 'title',
  MODE: 'mode',
  MACHINE: 'machine',
  TRACK: 'track',
  RACE: 'race',
  RESULTS: 'results',
  RETIRED: 'retired',
  PAUSE: 'pause',
};

class Game {
  constructor() {
    this.display = new Display();
    this.input = new Input(this.display);
    this.renderer = new PixelRenderer(this.display.sceneCanvas);
    this.ui = new UI(this.display);
    this.audio = new Audio();

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(
      62, this.display.width / this.display.height, 0.6, 1100,
    );
    this.chaseCam = new ChaseCamera(this.camera);

    this.time = 0;
    this.fade = 0;
    this.flash = 0;
    this.banner = null;
    this.debug = false;

    const s = Save.data.settings;
    this.machineId = s.machineId ?? MACHINES[0].id;
    this.difficulty = s.difficulty ?? 1;
    this.input.autoAccelerate = s.autoAccelerate !== false;
    this.audio.setMuted(!!s.muted);

    // Circuits are compiled once; building all six costs a few milliseconds and
    // means the track picker can show real previews immediately.
    this.paths = {};
    this.surfaceMaps = {};
    for (const t of TRACKS) {
      const path = new TrackPath(t.controlPoints, {
        step: 1.25, autoBank: 22, maxAutoBank: 16, defaultWidth: t.width,
      });
      this.paths[t.id] = path;
      this.surfaceMaps[t.id] = new SurfaceMap(path, t.zones);
    }

    this.menuIndex = 0;
    this.machineIndex = Math.max(0, MACHINES.findIndex((m) => m.id === this.machineId));
    this.trackIndex = 0;
    this.pauseIndex = 0;
    this.menuRects = [];

    this.cup = null;
    this._audioArmed = false;
    this._armAudio();

    this.loadTrack(TRACKS[0].id, { cinematic: true });
    this.setScreen(SCREEN.TITLE);

    this.loop = new Loop({
      hz: 120,
      update: (dt) => this.update(dt),
      render: (alpha, frameDt) => this.render(alpha, frameDt),
    });
    this.loop.start();

    window.addEventListener('keydown', (e) => {
      if (e.code === 'F3') { this.debug = !this.debug; e.preventDefault(); }
      if (e.code === 'KeyM') this.toggleMute();
    });
  }

  // -------------------------------------------------------------------
  // Audio unlock
  // -------------------------------------------------------------------

  _armAudio() {
    this.audio.init();
    const unlock = async () => {
      if (this._audioArmed) return;
      const ok = await this.audio.unlock();
      if (!ok) return;
      this._audioArmed = true;
      for (const ev of ['pointerdown', 'keydown', 'touchend']) {
        document.removeEventListener(ev, unlock, true);
      }
      this._onAudioReady();
    };
    for (const ev of ['pointerdown', 'keydown', 'touchend']) {
      document.addEventListener(ev, unlock, { capture: true, passive: true });
    }
  }

  _onAudioReady() {
    if (this._screen === SCREEN.RACE) {
      this.audio.playMusic(songForTheme(this.trackDef.theme));
      this.audio.startEngine();
    } else {
      this.audio.playMusic(TITLE_SONG);
    }
  }

  toggleMute() {
    const muted = !Save.data.settings.muted;
    Save.setSetting('muted', muted);
    this.audio.setMuted(muted);
  }

  // -------------------------------------------------------------------
  // Scene
  // -------------------------------------------------------------------

  loadTrack(id, { cinematic = false } = {}) {
    this.trackDef = trackById(id);
    this.theme = THEMES[this.trackDef.theme];
    this.path = this.paths[id];
    this.surfaces = this.surfaceMaps[id];

    if (this.trackMesh) { this.scene.remove(this.trackMesh.group); this.trackMesh.dispose(); }
    if (this.world) this.world.dispose();
    this._disposeViews();

    this.scene.fog = new THREE.Fog(this.theme.fog, this.theme.fogNear, this.theme.fogFar);
    this.scene.background = new THREE.Color(this.theme.fog);

    this.world = new World(this.scene, this.theme);
    this.world.buildScenery(this.path);

    this.trackMesh = new TrackMesh(this.path, this.theme, this.trackDef.zones);
    this.scene.add(this.trackMesh.group);

    this.cinematic = cinematic;
    this.cinematicS = 0;
    this.chaseCam.initialised = false;
  }

  _disposeViews() {
    if (this.views) for (const v of this.views) v.dispose();
    this.views = null;
  }

  // -------------------------------------------------------------------
  // Screens
  // -------------------------------------------------------------------

  setScreen(name) {
    this._screen = name;
    this.menuIndex = 0;
    this.menuRects = [];
    if (name === SCREEN.TITLE || name === SCREEN.MODE || name === SCREEN.TRACK) {
      this.cinematic = true;
    }
    if (name === SCREEN.MACHINE) this._ensureShowcase();
  }

  _ensureShowcase() {
    if (this.showcase) {
      this._setShowcaseMachine();
      return;
    }
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a0e1e);
    scene.fog = new THREE.Fog(0x0a0e1e, 14, 40);
    // A portrait viewport is narrow, so the horizontal field of view is much
    // tighter than the vertical number suggests: at 40 degrees vertical and a
    // 9:16 frame the camera only sees about 23 degrees across. The machine is
    // 5 m wide, so it needs real distance to fit.
    const camera = new THREE.PerspectiveCamera(
      40, this.display.width / this.display.height, 0.5, 120,
    );
    camera.position.set(0, 6.2, 20);
    camera.lookAt(0, -0.6, 0);
    this.showcase = { scene, camera, view: null, spin: 0 };
    this._setShowcaseMachine();
  }

  _setShowcaseMachine() {
    const machine = MACHINES[this.machineIndex];
    if (this.showcase.view) this.showcase.view.dispose();
    this.showcase.view = new MachineView(this.showcase.scene, machine);
    // Showcase machines sit still; the underglow would otherwise be pinned to a
    // road that is not there.
    this.showcase.view.underglow.visible = false;
  }

  // -------------------------------------------------------------------
  // Race lifecycle
  // -------------------------------------------------------------------

  startRace({ mode = 'race', trackId = null, cup = null } = {}) {
    const id = trackId ?? this.trackDef.id;
    if (id !== this.trackDef.id) this.loadTrack(id);
    this.cinematic = false;

    this.race = new Race({
      path: this.path,
      surfaces: this.surfaces,
      trackDef: this.trackDef,
      machineId: this.machineId,
      mode,
      difficulty: this.difficulty,
      opponents: mode === 'trial' ? 0 : 11,
      spares: this.cup?.spares ?? 2,
    });

    this._disposeViews();
    this.views = this.race.entries.map((e) => new MachineView(this.scene, e.machine));

    this.chaseCam.initialised = false;
    this.setScreen(SCREEN.RACE);
    this.banner = null;
    this.newRecord = false;

    this.audio.playMusic(songForTheme(this.trackDef.theme));
    this.audio.startEngine();
  }

  restartRace() {
    this.startRace({ mode: this.race?.mode ?? 'race', trackId: this.trackDef.id });
  }

  startGrandPrix() {
    this.cup = {
      index: 0,
      spares: 2,
      totals: new Map(),
      order: [...GRAND_PRIX.trackIds],
    };
    this.startRace({ mode: 'gp', trackId: this.cup.order[0] });
  }

  _advanceCup() {
    if (!this.cup) return false;
    // Accumulate championship points across the whole field so the standings
    // are a real championship rather than just the player's tally.
    for (const e of this.race.entries) {
      const key = e.name;
      const prev = this.cup.totals.get(key) ?? { name: e.name, isPlayer: e.isPlayer, points: 0 };
      prev.points += e.points;
      this.cup.totals.set(key, prev);
    }
    this.cup.index++;
    return this.cup.index < this.cup.order.length;
  }

  get cupStandings() {
    if (!this.cup) return null;
    return [...this.cup.totals.values()].sort((a, b) => b.points - a.points);
  }

  // -------------------------------------------------------------------
  // Update
  // -------------------------------------------------------------------

  update(dt) {
    this.time += dt;
    this.ui.tick(dt);
    // Driving zones exist only while a race is actually running.
    this.input.drivingControls = this._screen === SCREEN.RACE;
    this.input.update(dt);

    switch (this._screen) {
      case SCREEN.TITLE: this._updateTitle(dt); break;
      case SCREEN.MODE: this._updateMode(dt); break;
      case SCREEN.MACHINE: this._updateMachine(dt); break;
      case SCREEN.TRACK: this._updateTrack(dt); break;
      case SCREEN.RACE: this._updateRace(dt); break;
      case SCREEN.PAUSE: this._updatePause(dt); break;
      case SCREEN.RESULTS: this._updateResults(dt); break;
      case SCREEN.RETIRED: this._updateRetired(dt); break;
      default: break;
    }

    if (this.cinematic) {
      // Idle flight around the circuit behind the menus.
      this.cinematicS = this.path.wrapS(this.cinematicS + 62 * dt);
    }

    this.flash = Math.max(0, this.flash - dt * 3.2);
    if (this.banner) {
      this.banner.t -= dt;
      if (this.banner.t <= 0) this.banner = null;
    }
  }

  /** Shared menu navigation: returns the chosen index, or -1. */
  _navigate(count, { horizontal = false } = {}) {
    const inp = this.input;
    const prev = horizontal ? Action.LEFT : Action.UP;
    const next = horizontal ? Action.RIGHT : Action.DOWN;
    let moved = 0;
    if (inp.pressed(prev)) moved = -1;
    if (inp.pressed(next)) moved = 1;
    if (moved) {
      this.menuIndex = (this.menuIndex + moved + count) % count;
      this.audio.uiMove();
    }

    // Touch: a tap inside a listed rect both selects and confirms.
    const tap = inp.tapPoint;
    if (tap) {
      for (const r of this.menuRects) {
        if (tap.x >= r.x && tap.x <= r.x + r.w && tap.y >= r.y && tap.y <= r.y + r.h) {
          if (this.menuIndex === r.index) return r.index;
          this.menuIndex = r.index;
          this.audio.uiMove();
          return -1;
        }
      }
    }
    if (inp.pressed(Action.CONFIRM)) return this.menuIndex;
    return -1;
  }

  _updateTitle() {
    if (this.input.pressed(Action.CONFIRM)) {
      this.audio.uiConfirm();
      this.setScreen(SCREEN.MODE);
    }
  }

  _updateMode() {
    const chosen = this._navigate(4);
    if (chosen < 0) {
      if (this.input.pressed(Action.BACK)) { this.audio.uiBack(); this.setScreen(SCREEN.TITLE); }
      return;
    }
    this.audio.uiConfirm();
    this.pendingMode = ['gp', 'race', 'trial', 'practice'][chosen];
    this.setScreen(SCREEN.MACHINE);
  }

  _updateMachine(dt) {
    const inp = this.input;
    let moved = 0;
    if (inp.pressed(Action.LEFT)) moved = -1;
    if (inp.pressed(Action.RIGHT)) moved = 1;

    // Tapping the left or right third of the model area cycles machines.
    const tap = inp.tapPoint;
    if (tap && tap.y > 80 && tap.y < 300) {
      if (tap.x < this.display.width * 0.28) moved = -1;
      else if (tap.x > this.display.width * 0.72) moved = 1;
      else moved = 0;
    }

    if (moved) {
      this.machineIndex = (this.machineIndex + moved + MACHINES.length) % MACHINES.length;
      this.machineId = MACHINES[this.machineIndex].id;
      Save.setSetting('machineId', this.machineId);
      this._setShowcaseMachine();
      this.audio.uiMove();
    }

    this.showcase.spin += dt * 0.7;

    if (inp.pressed(Action.BACK)) { this.audio.uiBack(); this.setScreen(SCREEN.MODE); return; }
    const confirmTap = tap && tap.y >= 300;
    if (inp.pressed(Action.CONFIRM) || confirmTap) {
      this.audio.uiConfirm();
      if (this.pendingMode === 'gp') this.startGrandPrix();
      else this.setScreen(SCREEN.TRACK);
    }
  }

  _updateTrack() {
    const inp = this.input;
    let moved = 0;
    if (inp.pressed(Action.LEFT)) moved = -1;
    if (inp.pressed(Action.RIGHT)) moved = 1;
    if (moved) {
      this.trackIndex = (this.trackIndex + moved + TRACKS.length) % TRACKS.length;
      this.audio.uiMove();
      this.loadTrack(TRACKS[this.trackIndex].id, { cinematic: true });
    }

    const tap = inp.tapPoint;
    if (tap) {
      for (const r of this.menuRects) {
        if (tap.x >= r.x && tap.x <= r.x + r.w && tap.y >= r.y && tap.y <= r.y + r.h) {
          if (r.index === this.trackIndex) {
            this.audio.uiConfirm();
            this.startRace({ mode: this.pendingMode ?? 'race', trackId: TRACKS[r.index].id });
            return;
          }
          this.trackIndex = r.index;
          this.audio.uiMove();
          this.loadTrack(TRACKS[r.index].id, { cinematic: true });
          return;
        }
      }
    }

    if (inp.pressed(Action.BACK)) { this.audio.uiBack(); this.setScreen(SCREEN.MACHINE); return; }
    if (inp.pressed(Action.CONFIRM)) {
      this.audio.uiConfirm();
      this.startRace({ mode: this.pendingMode ?? 'race', trackId: TRACKS[this.trackIndex].id });
    }
  }

  _updateRace(dt) {
    const race = this.race;
    if (!race) return;

    if (this.input.pressed(Action.PAUSE) ||
        (this.input.pressed(Action.BACK) && race.state === RACE_STATE.RACING)) {
      this.pauseIndex = 0;
      this.setScreen(SCREEN.PAUSE);
      this.audio.stopEngine();
      return;
    }

    if (this.input.boostPressed) race.player.fireBoost();

    race.update(dt, {
      steer: this.input.steer,
      throttle: this.input.throttle,
      brake: this.input.brake,
      leanLeft: this.input.leanLeft,
      leanRight: this.input.leanRight,
    });

    this._consumeRaceEvents(race);

    // Music lifts on the final lap.
    const finalLap = race.playerEntry.lap >= race.laps - 1;
    this.audio.setTempoScale(finalLap ? 1.08 : 1);

    if (race.state === RACE_STATE.FINISHED) {
      this._finishRace();
    } else if (race.state === RACE_STATE.RETIRED) {
      this.audio.stopEngine();
      this.audio.explosion();
      this.setScreen(SCREEN.RETIRED);
    }
  }

  _consumeRaceEvents(race) {
    const p = race.player;
    for (const ev of race.events) {
      switch (ev.type) {
        case 'countdown': this.audio.countdownBeep(ev.n); break;
        case 'go':
          this.audio.countdownBeep(0);
          this.banner = { text: 'GO!', t: 0.8, color: PAL.warn };
          break;
        case 'lap': {
          this.audio.lapChime();
          const remaining = race.laps - ev.lap;
          this.banner = {
            text: remaining === 1 ? 'FINAL LAP' : `LAP ${ev.lap + 1}`,
            t: 1.4,
            color: remaining === 1 ? PAL.accent2 : PAL.accent,
          };
          if (Save.submitLap(this.trackDef.id, ev.time)) this.newRecord = true;
          break;
        }
        case 'boost': this.audio.boost(); this.flash = 0.35; break;
        case 'jump': this.audio.jump(); break;
        case 'impact':
          this.audio.impact(ev.force);
          this.chaseCam.addShake(ev.force * 0.6);
          this.flash = Math.max(this.flash, ev.force * 0.3);
          break;
        case 'land': this.audio.land(ev.force); this.chaseCam.addShake(ev.force * 0.3); break;
        case 'mine':
          this.audio.mine();
          this.chaseCam.addShake(1);
          this.flash = 0.7;
          break;
        default: break;
      }
    }
    race.clearEvents();

    // Continuous audio driven from player state.
    this.audio.updateEngine(
      p.speed01,
      this.input.throttle,
      clamp01((p.boosting ? 0.6 : 0) + p.railIntensity * 0.5),
    );
    this.audio.setScrape(p.onRail ? p.railIntensity : 0, p.speed01);
    const low = p.energy01 < 0.26 ? 1 - p.energy01 / 0.26 : 0;
    this.audio.setAlarm(low);

    for (const v of race.vehicles) v.clearEvents();
  }

  _finishRace() {
    this.audio.stopEngine();
    this.audio.setScrape(0);
    this.audio.setAlarm(0);
    const e = this.race.playerEntry;
    Save.submitRace(this.trackDef.id, e.finishTime);
    this.cupHasNext = this.cup ? this._advanceCup() : false;
    this.setScreen(SCREEN.RESULTS);
  }

  _updateResults() {
    if (this.input.pressed(Action.CONFIRM) || this.input.tapPoint) {
      this.audio.uiConfirm();
      if (this.cup && this.cupHasNext) {
        this.startRace({ mode: 'gp', trackId: this.cup.order[this.cup.index] });
      } else {
        this.cup = null;
        this.audio.playMusic(TITLE_SONG);
        this.loadTrack(TRACKS[this.trackIndex].id, { cinematic: true });
        this.setScreen(SCREEN.TITLE);
      }
    }
  }

  _updateRetired() {
    if (this.input.pressed(Action.CONFIRM) || this.input.tapPoint) {
      const spares = this.cup ? this.cup.spares : 1;
      if (spares > 0) {
        if (this.cup) this.cup.spares--;
        this.audio.uiConfirm();
        this.restartRace();
      } else {
        this.audio.uiBack();
        this.cup = null;
        this.audio.playMusic(TITLE_SONG);
        this.setScreen(SCREEN.TITLE);
      }
    }
  }

  _updatePause() {
    const chosen = this._navigate(3);
    if (this.input.pressed(Action.BACK)) {
      this.audio.uiBack();
      this.setScreen(SCREEN.RACE);
      this.audio.startEngine();
      return;
    }
    if (chosen < 0) return;
    this.audio.uiConfirm();
    if (chosen === 0) { this.setScreen(SCREEN.RACE); this.audio.startEngine(); }
    else if (chosen === 1) this.restartRace();
    else {
      this.cup = null;
      this.audio.playMusic(TITLE_SONG);
      this.loadTrack(TRACKS[this.trackIndex].id, { cinematic: true });
      this.setScreen(SCREEN.TITLE);
    }
  }

  // -------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------

  render(alpha, frameDt = 1 / 60) {
    const dt = Math.min(frameDt, 0.05);

    if (this._screen === SCREEN.MACHINE) {
      this._renderShowcase(dt);
    } else {
      this._renderWorld(alpha, dt);
    }

    this.ui.clear();
    this._drawScreen();

    this.renderer.setFlash(this.flash * 0.55, 0xffffff);
    this.renderer.setFade(this.fade);
  }

  _renderWorld(alpha, dt) {
    const race = this.race;
    const racing = this._screen === SCREEN.RACE || this._screen === SCREEN.PAUSE ||
      this._screen === SCREEN.RESULTS || this._screen === SCREEN.RETIRED;

    if (racing && race) {
      for (let i = 0; i < race.entries.length; i++) {
        this.views[i].update(race.vehicles[i], alpha, this.time);
      }
      const p = race.player;
      this._camTarget ??= {
        position: new THREE.Vector3(), forward: new THREE.Vector3(),
        up: new THREE.Vector3(), speed01: 0, boosting: false,
      };
      this._camTarget.position.copy(this.views[p.index].group.position).addScaledVector(p.up, 1.2);
      this._camTarget.forward.copy(p.heading);
      this._camTarget.up.copy(p.up);
      this._camTarget.speed01 = p.speed01;
      this._camTarget.boosting = p.boosting;
      this.chaseCam.update(this._camTarget, dt);
      this.trackMesh.update(p.s, this.theme.fogFar);
    } else {
      // Cinematic flight for the menus.
      const f = this._cineFrame ??= new TrackFrame();
      this.path.sampleAt(this.cinematicS, f);
      this._camTarget ??= {
        position: new THREE.Vector3(), forward: new THREE.Vector3(),
        up: new THREE.Vector3(), speed01: 0, boosting: false,
      };
      this._camTarget.position.copy(f.pos).addScaledVector(f.up, 1.6);
      this._camTarget.forward.copy(f.tangent);
      this._camTarget.up.copy(f.up);
      this._camTarget.speed01 = 0.45;
      this.chaseCam.update(this._camTarget, dt);
      this.trackMesh.update(this.cinematicS, this.theme.fogFar);
    }

    this.world.update(this.camera);
    this.renderer.render(this.scene, this.camera);
  }

  _renderShowcase(dt) {
    const sc = this.showcase;
    const machine = MACHINES[this.machineIndex];
    sc.scene.background.set(0x0a0e1e);
    sc.view.group.rotation.y = sc.spin;
    sc.view.group.position.set(0, Math.sin(this.time * 1.8) * 0.14, 0);
    sc.view.thrust.material.opacity = 0.55 + Math.sin(this.time * 6) * 0.12;
    sc.view.thrust.material.color.set(machine.colors.glow);
    sc.camera.aspect = this.display.width / this.display.height;
    sc.camera.updateProjectionMatrix();
    this.renderer.render(sc.scene, sc.camera);
  }

  _drawScreen() {
    const ui = this.ui;
    switch (this._screen) {
      case SCREEN.TITLE:
        ui.drawTitle({ canContinue: this.input.lastDevice === 'keyboard' });
        break;

      case SCREEN.MODE:
        this.menuRects = ui.drawMenu('MODE', [
          { label: 'GRAND PRIX', sub: `${TRACKS.length} CIRCUITS - CHAMPIONSHIP` },
          { label: 'SINGLE RACE', sub: 'ONE CIRCUIT, FULL GRID' },
          { label: 'TIME TRIAL', sub: 'ALONE AGAINST THE CLOCK' },
          { label: 'PRACTICE', sub: 'FULL GRID, NO ELIMINATION' },
        ], this.menuIndex, { top: 130, rowH: 40 });
        break;

      case SCREEN.MACHINE:
        ui.drawMachineSelect(MACHINES[this.machineIndex], this.machineIndex, MACHINES.length);
        break;

      case SCREEN.TRACK:
        this.menuRects = ui.drawTrackSelect(
          TRACKS, this.paths, this.trackIndex, Save.data.records,
        );
        break;

      case SCREEN.RACE: {
        const race = this.race;
        ui.drawHud(race, race.player, machineById(this.machineId), this.path, {
          record: Save.bestLap(this.trackDef.id) ?? Infinity,
        });
        if (race.state === RACE_STATE.COUNTDOWN) {
          ui.drawCountdown(Math.max(0, Math.ceil(race.countdown)));
        }
        if (this.banner) {
          ui.drawBanner(this.banner.text, clamp01(this.banner.t * 2), this.banner.color);
        }
        ui.drawTouchControls(this.input, this.input.hasTouch && race.time < 6);
        break;
      }

      case SCREEN.PAUSE:
        this.menuRects = ui.drawPause(this.menuIndex);
        break;

      case SCREEN.RESULTS:
        ui.drawResults(this.race, {
          title: this.cup
            ? (this.cupHasNext ? 'RACE COMPLETE' : 'CUP COMPLETE')
            : 'RESULTS',
          showPoints: !!this.cup,
          cupTotals: this.cup ? this.cupStandings : null,
        });
        if (this.newRecord && ui.blink(0.6, 0.6)) {
          ui.text('NEW RECORD', ui.W / 2, ui.H - 34, {
            scale: 1, align: 'center', color: PAL.good,
          });
        }
        break;

      case SCREEN.RETIRED:
        ui.drawRetired(this.race.retireReason, this.cup ? this.cup.spares : 1);
        break;

      default: break;
    }

    if (this.debug) {
      ui.drawDebug([
        `${this.loop.fps.toFixed(0)} FPS`,
        `${this.renderer.drawCalls} CALLS`,
        `${(this.renderer.triangles / 1000).toFixed(1)}K TRIS`,
        `${this.loop.stepsLastFrame} STEPS`,
      ]);
    }
  }
}

const game = new Game();
window.__game = game;
window.__THREE = THREE;
