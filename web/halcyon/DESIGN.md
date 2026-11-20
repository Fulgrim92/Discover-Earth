# HALCYON — a drone atlas of Earth and beyond

Design, art direction and build contract. This is the brief every coder works from. If code and this file
disagree, fix one of them in the same change.

## 1. What it is

A flight simulator for practising real drone control (screen or VR headset) set in a small endless planet of
**realms**: real wonders of Earth pushed slightly past real, and one that is not Earth at all. There is no score to
chase. The pull is that the next realm is always visible on the horizon in different light, and a ribbon of light
rings leads there.

Two promises:

1. **It is honest practice.** Mode-2 sticks, real rate/angle/GPS behaviour, motor lag, drag, momentum. What your
   thumbs learn here transfers to a real quad. A real RC transmitter plugged in over USB works as a gamepad.
2. **Every ten seconds of flight shows something worth a screenshot.** Light, colour and air first; geometry second.

## 2. Priorities and constraints (from C, fixed)

Priorities when they conflict: **1 visual quality, 2 stable frame pacing at the target spec, 3 small size.**

- No engine, no libraries at runtime. Raw WebGPU + WGSL. No WebGL fallback.
- Everything procedural. No texture, model, font or audio files. Deliverable: one self-contained `index.html`.
  Report its minified size.
- **Zero per-frame JS allocations.** Everything preallocated; see section 9.
- Assumed target spec (C has not confirmed): desktop Chrome, **RX 6650 XT, 1920x1080, 60 Hz**: GPU avg <= 11 ms,
  max <= 16.7 ms. VR: PC headset at 72-90 Hz, held by dynamic resolution.

## 3. VR, plainly

WebXR with WebGPU (`XRGPUBinding`, the "WebXR/WebGPU binding") is **not in any stable browser** as of November 2026.
Chrome has it behind the flag `chrome://flags/#webxr-webgpu-binding` (Windows, OpenXR); Meta Quest Browser has
announced it but not shipped it. So:

- The renderer is written **per view** from day one (`renderView(view)` with its own matrices, viewport, target).
  Desktop is one view. `?stereo=1` draws two side-by-side eyes through the same path so it is tested headlessly.
- `xr.js` implements the real `XRGPUBinding` session against the spec, feature-detected. If `XRGPUBinding` is
  missing, the "Enter VR" button explains the flag instead of failing. We do not fall back to WebGL.
- VR flight modes: **Line of sight** (you stand on the ground and watch the drone, the real beginner skill and
  comfortable) and **FPV** (you are the camera; comfort vignette on by default). Sticks come from the XR controller
  thumbsticks (left = throttle/yaw, right = pitch/roll) or any gamepad/transmitter.
- How it is built (`src/xr.js`, `src/fx/xrfx.js`, `src/wgsl/xr.wgsl`): each XR view renders through `renderView`
  into intermediate targets sized to its sub-image viewport, then the final pass writes into the layer's colour
  texture at that viewport (texture-array and side-by-side layouts both work). The XR projection keeps its x/y/w
  rows and gets reverse-Z depth (`mat4XRToRevZ`); `View.skew` carries the off-axis centre and `View.anc` the head,
  so camera-centred grids (flora, fauna, motes, terrain morph) pick the same instances in both eyes. Clouds march
  at 1/3 resolution in VR; dynres targets 80 % of the session's frame time. Controllers are a procedural mesh and the
  HUD a dot-matrix panel above the left controller. `?xrmock=1|2` fakes the API headlessly (`tools/shots/xr.json`,
  `tools/xrtest.mjs`, `tools/alloc.mjs --xrmock`).

## 4. The planet

World space: metres, **Y up, right-handed, sea level y = 0**. The plane is tiled by jittered cells of ~5.5 km
(Voronoi). Each cell is one realm. The seven cells nearest the origin are curated (Home in the middle, the other
five around it, Lumen Deep furthest north-east plus one repeat); beyond that realms are assigned by hash, so the
planet never ends and never repeats its arrangement.

