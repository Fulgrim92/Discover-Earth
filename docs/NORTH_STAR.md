# North star: the LLM-first world forge

**Goal.** Build the most capable tool there is for making Discover Earth, by studying the best existing solutions to
each problem the game has and recombining their ideas into one toolchain designed from the ground up for how an LLM
works. The game is the product and the proof: every piece of the tool exists because it makes the island visibly
better, and it lands with a before and after capture.

This page says what "designed for an LLM" means. [STUDY.md](STUDY.md) lists what to learn from, and
[ROADMAP.md](ROADMAP.md) says in what order, each step tied to something you can see in the game.

## How we learn from existing software

1. **Study, then recombine.** For each hard problem, read the two or three best open implementations, the papers
   behind them and the conference talks from the studios that shipped them. Write down the core idea, its cost and
   why it works (template in [STUDY.md](STUDY.md)). Then reimplement the idea cleanly in our Rust + Bevy code, so everything
   shares one data model instead of being glued-together libraries.
2. **Ideas, not code, from closed products.** Closed engines and tools are studied through their public docs, talks
   and papers. Nothing is decompiled: decompiled code can't legally ship, and the best techniques are published
   anyway. Open code is used directly only when its licence fits (MIT, Apache-2.0, BSD, zlib, CC0); GPL code is
   read for ideas only.
3. **Study just in time.** A topic is studied when its roadmap step starts, not up front. A study that doesn't end in
   a visible improvement within one step gets parked.

## Why an LLM needs a different tool

Human tools assume a person who watches the screen continuously, drags sliders, remembers what the scene looked like
yesterday and has taste built from years of looking at the real world. An LLM has none of that. It sees still
images one at a time, reasons well over text and numbers, forgets everything between sessions, can run many
experiments in parallel, and is good at writing rules and bad at hand-placing a thousand things. So the tool should:

- turn every look and feel question into **files it can read** (images, numbers and text, never only a window),
- turn every decision into **a comparison between options** rather than a single absolute judgement,
- keep **memory outside the model** (taste, decisions, references) in the repo,
- let it **describe intent** and have the engine do the placing,
- make every run **deterministic**, so any result can be reproduced, compared and bisected.

The repo already has the start of this: JSON content with generated schemas, `de capabilities`, the deterministic
`de-shot` step player with PNG and mp4 output, `scripts/check.sh` with a JSON verdict, and the Bevy Remote Protocol
on the live game. The principles below extend it.

## Principles

### 1. The closed loop: change, run, look, judge, keep

Every change ends with the agent seeing its effect and judging it against something written down. The loop has to be
fast enough to run dozens of times per task, so captures come in tiers:

| Tier | Size | Takes | For |
| --- | --- | --- | --- |
| `sketch` | 320x180, no shadows, no post | ~0.1 s per view | layout, composition, "is the thing there at all" |
| `check` | 1280x720 | under 1 s | everyday changes, regression compare |
| `hero` | 1920x1080 or 4K, all effects | seconds | PR images, look decisions, C's review |

### 2. Perception in more channels than pixels

An LLM's vision is good at "does this look like a Faroese valley" and poor at "is the fog 10% too dense" or "did
this frame flicker". So every capture writes a **sensor pack** next to the PNG:

- **Buffers:** depth, normals, ground layer weights, and a semantic ID per pixel (sky, sea, grass, rock, water,
  animal, ...). These come from the same render, so they always match the image.
- **Stats JSON:** coverage per class, luminance histogram and clipping, average colour per class, horizon height,
  sun angle, distance to the nearest surface, fog extinction at 1 km.
- **A text description** made from the buffers: "foreground grass 61%, cliff on the left, sea 12% at 3 km, sun 18°
  behind camera, no animals visible". A text-only agent, or a cheap check, can reason over this without an image.

Video gets the same treatment, because a model can't watch an mp4: every clip also writes a **keyframe contact
sheet** (a labelled grid of frames) and **motion stats** (per-frame change, flicker score, camera speed and height
over time). A flicker or stutter shows up as a number before anyone has to spot it.

### 3. Ask the world why

`de probe <view> <x,y>` answers "why is this pixel this colour?": which surface, which ground layers and weights,
which light, fog and exposure contributed how much. Debugging a visual bug becomes a question with a text answer
instead of a guessing game with shader edits.

