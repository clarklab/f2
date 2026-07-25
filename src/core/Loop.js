/**
 * Loop — fixed-timestep simulation with interpolated rendering.
 *
 * Physics runs at a constant 120 Hz no matter what the display does. Two things
 * fall out of that:
 *
 *  - Behaviour is identical on a 60 Hz phone and a 144 Hz monitor. Handling
 *    tuned on one machine feels the same on another, and replays/ghosts stay
 *    deterministic.
 *  - Integration stays stable. The hover spring is stiff; at a variable dt it
 *    would visibly wobble whenever the frame time spiked.
 *
 * Rendering interpolates between the previous and current simulation states, so
 * motion is smooth even when the step count per frame alternates between 1 and
 * 2. That costs up to one physics step (8.3 ms) of latency, which is well under
 * the threshold where steering starts to feel disconnected.
 */
export class Loop {
  /**
   * @param {{hz?:number, update:(dt:number)=>void, render:(alpha:number, dt:number)=>void}} opts
   */
  constructor({ hz = 120, update, render }) {
    this.hz = hz;
    this.dt = 1 / hz;
    this.update = update;
    this.render = render;

    this.accumulator = 0;
    this.lastTime = 0;
    this.running = false;
    this.frame = 0;

    // Rolling FPS estimate for the debug readout.
    this.fps = 60;
    this._fpsAccum = 0;
    this._fpsFrames = 0;
    this.stepsLastFrame = 0;

    this._tick = this._tick.bind(this);
    this._onVisibility = () => {
      // Coming back from a background tab hands us an enormous dt; drop it.
      if (!document.hidden) this.lastTime = performance.now();
    };
    document.addEventListener('visibilitychange', this._onVisibility);
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    this.accumulator = 0;
    this._raf = requestAnimationFrame(this._tick);
  }

  stop() {
    this.running = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
  }

  _tick(now) {
    if (!this.running) return;
    this._raf = requestAnimationFrame(this._tick);

    let frameTime = (now - this.lastTime) / 1000;
    this.lastTime = now;

    // Clamp so a long stall (GC, tab switch, breakpoint) cannot queue hundreds
    // of catch-up steps and lock the page — the classic "spiral of death".
    if (frameTime > 0.25) frameTime = 0.25;
    if (frameTime < 0) frameTime = 0;

    this._fpsAccum += frameTime;
    this._fpsFrames++;
    if (this._fpsAccum >= 0.5) {
      this.fps = this._fpsFrames / this._fpsAccum;
      this._fpsAccum = 0;
      this._fpsFrames = 0;
    }

    this.accumulator += frameTime;

    let steps = 0;
    const dt = this.dt;
    while (this.accumulator >= dt) {
      this.update(dt);
      this.accumulator -= dt;
      steps++;
      // Hard ceiling per frame. If we are this far behind we are better off
      // running slow than dropping the frame entirely.
      if (steps >= 8) {
        this.accumulator = 0;
        break;
      }
    }
    this.stepsLastFrame = steps;

    const alpha = this.accumulator / dt;
    this.render(alpha, frameTime);
    this.frame++;
  }

  dispose() {
    this.stop();
    document.removeEventListener('visibilitychange', this._onVisibility);
  }
}
