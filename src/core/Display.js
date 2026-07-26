import { clamp } from './MathUtil.js';

/**
 * Display — owns the two canvases and decides the game's internal resolution.
 *
 * The whole look depends on rendering at a very low resolution and letting the
 * browser scale it up with nearest-neighbour filtering. The question is *which*
 * low resolution, and the honest answer is that there is no single right one:
 * a fixed 270x480 is 9:16, and no phone on sale is 9:16. Pinning the game to it
 * letterboxes every real device, which on a black page reads as a bug.
 *
 * So the resolution adapts. 270 across is the authored width and every layout
 * coordinate is relative to it, but the *height* follows the device, and each
 * game pixel stays a whole number of device pixels:
 *
 *   step = round(deviceWidth / 270)         device pixels per game pixel
 *   W, H = deviceWidth / step, deviceHeight / step
 *
 * Rounding the step to an integer is the point. A fractional step means some
 * game pixels land on 3 device pixels and their neighbours on 4, so the art
 * crawls and shimmers whenever anything moves — the one artefact a pixel-art
 * game cannot hide. Taking the rounding on the *resolution* instead (a couple
 * of extra or missing rows) is invisible.
 *
 * The aspect ratio is clamped, because the layouts are authored for portrait
 * and a desktop window is not portrait. Inside the clamp — which is every phone
 * held upright — the stage is exactly the viewport and there is no letterbox at
 * all. Outside it, we fall back to centring a portrait box.
 */

/** Authored width. Every UI layout coordinate is relative to this. */
export const VIRT_W = 270;
/** Reference height, used only for the render target's initial allocation. */
export const VIRT_H = 480;

// Portrait phones run about 0.42 (21:9) to 0.68 (a small handset once the URL
// bar has taken its share). The clamp covers all of it with room to spare, so
// nothing anyone actually holds ever letterboxes. Past 0.70 is tablet and
// desktop territory, where a portrait game has to be boxed anyway — the touch
// band and the circuit picker both need a frame taller than it is wide.
const MIN_ASPECT = 0.38;
const MAX_ASPECT = 0.70;

// Bounds on the internal resolution. MAX_PIXELS is the real budget: it is what
// keeps fragment cost flat across devices no matter how tall the screen is.
const MIN_W = 220;
const MAX_W = 340;
const MAX_H = 680;
const MAX_PIXELS = 210_000;

// Scale applied to the scene canvas's drawing buffer. 1 means it matches the
// stage exactly and the browser does no scaling at all. Overridable at runtime
// purely as a diagnostic — see `deviceWidth` below.
const OUT_SCALE = (() => {
  const m = /[?&]out=([0-9.]+)/.exec(location.search);
  const v = m ? parseFloat(m[1]) : 1;
  return Number.isFinite(v) && v > 0.05 && v <= 1 ? v : 1;
})();

export class Display {
  constructor() {
    this.stage = document.getElementById('stage');
    this.sceneCanvas = document.getElementById('scene');
    this.uiCanvas = document.getElementById('ui');
    this.rotateHint = document.getElementById('rotate-hint');

    this.width = VIRT_W;
    this.height = VIRT_H;
    this.pixelScale = 1;
    this.scale = 1;

    this.ui = this.uiCanvas.getContext('2d', { alpha: true });

    this._onResize = this.resize.bind(this);
    window.addEventListener('resize', this._onResize, { passive: true });
    window.addEventListener('orientationchange', this._onResize, { passive: true });
    // The visual viewport is the one that shrinks when the URL bar slides in,
    // and the only one that reports the area actually on screen.
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', this._onResize, { passive: true });
      window.visualViewport.addEventListener('scroll', this._onResize, { passive: true });
    }