**Realm parameters are blended, not realm outputs.** Each realm is one row of numbers (`realms.js`, one
`Float32Array`, uploaded as a buffer and read by both WGSL and the JS mirror). At any point we take the Voronoi
weights (blend band ~1.4 km, smooth), blend the rows, and evaluate terrain, sky and look **once** with the blended
row. This makes borders organic, costs one evaluation, and gives the signature effect:

**The sun is part of the realm.** Sun elevation and azimuth are in the row, so flying from the Fjords toward the
Ice turns golden hour into dusk into aurora night as you travel. The planet feels tiny and you are flying around
it. No waiting for a day cycle; you explore to change the light. (A slow global drift of +/- 6 deg keeps it alive.)

### The realms

Colours are sRGB hex, used as starting points; tune by looking.

| # | Realm | Real anchor | Shape | Light | Signature |
|---|-------|-------------|-------|-------|-----------|
| 0 | **Home Fjords** | Faroe, Lofoten | Steep eroded valleys 600-900 m, drowned by sea, soft green shoulders, dark basalt cliffs with ledges | Golden hour, sun 12 deg, warm low cloud snagging on peaks | Thread-thin waterfalls on the cliffs, sea mist, wildflower meadows (yellow, white, violet) |
| 1 | **Painted Range** | Zhangye Danxia, Landmannalaugar, Grand Prismatic | Rounded ridges 300-500 m with strong terracing; basins hold hot pools | High clear afternoon, sun 38 deg, deep blue sky, crisp shadows | Strata bands in rust `#b5432a`, ochre `#e0a43a`, cream `#f1e3c0`, teal `#3fa69a`, plum `#6b3b5e` that follow height + warp; pools ringed orange-yellow-green-cyan with steam |
| 2 | **Mirror Salt** | Salar de Uyuni | Dead flat, 2-6 cm of water over salt; far cone islands | Pastel dawn, sun 6 deg, pink-peach-lavender sky, tall soft cumulus | A perfect mirror of the sky; hexagonal salt ridges just under the water; flamingo flocks |
| 3 | **Stone Forest** | Zhangjiajie, Ha Long | Hundreds of sheer pillars 150-400 m rising out of a cloud sea at ~120 m; flat forested tops | Misty morning, sun 25 deg behind veils, cool jade and gold shafts | The cloud sea: you slalom pillars above it or dive under into a dim green world; canopy-bumped pillar tops |
| 4 | **Aurora Ice** | Jokulsarlon, Vatnajokull | Glacier tongues, black sand, a lagoon with bergs, crevasse fields | Deep blue dusk into night, sun -8 deg, a band of afterglow on the horizon | Aurora curtains (green `#4dffa0` to magenta `#d44cff`), dense stars, ice that glows cyan `#7fe9ff` from inside |
| 5 | **Lumen Deep** | not Earth | Soft dunes and bowls, crystal spires, sinkholes of glowing water | Perpetual violet twilight; a **ringed giant** fills 25 deg of sky, two moons | Bioluminescent ground veins that pulse outward, glowing flora, drifting spores, sky jellies |

Every realm must have: one palette that is instantly its own, one thing that moves, one thing that glows or
reflects, and a reason to fly low **and** a reason to fly high.

## 5. Art direction

- **Light is the subject.** Low suns, long soft terrain shadows, visible air. Every realm has aerial perspective
  (distance tints toward the sky colour at the horizon) and height mist in its hollows. Nothing is ever flat-lit.
- **Colour.** Saturated but never neon on Earth realms: push chroma in the midtones, keep highlights rolling off
  to warm white. Lumen Deep is allowed neon, but only as emission against a dark ground. Shadows are never grey:
  they take the sky colour (blue on Earth day, violet in Lumen). Output in Display-P3 when the display supports it.
- **Scale.** The drone is 30 cm. Mountains are 800 m. Keep grass, pebbles and flowers near the camera and a
  40 km horizon, so both scales are in one frame. Clouds are huge and slow.
- **Bizarre comes from truth.** The strange things are real phenomena exaggerated ~1.3x (mirror flats, prismatic
  pools, karst pillars, auroras), so the brain accepts them. Only Lumen Deep breaks physics, and it does so quietly.
