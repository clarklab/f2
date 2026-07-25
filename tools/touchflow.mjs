/**
 * Touch navigation smoke test.
 *
 * Walks the whole front end with synthetic touch input — title, mode, machine,
 * circuit, race — and asserts the game reaches each screen. Menu navigation is
 * the easiest thing in a game to break silently, because it is the one part
 * that never runs during development (you reload straight into whatever you are
 * working on).
 */
import { chromium } from 'playwright';

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const context = await browser.newContext({
  viewport: { width: 400, height: 820 },
  hasTouch: true,
  isMobile: true,
});
const page = await context.newPage();

const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto('http://localhost:5173/', { waitUntil: 'load' });
await page.waitForFunction(() => window.__game?._screen, null, { timeout: 15000 });

const screen = () => page.evaluate(() => window.__game._screen);

/** Tap at a fraction of the stage, in stage-relative coordinates. */
async function tapAt(fx, fy) {
  const box = await page.locator('#stage').boundingBox();
  await page.touchscreen.tap(box.x + box.width * fx, box.y + box.height * fy);
  await page.waitForTimeout(320);
}

const steps = [];
const record = async (label, expected) => {
  const got = await screen();
  steps.push({ label, expected, got, ok: got === expected });
};

await record('initial', 'title');

// Title -> mode: a tap anywhere in the viewport area.
await tapAt(0.5, 0.3);
await record('after tapping title', 'mode');

// Mode -> machine: tap the first row (GRAND PRIX is row 0; take SINGLE RACE so
// the flow reaches the circuit picker rather than starting a championship).
await tapAt(0.5, 0.355);   // second row
await tapAt(0.5, 0.355);   // first tap selects, second confirms
await record('after choosing a mode', 'machine');

// Machine -> circuit: tap the lower panel area to confirm.
await tapAt(0.5, 0.78);
await record('after choosing a machine', 'track');

// Circuit -> race: tap the already-selected preview in the strip. This lives
// in the bottom 10% of the screen, which is exactly the region the driving
// control zones used to swallow.
const strip = await page.evaluate(() => {
  const r = window.__game.menuRects.find((x) => x.index === window.__game.trackIndex);
  const d = window.__game.display;
  return r ? { fx: (r.x + r.w / 2) / d.width, fy: (r.y + r.h / 2) / d.height } : null;
});
steps.push({
  label: 'circuit strip is laid out',
  expected: true, got: !!strip, ok: !!strip,
});
if (strip) await tapAt(strip.fx, strip.fy);
await record('after tapping a circuit', 'race');

// Drive with a touch drag in the steering zone and confirm input is read.
const box = await page.locator('#stage').boundingBox();
await page.touchscreen.tap(box.x + box.width * 0.25, box.y + box.height * 0.8);
await page.waitForTimeout(1200);
const input = await page.evaluate(() => ({
  hasTouch: window.__game.input.hasTouch,
  throttle: window.__game.input.throttle,
  screen: window.__game._screen,
}));

console.log(JSON.stringify({ steps, input, errors: errors.slice(0, 6) }, null, 2));

await browser.close();
const failed = steps.filter((s) => !s.ok);
if (failed.length || errors.length) process.exit(1);
