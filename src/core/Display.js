/**
 * Display — owns the two canvases and the letterboxing.
 *
 * The game renders at a fixed, small, portrait internal resolution and is
 * scaled up as a whole. Scaling by a whole number is what keeps every source
 * pixel exactly square on screen; a fractional scale makes some pixels one
 * device-pixel wider than their neighbours, which shows up as shimmering
 * banding across the road. Fractional scale is only used when the viewport is
 * genuinely too small to fit at 1x or larger.
 */

// 270x480 is a 9:16 portrait frame in the same ballpark as the SNES's 256x224.
// It is small enough that fill rate is a non-issue and large enough that the
// bitmap font stays readable.
export const VIRT_W = 270;
export const VIRT_H = 480;

export class Display {
  constructor() {
    this.stage = document.getElementById('stage');
    this.sceneCanvas = document.getElementById('scene');
    this.uiCanvas = document.getElementById('ui');
    this.rotateHint = document.getElementById('rotate-hint');

    this.width = VIRT_W;
    this.height = VIRT_H;
    this.scale = 1;

    // Backing stores are the internal resolution, never the device resolution.
    // The browser does the upscale for free with nearest-neighbour filtering.
    for (const c of [this.sceneCanvas, this.uiCanvas]) {
      c.width = VIRT_W;
      c.height = VIRT_H;
    }

    this.ui = this.uiCanvas.getContext('2d', { alpha: true, desynchronized: true });
    this.ui.imageSmoothingEnabled = false;

    this._onResize = this.resize.bind(this);
    window.addEventListener('resize', this._onResize, { passive: true });
    window.addEventListener('orientationchange', this._onResize, { passive: true });
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', this._onResize, { passive: true });
    }
    this.resize();
  }

  get aspect() { return VIRT_W / VIRT_H; }

  resize() {
    const vw = window.visualViewport?.width ?? window.innerWidth;
    const vh = window.visualViewport?.height ?? window.innerHeight;

    let scale = Math.min(vw / VIRT_W, vh / VIRT_H);
    // Snap to an integer once there is room to do so without wasting more than
    // a sliver of the screen. Below 2x, banding is less objectionable than a
    // postage-stamp-sized game.
    if (scale >= 2) {
      const snapped = Math.floor(scale);
      if (snapped / scale > 0.8) scale = snapped;
    }

    this.scale = scale;
    const w = Math.round(VIRT_W * scale);
    const h = Math.round(VIRT_H * scale);
    this.stage.style.width = `${w}px`;
    this.stage.style.height = `${h}px`;
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
    out.x = ((clientX - r.left) / r.width) * VIRT_W;
    out.y = ((clientY - r.top) / r.height) * VIRT_H;
    return out;
  }

  dispose() {
    window.removeEventListener('resize', this._onResize);
    window.removeEventListener('orientationchange', this._onResize);
    window.visualViewport?.removeEventListener('resize', this._onResize);
  }
}
