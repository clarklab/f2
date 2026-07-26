/**
 * Audio — every sound in the game, synthesised at runtime.
 *
 * Nothing is loaded. The engine is an oscillator stack driven by speed, the
 * effects are envelopes on filtered noise, and the music is a chiptune
 * sequencer built on pulse waves with programmable duty cycles.
 *
 * Three things carry most of the quality:
 *
 *  - Continuous parameters are driven with `setTargetAtTime`, never by
 *    assigning `.value` each frame. `.value` is applied as a hard step at the
 *    next block boundary, so writing it at 60 fps produces sixty
 *    discontinuities a second — audible as a buzzing "zipper" riding on the
 *    engine note.
 *
 *  - The whole oscillator stack is tuned from one `ConstantSourceNode` through
 *    per-oscillator gain multipliers. Oscillator frequency is an a-rate param
 *    and incoming connections sum with it, so one write retunes the entire
 *    stack in perfect lock instead of six writes that can drift apart.
 *
 *  - The music scheduler is a lookahead loop: a coarse timer wakes every 25 ms
 *    and schedules everything falling in the next 100 ms against the audio
 *    clock. Scheduling notes when they should play instead would put them at
 *    the mercy of layout and GC, which skew JS timers by tens of milliseconds.
 *    The timer lives in a Worker so a busy main thread cannot stall it.
 */

const TIMER_WORKER = `
let id = null, interval = 25;
self.onmessage = (e) => {
  if (e.data === 'start') { clearInterval(id); id = setInterval(() => postMessage('tick'), interval); }
  else if (e.data === 'stop') { clearInterval(id); id = null; }
  else if (e.data.interval) { interval = e.data.interval; if (id) { clearInterval(id); id = setInterval(() => postMessage('tick'), interval); } }
};`;

const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

export class Audio {
  constructor() {
    this.ready = false;
    this.enabled = true;
    this.ctx = null;
    this._pulseCache = new Map();
    this._lastEngine = { speed: -1, throttle: -1, load: -1 };
    this._throttleGates = new Map();
  }

  // -------------------------------------------------------------------
  // Setup
  // -------------------------------------------------------------------

  /** Build the graph. Safe to call before any user gesture. */
  init() {
    if (this.ctx) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) { this.enabled = false; return; }
    const ctx = new Ctx({ latencyHint: 'interactive' });
    this.ctx = ctx;

    this.master = ctx.createGain();
    this.master.gain.value = 0.85;

    // A compressor alone is not a ceiling — at 20:1 a 20 dB overshoot still
    // passes 1 dB. The soft clipper after it is the actual brick wall.
    this.limiter = ctx.createWaveShaper();
    this.limiter.curve = softClipCurve(1.3);
    this.limiter.oversample = '4x';

    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -12;
    this.comp.knee.value = 0;
    this.comp.ratio.value = 18;
    this.comp.attack.value = 0.003;
    this.comp.release.value = 0.25;

    this.comp.connect(this.limiter);
    this.limiter.connect(this.master);
    this.master.connect(ctx.destination);

    this.busEngine = ctx.createGain(); this.busEngine.gain.value = 0.5;
    this.busSfx = ctx.createGain(); this.busSfx.gain.value = 0.85;
    this.busMusic = ctx.createGain(); this.busMusic.gain.value = 0.42;
    for (const b of [this.busEngine, this.busSfx, this.busMusic]) b.connect(this.comp);

    // A feedback echo shared by the music voices. Space is the brief: the lead
    // and the FX pings send into it and their repeats trail away behind the
    // music, darkening as they go (the lowpass sits inside the loop, so every
    // pass through it stacks). One delay for everything, like the reverb.
    this.echoIn = ctx.createGain();
    this.echoDelay = ctx.createDelay(1.0);
    this.echoDelay.delayTime.value = 0.29;
    this.echoTone = ctx.createBiquadFilter();
    this.echoTone.type = 'lowpass';
    this.echoTone.frequency.value = 2600;
    this.echoFb = ctx.createGain();
    this.echoFb.gain.value = 0.42;
    this.echoIn.connect(this.echoDelay);
    this.echoDelay.connect(this.echoTone);
    this.echoTone.connect(this.echoFb);
    this.echoFb.connect(this.echoDelay);
    this.echoTone.connect(this.busMusic);

    // One reverb for the whole game. A ConvolverNode is among the most
    // expensive nodes available, so it is a single shared send, never per-voice.
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = makeImpulse(ctx, 1.5, 2.6, 0.4);
    this.reverbSend = ctx.createGain();
    this.reverbSend.gain.value = 0.9;
    this.reverbSend.connect(this.reverb);
    this.reverb.connect(this.comp);

    // Built once and shared by every noise-based effect for the lifetime of the
    // page. Allocating an AudioBuffer mid-race is a guaranteed frame spike.
    this.noiseWhite = makeNoise(ctx, 2, false);
    this.noisePink = makeNoise(ctx, 2, true);

