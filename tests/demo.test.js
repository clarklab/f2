import test from 'node:test';
import assert from 'node:assert/strict';
import { Demo, IDLE_BEFORE_DEMO } from '../src/game/Demo.js';
import { MACHINES } from '../src/game/Machines.js';
import { TRACKS } from '../src/track/tracks.js';
import { TrackPath } from '../src/track/TrackPath.js';
import { SurfaceMap } from '../src/track/SurfaceMap.js';
import { Race, RACE_STATE } from '../src/game/Race.js';

/**
 * Attract-mode tests.
 *
 * These run the demo against a stand-in front end rather than the real one, for
 * the same reason the physics tests run headless: the interesting cases are the
 * ones that take ten minutes of wall clock to reach in a browser. A destroyed
 * machine mid-championship, a screen the script did not anticipate, and a
 * six-circuit cup all reduce to a few hundred simulated steps here.
 *
 * `tools/demoflow.mjs` covers the other half — that the coordinates the script
 * taps actually land on the buttons the real UI draws. Neither test is
 * sufficient alone: this one would keep passing if every menu moved, and that
 * one is too slow to explore the branches.
 */

const DT = 1 / 60;
const FAKE_TRACKS = ['a', 'b', 'c', 'd', 'e', 'f'];

/**
 * A miniature of the real front end: the screens the demo touches, the rules
 * they respond to taps with, and a race that finishes after a fixed time.
 */
function fakeGame({ retireOn = [], spares = 2 } = {}) {
  const g = {
    _screen: 'title',
    cup: null,
    machineIndex: 0,
    menuIndex: 0,
    menuRects: [],
    trackDef: { id: FAKE_TRACKS[0] },
    display: { width: 270, height: 520 },
    taps: [],            // every tap the demo made, with the screen it hit
    finishes: [],        // circuits completed, in order
    sounds: 0,
    _raceT: 0,
    _pending: null,

    audio: {
      uiTap() { g.sounds++; },
      stopEngine() {}, setScrape() {}, setAlarm() {}, playMusic() {},
    },
    input: { virtualTap(x, y) { g._pending = { x, y }; } },
    loadTrack() {},
    setScreen(name) {
      g._screen = name;
      g.menuIndex = 0;
      g.menuRects = name === 'mode'
        ? [0, 1, 2, 3].map((i) => ({ index: i, x: 20, y: 130 + i * 40, w: 230, h: 36 }))
        : [];
    },
  };

  const W = g.display.width;
  const H = g.display.height;

  const startRace = () => { g._raceT = 0; g.setScreen('race'); };

  /** Apply the tap staged on the previous step, exactly as the game would. */
  g.applyTap = () => {
    const tap = g._pending;
    g._pending = null;
    if (!tap) return;
    g.taps.push({ ...tap, screen: g._screen });

    if (g._screen === 'title') { g.setScreen('mode'); return; }

    if (g._screen === 'mode') {
      const r = g.menuRects.find((m) => tap.x >= m.x && tap.x <= m.x + m.w
        && tap.y >= m.y && tap.y <= m.y + m.h);
      if (!r) return;
      // A row that is not already highlighted is only selected, not confirmed.
      if (g.menuIndex !== r.index) { g.menuIndex = r.index; return; }
      if (r.index === 0) g.setScreen('machine');    // GRAND PRIX
      return;
    }

    if (g._screen === 'machine') {
      const arrow = tap.y > H * 0.12 && tap.y < H * 0.62;
      if (arrow) {
        if (tap.x > W * 0.68) g.machineIndex = (g.machineIndex + 1) % MACHINES.length;
        else if (tap.x < W * 0.32) {
          g.machineIndex = (g.machineIndex + MACHINES.length - 1) % MACHINES.length;
        }
        return;
      }
      if (tap.y >= H * 0.62) {
        g.cup = { index: 0, spares, order: [...FAKE_TRACKS] };
        g.trackDef = { id: FAKE_TRACKS[0] };
        startRace();
      }
      return;
    }

    if (g._screen === 'results') {
      g.cup.index++;
      if (g.cup.index < g.cup.order.length) {
        g.trackDef = { id: g.cup.order[g.cup.index] };
        startRace();
      } else {
        g.cup = null;
        g.setScreen('title');
      }
      return;
    }

    if (g._screen === 'retired') {
      if (g.cup && g.cup.spares > 0) { g.cup.spares--; startRace(); }
      else { g.cup = null; g.setScreen('title'); }
    }
  };

  /** Advance the fake race clock; a race lasts two seconds here. */
  g.tickRace = (dt) => {
    if (g._screen !== 'race') return;
    g._raceT += dt;
    if (g._raceT < 2) return;
    const id = g.trackDef.id;
    if (retireOn.includes(id) && !g.finishes.includes(`retire:${id}`)) {
      g.finishes.push(`retire:${id}`);
      g.setScreen('retired');
    } else {
      g.finishes.push(id);
      g.setScreen('results');
    }
  };

  return g;
}

