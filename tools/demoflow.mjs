/**
 * Attract-mode smoke test.
 *
 * Leaves the title screen alone and watches the demo take over, then checks it
 * walked the real front end — mode menu, machine select, championship — and
 * that the player's machine is actually being driven. Finally it touches the
 * screen and checks the demo gets out of the way.
 *
 * The point of testing this in a browser rather than in a unit test is that the
 * demo's whole design is "press the real UI at real coordinates". A stub would
 * verify the script against itself and pass forever, including on the day the
 * machine-select confirm band moves.
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

const steps = [];
const check = (label, ok, detail = '') => steps.push({ label, ok: !!ok, detail });

const state = () => page.evaluate(() => {
  const g = window.__game;
  return {
    screen: g._screen,
    demo: g.demo.active,
    idle: +g.demo.idle.toFixed(1),
    taps: g.demo.taps.length,
    machineIndex: g.machineIndex,
    cup: g.cup ? g.cup.index : null,
    autopilot: g.race ? !!g.race.autopilot : null,
    speed: g.race ? Math.round(g.race.player.speed) : null,
  };
});

/** Poll until `pred(state)` holds, or give up. */
async function until(pred, ms, label) {
  const deadline = Date.now() + ms;
  let last = null;
  while (Date.now() < deadline) {
    last = await state();
    if (pred(last)) return last;
    await page.waitForTimeout(250);
  }
  check(label, false, JSON.stringify(last));
  return last;
}

// --- the demo must not fire early, and must fire on time -------------------
await page.waitForTimeout(4000);
let s = await state();
check('still idle at 4s', s.demo === false && s.screen === 'title', JSON.stringify(s));

s = await until((x) => x.demo, 8000, 'demo starts after the idle timeout');
check('demo started', s.demo, JSON.stringify(s));

// --- it walks the real menus -----------------------------------------------
s = await until((x) => x.screen === 'mode', 8000, 'demo reaches the mode menu');
check('reached mode menu', s.screen === 'mode', JSON.stringify(s));
check('taps are visible', s.taps > 0, JSON.stringify(s));

const machineAtEntry = (await until(
  (x) => x.screen === 'machine', 12000, 'demo reaches machine select',
)).machineIndex;
check('reached machine select', true);

// Browsing the roster has to actually change the machine on show.
const browsed = await until(
  (x) => x.screen !== 'machine' || x.machineIndex !== machineAtEntry,
  12000, 'demo browses the roster',
);
check('roster is browsed', browsed.machineIndex !== machineAtEntry || browsed.screen === 'race',
  JSON.stringify(browsed));

// --- it starts the championship and drives ---------------------------------
s = await until((x) => x.screen === 'race', 30000, 'demo starts a race');
check('championship started', s.screen === 'race' && s.cup === 0, JSON.stringify(s));
check('race is on autopilot', s.autopilot === true, JSON.stringify(s));

s = await until((x) => x.speed > 60, 25000, 'the demo machine gets moving');
check('machine is being driven', s.speed > 60, JSON.stringify(s));

// --- a real touch hands the game back --------------------------------------
const box = await page.locator('#stage').boundingBox();
await page.touchscreen.tap(box.x + box.width * 0.5, box.y + box.height * 0.3);
await page.waitForTimeout(600);
s = await state();
check('touch stops the demo', s.demo === false, JSON.stringify(s));
check('touch returns to the title screen', s.screen === 'title', JSON.stringify(s));
check('touch does not punch through to the menu', s.screen !== 'mode', JSON.stringify(s));

// ...and the attract loop re-arms rather than dying.
s = await until((x) => x.demo, 11000, 'demo re-arms after being dismissed');
check('demo re-arms', s.demo, JSON.stringify(s));

console.log(JSON.stringify({ steps, errors: errors.slice(0, 6) }, null, 2));

await browser.close();
if (steps.some((x) => !x.ok) || errors.length) process.exit(1);