- **No UI on the picture** beyond a thin, toggleable flight HUD. Type is the system UI font, small caps, 70% white.
- **Avoid:** plastic specular, uniform noise "moss", visible tiling or grid, flat ambient, pure black, pure white
  clipped skies, fog as a grey wall, low-poly-looking silhouettes, billboards that reveal themselves.

Tone mapping: scene-referred linear HDR -> exposure per realm (blended) -> a filmic curve that keeps saturation
(AgX-like base with a punchy look, or Khronos PBR Neutral with a soft shoulder; compare both by render) -> gentle
per-realm grade (lift/gamma/gain tint) -> blue-noise dither. Bloom is wide and subtle (threshold-free, energy
conserving, ~4% mix) except emissives, which are allowed to sing.

## 6. Rendering architecture

All HDR in `rgba16float`. Reverse-Z depth. One frame, per view:

1. **Clipmap bake** (only when a level's snapped centre moves; at most one level per frame). 8 levels of 512x512
   `rgba16float`: `height, dH/dx, dH/dz, aux` plus a second `rgba8unorm` target for material masks (strata phase,
   wetness/flow, canopy, glow). Level `i` texel = `0.5 * 2^i` m (L0 = 256 m across, L7 = 32 km). Fragment shader
   evaluates the shared terrain function. No CPU work.
2. **Opaque pass**, 4x MSAA, targets: HDR colour + `r16float` linear view depth (resolved, read by later passes).
   - Terrain: one grid mesh instanced per level, geomorphed between levels (CDLOD style), skirts. Vertex samples the
     clip textures. Fragment: material from masks + slope + height, procedural micro-normal, **sun shadow by
     marching the height clipmaps** (soft, 16-24 steps, long shadows for free), sky-coloured ambient with a cheap
     horizon occlusion term, cloud shadow from the cloud coverage function.
   - Flora and scatter: instances placed **in the vertex shader** from the instance index (hashed grid around the
     camera, height from the clipmap). Grass and flowers, reeds, crystals, glow-bulbs. Alpha-to-coverage.
   - Fauna: flocks whose motion is a closed-form function of time and index (no CPU sim). Light rings, drone body.
3. **Clouds**, half resolution: ray-marched Perlin-Worley (3D noise baked once at start) with realm-blended cover,
   base, top and tint; the Stone Forest cloud sea is the same system with a low flat layer. Blue-noise jitter,
   depth-aware upsample.
4. **Composite** (full screen): sky (analytic scattering fitted per realm, sun, stars, moons, ringed giant, aurora),
   **water** (ray-plane against sea level per pixel, compared with scene depth: wave normals, Fresnel, reflections by
   marching the height clipmaps + sky, refraction of the resolved scene, depth absorption, shore foam, the Mirror
   Salt sheet), aerial perspective, height mist, clouds over the top, sun shafts.
5. **Post**: bloom chain, tone map, grade, vignette, dither. Writes to the canvas (or the XR sub-image viewport).

Dynamic resolution holds the frame budget (scale 0.6-1.0 of the internal targets), driven by `timestamp-query`
where available.

### The shared terrain function

One recipe, driven by the blended realm row: domain-warped, derivative-eroded fbm + ridged term + terrace term +
pillar term (thresholded cellular, steep sides, flat tops) + flatten term (salt) + sea bias. **All noise uses
integer hashes** (`u32` in WGSL, `Math.imul`/`>>>0` in JS) so that `world.js: heightAt(x, z)` on the CPU and the
WGSL bake agree to within centimetres. The harness has a test that reads back a baked level and compares it with
`heightAt` at 256 points (max error < 0.15 m). Physics collides with `heightAt`; rendering uses the bake.

## 7. Flight model

Fixed 240 Hz substeps, rigid body, quaternion attitude. Thrust along body-up with first-order motor lag (~60 ms),
quadratic drag (higher from the side and from above), gravity, ground effect within 0.5 m, gentle realm-set wind
with gusts. Mass and thrust model a 5-inch-class quad for Acro and a 250 g camera drone for the other modes.

| Mode | What it is | Sticks |
|------|-----------|--------|
| **GPS** (default) | Camera drone. Position/altitude hold, braking to hover when sticks centre, tilt <= 25/35 deg (Normal/Sport), level gimbal with tilt control | Left: climb, yaw. Right: forward/strafe |
| **Angle** | Self-levelling, manual throttle | Left: throttle, yaw. Right: tilt angle |
| **Acro** | Rate mode, no self-levelling, Betaflight "actual" rates (centre 70, max 670 deg/s, expo 0.3 default), 25 deg camera uptilt | Left: throttle, yaw rate. Right: pitch/roll rate |

Mode 2 by default; modes 1, 3, 4 selectable. Deadband, expo. Inputs: Gamepad API (pads and USB transmitters, axis
mapping screen), XR controllers, keyboard (WASD + arrows) as a fallback. Cameras: FPV, chase, line-of-sight (pilot
on the ground, auto-zoom so the drone stays readable). Crash: tumble, 1.5 s, respawn at the last safe hover. A
**boost/transit** hold (GPS mode only) raises max speed to 120 m/s for crossing realms; number keys jump to realms.

Practice layer: **light rings**. A ribbon of rings leads from each realm centre through its best lines (valley
runs, pillar slaloms, low passes over the mirror) and on to the next realm. Rings chime and light the next one.
The HUD can show sticks, speed, height above ground, mode, and a small compass to the nearest unvisited realm.

## 8. Sound (procedural WebAudio, built once)

Motor tone from thrust (two detuned saws through a low-pass), wind noise from airspeed, and per realm a slow
generative pad in its own mode (Fjords: D dorian; Mirror: A lydian; Ice: sparse fifths; Lumen: whole-tone). Ring
chimes are notes of the current mode. Starts on the first user gesture; `M` mutes.

## 9. Zero-allocation rules

- After init, the frame loop creates **no** objects, arrays, closures, strings or bound functions. One `frame`
  function defined once. All matrices/vectors are slots in module-level `Float32Array`s; math writes into an
  `out` argument. Bind groups, views, pass descriptors and their attachment objects are built once and mutated.
- Uniforms: one preallocated `ArrayBuffer` per buffer, `queue.writeBuffer` with it. No `mapAsync` per frame.
- HUD text is updated at most 4x per second and only when the value changed (DOM text is outside the frame path;
  better still, draw it on the GPU).
- Known platform exceptions we cannot remove and will list in the report: `navigator.getGamepads()` snapshots,
  `getCurrentTexture().createView()` (one view per frame, required by WebGPU), and the WebXR frame objects.
- Proof: the harness runs 1,800 frames with `--trace-gc` after a forced GC and fails on any scavenge, and prints a
  sampling heap profile of the loop.

## 10. Code layout and the look loop

```
web/halcyon/
  DESIGN.md
  src/main.js            boot, frame loop, pass order, resize, dynamic resolution
  src/gpu.js             device, targets, pipelines helpers, uniform block layout (the Frame/View structs)
  src/math.js            alloc-free vec/mat/quat on Float32Array slots
  src/realms.js          the realm table + Voronoi weights (JS)
  src/world.js           heightAt() and realm blend, CPU mirror of terrain.wgsl
  src/sim/*.js           drone physics, input, cameras, rings, audio  (no GPU imports)
  src/fx/*.js            one module per pass or feature; each exports init(ctx) and draw hooks
  src/wgsl/*.wgsl        shaders; common.wgsl (hash, noise, Frame/View structs, realm row) is prepended to all
  tools/build.mjs        esbuild bundle + WGSL minify -> dist/index.html (single file), prints byte size
  tools/shot.mjs         headless Chromium (SwiftShader WebGPU) -> PNGs from a step list
  tools/shots/*.json     step lists: per-realm hero views, stereo, fly-throughs
  tools/alloc.mjs        the zero-allocation gate (scripted frame loop, --trace-gc + sampling heap profile)
  tools/bench.mjs        headless smoke test of ?bench=1 (report shape, GPU timer readback)
  tools/dyntest.mjs      dynamic-resolution controller against synthetic GPU-time feeds (node, no browser)
  tools/readytest.mjs    __halcyon.ready outside shot mode, start overlay progress while pipelines compile
  tools/play.mjs         scripted flights (?script=) -> frames + contact sheet; --dry runs the sim in node
```

URL parameters (all optional) make captures deterministic: `realm`, `pos=x,y,z`, `yaw`, `pitch`, `fov`, `t`
(freeze time), `w`, `h`, `scale`, `stereo`, `hud=0`, `bench=1`, `quality=low|high`; the full list (script, sim,
orbit, present, alloc, dynres, target, hdr, stride, inflight, ...) is at the top of `src/main.js`. The page sets
`window.__halcyon = {ready, frame, error}` and the harness waits for `ready` (all clip levels baked) before
grabbing; outside shot mode `ready` turns true once the pipelines have compiled and the first frame has finished.

Benching on the reference machine: `?bench=1` renders a fixed 1920x1080 canvas with dynamic resolution on (`dynres=0`
for a fixed internal 1920x1080). `off=<names>` switches costs off one by one (flora, fauna, particles, tshadow,
tdetail, tao, fshadow, clouds, cloudshadow, water, rings, drone, msaa, or `all`): bits in `Frame.flags`, named
`OFF_*` in common.wgsl. `split=1` splits the opaque pass into terrain / flora / fauna and times each (`gpuPassMs`
opaque = terrain + sky + drone); it adds an MSAA store and load per split, so compare totals with `split=0`. Shader compile errors and uncaptured GPU errors must surface in `__halcyon.error` and fail the shot.

Headless Chromium flags that work here: `--enable-unsafe-webgpu --enable-features=Vulkan --use-angle=swiftshader
--use-webgpu-adapter=swiftshader --ignore-gpu-blocklist`. SwiftShader is a CPU rasteriser: expect seconds per frame;
capture at 960x540. It proves the picture, not the frame time. Frame time is measured on C's PC with `?bench=1`.

**Nobody is done until they have looked at their own renders** (the Read tool shows PNGs) and fixed what is ugly.

## 11. Addendum from C, 2026-11-20: fluid transitions and photorealism

C's words: "make it so the transition from one area to the next is fluid and together so the dreamlike design
remains. Ideally we make it photorealistic graphics as initially designed."

### 11.1 The Drift (realm transitions)

A border is never a line, an outcrop pattern or a cross-fade of two pictures. It is a place: a 2-3 km wide zone
where one world **melts** into the next, the way scenes change in a dream. Rules:

- Nothing may reveal the cell geometry. Borders are warped by large-scale domain warp; the blend is smooth
  (smootherstep over ~2.4 km), never thresholded.
- **Landform morphs continuously** (the blended row drives one terrain function; keep it that way). Features of
  one realm grow out of features of the other: fjord ridges stretch into Painted strata; Painted terraces flatten
  and flood into the Mirror; pillars rise out of fjord cliffs; glacier ice creeps over meadow; Lumen veins thread
  into Earth soil before the ground darkens.
- **Skin flows.** Inside the zone, material weights are displaced by a slow, time-animated flow field (period
  20-40 s, advected like ink in water), so the surface of one world visibly drifts into the other in tongues and
  eddies. Height does not animate (physics and bake stay static); only materials, emission, wetness and flora do.
- **Light and air morph together**: sun direction, sky, fog, cloud type, water colour, exposure and grade all blend
  with the same weight, plus a faint **veil** in the middle of the zone: thin luminous mist that carries both
  realms' colours, with slightly raised bloom, so crossing feels like passing through a held breath.
- **Life overlaps**: both realms' flora coexist and thin out through each other (glow-bulbs among meadow grass,
  ice crystals on flowers); creatures may cross.