/**
 * Run the demo and the fake front end together for `seconds` of game time, or
 * until `stopWhen` holds. The stop condition matters: the attract loop rearms
 * seven seconds after it finishes, so a test that simply runs long enough to
 * see one championship will see the second one start.
 */
function run(demo, game, seconds, { realInputAt = null, stopWhen = null } = {}) {
  let t = 0;
  while (t < seconds) {
    game.applyTap();
    demo.tick(DT, game._screen, realInputAt !== null && t >= realInputAt && t < realInputAt + DT);
    game.tickRace(DT);
    t += DT;
    if (stopWhen && stopWhen()) return t;
  }
  return t;
}

// -------------------------------------------------------------------------

test('the demo waits out the idle timer before taking over', () => {
  const g = fakeGame();
  const demo = new Demo(g);
  run(demo, g, IDLE_BEFORE_DEMO - 0.5);
  assert.equal(demo.active, false, 'started early');
  assert.equal(g._screen, 'title');

  run(demo, g, 1);
  assert.equal(demo.active, true, 'never started');
});

test('the demo can take over from any browsing screen, not just the title', () => {
  // The screen a visitor is most likely to be abandoned on is not the title
  // one: the tap that unlocks audio lands them a screen deeper. If only the
  // title screen counted, the attract mode became unreachable the moment
  // anyone touched the game.
  for (const screen of ['mode', 'machine', 'track']) {
    const g = fakeGame();
    const demo = new Demo(g);
    g.setScreen(screen);
    run(demo, g, 60, { stopWhen: () => demo.active });
    assert.equal(demo.active, true, `never took over from ${screen}`);
    assert.equal(g._screen, 'title', `did not return to the title screen from ${screen}`);
  }
});

test('the idle timer never runs during a race or over held state', () => {
  // These screens hold something a player would lose: a race in progress, a
  // pause they will come back from, a classification they are still reading.
  for (const screen of ['race', 'pause', 'results', 'retired']) {
    const g = fakeGame();
    const demo = new Demo(g);
    g._screen = screen;
    run(demo, g, IDLE_BEFORE_DEMO * 6);
    assert.equal(demo.active, false, `hijacked the ${screen} screen`);
    assert.equal(demo.idle, 0);
  }
});

test('the demo walks the menus and reaches a race', () => {
  const g = fakeGame();
  const demo = new Demo(g);
  run(demo, g, 30);

  const screens = g.taps.map((t) => t.screen);
  assert.ok(screens.includes('title'), 'never tapped the title screen');
  assert.ok(screens.filter((s) => s === 'mode').length >= 3, 'did not work the mode menu');
  assert.ok(
    screens.filter((s) => s === 'machine').length > MACHINES.length,
    'did not browse the whole roster before confirming',
  );
  assert.ok(g.cup, 'never entered the championship');
  assert.ok(g.sounds >= g.taps.length, 'a tap went out without a sound');
});

test('the demo races every circuit of the championship, then stops', () => {
  const g = fakeGame();
  const demo = new Demo(g);
  run(demo, g, 300, { stopWhen: () => g.finishes.length >= FAKE_TRACKS.length && !demo.active });

  assert.deepEqual(g.finishes, FAKE_TRACKS, 'did not run every circuit in order');
  assert.equal(g.cup, null, 'championship never closed out');
  assert.equal(demo.active, false, 'demo never handed the game back');
  assert.equal(g._screen, 'title');
});

