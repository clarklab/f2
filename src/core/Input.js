import { clamp, damp } from './MathUtil.js';

/**
 * Input — one action model fed by keyboard, touch and gamepad simultaneously.
 *
 * Nothing downstream knows or cares which device produced a value. Every source
 * writes into the same `raw` block each frame; whichever moved last wins for
 * analogue axes, and digital actions are OR-ed. That means a player can hold the
 * steering with a thumb and hit boost on a keyboard without anything breaking.
 *
 * Portrait touch layout (fractions of the screen):
 *
 *   +--------------------+
 *   |                    |
 *   |     (viewport)     |
 *   |                    |
 *   +--------------------+  <- 0.58h
 *   |  STEER   |  BOOST  |
 *   |   PAD    |---------|  the steer pad is a relative slider: wherever the
 *   |          |  BRAKE  |  thumb lands becomes centre, so there is nothing to
 *   +--------------------+  aim at and no dead thumb travel.
 */

export const Action = {
  UP: 'up',
  DOWN: 'down',
  LEFT: 'left',
  RIGHT: 'right',
  CONFIRM: 'confirm',
  BACK: 'back',
  BOOST: 'boost',
  PAUSE: 'pause',
};

const KEY_MAP = {
  ArrowUp: Action.UP, KeyW: Action.UP,
  ArrowDown: Action.DOWN, KeyS: Action.DOWN,
  ArrowLeft: Action.LEFT, KeyA: Action.LEFT,
  ArrowRight: Action.RIGHT, KeyD: Action.RIGHT,
  Enter: Action.CONFIRM, Space: Action.CONFIRM, KeyZ: Action.CONFIRM,
  Escape: Action.BACK, Backspace: Action.BACK, KeyX: Action.BACK,
  ShiftLeft: Action.BOOST, ShiftRight: Action.BOOST, KeyB: Action.BOOST,
  KeyP: Action.PAUSE,
};

export class Input {
  constructor(display) {
    this.display = display;

    // Continuous driving inputs, all normalised.
    this.steer = 0;        // -1 left .. +1 right
    this.throttle = 0;     // 0 .. 1
    this.brake = 0;        // 0 .. 1
    this.leanLeft = 0;     // 0 .. 1  (the L/R "air brake" strafe)
    this.leanRight = 0;

    // Menu/discrete actions.
    this.down = new Set();
    this.justPressed = new Set();
    this.justReleased = new Set();

    this.lastDevice = 'keyboard';
    this.hasTouch = false;
    this.autoAccelerate = true;   // touch default; toggled in options

    this._keys = new Set();
    this._touchSteer = 0;
    this._touchThrottle = 0;
    this._touchBrake = 0;
    this._touchBoost = false;
    this._prevBoost = false;
    this._pointers = new Map();
    this._steerPointer = null;
    this._smoothSteer = 0;

    this._bind();
  }

  // -------------------------------------------------------------------
  // Wiring
  // -------------------------------------------------------------------