### 4. Decide by comparing, not by judging

Absolute aesthetic judgement is unreliable for models and people alike; picking the best of several side by side is
much easier. So the tool makes options cheap:

- `de sweep <view> look.fog.density=0.0002..0.001x5` renders a labelled grid over one or two parameters.
- **Time and weather sheets:** one view at six times of day, or under four weathers, in one image.
- **Before and after** with a perceptual difference heatmap (NVIDIA FLIP) instead of exact pixel equality, so
  compares still work across machines and GPUs.

C can pick from the same sheets on a phone, which brings us to memory.

### 5. Taste lives in the repo

The model forgets; the repo doesn't. Three files carry taste across sessions:

- `docs/taste.jsonl`: every time C picks or rejects an option from a sheet, the choice, the sheet and the reason are
  appended. Future agents read it before making look decisions.
- `docs/art-bible.md`: the look as checkable statements ("shadows on grass never go below 3% luminance", "sea is
  darker than sky at the horizon in overcast"). Each statement that can be measured becomes a check.
- `content/references/`: real photos (CC licensed) with their source and licence, used for photo-match (principle 6).

### 6. Ground truth from the real world

Discover Earth's islands are real places built from real elevation data. That gives us something most games don't
have: a right answer to compare against.

- **Photo-match views.** Take CC-licensed photos of Saksun and Tjørnuvík (Wikimedia Commons), solve each photo's
  camera position by matching its skyline against the DEM's skyline, and save it as a view. Every `hero` run then
  produces render and photo side by side with colour palette, luminance and sky-to-ground distance metrics. "More
  photoreal" becomes a number that goes down.
- **Satellite colour.** Sentinel-2 imagery gives the real ground colour for every 10 m cell; land cover maps
  (ESA WorldCover) say where grass, bare rock and water are. Distant terrain is checked against them, and vegetation
  placement starts from them.

### 7. Describe intent, let the engine place

LLMs write rules well and place thousands of things badly. So content is layered:

1. **Generated base:** terrain from the DEM, streams from flow accumulation, land cover from satellite maps.
2. **Rules:** text the agent writes, such as "puffins nest on sea-facing slopes over 60° between 50 and 300 m" or
   "waterfalls where a stream with catchment over 0.5 km² crosses a slope over 50°". The engine compiles rules into
   placements, deterministically from the island's seed.
3. **Overrides:** hand edits by path (`saksun/waterfalls/3.height_m = 40`) that survive regenerating the layers
   below, the way OpenUSD layers override each other.

Everything has a stable path, so a diff of the content reads like a description of what changed in the world.

### 8. Everything reproducible, everything bisectable

All randomness goes through the island seed (already a rule). On top of that: every run writes the seed, step list,
content hash and commit it used, so any capture can be rebuilt exactly; `de bisect-look <view>` walks git history
to find the commit where a view changed; and a bug report is just a step list.

### 9. The engine as a tool server

The `de` commands and the live game's Bevy Remote Protocol are wrapped as an **MCP server** (`render_view`,
`sweep`, `probe`, `describe`, `query_world`, `set_component`, `run_steps`). Any Claude session, in the cloud or on
C's PC, then drives the game with typed tools instead of shell glue, and the tool list doubles as documentation.

### 10. Docs sized for a context window

Each capability ships with a short skill-style page: what it does, its schema, one worked example and the check
that proves it works. `de explain <capability>` prints it. A fresh agent loads only the pages it needs instead of
reading the whole repo.

### 11. Budgets are tests

Frame time on a reference GPU profile, triangle and draw counts, memory and capture time are written as JSON by
every run and checked against budgets in content. Performance regressions fail the check like a broken test, with
the number in the summary.

### 12. Every PR shows itself

CI renders the `hero` views before and after the change and posts the sheet, the FLIP heatmap, the photo-match
metric change and the budget change on the PR. C reviews by looking, not by reading code.

## The guard rail

The main risk is building an engine instead of a game. So:

- Every roadmap step names the **visible improvement** it delivers and the **capture** that proves it.
- A tool feature is only built when a game step needs it, in the same step.
- If a step doesn't visibly improve the island, it is cut or parked, and the reason goes into `docs/taste.jsonl`.
