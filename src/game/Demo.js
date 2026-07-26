import { MACHINES } from './Machines.js';
import { TITLE_SONG } from '../audio/songs.js';

/**
 * Demo — the attract mode.
 *
 * Leave the title screen alone for a few seconds and the game plays itself, the
 * way a cabinet does: it picks a machine, enters the championship, and races all
 * six circuits back to back. Touch anything and it stops instantly and hands the
 * game back.
 *
 * IT DRIVES THE REAL UI. Every menu step is a synthesised *tap* at a real screen
 * position, fed through the same input path a thumb uses, so the demo exercises
 * the actual code — a menu that has broken cannot be papered over by an attract
 * mode that calls `setScreen` behind its back. It also makes the demo a live
 * smoke test of the whole front end: if the machine-select confirm band ever
 * moves again, the attract loop stops reaching the grid and says so.
 *
 * The taps are visible. A ring blooms where each one lands and a short tick
 * plays, so what the viewer sees is a person playing rather than a cutscene —
 * that legibility is the entire point of an attract mode.
 *
 * The script is a list of steps rather than a state machine because it is
 * fundamentally linear, and because "wait until the game reaches this screen,
 * then tap there" expresses the intent directly. Steps that wait on a screen
 * carry a timeout, so a demo can never wedge on a screen it did not expect.
 */

/** Seconds of stillness on the title screen before the demo takes over. */
export const IDLE_BEFORE_DEMO = 7;

export class Demo {
  constructor(game) {
    this.game = game;
    this.active = false;
    this.idle = 0;
    this.taps = [];          // visible ripples, consumed by the UI layer
    this._steps = null;
    this._i = 0;
    this._t = 0;
    this._waited = 0;
    this._dwell = 0;
  }

  /** Count idle time on the title screen; start the demo when it runs out. */
  tick(dt, screen, hadRealInput) {
    if (hadRealInput) {
      if (this.active) this.stop();
      this.idle = 0;
      return;
    }
    for (const r of this.taps) r.t += dt;
    this.taps = this.taps.filter((r) => r.t < 0.55);

    if (this.active) { this._run(dt); return; }
    if (screen === 'title') {
      this.idle += dt;
      if (this.idle >= IDLE_BEFORE_DEMO) this.start();
    } else {
      this.idle = 0;
    }
  }

  start() {
    this.active = true;
    this.idle = 0;
    this._i = 0;
    this._t = 0;
    this._waited = 0;
    this._dwell = 0;
    this._steps = this._script();
  }

  stop() {
    this.active = false;
    this.idle = 0;
    this.taps.length = 0;
    const g = this.game;
    // Hand a clean game back: no championship in progress, no race running.
    g.cup = null;
    g.race = null;
    g.audio.stopEngine();
    g.audio.setScrape(0);
    g.audio.setAlarm(0);
    g.audio.playMusic(TITLE_SONG);
    g.loadTrack(g.trackDef.id, { cinematic: true });
    g.setScreen('title');
  }

  /**
   * The run loop. Each step is a plain object:
   *   wait     screen (or list of screens) to be on before acting
   *   at       (screen) => [x, y] in internal pixels, the tap target
   *   dwell    seconds to sit on the screen *before* tapping, so it can be read
   *   hold     seconds to wait after tapping, before the next step
   *   timeout  seconds to wait for the screen before giving up
   *   until    () => true to advance past this step without acting
   *   repeat   stay on this step after acting, until `until` says otherwise
   *   run      side effect instead of a tap
   */
  _run(dt) {
    const g = this.game;
    this._t -= dt;
    if (this._t > 0) return;

    const step = this._steps[this._i];
    if (!step) { this.stop(); return; }

    if (step.until && step.until()) { this._i++; this._waited = 0; return; }

    if (step.wait) {
      const want = Array.isArray(step.wait) ? step.wait : [step.wait];
      if (!want.includes(g._screen)) {
        this._waited += dt;
        // Never stall on a screen the script did not anticipate: give up and
        // hand the title screen back rather than leaving the attract loop
        // wedged on a screen with nothing to tap.
        if (this._waited > (step.timeout ?? 90)) { this._waited = 0; this.stop(); }
        this._dwell = 0;
        return;
      }
    }
    this._waited = 0;

    // A screen has to be readable before it is dismissed. `hold` cannot do
    // this: the tap is what closes a results screen, so anything spent after
    // the tap is spent on the screen that replaced it.
    if (step.dwell) {
      this._dwell += dt;
      if (this._dwell < step.dwell) return;
    }
    this._dwell = 0;

    if (step.at) {
      const [x, y] = step.at(g._screen);
      this.tapAt(x, y);
    }
    if (step.run) step.run();
    this._t = step.hold ?? 0.9;
    if (!step.repeat) this._i++;
  }

