# Seeing what you changed

An agent cannot watch the game, so everything it needs to judge a change comes out as files or JSON.

## Captures (`de-shot`)

```
cargo run -q -p de_client --bin de-shot -- content/shots/smoke.json out/shots
```

Plays a step list against the real client drawn offscreen (software Vulkan without a GPU; on Linux install
`mesa-vulkan-drivers`). Every frame is exactly 1/60 s of game time and pipelines compile before the first frame, so
the same list gives the same pixels on every run on one machine. Steps (`de schema steps`):

| Step | Does |
| --- | --- |
| `{"view": "valley"}` | jump to a named view of the island |
| `{"camera": {"pos": [x,y,z], "look_at": [x,y,z]}}` | place the camera anywhere; optional `fov_y_deg` (lens) and `roll_deg` |
| `{"wait": 30}` | let frames pass |
| `{"shot": "name"}` | save `out/name.png` |
| `{"fly": {"name": "clip", "to": "lagoon", "frames": 90}}` | fly to a view, saving every frame and `out/clip.mp4` |
| `{"drone": {"frames": 240, "mode": "cine", "sticks": {"pitch": 1, "yaw": -0.25}, "clip": "name"}}` | fly the drone with sticks held, like a pilot; `clip` saves frames and an mp4 |
| `"state"` | print camera, drone (mode, speed, heading, gimbal), ground height and altitude as one JSON line |

`content/shots/drone.json` flies the valley in cine and sport mode. To judge how flying feels, read the `state`
lines (speed, braking, altitude) and watch the clips. The flight model is `de_world::drone`, tested without a GPU.

On a software renderer a 1280x720 shot takes well under a second and a 90-frame clip about 40 s.

## Reading a capture (sensor packs)

You see one still image at a time and judge "is the fog 10% too strong" badly, so every `de-shot` run also writes
what each shot shows as files. **Read `out/<dir>/sense.md` first**: one paragraph per shot and per clip.

Per shot `<name>`:

