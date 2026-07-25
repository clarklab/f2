import { drawText, textWidth } from './BitmapFont.js';
import { drawMinimap, trackPreview } from './Minimap.js';
import { formatTime, clamp01, clamp } from '../core/MathUtil.js';
import { loadLogo, logoImage, LOGO_WIDTH, LOGO_HEIGHT } from './logo.js';

/**
 * UI — every screen and the in-race HUD, drawn into the 2D overlay canvas at
 * the same 270x480 internal resolution as the game.
 *
 * Everything here is immediate mode: `main.js` decides which screen is current
 * and calls the matching method each frame. There is no retained widget tree,
 * because at this size there is nothing a widget tree would buy — the whole
 * HUD is a few dozen rectangles and some text.
 */

export const PAL = {
  ink: '#f2f6ff',
  dim: '#8b95c4',
  dark: '#0a0d1a',
  panel: '#151a30',
  panelEdge: '#39436e',
  accent: '#40e0ff',
  accent2: '#ff4d7a',
  warn: '#ffd23f',
  good: '#5cff9d',
  bad: '#ff5c5c',
};

export class UI {
  constructor(display) {
    this.display = display;
    this.ctx = display.ui;
    this.W = display.width;
    this.H = display.height;
    this.time = 0;
    // Start decoding immediately; the title screen is the first thing drawn.
    loadLogo();
  }

  clear() {
    this.ctx.clearRect(0, 0, this.W, this.H);
  }

  tick(dt) {
    this.time += dt;
  }

  /** Blink helper: true for `on` seconds out of every `on + off`. */
  blink(period = 0.8, duty = 0.55) {
    return (this.time % period) / period < duty;
  }

  // -------------------------------------------------------------------
  // Primitives
  // -------------------------------------------------------------------

  rect(x, y, w, h, color) {
    this.ctx.fillStyle = color;
    this.ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
  }

  frame(x, y, w, h, { fill = PAL.panel, edge = PAL.panelEdge, alpha = 1 } = {}) {
    const c = this.ctx;
    c.globalAlpha = alpha;
    this.rect(x, y, w, h, fill);
    c.fillStyle = edge;
    c.fillRect(Math.round(x), Math.round(y), Math.round(w), 1);
    c.fillRect(Math.round(x), Math.round(y + h - 1), Math.round(w), 1);
    c.fillRect(Math.round(x), Math.round(y), 1, Math.round(h));
    c.fillRect(Math.round(x + w - 1), Math.round(y), 1, Math.round(h));
    c.globalAlpha = 1;
  }

  text(str, x, y, opts) {
    drawText(this.ctx, str, x, y, opts);
  }