  /** Synthesise a tap: visible ring, UI sound, and a real input event. */
  tapAt(x, y) {
    this.taps.push({ x, y, t: 0 });
    this.game.audio.uiTap();
    this.game.input.virtualTap(x, y);
  }

  _script() {
    const g = this.game;
    const W = () => g.display.width;
    const H = () => g.display.height;
    const steps = [];

    // Title -> mode. Tap high, clear of anything else.
    steps.push({ wait: 'title', at: () => [W() * 0.5, H() * 0.3], hold: 1.2 });

    // Mode. A menu row that is not already highlighted takes two taps — one to
    // select, one to confirm — so the script deliberately walks *down* to
    // SINGLE RACE and back up to GRAND PRIX before committing. That costs a
    // second and a half and buys the thing the attract mode exists for: the
    // viewer watches the menu being read, not a screen that blinks past.
    const modeRow = (i) => () => {
      const r = g.menuRects.find((m) => m.index === i);
      return r ? [r.x + r.w / 2, r.y + r.h / 2] : [W() * 0.5, 0.3 * H() + i * 34];
    };
    steps.push({ wait: 'mode', at: modeRow(1), hold: 0.75 });
    steps.push({ wait: 'mode', at: modeRow(0), hold: 0.85 });
    steps.push({ wait: 'mode', at: modeRow(0), hold: 1.3 });

    // Machine select. One full lap of the roster, so every machine and its stat
    // bars get their moment, landing on the *first* machine rather than on
    // whichever one happens to be saved. That matters: the roster runs from a
    // balanced all-rounder to a glass cannon, and the demo racing a machine
    // that gets destroyed on two of the six circuits is a worse advert than one
    // that wins all six. Tapping the right arrow the right number of times is
    // how a person would do it, so it is how the demo does it.
    const laps = (MACHINES.length - g.machineIndex) % MACHINES.length || MACHINES.length;
    for (let i = 0; i < laps; i++) {
      steps.push({ wait: 'machine', at: () => [W() * 0.86, H() * 0.4], hold: 1.5 });
    }
    // Confirm: the stats panel, below the arrow band.
    steps.push({ wait: 'machine', at: () => [W() * 0.5, H() * 0.82], hold: 1.2 });

    // The championship: every circuit, back to back, on one repeating step.
    //
    // A fixed step per race would be wrong, because the number of screens a
    // championship produces is not fixed — a destroyed machine adds a retire
    // screen and re-runs the circuit. So this waits for whichever end-of-race
    // screen arrives, taps the right place for it, and repeats until the cup
    // is over, which is precisely when `game.cup` goes null.
    steps.push({
      until: () => !g.cup,
      wait: ['results', 'retired'],
      timeout: 320,                       // a full race, with slack
      at: (screen) => (screen === 'retired'
        ? [W() * 0.5, H() * 0.72]
        : [W() * 0.5, H() * 0.86]),
      // Long enough to read a full classification and the championship
      // standings under it, which is the payoff of the race just watched.
      dwell: 4.5,
      hold: 0.6,
      repeat: true,
    });
    steps.push({ run: () => this.stop() });
    return steps;
  }
}