- Sound cross-fades modes through shared notes.
- Test views: one per curated border, at 5 m and at 150 m, at the midpoint and at both quarter points.

### 11.2 Photoreal

The target is a photograph taken from a drone, not concept art. Earth realms must hold up next to real photos of
their anchors (the repo has Saksun reference photos in `content/references/saksun/`: use them for Home Fjords).
Lumen Deep stays unearthly in content but is rendered with the same physical camera and materials.

- Physically based light: real sun/sky ratio, Rayleigh/Mie atmosphere with ozone, energy-conserving GGX specular,
  measured-range albedos (grass 0.08-0.2, basalt 0.05-0.1, sand 0.3-0.4, snow 0.8-0.9, water F0 0.02), no
  hand-painted rim lights or tinted shadows beyond what sky light gives.
- Photographic camera: exposure in EV, a neutral filmic curve, natural saturation (colour comes from the place and
  the light, not from the grade), subtle lens effects only.
- Natural geometry and texture statistics: erosion-shaped landforms (drainage networks, talus, alluvial fans),
  multi-scale detail down to centimetres near the camera, no cartoon bands, no flat-colour fills, no smooth
  blob shapes; vegetation with real density and colour variance.
- Stylisation that must go: neon outlines, toy-like mushrooms and crystals, barcode or poster-like sky features,
  uniformly saturated fills.
