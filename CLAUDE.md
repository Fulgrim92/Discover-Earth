# Working in this repo

Discover Earth is a Rust game with **Bevy 0.20** drawing in 3D; it builds from this repository alone. Read
`docs/ARCHITECTURE.md` first, then `docs/agents.md` for how to see what you changed.

## The loop

- Before adding a feature, check what exists: `cargo run -q -p de_cli -- capabilities`.
- After any change: `scripts/check.sh`. On failure read `out/check/summary.json` and the step's log in `out/check/`.
- Visual changes: `scripts/check.sh --shots` writes `out/shots/*.png` and a sensor pack per shot. Read
  `out/shots/sense.md` first, then look at the images. Keep a copy of the shots from `main` and pass `--ref <that dir>`:
  `de compare` scores each shot with FLIP and writes before|after|heatmap sheets to `out/compare/`.
- Clips: look at `<clip>.sheet.png` and read `<clip>.motion.json` (flicker, jumps), never only the mp4.
- Look decisions: compare options with `de sweep <view> --set <path>=a,b,c` instead of guessing one value. Read
  `docs/taste.jsonl` before changing the look, and record every pick with `de taste`.
- Fast loop: `de-shot <steps> <out> --tier sketch` (320x180, no shadows) for layout; `hero` for PR images.
- Content is JSON in `content/` with schemas from the Rust types (`de schema terrain|steps`). Edit it directly, then
  `de validate`. Errors name the file, the field and the fix.
- New island: `python3 scripts/terrain/fetch.py <N62> <W008>` then `scripts/terrain/import.py` (see its header), add
  views by hand, `de validate`, and a step list in `content/shots/`.
- Ground look: layer colours, relief and detail are `look` in `terrain.json`; blending is `crates/de_client/src/terrain.wesl`.
  Scanned textures come from `python3 scripts/materials/fetch.py` (ids in `content/materials.json`); without them the
  shader draws each layer from noise, so check both if you change it.
- Flight feel is data in `content/drone.json` (`de schema drone`) and code in `crates/de_world/src/drone.rs`. Keep it
  like a real stabilised camera drone (mode-2 sticks, braking hover, level gimbal); fly `content/shots/drone.json`
  and read its `state` lines after changing it.
- If you add a capability, add it to the capability list (`crates/de_world/src/module.rs`).

## Rules

- Don't access the cardcraft-eternal repo (C's other game) from here; nothing in this repo needs it.
- Respect the layers: `de_world` (data, no renderer) <- `de_client` (Bevy) <- `de_cli` (tool). `de_world` never
  depends on Bevy's renderer, so its tests and the CLI run anywhere.
- All randomness goes through `de_world::Rng`, seeded from content, so captures stay identical run to run.
- Free and open data, tools and assets only; credit them in README.md.
- Never skip or weaken a test to get green.