  /** A horizontal meter with a segmented, dithered fill. */
  meter(x, y, w, h, value01, { fill = PAL.accent, back = '#241a2e', edge = PAL.ink } = {}) {
    this.rect(x, y, w, h, back);
    const filled = Math.round((w - 2) * clamp01(value01));
    // Drawn as discrete segments rather than a smooth bar: a continuous bar is
    // the one element that would give away that this is not a 16-bit HUD.
    const seg = 3;
    for (let i = 0; i < filled; i += seg) {
      this.rect(x + 1 + i, y + 1, Math.min(seg - 1, filled - i), h - 2, fill);
    }
    this.ctx.strokeStyle = edge;
    this.ctx.lineWidth = 1;
    this.ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(w) - 1, Math.round(h) - 1);
  }

  // -------------------------------------------------------------------
  // Title
  // -------------------------------------------------------------------

  drawTitle({ canContinue = false } = {}) {
    const { W } = this;
    const bob = Math.sin(this.time * 1.6) * 2;

    const logo = logoImage();
    const logoY = 74 + bob;
    if (logo) {
      this.ctx.drawImage(logo, Math.round((W - LOGO_WIDTH) / 2), Math.round(logoY));
    } else {
      // The sprite is a data URI so it decodes almost immediately, but drawing
      // nothing at all on the very first frames would be a visible blink.
      this.text('V-ZERO', W / 2, logoY + 20, {
        scale: 5, align: 'center', color: PAL.ink, shadow: PAL.dark,
      });
    }

    const underY = logoY + LOGO_HEIGHT + 14;
    this.rect(W / 2 - 96, underY - 6, 192, 1, PAL.accent);
    this.text('VELOCITY ZERO RACING LEAGUE', W / 2, underY, {
      scale: 1, align: 'center', color: PAL.accent, tracking: 2,
    });

    // The flythrough runs behind all of this, and the road is bright. Both of
    // the lower text blocks need something to sit on.
    this.rect(0, 294, W, 22, 'rgba(8,11,22,0.66)');
    if (this.blink(1.0, 0.62)) {
      this.text(canContinue ? 'TAP OR PRESS ENTER' : 'TAP TO START', W / 2, 300, {
        scale: 2, align: 'center', color: PAL.warn,
      });
    }

    this.rect(0, this.H - 32, W, 32, 'rgba(8,11,22,0.66)');
    this.text('BUILT WITH THREE.JS', W / 2, this.H - 26, { scale: 1, align: 'center', color: PAL.dim });
    // Deliberately says "world, models and sound" rather than "everything":
    // the wordmark above is supplied artwork, not generated.
    this.text('PROCEDURAL WORLD, MODELS AND SOUND', W / 2, this.H - 16, {
      scale: 1, align: 'center', color: PAL.dim,
    });
  }

  // -------------------------------------------------------------------
  // Menus
  // -------------------------------------------------------------------

  /**
   * A vertical list. Returns the hit rectangles so the caller can map taps.
   * @param {Array<{label:string, sub?:string, locked?:boolean}>} items
   */
  drawMenu(title, items, index, { top = 120, rowH = 34 } = {}) {
    const { W } = this;
    this.text(title, W / 2, 62, { scale: 2, align: 'center', color: PAL.accent });
    this.rect(W / 2 - 60, 80, 120, 1, PAL.panelEdge);

    const rects = [];
    items.forEach((item, i) => {
      const y = top + i * rowH;
      const sel = i === index;
      this.frame(24, y, W - 48, rowH - 6, {
        fill: sel ? '#222b4e' : PAL.panel,
        edge: sel ? PAL.accent : PAL.panelEdge,
      });
      if (sel && this.blink(0.7, 0.7)) {
        this.text('>', 32, y + 8, { scale: 1, color: PAL.accent });
      }
      this.text(item.label, 44, y + 6, {
        scale: 1, color: item.locked ? PAL.dim : (sel ? PAL.ink : PAL.dim),
      });
      if (item.sub) {
        this.text(item.sub, 44, y + 16, { scale: 1, color: PAL.dim });
      }
      rects.push({ x: 24, y, w: W - 48, h: rowH - 6, index: i });
    });
    return rects;
  }

  // -------------------------------------------------------------------
  // Machine select
  // -------------------------------------------------------------------

  /** The 3D model is rendered behind this by the scene; this is the chrome. */
  drawMachineSelect(machine, index, total) {
    const { W, H } = this;
    this.rect(0, 0, W, 70, 'rgba(10,13,26,0.8)');
    this.text('SELECT MACHINE', W / 2, 22, { scale: 1, align: 'center', color: PAL.dim });

    this.text(machine.name, W / 2, 36, { scale: 2, align: 'center', color: PAL.ink });
    this.text(`NO.${machine.number}  ${machine.pilot}`, W / 2, 56, {
      scale: 1, align: 'center', color: PAL.accent,
    });

    // Left/right arrows sit at thumb height on the model, not at the top.
    const arrowY = 190;
    if (this.blink(0.9, 0.6)) {
      this.text('<', 16, arrowY, { scale: 2, color: PAL.accent });
      this.text('>', W - 26, arrowY, { scale: 2, color: PAL.accent });
    }

    // Dots showing position in the list.
    for (let i = 0; i < total; i++) {
      const dx = W / 2 - (total * 8) / 2 + i * 8;
      this.rect(dx, 300, 5, 3, i === index ? PAL.accent : PAL.panelEdge);
    }

    const panelY = 312;
    this.frame(20, panelY, W - 40, 96, { fill: 'rgba(16,21,42,0.96)' });

    const stats = [
      ['BODY', machine.stats.body],
      ['BOOST', machine.stats.boost],
      ['GRIP', machine.stats.grip],
    ];
    stats.forEach(([label, value], i) => {
      const y = panelY + 10 + i * 14;
      this.text(label, 30, y, { scale: 1, color: PAL.dim });
      for (let k = 0; k < 5; k++) {
        const on = k < value;
        this.rect(78 + k * 12, y, 10, 6, on ? PAL.accent : '#232a48');
      }
    });

    this.text(`TOP  ${Math.round(machine.topSpeed * 3.6)} KM/H`, 30, panelY + 56, {
      scale: 1, color: PAL.ink,
    });
    this.text(`MASS ${machine.weight} KG`, 30, panelY + 66, { scale: 1, color: PAL.ink });

    // Blurb wraps to the panel width.
    this._wrapText(machine.blurb, 30, panelY + 80, W - 60, 1, PAL.warn);
  }

  _wrapText(str, x, y, maxW, scale, color) {
    const words = String(str).split(' ');
    let line = '';
    let ly = y;
    for (const w of words) {
      const test = line ? `${line} ${w}` : w;
      if (textWidth(test, scale) > maxW && line) {
        this.text(line, x, ly, { scale, color });
        ly += (7 + 2) * scale;
        line = w;
      } else {
        line = test;
      }
    }
    if (line) this.text(line, x, ly, { scale, color });
    return ly;
  }

  // -------------------------------------------------------------------
  // Track select
  // -------------------------------------------------------------------

  drawTrackSelect(tracks, paths, index, records) {
    const { W } = this;
    this.rect(0, 0, W, 32, 'rgba(10,13,26,0.88)');
    this.text('SELECT CIRCUIT', W / 2, 20, { scale: 1, align: 'center', color: PAL.dim });

    const track = tracks[index];
    const path = paths[track.id];

    // Big preview of the selected circuit — the top-down map.
    const pw = 200;
    const ph = 150;
    const px = (W - pw) / 2;
    const py = 40;
    this.frame(px - 4, py - 4, pw + 8, ph + 8, { fill: '#0d1120' });
    if (path) {
      const prev = trackPreview(track.id, path, pw, ph, {
        road: PAL.ink, edge: '#2b3358', start: PAL.accent2, width: 5, pad: 14,
      });
      this.ctx.drawImage(prev.canvas, Math.round(px), Math.round(py));
    }

    // The live 3D scene runs behind these menus, so every text block needs its
    // own backing panel — white text over a sunlit road is unreadable.
    const infoTop = py + ph + 8;
    this.frame(16, infoTop, W - 32, 92, { fill: 'rgba(10,13,26,0.92)' });

    this.text(track.name, W / 2, infoTop + 6, { scale: 2, align: 'center', color: PAL.ink });
    this.text(track.subtitle, W / 2, infoTop + 26, { scale: 1, align: 'center', color: PAL.accent });

    // Length and difficulty.
    const infoY = infoTop + 42;
    this.text(`${Math.round(path?.length ?? 0)} M`, 26, infoY, { scale: 1, color: PAL.dim });
    this.text(`${track.laps} LAPS`, W - 26, infoY, { scale: 1, color: PAL.dim, align: 'right' });

    this.text('DIFFICULTY', 26, infoY + 12, { scale: 1, color: PAL.dim });
    for (let k = 0; k < 5; k++) {
      this.rect(94 + k * 10, infoY + 12, 8, 6, k < track.difficulty ? PAL.accent2 : '#232a48');
    }

    const rec = records?.[track.id];
    this.text('BEST', 26, infoY + 26, { scale: 1, color: PAL.dim });
    this.text(rec ? formatTime(rec) : "--'--\"--", 94, infoY + 26, {
      scale: 1, color: rec ? PAL.warn : PAL.dim,
    });

    // Row of small previews acting as the selector.
    const stripY = this.H - 62;
    const cell = 34;
    const totalW = tracks.length * (cell + 4) - 4;
    const startX = (W - totalW) / 2;
    const rects = [];
    tracks.forEach((t, i) => {
      const x = startX + i * (cell + 4);
      const sel = i === index;
      this.frame(x, stripY, cell, cell, {
        fill: '#0d1120', edge: sel ? PAL.accent : PAL.panelEdge,
      });
      const p = paths[t.id];
      if (p) {
        const sm = trackPreview(t.id, p, cell - 6, cell - 6, {
          road: sel ? PAL.ink : PAL.dim, edge: '#0d1120', start: PAL.accent2,
          width: 2, pad: 3,
        });
        this.ctx.drawImage(sm.canvas, x + 3, stripY + 3);
      }
      rects.push({ x, y: stripY, w: cell, h: cell, index: i });
    });

    this.rect(0, this.H - 24, W, 24, 'rgba(10,13,26,0.88)');
    if (this.blink(1.0, 0.6)) {
      this.text('TAP CIRCUIT TO RACE', W / 2, this.H - 17, {
        scale: 1, align: 'center', color: PAL.warn,
      });
    }
    return rects;
  }

  // -------------------------------------------------------------------
  // HUD
  // -------------------------------------------------------------------

  drawHud(race, player, machine, path, opts = {}) {
    const { W, H } = this;
    const entry = race.playerEntry;

    // --- top left: best and current lap ---
    this.text('BEST', 6, 6, { scale: 1, color: PAL.dim });
    this.text(formatTime(race.bestLap ?? opts.record ?? Infinity), 6, 16, {
      scale: 2, color: PAL.ink,
    });

    // --- top right: power and speed ---
    const barW = 96;
    const barX = W - barW - 6;
    this.text('POWER', barX, 6, { scale: 1, color: PAL.dim });
    const e01 = player.energy01;
    const low = e01 < 0.26;
    this.meter(barX + 32, 5, barW - 32, 8, e01, {
      fill: low ? (this.blink(0.28, 0.5) ? PAL.bad : '#7a2030') : PAL.accent2,
    });

    this.text('SPEED', barX, 20, { scale: 1, color: PAL.dim });
    const kmh = Math.round(player.speedKmh);
    this.text(String(kmh).padStart(3, ' '), W - 34, 17, {
      scale: 2, align: 'right', color: player.boosting ? PAL.warn : PAL.ink,
    });
    this.text('KM/H', W - 6, 22, { scale: 1, align: 'right', color: PAL.dim });

    // --- current lap time ---
    this.text(formatTime(race.currentLapTime), W - 6, 36, {
      scale: 2, align: 'right', color: PAL.warn,
    });

    // --- lap counter ---
    this.text(`LAP ${Math.min(entry.lap + 1, race.laps)}/${race.laps}`, W / 2, 6, {
      scale: 1, align: 'center', color: PAL.ink,
    });

    // --- rank ---
    const need = race.qualifyRank;
    const inDanger = need !== null && entry.rank > need;
    this.text('RANK', 6, 40, { scale: 1, color: PAL.dim });
    this.text(String(entry.rank), 6, 50, {
      scale: 3, color: inDanger ? (this.blink(0.3, 0.5) ? PAL.bad : PAL.ink) : PAL.ink,
    });
    this.text(`/${race.fieldSize}`, 26, 60, { scale: 1, color: PAL.dim });
    if (need !== null) {
      this.text('SAFE', 6, 76, { scale: 1, color: PAL.dim });
      this.text(String(need), 32, 74, { scale: 2, color: inDanger ? PAL.bad : PAL.good });
    }

    // --- boost charges ---
    for (let i = 0; i < 3; i++) {
      const on = i < player.boostCharges;
      const x = W - 12 - i * 12;
      this.text('S', x, H - 76, {
        scale: 2, color: on ? (player.boosting ? PAL.warn : PAL.good) : '#2a3050', align: 'right',
      });
    }

    // --- minimap ---
    drawMinimap(this.ctx, race.trackDef.id, path, 6, H - 66, 60, 60, race.entries, {
      road: '#cfd8ff', edge: '#0d1120',
    });

    // --- warnings ---
    if (inDanger && this.blink(0.5, 0.5)) {
      this.text('RANK WARNING', W / 2, 96, { scale: 1, align: 'center', color: PAL.bad });
    }
    if (low && this.blink(0.4, 0.5)) {
      this.text('POWER LOW', W / 2, 106, { scale: 1, align: 'center', color: PAL.bad });
    }
  }

  drawCountdown(n) {
    const { W, H } = this;
    if (n > 0) {
      const scale = 8;
      this.text(String(n), W / 2, H / 2 - 40, {
        scale, align: 'center', color: PAL.ink, shadow: PAL.dark,
      });
    } else {
      this.text('GO!', W / 2, H / 2 - 40, {
        scale: 9, align: 'center', color: PAL.warn, shadow: PAL.dark,
      });
    }
  }

  /** Big transient banner: LAP 2, FINAL LAP, BOOST, and so on. */
  drawBanner(text, alpha = 1, color = PAL.accent) {
    if (alpha <= 0) return;
    const { W, H } = this;
    this.ctx.globalAlpha = clamp01(alpha);
    this.rect(0, H / 2 - 24, W, 26, 'rgba(10,13,26,0.72)');
    this.text(text, W / 2, H / 2 - 18, { scale: 2, align: 'center', color });
    this.ctx.globalAlpha = 1;
  }

  // -------------------------------------------------------------------
  // Touch hints
  // -------------------------------------------------------------------

  drawTouchControls(input, show) {
    if (!show) return;
    const L = input.layout;
    const c = this.ctx;
    c.globalAlpha = 0.16;
    this.rect(L.steer.x, L.steer.y, L.steer.w, L.steer.h, PAL.accent);
    this.rect(L.boost.x + 2, L.boost.y, L.boost.w - 2, L.boost.h - 1, PAL.warn);
    this.rect(L.brake.x + 2, L.brake.y + 1, L.brake.w - 2, L.brake.h - 1, PAL.accent2);
    c.globalAlpha = 0.55;
    this.text('STEER', L.steer.x + L.steer.w / 2, L.steer.y + L.steer.h / 2 - 4, {
      scale: 1, align: 'center', color: PAL.ink,
    });
    this.text('BOOST', L.boost.x + L.boost.w / 2, L.boost.y + L.boost.h / 2 - 4, {
      scale: 1, align: 'center', color: PAL.ink,
    });
    this.text('BRAKE', L.brake.x + L.brake.w / 2, L.brake.y + L.brake.h / 2 - 4, {
      scale: 1, align: 'center', color: PAL.ink,
    });
    c.globalAlpha = 1;
  }

  // -------------------------------------------------------------------
  // Results
  // -------------------------------------------------------------------

  drawResults(race, { title = 'RESULTS', showPoints = true, cupTotals = null } = {}) {
    const { W, H } = this;
    this.rect(0, 0, W, H, 'rgba(6,8,18,0.86)');
    this.text(title, W / 2, 24, { scale: 3, align: 'center', color: PAL.accent });

    const standings = race.standings();
    const top = 60;
    const rowH = 16;
    const shown = Math.min(standings.length, 12);

    this.text('POS', 12, top - 12, { scale: 1, color: PAL.dim });
    this.text('PILOT', 40, top - 12, { scale: 1, color: PAL.dim });
    this.text('TIME', W - 44, top - 12, { scale: 1, color: PAL.dim, align: 'right' });
    if (showPoints) this.text('PTS', W - 10, top - 12, { scale: 1, color: PAL.dim, align: 'right' });

    for (let i = 0; i < shown; i++) {
      const e = standings[i];
      const y = top + i * rowH;
      const me = e.isPlayer;
      if (me) this.rect(8, y - 2, W - 16, rowH - 2, '#1d2647');
      const color = me ? PAL.warn : (e.retired ? PAL.bad : PAL.ink);
      this.text(String(e.rank), 12, y, { scale: 1, color });
      this.text(e.name, 40, y, { scale: 1, color });
      this.text(e.retired ? 'OUT' : formatTime(e.finishTime), W - 44, y, {
        scale: 1, color, align: 'right',
      });
      if (showPoints) {
        this.text(String(e.points), W - 10, y, { scale: 1, color, align: 'right' });
      }
    }

    if (cupTotals) {
      const cy = top + shown * rowH + 10;
      this.rect(8, cy, W - 16, 1, PAL.panelEdge);
      this.text('CHAMPIONSHIP', W / 2, cy + 6, { scale: 1, align: 'center', color: PAL.accent });
      cupTotals.slice(0, 5).forEach((c, i) => {
        const y = cy + 18 + i * 12;
        const color = c.isPlayer ? PAL.warn : PAL.dim;
        this.text(`${i + 1}`, 12, y, { scale: 1, color });
        this.text(c.name, 30, y, { scale: 1, color });
        this.text(String(c.points), W - 12, y, { scale: 1, color, align: 'right' });
      });
    }

    if (this.blink(1.0, 0.6)) {
      this.text('TAP TO CONTINUE', W / 2, H - 20, { scale: 1, align: 'center', color: PAL.warn });
    }
  }

  drawRetired(reason, spares) {
    const { W, H } = this;
    this.rect(0, 0, W, H, 'rgba(24,4,10,0.82)');
    this.text(reason === 'RANK' ? 'DISQUALIFIED' : 'MACHINE LOST', W / 2, H / 2 - 60, {
      scale: 2, align: 'center', color: PAL.bad,
    });
    this.text(
      reason === 'RANK' ? 'RANK BELOW THE QUALIFYING CUT' : 'POWER DEPLETED',
      W / 2, H / 2 - 34, { scale: 1, align: 'center', color: PAL.dim },
    );
    this.text(`SPARE MACHINES  ${Math.max(0, spares)}`, W / 2, H / 2, {
      scale: 1, align: 'center', color: spares > 0 ? PAL.ink : PAL.bad,
    });
    if (this.blink(0.9, 0.6)) {
      this.text(spares > 0 ? 'TAP TO RETRY' : 'TAP TO CONTINUE', W / 2, H / 2 + 40, {
        scale: 1, align: 'center', color: PAL.warn,
      });
    }
  }

  drawPause(index) {
    const { W, H } = this;
    this.rect(0, 0, W, H, 'rgba(6,8,18,0.8)');
    this.text('PAUSED', W / 2, 120, { scale: 3, align: 'center', color: PAL.accent });
    return this.drawMenu('', [
      { label: 'RESUME' },
      { label: 'RESTART RACE' },
      { label: 'QUIT TO TITLE' },
    ], index, { top: 190, rowH: 30 });
  }

  /** Small diagnostic readout, toggled with F3. */
  drawDebug(lines) {
    let y = 2;
    for (const line of lines) {
      this.text(line, this.W - 2, y, { scale: 1, align: 'right', color: PAL.good });
      y += 9;
    }
  }
}