- Where photorealism and frame budget conflict, look wins (priority 1), but dynamic resolution must keep pacing.

## 12. Addendum from C, 2026-11-20: encounters

C's words: "any encounter includes otherworldly feelings for the operator of the drone, meaning we have animals,
wildlife, as well as natural occurrences such as waves splashing, night sky shifting, rain and weather, sunsets."

The world must **do things to you**. Scenery alone is a postcard; an encounter is a moment that happens once, near
you, because you were there. Target rhythm: something worth turning the camera for every 40-90 s of flight, and one
rare, overwhelming event every 5-8 minutes. Never a notification, never UI: the pilot notices it themselves (a
glint, a sound, a shadow passing over the ground), per the cue grammar of Discover Earth (glint, call, ripple,
gust, hum).

### 12.1 The living baseline (always on, photoreal, everywhere it belongs)

- **Sea and shore**: swell that travels, waves that steepen and break on beaches, surf line foam that washes up and
  drains back leaving wet sand, spray bursting on cliffs and skerries with mist drifting downwind, tide pools.
- **Weather**: every realm has weather that moves across it: rain squalls with visible rain shafts under their
  clouds, wet darkened ground and puddles that dry, fog banks that roll through valleys, wind you can see in grass,
  water and cloud; snow showers over the Ice; dust devils in the Painted Range; spore storms in Lumen. Flying into
  rain puts drops on the lens (subtle) and changes the sound.