    this._buildEngine();
    this._buildScrape();
    this._buildAlarm();
    this._buildSequencer();

    // Pre-bake the wavetables the music and UI will need.
    for (const d of [0.125, 0.25, 0.5, 0.75]) this.pulseWave(d);
  }

  /**
   * Resume the context. Must be called from inside a user gesture; the graph
   * itself is built ahead of time so the gesture handler does no real work.
   */
  async unlock() {
    if (!this.ctx) this.init();
    if (!this.ctx) return false;
    try {
      if (this.ctx.state !== 'running') await this.ctx.resume();
      // iOS belt-and-braces: a silent one-sample buffer inside the gesture.
      const b = this.ctx.createBuffer(1, 1, this.ctx.sampleRate);
      const s = this.ctx.createBufferSource();
      s.buffer = b;
      s.connect(this.ctx.destination);
      s.start(0);
      this.ready = this.ctx.state === 'running';
      return this.ready;
    } catch {
      return false;
    }
  }

  get time() { return this.ctx ? this.ctx.currentTime : 0; }

  setMuted(muted) {
    this.enabled = !muted;
    if (this.master) {
      this.master.gain.setTargetAtTime(muted ? 0.0001 : 0.85, this.time, 0.03);
    }
  }

  /** Cached PeriodicWave for a pulse of arbitrary duty cycle. */
  pulseWave(duty, harmonics = 48) {
    const key = duty.toFixed(3);
    let w = this._pulseCache.get(key);
    if (w) return w;
    const real = new Float32Array(harmonics + 1);
    const imag = new Float32Array(harmonics + 1);
    // Fourier series of a bipolar pulse train: a_n = (4/(n*pi)) * sin(n*pi*d).
    // At d = 0.5 the even terms vanish and this reduces to a square wave, which
    // is the sanity check that the formula is right.
    for (let n = 1; n <= harmonics; n++) {
      real[n] = (4 / (n * Math.PI)) * Math.sin(n * Math.PI * duty);
    }
    w = this.ctx.createPeriodicWave(real, imag, { disableNormalization: false });
    this._pulseCache.set(key, w);
    return w;
  }

  _noiseSource(pink = false, loop = true) {
    const s = this.ctx.createBufferSource();
    s.buffer = pink ? this.noisePink : this.noiseWhite;
    s.loop = loop;
    s.playbackRate.value = 0.85 + Math.random() * 0.3;
    return s;
  }

  // -------------------------------------------------------------------
  // Engine
  // -------------------------------------------------------------------

  _buildEngine() {
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const out = ctx.createGain();
    out.gain.value = 0;
    out.connect(this.busEngine);

    // One node controls the pitch of the entire stack.
    const pitch = ctx.createConstantSource();
    pitch.offset.value = 44;
    pitch.start(t);

    const SPEC = [
      { mult: 0.5, det: 0, type: 'sine', g: 0.9 },
      { mult: 1.0, det: -7, type: 'sawtooth', g: 1.0 },
      { mult: 1.0, det: 6, type: 'sawtooth', g: 0.95 },
      { mult: 2.0, det: -11, type: 'sawtooth', g: 0.45 },
      { mult: 3.0, det: 13, type: 'square', g: 0.18 },
      { mult: 4.02, det: 3, type: 'sawtooth', g: 0.1 },
    ];

    const oscMix = ctx.createGain();
    oscMix.gain.value = 0.2;
    const oscs = [];
    for (const s of SPEC) {
      const osc = ctx.createOscillator();
      osc.type = s.type;
      osc.frequency.value = 0;         // all pitch arrives through the connection
      osc.detune.value = s.det;
      const mult = ctx.createGain();
      mult.gain.value = s.mult;
      pitch.connect(mult);
      mult.connect(osc.frequency);
      const g = ctx.createGain();
      g.gain.value = s.g;
      osc.connect(g);
      g.connect(oscMix);
      osc.start(t);
      oscs.push(osc);
    }

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 420;
    lp.Q.value = 6;
    oscMix.connect(lp);

    const peak = ctx.createBiquadFilter();
    peak.type = 'peaking';
    peak.frequency.value = 1400;
    peak.Q.value = 2.5;
    peak.gain.value = 7;
    lp.connect(peak);

    // Hover throb: an LFO added onto a gain's value. With a non-zero base the
    // result is tremolo; at zero it would be true ring modulation.
    const throb = ctx.createGain();
    throb.gain.value = 0.84;
    const throbLfo = ctx.createOscillator();
    throbLfo.type = 'sine';
    throbLfo.frequency.value = 17;
    const throbDepth = ctx.createGain();
    throbDepth.gain.value = 0.16;
    throbLfo.connect(throbDepth);
    throbDepth.connect(throb.gain);
    throbLfo.start(t);
    peak.connect(throb);
    throb.connect(out);

    // Thrust air.
    const noise = this._noiseSource(true);
    const nHp = ctx.createBiquadFilter();
    nHp.type = 'highpass';
    nHp.frequency.value = 180;
    const nBp = ctx.createBiquadFilter();
    nBp.type = 'bandpass';
    nBp.frequency.value = 600;
    nBp.Q.value = 0.9;
    const nGain = ctx.createGain();
    nGain.gain.value = 0;
    noise.connect(nHp); nHp.connect(nBp); nBp.connect(nGain); nGain.connect(out);
    noise.start(t);

    this.engine = { out, pitch, oscs, oscMix, lp, peak, throbLfo, throbDepth, nBp, nGain };
  }

  startEngine() {
    if (!this.ready) return;
    const t = this.time;
    const g = this.engine.out.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(0.9, t + 0.3);
  }

  stopEngine() {
    if (!this.ctx) return;
    const t = this.time;
    const g = this.engine.out.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(0.0001, t + 0.4);
  }

  /**
   * @param {number} speed01 0..1
   * @param {number} throttle 0..1
   * @param {number} load 0..1 — boosting, scraping, climbing
   */
  updateEngine(speed01, throttle, load = 0) {
    if (!this.ready || !this.engine) return;
    const L = this._lastEngine;
    // Gate on an epsilon: every scheduled event lands in a per-parameter list
    // that the audio thread has to walk, and 60 writes/second/param adds up.
    if (Math.abs(speed01 - L.speed) < 0.003 &&
        Math.abs(throttle - L.throttle) < 0.02 &&
        Math.abs(load - L.load) < 0.02) return;
    L.speed = speed01; L.throttle = throttle; L.load = load;

    const e = this.engine;
    const t = this.time;
    const FAST = 0.035;
    const SLOW = 0.11;   // pitch gets inertia, like a turbine spooling

    // Exponential in speed: a linear map sounds like a sewing machine.
    set(e.pitch.offset, 44 * Math.pow(7.4, speed01), t, SLOW);
    set(e.lp.frequency, Math.min(16000, 320 + 5200 * Math.pow(speed01, 1.4) + 1800 * throttle), t, FAST);
    set(e.lp.Q, 4 + 6 * Math.sin(Math.PI * Math.min(1, speed01)), t, 0.2);
    set(e.peak.frequency, 900 + 3000 * speed01, t, SLOW);
    set(e.throbLfo.frequency, 14 + 44 * speed01, t, SLOW);
    set(e.throbDepth.gain, 0.2 * (1 - 0.6 * speed01) + 0.22 * load, t, 0.15);
    set(e.nBp.frequency, 380 + 4000 * speed01, t, FAST);
    set(e.nGain.gain, 0.04 + 0.26 * throttle * (0.35 + speed01), t, FAST);
    set(e.oscMix.gain, 0.11 + 0.15 * throttle + 0.07 * speed01, t, FAST);
  }

  // -------------------------------------------------------------------
  // Continuous effects
  // -------------------------------------------------------------------

  _buildScrape() {
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const out = ctx.createGain();
    out.gain.value = 0.0001;

    const shaper = ctx.createWaveShaper();
    shaper.curve = softClipCurve(5);
    shaper.oversample = '2x';
    out.connect(shaper);
    shaper.connect(this.busSfx);
    const send = ctx.createGain();
    send.gain.value = 0.25;
    shaper.connect(send);
    send.connect(this.reverbSend);

    const src = this._noiseSource(false);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 900;
    src.connect(hp);

    // High-Q bandpasses at inharmonic ratios is what makes noise sound like
    // metal rather than like hiss.
    const RATIOS = [1, 1.71, 2.43, 3.12, 4.31];
    const res = RATIOS.map((r, i) => {
      const b = ctx.createBiquadFilter();
      b.type = 'bandpass';
      b.frequency.value = 1800 * r;
      b.Q.value = 26 - i * 3;
      const g = ctx.createGain();
      g.gain.value = 1 / (1 + i * 0.6);
      hp.connect(b); b.connect(g); g.connect(out);
      return { b, ratio: r };
    });

    // Chatter turns a smooth hiss into a grind.
    const chatter = ctx.createOscillator();
    chatter.type = 'sawtooth';
    chatter.frequency.value = 33;
    const chatterDepth = ctx.createGain();
    chatterDepth.gain.value = 0;
    chatter.connect(chatterDepth);
    chatterDepth.connect(out.gain);
    chatter.start(t);
    src.start(t);

    this.scrape = { out, hp, res, chatter, chatterDepth, last: -1 };
  }

  setScrape(intensity, speed01 = 1) {
    if (!this.ready || !this.scrape) return;
    const s = this.scrape;
    if (Math.abs(intensity - s.last) < 0.02) return;
    s.last = intensity;
    const t = this.time;
    const k = Math.max(0.0001, intensity);
    set(s.out.gain, 0.0001 + 0.5 * k * k, t, 0.03);
    set(s.chatter.frequency, 18 + 90 * speed01 + 40 * k, t, 0.05);
    set(s.chatterDepth.gain, 0.28 * k, t, 0.05);
    set(s.hp.frequency, 600 + 1400 * k, t, 0.05);
    const base = 1800 * (0.7 + 0.9 * speed01) * (0.85 + 0.4 * k);
    for (const r of s.res) set(r.b.frequency, base * r.ratio, t, 0.06);
  }

  _buildAlarm() {
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const out = ctx.createGain();
    out.gain.value = 0.0001;
    out.connect(this.busSfx);

    const o1 = ctx.createOscillator();
    const o2 = ctx.createOscillator();
    o1.setPeriodicWave(this.pulseWave(0.25));
    o2.setPeriodicWave(this.pulseWave(0.25));
    o1.frequency.value = 880;
    o2.frequency.value = 660;
    o2.detune.value = 8;

    const gate1 = ctx.createGain(); gate1.gain.value = 0.5;
    const gate2 = ctx.createGain(); gate2.gain.value = 0.5;
    const lfo = ctx.createOscillator();
    lfo.type = 'square';
    lfo.frequency.value = 3;
    const up = ctx.createGain(); up.gain.value = 0.5;
    const dn = ctx.createGain(); dn.gain.value = -0.5;
    lfo.connect(up); lfo.connect(dn);
    up.connect(gate1.gain); dn.connect(gate2.gain);
    o1.connect(gate1); o2.connect(gate2);
    gate1.connect(out); gate2.connect(out);
    o1.start(t); o2.start(t); lfo.start(t);

    this.alarm = { out, o1, o2, lfo, last: -1 };
  }

  setAlarm(severity) {
    if (!this.ready || !this.alarm) return;
    const a = this.alarm;
    if (Math.abs(severity - a.last) < 0.03) return;
    a.last = severity;
    const t = this.time;
    set(a.out.gain, severity <= 0 ? 0.0001 : 0.05 + 0.2 * severity, t, 0.08);
    set(a.lfo.frequency, 2.2 + 7 * severity, t, 0.15);
    set(a.o1.frequency, 880 + 260 * severity, t, 0.2);
    set(a.o2.frequency, 660 + 200 * severity, t, 0.2);
  }

  // -------------------------------------------------------------------
  // One-shot effects
  // -------------------------------------------------------------------

  /** Rate-limit a sound type; a pile-up can otherwise fire dozens in a frame. */
  _gate(key, minGap) {
    const t = this.time;
    const last = this._throttleGates.get(key) ?? -99;
    if (last + minGap > t) return false;
    this._throttleGates.set(key, t);
    return true;
  }

  _free(node, at) {
    const ms = Math.max(0, at - this.time) * 1000 + 150;
    setTimeout(() => { try { node.disconnect(); } catch { /* already gone */ } }, ms);
  }

  /** Short chiptune blip: pulse wave with stepped pitch and a fast envelope. */
  chip(steps, { dur = 0.09, duty = 0.5, gain = 0.26, at = null, dest = null, vibrato = 0, echo = 0 } = {}) {
    if (!this.ready) return;
    const ctx = this.ctx;
    const t = at ?? this.time;
    const o = ctx.createOscillator();
    o.setPeriodicWave(this.pulseWave(duty));
    const stepDur = dur / steps.length;
    // Stepped, not glided: the stepping is the sound.
    steps.forEach((m, i) => o.frequency.setValueAtTime(mtof(m), t + i * stepDur));

    if (vibrato > 0) {
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 14;
      const d = ctx.createGain();
      d.gain.value = vibrato;
      lfo.connect(d); d.connect(o.detune);
      lfo.start(t); lfo.stop(t + dur + 0.05);
    }

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.004);
    g.gain.setValueAtTime(gain, t + dur * 0.7);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g);
    g.connect(dest ?? this.busSfx);
    if (echo > 0 && this.echoIn) {
      const e = ctx.createGain();
      e.gain.value = echo;
      g.connect(e);
      e.connect(this.echoIn);
    }
    o.start(t);
    o.stop(t + dur + 0.02);
    this._free(g, t + dur);
  }

  uiMove() { this.chip([84], { dur: 0.05, duty: 0.25, gain: 0.2 }); }
  uiConfirm() {
    const t = this.time;
    this.chip([79], { dur: 0.06, at: t, gain: 0.24 });
    this.chip([86], { dur: 0.13, at: t + 0.06, gain: 0.24 });
  }
  uiBack() {
    const t = this.time;
    this.chip([74], { dur: 0.055, duty: 0.125, at: t, gain: 0.22 });
    this.chip([67], { dur: 0.11, duty: 0.125, at: t + 0.055, gain: 0.22 });
  }
  uiError() {
    this.chip([43, 41, 43, 41, 43, 41, 40, 40], { dur: 0.3, duty: 0.125, gain: 0.28 });
  }

  /**
   * The contact click for a screen tap — deliberately not one of the menu
   * sounds above.
   *
   * A tap and the thing it activates are two separate events, and in the
   * attract mode they are separated in time by a frame or two. Reusing
   * `uiMove` for the tap made every menu press a stuttered double-blip;
   * a short, quiet, high tick reads as a finger landing on glass and then
   * gets out of the way of the menu's own answer.
   */
  uiTap() { this.chip([96], { dur: 0.028, duty: 0.125, gain: 0.11 }); }

  countdownBeep(n) {
    if (!this.ready) return;
    if (n > 0) {
      this.chip([81], { dur: 0.16, gain: 0.32 });
      this._sine(220, 0.16, 0.18);
    } else {
      // "GO" is an octave up and longer — the pitch jump is the signal.
      this.chip([93, 93, 93], { dur: 0.5, duty: 0.25, gain: 0.36, vibrato: 25 });
      this.chip([88], { dur: 0.45, gain: 0.16 });
      this._sine(440, 0.45, 0.2);
    }
  }

  _sine(hz, dur, gain) {
    const ctx = this.ctx;
    const t = this.time;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.value = hz;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(this.busSfx);
    o.start(t); o.stop(t + dur + 0.02);
    this._free(g, t + dur);
  }

  lapChime() {
    if (!this.ready) return;
    const t = this.time;
    const wet = this.ctx.createGain();
    wet.gain.value = 0.4;
    wet.connect(this.reverbSend);
    [[72, 0], [76, 0.09], [79, 0.18], [84, 0.27]].forEach(([m, off], i) => {
      const dur = i === 3 ? 0.34 : 0.1;
      this.chip([m], { at: t + off, dur, gain: 0.24 });
      this.chip([m], { at: t + off, dur, gain: 0.18, dest: wet });
    });
    this._free(wet, t + 3);
  }

  boost() {
    if (!this.ready || !this._gate('boost', 0.15)) return;
    const ctx = this.ctx;
    const t = this.time;
    const dur = 1.1;
    const out = ctx.createGain();
    out.gain.value = 0.85;
    out.connect(this.busSfx);
    const send = ctx.createGain();
    send.gain.value = 0.22;
    out.connect(send); send.connect(this.reverbSend);

    // Noise through a bandpass that sweeps up then falls away.
    const n = this._noiseSource(false);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.Q.value = 1.6;
    bp.frequency.setValueAtTime(180, t);
    bp.frequency.exponentialRampToValueAtTime(5000, t + dur * 0.42);
    bp.frequency.exponentialRampToValueAtTime(320, t + dur);
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.0001, t);
    ng.gain.exponentialRampToValueAtTime(0.8, t + 0.09);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    n.connect(bp); bp.connect(ng); ng.connect(out);
    n.start(t); n.stop(t + dur + 0.05);

    // Pitched ignition.
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(70, t);
    o.frequency.exponentialRampToValueAtTime(520, t + dur * 0.35);
    o.frequency.exponentialRampToValueAtTime(240, t + dur);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.Q.value = 8;
    lp.frequency.setValueAtTime(300, t);
    lp.frequency.exponentialRampToValueAtTime(6000, t + dur * 0.35);
    lp.frequency.exponentialRampToValueAtTime(500, t + dur);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.0001, t);
    og.gain.exponentialRampToValueAtTime(0.5, t + 0.05);
    og.gain.exponentialRampToValueAtTime(0.0001, t + dur * 0.9);
    o.connect(lp); lp.connect(og); og.connect(out);
    o.start(t); o.stop(t + dur + 0.05);

    // Sub kick so the boost has physical weight.
    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(140, t);
    sub.frequency.exponentialRampToValueAtTime(38, t + 0.28);
    const sg = ctx.createGain();
    sg.gain.setValueAtTime(0.0001, t);
    sg.gain.exponentialRampToValueAtTime(0.85, t + 0.01);
    sg.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
    sub.connect(sg); sg.connect(out);
    sub.start(t); sub.stop(t + 0.4);

    this._free(out, t + dur + 0.2);
  }

  impact(force = 1) {
    if (!this.ready || !this._gate('impact', 0.05)) return;
    const ctx = this.ctx;
    const t = this.time;
    const out = ctx.createGain();
    out.gain.value = Math.min(1, 0.45 + 0.6 * force);
    out.connect(this.busSfx);

    const body = ctx.createOscillator();
    body.type = 'sine';
    const f0 = 190 * (0.75 + 0.5 * force);
    body.frequency.setValueAtTime(f0, t);
    body.frequency.exponentialRampToValueAtTime(f0 * 0.18, t + 0.16);
    const bg = ctx.createGain();
    bg.gain.setValueAtTime(0.0001, t);
    bg.gain.exponentialRampToValueAtTime(1, t + 0.004);
    bg.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
    body.connect(bg); bg.connect(out);
    body.start(t); body.stop(t + 0.35);

    const n = this._noiseSource(false);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.Q.value = 1.5;
    lp.frequency.setValueAtTime(2200, t);
    lp.frequency.exponentialRampToValueAtTime(280, t + 0.14);
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.0001, t);
    ng.gain.exponentialRampToValueAtTime(0.8, t + 0.003);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
    n.connect(lp); lp.connect(ng); ng.connect(out);
    n.start(t); n.stop(t + 0.25);

    this._free(out, t + 0.5);
  }

  explosion() {
    if (!this.ready) return;
    const ctx = this.ctx;
    const t = this.time;
    const dur = 1.5;
    const out = ctx.createGain();
    const dist = ctx.createWaveShaper();
    dist.curve = softClipCurve(3.5);
    dist.oversample = '2x';
    out.connect(dist); dist.connect(this.busSfx);
    const send = ctx.createGain(); send.gain.value = 0.5;
    dist.connect(send); send.connect(this.reverbSend);

    const n = this._noiseSource(true);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.Q.value = 2.2;
    lp.frequency.setValueAtTime(6000, t);
    lp.frequency.exponentialRampToValueAtTime(1400, t + 0.12);
    lp.frequency.exponentialRampToValueAtTime(70, t + dur);
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.0001, t);
    ng.gain.exponentialRampToValueAtTime(1, t + 0.006);
    ng.gain.exponentialRampToValueAtTime(0.4, t + 0.22);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    n.connect(lp); lp.connect(ng); ng.connect(out);
    n.start(t); n.stop(t + dur + 0.1);

    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(120, t);
    sub.frequency.exponentialRampToValueAtTime(22, t + 0.8);
    const sg = ctx.createGain();
    sg.gain.setValueAtTime(0.0001, t);
    sg.gain.exponentialRampToValueAtTime(1.1, t + 0.012);
    sg.gain.exponentialRampToValueAtTime(0.0001, t + 0.95);
    sub.connect(sg); sg.connect(out);
    sub.start(t); sub.stop(t + 1.1);

    this._free(out, t + dur + 1);
  }

  jump() {
    if (!this.ready || !this._gate('jump', 0.2)) return;
    const ctx = this.ctx;
    const t = this.time;
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(180, t);
    o.frequency.exponentialRampToValueAtTime(760, t + 0.22);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.55, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
    o.connect(g); g.connect(this.busSfx);
    o.start(t); o.stop(t + 0.35);
    this._free(g, t + 0.4);
  }

  land(force = 1) { this.impact(0.6 * force); }
  mine() { this.impact(1); this.explosion(); }

  // -------------------------------------------------------------------
  // Music
  // -------------------------------------------------------------------

  _buildSequencer() {
    this.seq = {
      playing: false,
      tempo: 168,
      step: 0,
      nextTime: 0,
      bar: 0,
      song: null,
      lookahead: 0.1,
    };
    try {
      this.seq.worker = new Worker(URL.createObjectURL(
        new Blob([TIMER_WORKER], { type: 'application/javascript' }),
      ));
      this.seq.worker.onmessage = () => this._schedule();
      this.seq.worker.postMessage({ interval: 25 });
    } catch {
      // Worker unavailable (rare CSP setups). A main-thread timer still works,
      // it is only less robust when the render loop is saturated.
      this.seq.timer = null;
    }
  }

  playMusic(song) {
    if (!this.ready || !song) return;
    this.seq.song = song;
    this.seq.tempo = song.bpm;
    this.seq.step = 0;
    this.seq.bar = 0;
    this.seq.nextTime = this.time + 0.08;
    this.seq.playing = true;
    if (this.seq.worker) this.seq.worker.postMessage('start');
    else if (!this.seq.timer) this.seq.timer = setInterval(() => this._schedule(), 25);
  }

  stopMusic() {
    if (!this.seq) return;
    this.seq.playing = false;
    if (this.seq.worker) this.seq.worker.postMessage('stop');
    if (this.seq.timer) { clearInterval(this.seq.timer); this.seq.timer = null; }
  }

  /** Speed the music up on the final lap. Takes effect on the next step. */
  setTempoScale(scale) {
    if (this.seq?.song) this.seq.tempo = this.seq.song.bpm * scale;
  }

  _schedule() {
    const s = this.seq;
    if (!s.playing || !this.ready) return;
    while (s.nextTime < this.time + s.lookahead) {
      this._playStep(s.step, s.nextTime);
      s.nextTime += (60 / s.tempo) / 4;    // sixteenth notes
      s.step++;
      if (s.step % 16 === 0) s.bar++;
    }
  }

  _playStep(step, when) {
    const song = this.seq.song;
    const i = step % 16;
    const chord = song.chords[this.seq.bar % song.chords.length];
    const root = song.key + chord[0];
    const quality = chord[1];
    const stepDur = (60 / this.seq.tempo) / 4;

    // Bass: relentless sixteenths. This pattern is most of what makes the
    // genre feel fast. Songs opt into the acid voice — a filter-swept saw over
    // a sine sub — which is where most of the techno lives.
    const bassTok = song.bass[i];
    if (bassTok !== null) {
      const n = root - 24 + (bassTok === 1 ? 12 : 0) + (typeof bassTok === 'number' && bassTok > 1 ? bassTok : 0);
      if (song.bassStyle === 'acid') this._acid(n, when, stepDur * 0.92, i % 4 === 0);
      else this._tri(n, when, stepDur * 0.92, 0.3);
    }

    // Pad: a dark two-oscillator wash under each bar. It sits far back in the
    // mix, but it is what turns a pattern into a place.
    if (song.pad && i === 0) {
      this._pad(root, quality, when, stepDur * 16);
    }

    // Space FX on a four-bar cycle: a filtered-noise riser into the odd bars,
    // a sonar ping answered by the echo bus on the others. Deterministic by
    // bar, so the song breathes on a schedule rather than at random.
    if (song.fx && i === 0) {
      const bar = this.seq.bar;
      if (bar % 4 === 2) this._riser(when, stepDur * 16);
      else if (bar % 4 === 0 && bar > 0) this._ping(root + 36, when);
    }

    // Arpeggio: a chord tone per sixteenth. At this tempo the ear fuses them
    // into a chord — the classic chiptune fake-chord trick.
    if (song.arp[i] !== null) {
      const tone = quality[song.arp[i] % quality.length];
      this.chip([root + tone + 12], {
        at: when, dur: stepDur * 0.7, duty: 0.25, gain: 0.09, dest: this.busMusic,
      });
    }

    // Lead. The echo send is per-song: the space songs let every phrase trail
    // off into the delay, which fills the gaps the sparser writing leaves.
    const lead = song.lead[(step % song.lead.length)];
    if (lead !== null && lead !== -1) {
      let len = stepDur;
      let k = (step % song.lead.length) + 1;
      while (k < song.lead.length && song.lead[k] === -1) { len += stepDur; k++; }
      this.chip([lead], {
        at: when, dur: len * 0.95, duty: song.leadDuty ?? 0.5, gain: 0.12,
        dest: this.busMusic, vibrato: 18, echo: song.leadEcho ?? 0,
      });
    }

    if (song.kick[i]) this._kick(when);
    if (song.snare[i]) this._snare(when);
    if (song.hat[i]) this._hat(when, song.ohat[i] === 1);
  }

  _tri(midi, when, dur, gain) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(mtof(midi), when);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 2400; lp.Q.value = 1.2;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.linearRampToValueAtTime(gain, when + 0.004);
    g.gain.setValueAtTime(gain, when + Math.max(dur - 0.02, 0.01));
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    o.connect(lp); lp.connect(g); g.connect(this.busMusic);
    o.start(when); o.stop(when + dur + 0.02);
    this._free(g, when + dur);
  }

  /**
   * Acid bass: a sawtooth through a resonant lowpass whose cutoff is an
   * envelope, over a sine sub an octave down. The sweep is the squelch; the
   * sub is the weight the saw alone does not have. Accented steps open the
   * filter harder, which is what makes a static pattern move.
   */
  _acid(midi, when, dur, accent) {
    const ctx = this.ctx;
    const saw = ctx.createOscillator();
    saw.type = 'sawtooth';
    saw.frequency.setValueAtTime(mtof(midi), when);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 9;
    lp.frequency.setValueAtTime(accent ? 2100 : 1100, when);
    lp.frequency.exponentialRampToValueAtTime(220, when + dur);
    const sg = ctx.createGain();
    sg.gain.setValueAtTime(0.0001, when);
    sg.gain.linearRampToValueAtTime(accent ? 0.3 : 0.22, when + 0.005);
    sg.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    saw.connect(lp); lp.connect(sg); sg.connect(this.busMusic);
    saw.start(when); saw.stop(when + dur + 0.02);

    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(mtof(midi - 12), when);
    const bg = ctx.createGain();
    bg.gain.setValueAtTime(0.0001, when);
    bg.gain.linearRampToValueAtTime(0.24, when + 0.006);
    bg.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    sub.connect(bg); bg.connect(this.busMusic);
    sub.start(when); sub.stop(when + dur + 0.02);
    this._free(sg, when + dur);
    this._free(bg, when + dur);
  }

  /**
   * Pad: two detuned saws on root and fifth through a slow lowpass, one bar
   * long, quiet. The detune beats against itself, which is the whole "synth
   * wash" effect; the send into the echo smears the bar changes together.
   */
  _pad(root, quality, when, dur) {
    const ctx = this.ctx;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(520, when);
    lp.frequency.linearRampToValueAtTime(980, when + dur * 0.6);
    lp.frequency.linearRampToValueAtTime(520, when + dur);
    lp.Q.value = 0.8;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.linearRampToValueAtTime(0.055, when + dur * 0.25);
    g.gain.setValueAtTime(0.055, when + dur * 0.8);
    g.gain.linearRampToValueAtTime(0.0001, when + dur + 0.05);
    lp.connect(g); g.connect(this.busMusic);
    const e = ctx.createGain();
    e.gain.value = 0.12;
    g.connect(e); e.connect(this.echoIn);

    const fifth = quality[2] ?? 7;
    for (const [m, cents] of [[root, -7], [root, 6], [root + fifth, -5], [root + fifth + 12, 4]]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(mtof(m), when);
      o.detune.value = cents;
      o.connect(lp);
      o.start(when); o.stop(when + dur + 0.1);
    }
    this._free(g, when + dur + 0.1);
  }

  /** A filtered-noise riser: tension that resolves onto the next downbeat. */
  _riser(when, dur) {
    const ctx = this.ctx;
    const n = this._noiseSource(false, false);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 1.6;
    bp.frequency.setValueAtTime(260, when);
    bp.frequency.exponentialRampToValueAtTime(3400, when + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.linearRampToValueAtTime(0.07, when + dur * 0.85);
    g.gain.linearRampToValueAtTime(0.0001, when + dur);
    n.connect(bp); bp.connect(g); g.connect(this.busMusic);
    n.start(when); n.stop(when + dur + 0.02);
    this._free(g, when + dur + 0.05);
  }

  /** A sonar blip that the echo bus answers. The cheapest space there is. */
  _ping(midi, when) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(mtof(midi), when);
    o.frequency.exponentialRampToValueAtTime(mtof(midi) * 0.985, when + 0.16);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.linearRampToValueAtTime(0.11, when + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, when + 0.18);
    o.connect(g); g.connect(this.busMusic);
    const e = ctx.createGain();
    e.gain.value = 0.85;
    g.connect(e); e.connect(this.echoIn);
    o.start(when); o.stop(when + 0.2);
    this._free(g, when + 0.25);
  }

  _kick(when) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(150, when);
    o.frequency.exponentialRampToValueAtTime(45, when + 0.055);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(0.85, when + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, when + 0.3);
    o.connect(g); g.connect(this.busMusic);
    o.start(when); o.stop(when + 0.33);
    this._free(g, when + 0.35);
  }

  _snare(when) {
    const ctx = this.ctx;
    // Two components: the drum skins and the wires.
    for (const [f, amt] of [[185, 0.45], [349, 0.3]]) {
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = f;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.4 * amt, when);
      g.gain.exponentialRampToValueAtTime(0.0001, when + 0.1);
      o.connect(g); g.connect(this.busMusic);
      o.start(when); o.stop(when + 0.12);
      this._free(g, when + 0.14);
    }
    const n = this._noiseSource(false, false);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 1800;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.34, when);
    g.gain.exponentialRampToValueAtTime(0.0001, when + 0.19);
    n.connect(hp); hp.connect(g); g.connect(this.busMusic);
    n.start(when); n.stop(when + 0.22);
    this._free(g, when + 0.25);
  }

  _hat(when, open) {
    const ctx = this.ctx;
    const dur = open ? 0.26 : 0.045;
    const n = this._noiseSource(false, false);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 7000;
    const g = ctx.createGain();
    g.gain.setValueAtTime(open ? 0.14 : 0.1, when);
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    n.connect(hp); hp.connect(g); g.connect(this.busMusic);
    n.start(when); n.stop(when + dur + 0.02);
    this._free(g, when + dur + 0.05);
  }

  dispose() {
    this.stopMusic();
    this.seq?.worker?.terminate();
    this.ctx?.close();
  }
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