    this.resize();
  }

  get aspect() { return this.width / this.height; }

  /**
   * Pick an internal resolution for the current viewport and size the stage to
   * match it, so the canvases fill the screen with no black surround.
   */
  resize() {
    // Three different numbers claim to be "the height of the viewport" and on
    // mobile they disagree, because the URL bar and the gesture bar overlay the
    // page rather than shrinking it. Take the smallest: a stage larger than the
    // screen pushes the HUD off the bottom edge, and there is no upside to
    // guessing high.
    const de = document.documentElement;
    const vw = Math.max(1, Math.min(
      window.visualViewport?.width ?? Infinity,
      de?.clientWidth || Infinity,
      window.innerWidth || Infinity,
    ));
    const vh = Math.max(1, Math.min(
      window.visualViewport?.height ?? Infinity,
      de?.clientHeight || Infinity,
      window.innerHeight || Infinity,
    ));

    // The tallest box the layouts tolerate that fits the viewport. When the
    // viewport is already inside the clamp this *is* the viewport, exactly.
    const aspect = clamp(vw / vh, MIN_ASPECT, MAX_ASPECT);
    let cw = vw;
    let ch = vw / aspect;
    if (ch > vh) { ch = vh; cw = vh * aspect; }

    // Capping the device pixel ratio matters more than it looks: it only feeds
    // the integer step below, and a 4x phone would otherwise pick a step that
    // buys nothing visible through a nearest-neighbour upscale.
    const dpr = clamp(window.devicePixelRatio || 1, 1, 3);
    const dw = Math.max(1, Math.round(cw * dpr));
    const dh = Math.max(1, Math.round(ch * dpr));

    const at = (s) => ({
      w: Math.max(2, Math.round(dw / s)),
      h: Math.max(2, Math.round(dh / s)),
    });

    // Coarsen until the resolution is inside every bound; then, only if that
    // left it narrower than the layouts can take, back off one step.
    let step = Math.max(1, Math.round(dw / VIRT_W));
    let r = at(step);
    while (step < 24 && (r.w > MAX_W || r.h > MAX_H || r.w * r.h > MAX_PIXELS)) {
      r = at(++step);
    }
    while (step > 1 && r.w < MIN_W && at(step - 1).w <= MAX_W) {
      r = at(--step);
    }

    // A low-DPR screen can leave no whole number that lands in range at all —
    // 400 device pixels across is either 400 game pixels (no pixel art left) or
    // 200 (the longest string on the title screen no longer fits). Take the
    // fractional step rather than break the layout: uneven pixel sizes are a
    // blemish, text running off the edge is a bug.
    if (r.w < MIN_W) {
      step = dw / MIN_W;
      r = { w: MIN_W, h: Math.max(2, Math.round(dh / step)) };
    }

    const changed = r.w !== this.width || r.h !== this.height;
    this.width = r.w;
    this.height = r.h;
    this.pixelScale = step;
    this.scale = cw / r.w;            // CSS pixels per game pixel

    // Device-pixel size of the stage. The scene canvas takes this as its
    // drawing buffer so the browser never has to scale it — see PixelRenderer.
    //
    // `?out=<n>` scales it, for bisecting a fault that only appears on one
    // physical device. A full-resolution buffer on a tall phone is ~10 MB, and
    // a browser under GPU memory pressure (a hundred open tabs, say) can hand
    // back less than was asked for. Halving it is a one-tap way to find out
    // whether size is the variable, without a rebuild or a redeploy.
    this.deviceWidth = Math.max(2, Math.round(dw * OUT_SCALE));
    this.deviceHeight = Math.max(2, Math.round(dh * OUT_SCALE));

    if (changed) {
      // Only the UI canvas. The scene canvas's buffer belongs to the renderer,
      // which sizes it to the device instead.
      this.uiCanvas.width = r.w;
      this.uiCanvas.height = r.h;
      // Assigning a backing-store size resets every 2D context flag, so the one
      // that actually matters has to be reapplied here rather than once at setup.
      this.ui.imageSmoothingEnabled = false;
    }

    const w = Math.round(cw);
    const h = Math.round(ch);
    // `position: fixed` is relative to the layout viewport; visualViewport's
    // offsets say where the visible area currently sits inside it. Both are 0
    // in the normal case and non-zero exactly when the user has pinch-zoomed or
    // the on-screen keyboard has pushed the page up.
    const ox = window.visualViewport?.offsetLeft ?? 0;
    const oy = window.visualViewport?.offsetTop ?? 0;
    this.stage.style.width = `${w}px`;
    this.stage.style.height = `${h}px`;
    this.stage.style.left = `${Math.round(ox + (vw - cw) / 2)}px`;
    this.stage.style.top = `${Math.round(oy + (vh - ch) / 2)}px`;
    this.cssWidth = w;
    this.cssHeight = h;

    // Nudge landscape phones to turn; desktop landscape just gets pillarboxed.
    const coarse = window.matchMedia?.('(pointer: coarse)').matches;
    const landscape = vw > vh;
    if (this.rotateHint) this.rotateHint.hidden = !(coarse && landscape);

    this.onResize?.(this);
  }

  /** Map a client-space point (pointer event) into internal pixel space. */
  toVirtual(clientX, clientY, out = {}) {
    const r = this.stage.getBoundingClientRect();
    out.x = ((clientX - r.left) / r.width) * this.width;
    out.y = ((clientY - r.top) / r.height) * this.height;
    return out;
  }

  dispose() {
    window.removeEventListener('resize', this._onResize);
    window.removeEventListener('orientationchange', this._onResize);
    window.visualViewport?.removeEventListener('resize', this._onResize);
    window.visualViewport?.removeEventListener('scroll', this._onResize);
  }
}
