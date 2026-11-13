# Working in this repo

Discover Earth is a game on **Forge** (the engine from Equilibrium: Eternal) with **Bevy 0.20** drawing in 3D. Read
`docs/ARCHITECTURE.md` first, then `docs/agents.md` for how to see what you changed.

## The loop

- Before adding a feature, check what exists: `cargo run -q -p de_cli -- capabilities`.
- After any change: `scripts/check.sh`. On failure read `out/check/summary.json` and the step's log in `out/check/`.
- Visual changes: `scripts/check.sh --shots` writes `out/shots/*.png`; look at them. Keep a copy of the shots from
  `main` and pass `--ref <that dir>` to see which ones changed (same pixels every run on one machine).
- Content is JSON in `content/` with schemas from the Rust types (`de schema terrain|steps`). Edit it directly, then
  `de validate`. Errors name the file, the field and the fix.
- New island: `python3 scripts/terrain/fetch.py <N62> <W008>` then `scripts/terrain/import.py` (see its header), add
  views by hand, `de validate`, and a step list in `content/shots/`.
- Flight feel is data in `content/drone.json` (`de schema drone`) and code in `crates/de_world/src/drone.rs`. Keep it
  like a real stabilised camera drone (mode-2 sticks, braking hover, level gimbal); fly `content/shots/drone.json`
  and read its `state` lines after changing it.
- If you add a capability, register it in the crate's Forge module (`crates/de_world/src/module.rs` for now).

## Rules

- Never change `vendor/forge` or the cardcraft-eternal repo from here. Forge is pinned by `FORGE_REV`; moving the pin
  is its own reviewed change (`docs/forge.md`).
- Respect Forge's layers: `de_world` (data, no renderer) <- `de_client` (Bevy) <- `de_cli` (tool). `de_world` never
  depends on Bevy's renderer, so its tests and the CLI run anywhere.
- All randomness goes through `forge_core::Rng`, seeded from content, so captures stay identical run to run.
- Free and open data, tools and assets only; credit them in README.md.
- Never skip or weaken a test to get green.
