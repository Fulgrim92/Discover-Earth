# Architecture

```
              de_cli (tool)          the `de` command line: capabilities, schemas, validate, sweep, compare, taste
                  |
              de_client (game)       Bevy 3D: terrain mesh, sea, sky, sun, fog, fly camera, captures
                  |
              de_world (gameplay)    islands as data: terrain manifests, heightfields, views, looks, step lists,
                                     drone, seeded Rng, sensors, the capability list
```

Everything builds from this repository alone. `de_world::Rng` (SplitMix64) is the one source of randomness, and
`crates/de_world/src/module.rs` is the capability list `de capabilities` prints.

## World space

+X east, +Y up, +Z south, in metres. An island's heightfield is centred on the origin; sea level is y = 0 and the sea
surface sits at 0.6 m. Ground the DEM marks as sea is pushed down to -25 m so the coast drops away under the water.

## Content

- `content/islands/<id>/terrain.json`: the island (`de schema terrain`). `scripts/terrain/import.py` writes the
  generated half from a Copernicus GLO-30 tile; `views` (named cameras, the first is the spawn) and `look` (sun,
  fog, ground and sea colours) are written by hand and survive re-imports.
- `content/islands/<id>/height.png`: 16-bit greyscale, row 0 north, mapped linearly onto `height_range_m`.
- `content/shots/*.json`: step lists for captures (`de schema steps`).
- `content/drone.json`: the drone's flight modes, clearance, gimbal, dead zone and wind (`de schema drone`).

## The drone

The player is a camera drone flown like a consumer drone in its stabilised mode. `de_world::DroneState::step` turns
mode-2 sticks into motion: velocity eases towards the stick target (with an expo curve for gentle small moves),
centred sticks brake to a hover, wind gusts from `de_world::Rng` push it slightly, and it never goes below
`min_clearance_m` over ground or sea. The camera hangs on a gimbal that keeps the horizon level, with a slight bank
into sideways moves. The window game, the `drone` capture step and the tests all fly this one function, so a
captured flight is the flight a player gets. Real VR controllers would feed the same `Sticks`.

## Rendering

One terrain mesh per island, `look.subdivide` vertices per DEM pixel (Catmull-Rom between pixels plus `relief_m`
of seeded small relief). Vertex colours carry ground layer weights (grass, rock, shore, moss) from height and slope;
`terrain.wesl` extends Bevy's PBR to blend the layers, from scanned CC0 textures in `content/materials/` when they
exist (triplanar, at two scales) and from seeded noise otherwise, with basalt banding on rock, patches of browner
grass, and fine detail normals that fade with distance. Then a large
sea plane, an unlit sky dome, a sun with cascaded shadows, exponential distance fog and Bevy's PBR. The same
`ScenePlugin` runs in the window and offscreen. The sky dome and sea never cast shadows (the dome encloses the sun's
shadow camera).

## Decisions

| Area | Options weighed | Chosen | Why |
| --- | --- | --- | --- |
| Engine | UE5 + Cesium, Forge all the way, Forge + Bevy 3D | Forge + Bevy 3D | Agent-drivable end to end without writing terrain, lighting and PBR from scratch (C, 2026-11-07) |
| Forge dependency | keep the pinned fetch from cardcraft-eternal, copy it in, own small replacements | Own replacements | The game only used Forge's Rng and capability list; now it builds anywhere, with no token or second repository (C, 2026-11-13) |
| Elevation | Google 3D Tiles, SRTM, Copernicus GLO-30 | Copernicus GLO-30 | Free with attribution, 30 m, good coastlines |
| Player movement | free fly camera, FPV acro drone, stabilised camera drone | Stabilised camera drone (mode 2) | Calm, cinematic pacing for nature, and it matches real drone and VR thumbstick controls (C, 2026-11-08) |
| Agent access to a live game | Custom socket, Bevy Remote Protocol | Bevy Remote Protocol | Built in; queries and edits any reflected component as JSON |