test('a destroyed machine re-runs its circuit instead of derailing the demo', () => {
  const g = fakeGame({ retireOn: ['c'] });
  const demo = new Demo(g);
  run(demo, g, 300, { stopWhen: () => g.finishes.length >= 7 && !demo.active });

  assert.deepEqual(
    g.finishes, ['a', 'b', 'retire:c', 'c', 'd', 'e', 'f'],
    'the retire screen was not absorbed and the circuit re-run',
  );
  assert.equal(g.cup, null);
  assert.equal(demo.active, false);
});

test('real input stops the demo instantly and rearms the idle timer', () => {
  const g = fakeGame();
  const demo = new Demo(g);
  run(demo, g, 20);
  assert.equal(demo.active, true);

  demo.tick(DT, g._screen, true);
  assert.equal(demo.active, false, 'ignored a real touch');
  assert.equal(demo.idle, 0, 'did not restart the idle timer');
  assert.equal(demo.taps.length, 0, 'left stale tap markers on screen');
  assert.equal(g.cup, null, 'left a championship in progress');
  assert.equal(g._screen, 'title', 'did not hand back the title screen');
});

test('an unexpected screen ends the demo rather than wedging it', () => {
  const g = fakeGame();
  const demo = new Demo(g);
  demo.start();
  // A screen nothing in the script waits for. The first step wants 'title'.
  g._screen = 'pause';
  run(demo, g, 95);
  assert.equal(demo.active, false, 'still waiting on a screen that will never come');
});

test('the demo lands on the first machine whatever was last saved', () => {
  for (let start = 0; start < MACHINES.length; start++) {
    const g = fakeGame();
    g.machineIndex = start;
    const demo = new Demo(g);
    run(demo, g, 45, { stopWhen: () => !!g.cup });
    assert.equal(
      g.machineIndex, 0,
      `starting from ${MACHINES[start].id} the demo entered the cup on ${MACHINES[g.machineIndex].id}`,
    );
  }
});

test('the attract-mode driver wins every circuit it is shown on', () => {
  const SIM_DT = 1 / 120;          // the game's real physics step
  const ctrl = { steer: 0, throttle: 0, brake: 0, leanLeft: 0, leanRight: 0 };
  const results = [];

  for (const def of TRACKS) {
    const path = new TrackPath(def.controlPoints, {
      step: 1.25, autoBank: 22, maxAutoBank: 16, defaultWidth: def.width,
    });
    const race = new Race({
      path,
      surfaces: new SurfaceMap(path, def.zones),
      trackDef: def,
      machineId: MACHINES[0].id,     // the machine the demo always lands on
      mode: 'gp',
      difficulty: 1,
      opponents: 5,
      spares: 2,
      autopilot: true,
    });
    let t = 0;
    while (race.state !== RACE_STATE.FINISHED && race.state !== RACE_STATE.RETIRED && t < 400) {
      race.update(SIM_DT, ctrl);
      for (const v of race.vehicles) v.clearEvents();
      race.clearEvents();
      t += SIM_DT;
    }
    results.push({
      track: def.id,
      pos: race.state === RACE_STATE.RETIRED
        ? 'DESTROYED'
        : race.standings().findIndex((e) => e.isPlayer) + 1,
    });
  }

  // An attract mode is a sales pitch. Coming third, or exploding in front of
  // the viewer on the last circuit of the championship, is the failure mode
  // this locks down — and it is a real one: before the driver was given a
  // wider cornering envelope and taught to detour to a recharge strip, this
  // machine finished 3rd, 2nd, 2nd, 3rd, 3rd, 1st across the same six races.
  assert.deepEqual(
    results.map((r) => r.pos), [1, 1, 1, 1, 1, 1],
    `attract mode did not sweep the championship: ${JSON.stringify(results)}`,
  );
});

test('tap markers expire so the screen does not fill with rings', () => {
  const g = fakeGame();
  const demo = new Demo(g);
  run(demo, g, 40);
  assert.ok(demo.taps.length <= 2, `${demo.taps.length} rings alive at once`);
});
