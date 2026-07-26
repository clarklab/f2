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
npm test         # 44 tests: track geometry, physics, race rules, attract mode
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

## Attract mode

Leave the title screen alone for seven seconds and the game plays itself, the
way a cabinet does: it picks a machine, enters the championship, and races all
six circuits back to back. Touch anything and it stops instantly and hands the
game back — and that first touch is spent on the dismissal, so a stray tap drops
you on the title screen rather than punching through into the menus.

It drives the real UI. Every menu step is a synthesised *tap* at a real screen
position, pushed through the same input path a thumb uses, so the demo exercises
the actual code — a menu that has broken cannot be papered over by an attract
mode that calls `setScreen` behind its back. The races are the real race
director with `autopilot` on, so it is genuinely racing, not replaying anything.
That makes it a live smoke test of the whole front end, which is how the
machine-select tap regions ended up getting checked on every run for free.

Building it turned up a real AI bug, which is the argument for attract modes in
a sentence. The demo kept exploding on the last circuit of the championship
*while leading* — it drove the perfect line, ground itself down on the rails,
and died. The AI's lane chooser scored a recharge strip at exactly zero, so it
drove past the one thing on the circuit that could save it, every lap. Recharge
strips are now worth a detour in proportion to how much energy is missing, and
the cornering envelope narrows as the tank empties: a rail graze that costs 13%
of a full tank costs everything at 8%. Every AI on the grid got that fix, not
just the demo.

The taps are visible: a ring blooms where each one lands and a short tick plays,
so what you see is a person playing rather than a cutscene. The rings are
plotted with the midpoint circle algorithm instead of `ctx.arc` — at 270 pixels
across, an anti-aliased stroke smears a one-pixel ring over three columns of
half-lit grey, and nothing else on the screen has a soft edge.

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

The scene is drawn into a render target of roughly **270×520** and magnified to
the canvas with nearest-neighbour filtering. That is ~140k pixels against a
modern phone's 2.6M, and shading 5% of the pixels is what buys the frame budget.
It is also what makes the image read as pixel art: the chunkiness is real, not a
post-process.

*Roughly*, because there is no one right resolution. 270 across is the authored
width, but a fixed 270×480 is 9:16 and no phone on sale is 9:16 — pinning the
game to it letterboxes every real device, which on a black page just looks
broken. So the height follows the screen and the width is held near 270, subject
to one constraint: each game pixel must cover a whole number of device pixels.

```
step = round(deviceWidth / 270)      device pixels per game pixel
W, H = deviceWidth / step, deviceHeight / step
```

The integer `step` is the part that matters. A fractional one puts some game
pixels on 3 device pixels and their neighbours on 4, and the art crawls whenever
anything moves — the one artefact a pixel-art game cannot hide. Taking the
rounding on the *resolution* instead, as a couple of extra or missing rows, is
invisible. Camera FOVs are then corrected to hold the *horizontal* field fixed
(`fitFov`), so the track is exactly as wide on screen as it was tuned to be and
a taller phone spends its extra rows seeing further ahead.

The retro grade — sRGB conversion, then 5-bit-per-channel quantisation with an
8×8 ordered dither — happens in a second GL pass, still at internal resolution.
The conversion has to come first: three.js writes render targets in the
*linear* working space, so quantising the raw values would crowd every band
into the shadows.

**The WebGL canvas is never in the document.** It renders offscreen, and each
finished frame is copied with `drawImage()` into a plain 2D canvas, which is
what the page actually shows. That indirection was bought with a real device
bug: on at least one Pixel-class phone, Chrome composites a document WebGL
canvas into only the bottom ~60% of its own element — with the element rect,
the drawing buffer size and the GL viewport all reporting correct values, and a
2D canvas under identical CSS compositing perfectly. It survived every indirect
fix (buffer matched 1:1 to the box, `desynchronized` removed, `image-rendering`
removed, buffer halved, the overlay canvas hidden). The one presentation path
that provably works everywhere we have looked is the 2D canvas raster path, so
it is the only one used: WebGL does all the rendering and never talks to the
compositor. The copy is 1:1 at ~140k pixels and stays on the GPU.

Debug switches, kept because they earned it: `?debug` overlays the live
geometry the device believes (element rects, buffer sizes, GL viewport), and
`?noui` hides the HUD canvas — the bisect that finally proved the WebGL canvas
was failing alone.

