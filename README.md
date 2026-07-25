# VELOCITY ZERO

A pixel-art anti-gravity racer that runs in a browser, played in portrait.
Real 3D geometry — banked corners, elevation changes, hills — rendered at a low
internal resolution so it reads as authentic 16-bit pixel art rather than as a
filter over a modern scene.

**No outside assets.** Nothing is sourced from anywhere — every pixel and every
sound is original. The road surface, the machines, the sky, the HUD typeface,
the engine note and the music are all synthesised in code when the page loads;
the V-ZERO wordmark is original art baked into the bundle at build time (see
[The logo](#the-logo)). The build is one JavaScript file and one stylesheet,
with no images, audio or fonts alongside them.

```
npm install
npm run dev      # http://localhost:5173
npm run build    # -> dist/
npm test         # 34 tests: track geometry, physics, race rules
```

## Controls

|                | Touch                                | Keyboard   | Gamepad            |
| -------------- | ------------------------------------ | ---------- | ------------------ |
| Steer          | Drag anywhere in the lower-left area | ← → or A D | Left stick / d-pad |
| Accelerate     | Automatic while steering             | ↑ or W     | RT or A            |
| Brake          | Bottom-right button                  | ↓ or S     | LT or B            |
| Boost          | Right button above brake             | Shift or B | LB + RB            |
| Lean / strafe  | Push the steer drag past ~80%        | Q / E      | LB / RB            |
| Pause          | —                                    | P or Esc   | Start              |

Steering is a *relative* slider: wherever your thumb lands becomes centre, so
there is nothing to aim for and no dead travel. Pushing past 80% engages the
lean on that side automatically, which is what an expert would do anyway.

## How it drives

The handling is modelled on the 1990 original rather than on a generic arcade
racer, because that game's feel comes from one specific and unusual decision:
the machine's **heading** and its **velocity vector** are separate quantities,
and cornering is entirely about how fast one is rotated onto the other.

```
gripped = (speed < slipSpeed) || throttle released
```

The slip speed sits *below* top speed. So at racing pace, holding the throttle
through a corner breaks traction: the nose points into the corner and the
machine keeps travelling straight. Lift for a fraction of a second and grip
snaps back, the velocity swings onto the heading, and the acceleration curve
immediately restores the speed you gave up.

Feathering the throttle through corners is therefore not a technique layered on
top of the physics — it *is* the physics. Everything else follows: the shoulder
buttons are a lateral strafe rather than a drift, acceleration is a decaying
curve sampled by current speed rather than a formula, and top speed comes from
that curve tailing off against a hard clamp rather than from drag.

The energy economy is the other half. The POWER bar is both your health and
your lap time: rails drain it, low power caps your top speed, and the only way
to refill is a strip you have to *slow down* on to benefit from. Every wall
scrape is compound interest.

And you are not racing the leader — you are racing a **qualifying cut** that
tightens every lap. Miss it and you are out on the spot.

## Circuits

Six, each built around one idea.

| Circuit | Signature |
| --- | --- |
| **NEON MILE** | Wide and forgiving. A jump plate mid-backstretch, dirt on the exits. |
| **AZURE DRIFT** | Flowing, over water. The final corner is coated and has no grip at all. |
| **DUNE SEA** | Long constant-radius sweepers over dunes. No gimmicks — pure cornering. |
| **SILENT GRID** | Square corners and narrow corridors. Mine fields with one clean lane. |
| **GALE SPINE** | A plain rectangle made hard by a constant crosswind and a dash-plate chain. Its pit is mid-lap, so using it costs you. |
| **EMBER CORE** | The finale. Every hazard class at once, and attrition is the real opponent. |

Circuits are authored as a drive around them, not as coordinates:

```js
layout: [
  { s: 220, name: 'home-straight' },
  { turn: 45, r: 150, name: 't1' },
  { s: 300, name: 'backstretch', y: 7 },
  ...
]
```

`LoopBuilder` compiles that to control points and asserts that the turns sum to
exactly 360°, which catches a mistyped corner immediately instead of leaving a
kink at the start line. Surface zones then reference segments *by name* —
`{ type: 'boost', seg: 'backstretch', at: [0.12, 0.22] }` — so retuning a corner
moves the boost pad sitting on it instead of silently sliding it into the next
one.

## How it renders

The scene is drawn into a **270×480 render target** and blitted 1:1 to a canvas
that CSS scales up with nearest-neighbour filtering. That is ~130k pixels
against a modern phone's 2.6M, and shading 5% of the pixels is what buys the
frame budget. It is also what makes the image read as pixel art: the chunkiness
is real, not a post-process.

The blit does the retro grade in one pass — sRGB conversion, then
5-bit-per-channel quantisation with an 8×8 ordered dither. The conversion has to
come first: three.js writes render targets in the *linear* working space, so
quantising the raw values would crowd every band into the shadows.

There are no lights in the scene at all. Machine hulls bake a fixed brightness
per face direction into vertex colours, which is both free and much closer to
how sprite-era art actually looked. The underglow is an additive quad with a
dithered radial falloff — a smooth gradient there is the single clearest
giveaway that a "pixel art" game is not really one.

## The logo

The V-ZERO wordmark is the one piece of art that is baked at build time rather
than synthesised at runtime. It starts as a 2172x724 print-resolution image on a
black field and has to end up as a sprite on a 270x480 UI canvas, so
`tools/make-logo.mjs` bakes it down. Three things happen, in this order, and the
order matters:

1. **Key the background** by flood-filling black inward from the borders. A
   plain "all black is transparent" test punches holes in the letterforms — the
   counter of the R and the gaps in the Z are black too, and are part of the
   design. Flood filling only removes black connected to the outside.
2. **Downscale with premultiplied alpha.** Without premultiplying, every partly
   transparent edge pixel blends toward the black underneath it and the wordmark
   comes out ringed in mud.
3. **Quantise to 5 bits per channel with an ordered dither**, matching what the
   renderer does to the 3D scene. The UI is a separate overlay canvas that does
   not pass through that shader, so skipping this leaves the logo as the one
   smoothly shaded thing on screen.

The result is inlined as a base64 data URI, so the build stays a single bundle
and the title never flashes an empty logo while a separate file loads.

## Architecture

```
src/
  core/      display, fixed-timestep loop, input, save, math
  track/     spline + frames, loop authoring DSL, mesh builder, surfaces
  game/      vehicle physics, machines, AI driver, race director, camera
  render/    low-res pipeline, procedural textures, machine models, world
  audio/     synthesis, sequencer, songs
  ui/        bitmap font, screens, HUD, minimap
tests/       geometry, physics and race-rule tests
tools/       headless screenshot + smoke-test harness
```

Everything resolves to **track space** — arc length `s` along the centreline and
lateral offset `d` from it. Mesh generation, physics, AI, lap counting, the
minimap and the camera all read the same sample table, which is uniform in arc
length (not in curve parameter) and framed with rotation-minimising frames
(Frenet frames flip through inflection points and would tear the road apart).

Lap counting integrates signed progress rather than watching for a line
crossing, which makes cutting the course impossible by construction — you cannot
bank distance you did not cover, and driving backwards subtracts.

Physics runs at a fixed 120 Hz with interpolated rendering, so handling is
identical on a 60 Hz phone and a 144 Hz monitor.

## Audio

Synthesised with the Web Audio API, nothing loaded. The engine is a stack of six
detuned oscillators through a resonant lowpass, all tuned from a single
`ConstantSourceNode` so one write retunes the whole stack in lock. Continuous
parameters use `setTargetAtTime` rather than assigning `.value`, which would
apply as a hard step at each block boundary and buzz.

The music is a chiptune sequencer over pulse waves with programmable duty cycles
(the Fourier series of a pulse train, cached per duty). It is scheduled with a
lookahead loop running in a Worker: a coarse timer wakes every 25 ms and queues
everything falling in the next 100 ms against the audio clock, so a busy render
loop cannot make the music stutter.

## Testing

The interesting tests drive the game rather than poking at functions. A handling
bug is invisible in a unit test and obvious after thirty seconds behind the
wheel, so the suite puts an AI on every circuit and checks what happens: does it
complete laps, stay on the road, keep its energy, hit plausible lap times, and
does the full race machinery produce a coherent classification.

That is how most of the real bugs here were found — boost assigning speed
directly so releasing the throttle did nothing, a jump plate applying its impulse
every tick instead of once, a rail correction that pushed the machine further off
track each tick until it reached 1e50 metres, and a packed grid quietly damaging
itself to death because two cars travelling side by side at the same speed
counted as grinding against each other.

## Notes

- `prefers-reduced-motion` is respected: screen shake and camera flourishes damp down.
- Audio is built before the first user gesture and only *resumed* inside it, so
  the gesture handler does no real work and there is no hitch on the first tap.
- `localStorage` is optional; the game runs identically without it.
- Re-bake the logo with `node tools/make-logo.mjs tools/logo-source.png 240`.
- `netlify.toml` builds before publishing. Without it Netlify serves the repo
  root, which means raw unbundled source and a bare `three` import the browser
  cannot resolve — the page loads and the game never starts.
- Press `F3` for a draw-call and frame-rate readout, `M` to mute.

## Licence

MIT. Built as an open-source demo — not for sale.