- **The sky turns**: the star field rotates around a pole, moons rise and set, the ringed giant shows phases and its
  ring shadow moves; every realm's sun drifts along a slow arc so sunsets and blue hours actually happen (a few
  minutes each), with afterglow, Belt of Venus, crepuscular rays, green flash at a sea horizon.
- **Wildlife as populations**, placed by habitat, behaving: sheep on Faroese slopes, puffins and gannets diving at
  cliffs, seals on skerries; ibex or wild horses in the Painted Range; flamingos feeding and taking off in waves;
  hornbills and monkeys in the Stone Forest canopy, swifts around pillars; arctic foxes, seals and whales at the
  Ice; Lumen's own ecology (sky jellies, grazing light-eaters, a slow giant on the horizon). They **react to the
  drone**: flocks lift and wheel away, a curious bird flies alongside for a while, whales ignore you.

### 12.2 Encounters (directed, rare, seeded)

A director (`src/encounters.js`, deterministic from seed + position + time, allocation-free) keeps up to 8 active
encounter slots `[type, x, y, z, t0, duration, seed, intensity]` in a uniform buffer that every shader can read,
and chooses events by realm, time since the last event, and where the pilot is looking and heading (events start
ahead of the flight path, in view, at a readable distance). Examples, each must be built to photoreal standard and
feel uncanny in a quiet way:

| Realm | Common | Rare |
|-------|--------|------|
| Home Fjords | Gannets plunge-diving beside you; a rainbow in a passing squall; a wave set bursting on a headland | A pod of orcas travelling up the fjord under the drone; a murmuration folding around you at dusk |
| Painted Range | Dust devil crossing a basin; a hot pool erupting as a geyser; wild horses running a ridge | A dry thunderstorm: lightning walking along the horizon, virga lit pink |
| Mirror Salt | Flamingos taking off in a wave that doubles in the mirror; a far rain shaft with its reflection | Night falls for a minute and the Milky Way is above and below you |
| Stone Forest | Cloud sea rising and pouring between pillars like a waterfall; swifts streaming past | Brocken spectre: the drone's shadow in a rainbow halo on the cloud below |
| Aurora Ice | A glacier calving with a wave rolling across the lagoon; a meteor; aurora surge to a corona | A humpback breaching in moonlight; a total lunar eclipse turning the ice red |
| Lumen Deep | A pulse of light travelling through every plant; sky jellies gathering | The ringed giant eclipses the sun: diamond ring, then the whole land lights itself; a migration of giants |
| The Drift | Creatures of one realm crossing into the other | Both skies visible at once through the veil |

