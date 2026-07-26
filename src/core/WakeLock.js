/**
 * WakeLock — hold the screen on while nobody is touching it.
 *
 * The attract mode is the one part of this game that runs for minutes with no
 * input at all, which is exactly the condition every phone treats as "nobody is
 * here" before dimming and locking. A demo that puts itself to sleep two
 * minutes in is not a demo.
 *
 * Everything here is best-effort by design. `navigator.wakeLock` is absent on
 * older browsers, and `request()` rejects for reasons that are none of the
 * game's business — battery saver, a backgrounded tab, platform policy. None of
 * those are errors worth surfacing: the screen dims, which is what would have
 * happened anyway.
 *
 * The one non-obvious part is re-acquisition. A screen lock is released
 * automatically whenever the page stops being visible, and it is *not* restored
 * when the page comes back — so a lock taken once and forgotten is gone the
 * first time the user switches apps. `want` is the intent, `_sentinel` is
 * whether we currently hold one, and the visibility handler reconciles them.
 */
export class WakeLock {
  constructor() {
    this.want = false;
    this._sentinel = null;
    this._pending = false;
    this.supported = typeof navigator !== 'undefined' && 'wakeLock' in navigator;

    if (this.supported && typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (this.want && document.visibilityState === 'visible') this._acquire();
      });
    }
  }

  /** Ask for the screen to stay on. Safe to call repeatedly. */
  enable() {
    this.want = true;
    this._acquire();
  }

  /** Let the screen sleep again. Safe to call when nothing is held. */
  disable() {
    this.want = false;
    const s = this._sentinel;
    this._sentinel = null;
    s?.release?.().catch(() => {});
  }

  get held() { return this._sentinel !== null; }

  async _acquire() {
    if (!this.supported || this._sentinel || this._pending) return;
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    this._pending = true;
    try {
      const s = await navigator.wakeLock.request('screen');
      // The intent can be dropped while the request is in flight — a touch that
      // ends the demo lands before the promise settles often enough to matter.
      if (!this.want) { s.release().catch(() => {}); return; }
      this._sentinel = s;
      s.addEventListener?.('release', () => {
        if (this._sentinel === s) this._sentinel = null;
      });
    } catch {
      // Denied. The screen dims; nothing else changes.
    } finally {
      this._pending = false;
    }
  }
}