/** The zipper-noise-free setter: a one-pole smoother running at a-rate. */
function set(param, value, t, tau) {
  param.setTargetAtTime(value, t, tau);
}

function softClipCurve(drive = 1.2, n = 2048) {
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / (n - 1) - 1;
    c[i] = Math.tanh(drive * x) / Math.tanh(drive);
  }
  return c;
}

function makeNoise(ctx, seconds, pink) {
  const len = (ctx.sampleRate * seconds) | 0;
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  if (!pink) {
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }
  // Paul Kellet's pink filter. Pink reads as air and rumble; white reads as
  // hiss, which is wrong for engines and explosions.
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < len; i++) {
    const w = Math.random() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.016898;
    d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
    b6 = w * 0.115926;
  }
  return buf;
}

/** Procedural room impulse: noise under an exponential decay, darkening. */
function makeImpulse(ctx, seconds, decay, damping) {
  const rate = ctx.sampleRate;
  const len = Math.floor(rate * seconds);
  const ir = ctx.createBuffer(2, len, rate);
  for (let c = 0; c < 2; c++) {
    const d = ir.getChannelData(c);
    let z = 0;
    for (let i = 0; i < len; i++) {
      const p = i / len;
      const a = damping * p;                       // tail loses highs over time
      z = (Math.random() * 2 - 1) * (1 - a) + z * a;
      const fadeIn = Math.min(1, i / (rate * 0.004));
      d[i] = z * Math.pow(1 - p, decay) * fadeIn;
    }
  }
  return ir;
}