Each encounter has: a cue (sound + visual), a build-up, a peak, and an afterimage that lingers (wet rock, ripples,
feathers on the wind, a changed sky). Sound is half of it: procedural calls, surf, rain, thunder, ice cracking.

Test: `?enc=<type>&et=<seconds into it>` forces an encounter for captures; `tools/shots/encounters.json` holds one
view per encounter at build-up and peak.

## 13. Addendum from C, 2026-11-20: the atlas grows

C's words: "Think of the most beautiful natural resorts and areas of the world which enables the player to explore."

The planet becomes an atlas of twelve realms: the six above plus six more, chosen so that each adds a kind of
flying and a kind of light the others do not have. Curated layout: Home in the centre, two hexagonal rings (19
cells) so every realm appears near the start; beyond that, hash-assigned as before. Every realm obeys sections 5,
11 and 12 (photoreal, melts into its neighbours, has weather, wildlife and encounters).

| # | Realm | Real anchors | Shape and flying | Light | Life and encounters |
|---|-------|--------------|------------------|-------|---------------------|
| 6 | **Coral Atoll** | Bora Bora, Maldives, Raja Ampat, Whitehaven | Ring reefs and sand motus around a jungle-clad volcanic core; lagoon 1-30 m deep with reef patterns visible through water; skim centimetres above glass-clear water | Tropical noon, towering trade-wind cumulus, squalls with rainbows | Manta rays and reef sharks as shadows under the surface, turtles, frigatebirds, dolphins riding your bow; bioluminescent surf at night |
| 7 | **Slot Canyons** | Antelope Canyon, The Wave, Zion Narrows, Grand Canyon | Mesas cut by deep, sinuous slots 3-15 m wide and 60 m deep, widening into amphitheatres: the precision course | High sun pouring down as light shafts in dust; glowing orange bounce light on the walls | Ravens, bighorn sheep on ledges, a flash flood roaring through a side canyon, a condor at eye level |
| 8 | **Alpine Crown** | Dolomites, Torres del Paine, Moraine Lake, Lauterbrunnen | Granite towers and hanging glaciers above milky-turquoise lakes; larch and pine forest; waterfalls free-falling 300 m into a U-valley | Alpenglow at sunrise, clearing storm, cloud banners off summits | Eagles soaring the walls, ibex, marmot calls, an avalanche on the far wall, a glory around the drone's shadow |
| 9 | **Falling Waters** | Plitvice, Jiuzhaigou, Iguazu, Havasu, Pamukkale | Stepped travertine terraces holding jewel-blue pools, joined by hundreds of cascades, ending in one immense horseshoe fall with a permanent mist plume | Soft overcast breaking to sun; rainbows in the spray, wet-leaf greens | Swifts flying through the falls, butterflies in clouds, fish visible in the pools, a moonbow at night |
| 10 | **Fire Fields** | Fagradalsfjall, Kilauea, Erta Ale, Na Pali | Fresh black lava plains, spatter cones, a lava river and lava falls to the sea with steam explosions; old flows under green moss | Blue hour: the lava is the light source; orange underlit steam and clouds | Lava fountaining, a new skylight opening, volcanic lightning in the plume, seabirds along the steaming coast |
| 11 | **Red Dunes** | Sossusvlei and Deadvlei, Rub' al Khali, White Sands | Star dunes 300 m high with knife crests, white clay pans with dead camel-thorn trees, a dry river; ridge-surfing lines | First light: one face orange, the other in blue shadow; fog rolling in from a cold coast | Oryx walking a crest, ostriches, sand streaming off ridges in wind, a sand storm front, a night of zodiacal light |

Rule for adding a realm: it is a row of parameters plus at most two new terrain terms, two materials, one flora
set, one fauna set and three encounters; nothing in the frame loop may scale with the number of realms.