| File | What |
| --- | --- |
| `<name>.sense.json` | coverage per class (sky, sea, grass, rock, shore, moss, land, `land_in_shadow`), 3x3 composition grid, land and sea distances, skyline height, camera heading, pitch and altitude, sun side and angle, fog left at 1 km and at the median land distance, and from the PNG: brightness histogram, clipping, mean colour and brightness per class, land brightness in sun vs shadow. `text` says it in sentences. |
| `<name>.labels.png` | class per pixel (sky light blue, sea dark blue, grass green, rock brown, shore sand, moss dark green; land in the sun's shadow at half brightness) |
| `<name>.depth.png` | distance, nearer is brighter (log scale 10 m to 50 km) |
| `<name>.normal.png` | surface direction as colour |

They come from casting a ray per pixel against the heightfield and the sea with the shot's exact camera
(`de_world::sense`), on the CPU, so they need no GPU and match the island data. They see the heightfield, not the
mesh's sub-pixel relief, so silhouettes can be a pixel or two off. `shots.json` records every saved image's camera.

Per clip `<clip>`:

| File | What |
| --- | --- |
| `<clip>.sheet.png` | 12 keyframes, labelled with frame, time and altitude: look at this instead of the mp4 |
| `<clip>.motion.json` | flicker score (share of pixels whose brightness goes up then down by over 10/255 across three frames; under 0.5% reads as stable), worst frame, sudden jumps (cuts, pops), camera speed and altitude, per-frame stats |
| `<clip>.flicker.png` | where it flickers: red to yellow over a faint copy of the middle frame |

`de sense <dir> [--island id]` rebuilds them for a folder without rendering again.

## Tiers

`de-shot <steps> <out> --tier sketch|check|hero` overrides the step list's size: `sketch` is 320x180 without
shadows (layout, "is it there", about 10 s a run), `check` 1280x720, `hero` 1920x1080 for PR images and look decisions.

## The film look (`look.cinema`)

`de schema terrain` lists it: `atmosphere`, `sun_lux` (above the atmosphere), `exposure_ev100`, `tonemapper`,
`bloom`, `mist`/`mist_top_m`, `temperature`, `saturation`, `contrast`. Sweep it like any look value, e.g.
`de sweep valley --set look.sun_azimuth_deg=230,280,320 --set look.sun_elevation_deg=5,12,30`.
`content/shots/cinematic.json` renders the hero views and a cine-mode clip down the valley (`golden-valley`).
Notes from tuning: Bevy's `contrast` is strong (1.15 already crushes shadows); mist density is per metre, so 0.001 is
already a visible haze; the atmosphere is a clear sky, so it moves renders away from the overcast reference photos
(`de photo match` says how far).

## Deciding by comparing: sweeps and taste

```
de sweep valley --set look.fog_half_m=2500,8000,30000 --set look.sun_elevation_deg=8,24,45 [--tier sketch]
```

renders the view once per combination (each with the changed `terrain.json` in an overlay folder, `DE_OVERLAY`, so
`content/` is untouched) and writes `out/sweep/sheet.png` (first `--set` across, second down) and `out/sweep/sweep.md`
with each cell's brightness, shadow contrast and fog. A typo in the path is an error listing the keys that exist.
Show the sheet to C, or pick yourself, then copy the chosen values into `terrain.json`.

Record every look decision, C's or yours, so later sessions don't undo it:

```
de taste --sheet out/sweep/sheet.png --pick "#5 fog_half_m=8000 sun_elevation_deg=24" --reject "#1" --why "..." [--by C]
```

appends a line to `docs/taste.jsonl`. **Read `docs/taste.jsonl` before changing the look.**

## Did it change? (FLIP)

```
de compare <reference-dir> <test-dir> [--out out/compare] [--report]
```

scores every shot in both folders with NVIDIA FLIP (how different they look to a person, 0..1), and writes
`<name>.flip.png` heatmaps, `<name>.compare.png` (before | after | heatmap) and `compare.json`. A mean under 0.005 is
`same`. It exits 1 when anything changed unless `--report`. `scripts/check.sh --shots --ref <dir>` runs it.

## Ground truth (satellite)

The islands are real places, so their ground can be checked against the real thing.

```
pip install rasterio pyproj
python3 scripts/truth/fetch.py saksun        # once per island: satellite.png, landcover.png, truth.json
de truth saksun [--apply]                    # island-wide report and maps in out/truth/saksun/
```

`satellite.png` is the per-pixel median surface reflectance (the ground's albedo) of the clearest Sentinel-2
summer scenes, and `landcover.png` is ESA WorldCover. Both sit on a grid twice as fine as the heightmap.
`de truth` fits the four ground layer albedos (`look.grass|rock|shore|moss`) so that, blended where we draw them,
they best reproduce the satellite, and reports the mean colour gap (CIE ΔE: about 2 is barely visible, over 10
clearly different) before and after, plus where our layers disagree with WorldCover. `--apply` writes the fitted
albedos into `terrain.json`. `out/truth/<island>/map.png` shows satellite | ours now | ours fitted | land cover from
above.

When an island has these files, every shot's sensor pack also gets `truth` in `<shot>.sense.json` (land cover in
view, agreement, per-layer colour gap), a sentence in `sense.md`, `<shot>.satellite.png` (the same view painted with
satellite colour, brightness matched to the render) and `<shot>.truth.png` (render | satellite colour | land cover).
Caveats: the satellite sees the ground lit by a late-morning sun, so steep shaded slopes read darker than their
albedo, and WorldCover often calls shaded cliffs "tree".

## Ground truth (real photos)

The satellite says what colour the ground is; photos say what the place looks like from the ground: sky, haze, light,
water. `content/references/<island>/references.json` (`de schema references`) lists CC-licensed Wikimedia Commons
photos, each with a rough `guess` of where it was taken (heading, how far off the geotag may be).

```
python3 scripts/truth/photos.py saksun     # download photos and record author, licence, geotag, focal length
de photo solve [ids]                        # camera of each photo from its skyline -> references.json `camera`
de photo match [--set look.x=v] [--ref <dir>] [--out <dir>]   # render each camera, measure against the photo
```

`solve` finds the sky in the photo (colour clusters from the top rows plus "sky is brighter than what is under it",
by dynamic programming per column), then searches positions around the geotag and heading, pitch, roll and field of
view so the heightfield's skyline (with Earth curvature) lies on the photo's. Check `out/photo/solve/<id>.solve.png`:
red is the photo's skyline, green the solved camera's. A median error under about 0.2° and most columns within 0.5°
means the camera is right. If the sky detection follows a cloud or a house, add `ignore_columns`; if the solve hits
a limit (roll near ±8°, fov at 10° or 100°), widen `guess.within_m` or `heading_within_deg`, or give `fov_y_deg`.

`match` renders every solved camera (the `camera` step takes `fov_y_deg` and `roll_deg`), splits the view into sky,
sea, land near (<1.5 km) and land far by the sensor's ray cast, and compares each region's mean colour (ΔE), its
lightness distribution (L* earth mover's distance) and the images' six-colour palettes. The **gap** is the mean of
those three; lower is closer to the real place. It writes `<id>.match.png` (photo | before | render, region swatches,
L* 10/50/90th percentiles, palettes), `sheet.png`, `match.json` and `match.md`. `--set` renders through an overlay like
`de sweep`, so a look change can be scored against the photos before it touches `terrain.json`; `--ref` adds an
earlier run as "before" and counts on how many photos the gap went down.

Caveats: each photo has its own weather and hour, and the render has one look, so a gap never reaches zero; judge the
mean and how many photos move. Houses, people and fences are in the photos and not in the island.

## The live game (Bevy Remote Protocol)

`discover-earth` listens on `http://127.0.0.1:15702` (JSON-RPC). Find the camera and read where it is:

```
curl -s -X POST http://127.0.0.1:15702 -d '{"jsonrpc":"2.0","id":1,"method":"world.query","params":{
  "data":{"option":["bevy_transform::components::transform::Transform"]},
  "filter":{"with":["de_client::scene::CameraRig"]}}}'
```

`world.list_components`, `world.get_components`, `world.insert_components` and `world.mutate_components` work the same
way on any reflected component (`rpc.discover` lists every method). Entities carry a `Name` (`terrain`, `sea`, `sky`,
`sun`, `camera`).