There are no lights in the scene at all. Machine hulls bake a fixed brightness
per face direction into vertex colours, which is both free and much closer to
how sprite-era art actually looked. The underglow is an additive quad with a
dithered radial falloff — a smooth gradient there is the single clearest
giveaway that a "pixel art" game is not really one.

## The environments

Every circuit gets a hand-built world rather than the same box field recoloured:
a night city of lit towers, a sunset beach with palms and a dithered sun, a
conifer forest, an orbital pipe yard, an eroded desert of layered mesas, and a
volcanic basalt plain.

They are real models — `Scenery.js` has a small prop toolkit (tapering boxes,
tubes along arbitrary axes, cones, crossed billboards) that builds a palm's
drooping fronds, a mesa's strata as separate blocks, a lattice mast, a knot of
twisted pipes. Layers are placed from the track itself, so scenery always frames
the road however a circuit was authored, and dropped onto the ground plane
rather than into the track's frame — otherwise a banked corner produces leaning
trees. A few props straddle the road instead: sign gantries in the city, pipe
bridges at the port.

The budget is what shapes it. Each layer is one `InstancedMesh`, so 240 trees
cost one draw call, and per-instance colour supplies the variety that would
otherwise need separate meshes — a single conifer model yields a forest of
different greens. Six environments run at 26–32 draw calls and 32–78k triangles.

Two things had to be learned the hard way. Face brightness is baked into vertex
colours exactly as the machines do it, because there are no lights in this game.
And prop textures are *neutral* — `map * vertexColor` means a green leaf texture
over green vertices comes out black, which is precisely what the first attempt
looked like, so the maps carry only light and shade and every hue comes from the
geometry and the instance tint. The one exception is the city, where the window
texture deliberately *is* the wall colour, and the instance tint paints it.

## The machines

Four hulls, each assembled from one primitive: a box that tapers, shears and
rotates. Between those it describes everything these craft are made of — nose
cones and knife edges (`wFront`/`hFront`), booms that converge on the nose
(`xFront`), canted winglets and swept leading-edge trim (`rx`/`ry`/`rz`).

Two details do most of the work. Canopy glass gets a top face brighter than
white; it clips at the blit, which is the blown-out glint the reference art for
this genre paints in by hand, and it is the only thing that makes the canopy
read as a different *material* rather than a different colour. And every
exhaust is a dark cowl with a small bright nozzle protruding just past its back
face — a flat panel of engine colour reads as a white block from behind, while
a bright core inside a dark ring reads as a jet.

The rest is silhouette discipline: converging booms and a spear nose on the
balanced machine, a flat chisel on the light one, stepped shoulder armour and a
roll bar on the heavy one, and a manta delta with the canopy sunk flush into
the wing on the fast one. At racing distance a machine is about forty pixels
across, so who is who has to be legible from the outline alone.

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
  game/      vehicle physics, machines, AI driver, race director, camera, attract mode
  render/    low-res pipeline, procedural textures, machine models, world, scenery
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

`tools/touchflow.mjs` and `tools/demoflow.mjs` drive a real browser with real
touch events: the first walks the menus by hand, the second leaves the title
screen alone and watches the attract mode take over, browse the roster, start
the championship and get out of the way when the screen is touched. Menu
navigation is the easiest thing in a game to break silently, because it is the
one part that never runs during development — you reload straight into whatever
you are working on.

## Notes

- `prefers-reduced-motion` is respected: screen shake and camera flourishes damp down.
- Audio is built before the first user gesture and only *resumed* inside it, so
  the gesture handler does no real work and there is no hitch on the first tap.
- `localStorage` is optional; the game runs identically without it.
- The attract mode is silent on a page nobody has touched yet — browsers refuse
  to start an `AudioContext` without a user gesture, and there is no way around
  it. The synthesised taps are not gestures and deliberately do not pretend to
  be. Touch the screen once (which hands the game back) and every later attract
  run has full audio.
- Re-bake the logo with `node tools/make-logo.mjs tools/logo-source.png 240`.
- `netlify.toml` builds before publishing. Without it Netlify serves the repo
  root, which means raw unbundled source and a bare `three` import the browser
  cannot resolve — the page loads and the game never starts.
- Press `F3` for a draw-call and frame-rate readout, `M` to mute.

## Licence

MIT. Built as an open-source demo — not for sale.
