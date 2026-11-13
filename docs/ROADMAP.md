# Roadmap

Each step makes the island visibly better and builds only the tool features that step needs. A step is done when
its proof capture is in the PR. Principles are in [NORTH_STAR.md](NORTH_STAR.md), sources in [STUDY.md](STUDY.md).

Where we are: the Saksun valley flies as a camera drone on real Copernicus terrain (PR #1), with blended ground
layers and finer relief (PR #2). Captures are deterministic PNGs and mp4s, and `scripts/check.sh` writes a JSON
verdict.

## Step 1: Eyes (sensor packs, contact sheets, sweeps)

- **Game:** a first look pass on Saksun (fog, sun, exposure) chosen from sweep sheets by C.
- **Tool:** semantic, depth and normal buffers per shot; stats JSON and text description; keyframe sheets and motion
  stats for clips; `de sweep`; capture tiers; FLIP compare in `check.sh`; `docs/taste.jsonl` started.
- **Proof:** a 3x3 sweep sheet of the valley, C's pick recorded, the clip's flicker score in the summary.
- **Cut if:** an agent still can't answer "is the fog too strong?" with numbers.

## Step 2: Ground truth (photo-match)

- **Game:** Saksun's colours and light match real photos of the place.
- **Tool:** `content/references/` with five CC photos; skyline camera solve against the DEM; render vs photo sheets
  with palette and luminance metrics; Sentinel-2 ground colour as a check for distant terrain; `de probe`.
- **Proof:** photo-match sheet before and after, with the metric going down on at least four of five photos.
- **Cut if:** no usable CC photos can be matched; fall back to Sentinel-2 colour alone.
- **Status:** satellite half in PR #6. Photo half: five Commons photos in `content/references/saksun/`, cameras
  solved from their skylines (median error 0.04 to 0.19 degrees), `de photo match`; a fitted overcast look took the
  mean photo gap from 19.2 to 14.4, closer on 5 of 5 (`docs/shots/photo/`). Left: `de probe`; the sky dome still
  renders flatter and darker than the photos' skies, which is step 3's job.

## Step 3: Sky and weather

- **Game:** a physically based sky and volumetric clouds and fog banks rolling over the ridges, at any time of day.
- **Tool:** time-of-day and weather sheets; `look` gets a weather block (cloud cover, fog height, wind).
- **Proof:** a six-time-of-day sheet and an overcast sheet against the photo references.

## Step 4: Water from the land's own data

First slice done (streams, waterfalls and lakes from the DEM, `rules.json` with overrides, `de water` with a map
against WorldCover and a waterfall sheet), with moving water, foam, sky reflection and mist at the falls. Still to
do: the lagoon with tide, an FFT sea with shore foam, and the cached generation graph.

- **Game:** the real streams of Saksun, found from the DEM; waterfalls where they drop over cliffs; the lagoon with
  tide; an FFT sea with foam on the shore.
- **Tool:** first rule layer (`content/islands/<id>/rules.json`): streams and waterfalls compiled from flow
  accumulation and slope rules, with path overrides; the generation graph caches so a rule change only rebuilds water.
- **Proof:** a sheet of every generated waterfall, a clip down the valley to the lagoon, and the stream map overlaid on
  OpenStreetMap's streams.

## Step 5: Living ground

- **Game:** wind-moved grass, moss and heather where the satellite land cover says they are.
- **Tool:** vegetation rules from WorldCover plus slope, height and exposure; budgets as tests (frame time and
  instance counts) with a reference GPU profile, run on C's PC.
- **Proof:** ground-level hero shots before and after, and a clip with wind; frame time inside the budget.

## Step 6: Life

- **Game:** sheep on the slopes and seabird flocks along the cliffs, behaving by rules.
- **Tool:** animals in the rule layer (habitat, group size, time of day); animal positions in the stats JSON so a
  check can say "puffins visible from the lagoon view".
- **Proof:** a clip of a flock at the cliffs and a sheet of where animals spawn across the island.

## Step 7: The engine as a tool server

- **Game:** C and any Claude session can direct the game in words ("show me the valley at dusk in fog").
- **Tool:** MCP server over `de` and the Bevy Remote Protocol; `de explain` pages for every capability; CI posts
  hero sheets, FLIP heatmaps, photo-match and budget changes on each PR.
- **Proof:** a session that only has the MCP tools makes a look change end to end, with the PR showing it.

## Step 8: Dream states

- **Game:** the signature: aurora, bioluminescent shores and the fluid morphs between real and dream island.
- **Tool:** phenomena as rule-driven events in content, with their own sheets.
- **Proof:** a clip of a morph and an aurora night, reviewed by C against the design doc.

## Later

Island streaming and floating origin for island-hopping (Kauai second), Gaussian splat close-ups from C's drone
footage, procedural ambience and the adaptive score, HDR10 output tuning on C's OLED.

## Order and parallel work

Steps 1 and 2 come first because every later step is judged with their tools. Steps 3 to 6 can run in parallel
threads once they exist, since each one touches its own part of the content and renderer.
