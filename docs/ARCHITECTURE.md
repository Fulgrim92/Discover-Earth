# Architecture

```
              de_cli (tool)          the `de` command line: capabilities, schemas, validate, islands
                  |
              de_client (game)       Bevy 3D: terrain mesh, sea, sky, sun, fog, fly camera, captures
                  |
              de_world (gameplay)    islands as data: terrain manifests, heightfields, views, looks, step lists
                  |
              forge_core (core)      Forge: Rng, module manifests, capability registry, layer rules
```

`forge_core` comes from Forge in `Fulgrim92/cardcraft-eternal`, pinned by `FORGE_REV` and fetched by
`scripts/forge.sh` (see `docs/forge.md`). `de_world` registers its features as a Forge module, so `de capabilities`
lists engine and game together.

## World space

+X east, +Y up, +Z south, in metres. An island's heightfield is centred on the origin; sea level is y = 0 and the sea
surface sits at 0.6 m. Ground the DEM marks as sea is pushed down to -25 m so the coast drops away under the water.

## Content

- `content/islands/<id>/terrain.json`: the island (`de schema terrain`). `scripts/terrain/import.py` writes the
  generated half from a Copernicus GLO-30 tile; `views` (named cameras, the first is the spawn) and `look` (sun,
  fog, ground and sea colours) are written by hand and survive re-imports.
- `content/islands/<id>/height.png`: 16-bit greyscale, row 0 north, mapped linearly onto `height_range_m`.
- `content/shots/*.json`: step lists for captures (`de schema steps`).

## Rendering

One terrain mesh per island (a vertex per DEM pixel, colours from height and slope with seeded variation), a large
sea plane, an unlit sky dome, a sun with cascaded shadows, exponential distance fog and Bevy's PBR. The same
`ScenePlugin` runs in the window and offscreen. The sky dome and sea never cast shadows (the dome encloses the sun's
shadow camera).

## Decisions

| Area | Options weighed | Chosen | Why |
| --- | --- | --- | --- |
| Engine | UE5 + Cesium, Forge all the way, Forge + Bevy 3D | Forge + Bevy 3D | Agent-drivable end to end without writing terrain, lighting and PBR from scratch (C, 2026-11-07) |
| Getting Forge | Cargo git dependency, copy, sparse pinned fetch | Sparse pinned fetch | cardcraft-eternal is ~9 GB at one commit; the sparse fetch is a few MB and still pins an exact commit |
| Elevation | Google 3D Tiles, SRTM, Copernicus GLO-30 | Copernicus GLO-30 | Free with attribution, 30 m, good coastlines |
| Agent access to a live game | Custom socket, Bevy Remote Protocol | Bevy Remote Protocol | Built in; queries and edits any reflected component as JSON |
