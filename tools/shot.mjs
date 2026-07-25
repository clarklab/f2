/**
 * Screenshot / smoke-test harness.
 *
 * Loads the game in a real browser at a phone-shaped viewport, waits for the
 * first frames, captures a PNG and reports any console errors plus a frame-rate
 * sample. Used both for eyeballing the visuals during development and as a
 * headless check that the whole pipeline still boots.
 *
 *   node tools/shot.mjs out.png [--track=neon-mile] [--wait=1500] [--eval="..."]
 */
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

const args = Object.fromEntries(
  process.argv.slice(3).map((a) => {
    const [k, ...v] = a.replace(/^--/, '').split('=');
    return [k, v.join('=') || true];
  }),
);
const out = process.argv[2] ?? 'shot.png';
const wait = Number(args.wait ?? 1600);

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: [
    '--use-gl=swiftshader',
    '--enable-unsafe-swiftshader',
    '--disable-dev-shm-usage',
    '--no-sandbox',
  ],
});
const page = await browser.newPage({
  viewport: { width: 420, height: 860 },
  deviceScaleFactor: 2,
});

const errors = [];
const logs = [];
page.on('console', (m) => {
  const t = `${m.type()}: ${m.text()}`;
  logs.push(t);
  if (m.type() === 'error') errors.push(t);
});
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}\n${e.stack ?? ''}`));

await page.goto('http://localhost:5173/', { waitUntil: 'load' });

if (args.track) {
  await page.evaluate((id) => window.__game?.loadTrack?.(id), args.track);
}
if (args.eval) {
  await page.evaluate(args.eval);
}

await page.waitForTimeout(wait);

// Sample the frame rate over a short window.
const perf = await page.evaluate(() => new Promise((resolve) => {
  const g = window.__game;
  if (!g) return resolve({ error: 'no game instance' });
  let frames = 0;
  const t0 = performance.now();
  const tick = () => {
    frames++;
    if (performance.now() - t0 < 1000) requestAnimationFrame(tick);
    else resolve({
      fps: +(frames / ((performance.now() - t0) / 1000)).toFixed(1),
      reportedFps: +(g.loop?.fps ?? 0).toFixed(1),
      drawCalls: g.renderer?.drawCalls ?? -1,
      triangles: g.renderer?.triangles ?? -1,
      stepsPerFrame: g.loop?.stepsLastFrame ?? -1,
    });
  };
  requestAnimationFrame(tick);
}));

const buf = await page.screenshot({ type: 'png' });
writeFileSync(out, buf);

console.log(JSON.stringify({ out, perf, errors: errors.slice(0, 12) }, null, 2));
if (args.logs) console.log(logs.slice(-40).join('\n'));

await browser.close();
process.exit(errors.length ? 1 : 0);