  _bind() {
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      const a = KEY_MAP[e.code];
      // Only swallow keys the game actually uses, so devtools shortcuts and
      // tabbing away still work.
      if (a || e.code === 'Space') e.preventDefault();
      this._keys.add(e.code);
      this.lastDevice = 'keyboard';
      if (a) this._press(a);
    });

    window.addEventListener('keyup', (e) => {
      const a = KEY_MAP[e.code];
      this._keys.delete(e.code);
      if (a && !this._anyKeyFor(a)) this._release(a);
    });

    // A lost focus with keys held would otherwise leave the car pinned at full
    // throttle when the player comes back.
    window.addEventListener('blur', () => this.reset());

    const el = this.display.stage;
    el.addEventListener('pointerdown', (e) => this._onPointerDown(e));
    el.addEventListener('pointermove', (e) => this._onPointerMove(e));
    el.addEventListener('pointerup', (e) => this._onPointerUp(e));
    el.addEventListener('pointercancel', (e) => this._onPointerUp(e));
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  _anyKeyFor(action) {
    for (const code of this._keys) if (KEY_MAP[code] === action) return true;
    return false;
  }

  _press(a) {
    if (!this.down.has(a)) {
      this.down.add(a);
      this.justPressed.add(a);
    }
  }

  _release(a) {
    if (this.down.delete(a)) this.justReleased.add(a);
  }

  // -------------------------------------------------------------------
  // Touch
  // -------------------------------------------------------------------

  get layout() {
    // Expressed in internal pixels so the UI layer can draw matching hints.
    const { width: W, height: H } = this.display;
    const padTop = H * 0.58;
    return {
      padTop,
      steer: { x: 0, y: padTop, w: W * 0.58, h: H - padTop },
      boost: { x: W * 0.58, y: padTop, w: W * 0.42, h: (H - padTop) * 0.55 },
      brake: { x: W * 0.58, y: padTop + (H - padTop) * 0.55, w: W * 0.42, h: (H - padTop) * 0.45 },
    };
  }

  _onPointerDown(e) {
    this.hasTouch = this.hasTouch || e.pointerType === 'touch';
    this.lastDevice = e.pointerType === 'touch' ? 'touch' : 'mouse';
    this.display.stage.setPointerCapture?.(e.pointerId);
    const p = this.display.toVirtual(e.clientX, e.clientY);
    const L = this.layout;

    // Anything above the control band counts as "confirm" — the whole viewport
    // is a button on the menus.
    if (p.y < L.padTop) {
      this._pointers.set(e.pointerId, { role: 'tap', ...p });
      this._press(Action.CONFIRM);
      this._tapPoint = { x: p.x, y: p.y };
      return;
    }

    if (this._inside(p, L.boost)) {
      this._pointers.set(e.pointerId, { role: 'boost' });
      this._touchBoost = true;
      this._press(Action.BOOST);
    } else if (this._inside(p, L.brake)) {
      this._pointers.set(e.pointerId, { role: 'brake' });
      this._touchBrake = 1;
    } else {
      // Relative steering: this touch point becomes the centre.
      this._pointers.set(e.pointerId, { role: 'steer', originX: p.x, x: p.x });
      this._steerPointer = e.pointerId;
      this._touchThrottle = 1;
    }
    e.preventDefault();
  }

  _onPointerMove(e) {
    const rec = this._pointers.get(e.pointerId);
    if (!rec) return;
    const p = this.display.toVirtual(e.clientX, e.clientY);
    if (rec.role === 'steer') {
      rec.x = p.x;
      // ~22% of screen width of travel for full lock: enough to be precise,
      // short enough that a thumb can reach the extremes without shifting grip.
      const range = this.display.width * 0.22;
      this._touchSteer = clamp((p.x - rec.originX) / range, -1, 1);
    }
    e.preventDefault();
  }

  _onPointerUp(e) {
    const rec = this._pointers.get(e.pointerId);
    this._pointers.delete(e.pointerId);
    if (!rec) return;
    if (rec.role === 'steer') {
      this._touchSteer = 0;
      this._steerPointer = null;
      if (!this.autoAccelerate) this._touchThrottle = 0;
    } else if (rec.role === 'boost') {
      this._touchBoost = false;
      this._release(Action.BOOST);
    } else if (rec.role === 'brake') {
      this._touchBrake = 0;
    } else if (rec.role === 'tap') {
      this._release(Action.CONFIRM);
    }
  }

  _inside(p, r) {
    return p.x >= r.x && p.x < r.x + r.w && p.y >= r.y && p.y < r.y + r.h;
  }

  // -------------------------------------------------------------------
  // Gamepad
  // -------------------------------------------------------------------

  _pollGamepad() {
    const pads = navigator.getGamepads?.() ?? [];
    let pad = null;
    for (const p of pads) if (p && p.connected) { pad = p; break; }
    if (!pad) return null;

    const dead = (v) => (Math.abs(v) < 0.18 ? 0 : v);
    const ax = dead(pad.axes[0] ?? 0);
    const rt = pad.buttons[7]?.value ?? 0;
    const lt = pad.buttons[6]?.value ?? 0;
    const a = pad.buttons[0]?.pressed ?? false;
    const b = pad.buttons[1]?.pressed ?? false;
    const lb = pad.buttons[4]?.pressed ?? false;
    const rb = pad.buttons[5]?.pressed ?? false;
    const start = pad.buttons[9]?.pressed ?? false;
    const dpad = {
      up: pad.buttons[12]?.pressed ?? false,
      down: pad.buttons[13]?.pressed ?? false,
      left: pad.buttons[14]?.pressed ?? false,
      right: pad.buttons[15]?.pressed ?? false,
    };

    const active = ax !== 0 || rt > 0.05 || lt > 0.05 || a || b || lb || rb || start ||
      dpad.up || dpad.down || dpad.left || dpad.right;
    if (active) this.lastDevice = 'gamepad';

    return { ax, rt, lt, a, b, lb, rb, start, dpad };
  }

  // -------------------------------------------------------------------
  // Frame
  // -------------------------------------------------------------------

  /** Call once per rendered frame, before the simulation steps. */
  update(dt) {
    const pad = this._pollGamepad();

    // --- steering ---
    let kSteer = 0;
    if (this.down.has(Action.LEFT)) kSteer -= 1;
    if (this.down.has(Action.RIGHT)) kSteer += 1;

    let target = 0;
    if (this.lastDevice === 'touch' || this.lastDevice === 'mouse') target = this._touchSteer;
    else if (this.lastDevice === 'gamepad' && pad) target = pad.ax || kSteer;
    else target = kSteer;

    // Keyboard is binary, so ease it into an analogue value. Touch and stick are
    // already analogue and get eased far less, keeping them feeling direct.
    const rate = (this.lastDevice === 'keyboard') ? 14 : 34;
    this._smoothSteer = damp(this._smoothSteer, target, rate, dt);
    this.steer = Math.abs(this._smoothSteer) < 0.002 ? 0 : this._smoothSteer;

    // --- throttle / brake ---
    let throttle = 0;
    let brake = 0;
    if (this.down.has(Action.UP)) throttle = 1;
    if (this.down.has(Action.DOWN)) brake = 1;
    if (pad) {
      if (pad.rt > 0.05) throttle = Math.max(throttle, pad.rt);
      if (pad.lt > 0.05) brake = Math.max(brake, pad.lt);
      if (pad.a) throttle = 1;
      if (pad.b) brake = 1;
      if (pad.dpad.up) throttle = 1;
      if (pad.dpad.down) brake = 1;
    }
    if (this._pointers.size > 0 || this.autoAccelerate && this.hasTouch) {
      throttle = Math.max(throttle, this._touchThrottle);
    }
    brake = Math.max(brake, this._touchBrake);

    this.throttle = clamp(throttle, 0, 1);
    this.brake = clamp(brake, 0, 1);

    // --- lean / air brake ---
    // On a controller these are the shoulders. On touch there is nowhere sane to
    // put two more buttons, so pushing the steer slider past 80% engages the
    // lean on that side automatically — which is what an expert does anyway.
    this.leanLeft = 0;
    this.leanRight = 0;
    if (this._keys.has('KeyQ')) this.leanLeft = 1;
    if (this._keys.has('KeyE')) this.leanRight = 1;
    if (pad) {
      if (pad.lb) this.leanLeft = 1;
      if (pad.rb) this.leanRight = 1;
    }
    if (this.hasTouch) {
      const over = (Math.abs(this._touchSteer) - 0.8) / 0.2;
      if (over > 0) {
        if (this._touchSteer < 0) this.leanLeft = Math.max(this.leanLeft, clamp(over, 0, 1));
        else this.leanRight = Math.max(this.leanRight, clamp(over, 0, 1));
      }
    }

    // --- gamepad digital edges ---
    if (pad) {
      this._edge(Action.CONFIRM, pad.a || pad.start);
      this._edge(Action.BACK, pad.b);
      this._edge(Action.UP, pad.dpad.up || (pad.axes ?? [])[1] < -0.5);
      this._edge(Action.DOWN, pad.dpad.down);
      this._edge(Action.LEFT, pad.dpad.left);
      this._edge(Action.RIGHT, pad.dpad.right);
    }

    this.boost = this.down.has(Action.BOOST) || this._touchBoost || (pad?.lb && pad?.rb) || false;
    this.boostPressed = this.boost && !this._prevBoost;
    this._prevBoost = this.boost;
  }

  _edge(action, isDown) {
    const key = `_pad_${action}`;
    const was = this[key] ?? false;
    if (isDown && !was) this._press(action);
    if (!isDown && was && !this._anyKeyFor(action)) this._release(action);
    this[key] = isDown;
  }

  /** Call at the very end of the frame, after everything has read the edges. */
  endFrame() {
    this.justPressed.clear();
    this.justReleased.clear();
    this._tapPoint = null;
  }

  pressed(action) { return this.justPressed.has(action); }
  held(action) { return this.down.has(action); }

  /** Where the player tapped this frame, in internal pixels, or null. */
  get tapPoint() { return this._tapPoint ?? null; }

  reset() {
    this._keys.clear();
    this.down.clear();
    this._pointers.clear();
    this._touchSteer = 0;
    this._touchBrake = 0;
    this._touchBoost = false;
    this._touchThrottle = 0;
    this.steer = this.throttle = this.brake = 0;
    this._smoothSteer = 0;
  }
}
