# Study list

For each hard problem in Discover Earth, the best open implementations, papers and talks to learn from. Study a
topic when its [roadmap](ROADMAP.md) step starts, and write the result to `docs/study/<topic>.md` with the template
at the bottom. Licences are noted where we might use code directly; "ideas only" means read it, then write our own.
Licences marked "check" must be confirmed before any code is reused.

## 1. Agent tooling and capture (the loop itself)

| Source | What to take |
| --- | --- |
| Godot `--write-movie` (Movie Maker mode), MIT | Fixed-timestep offline capture that's exact regardless of speed; we already do this, compare edge cases (audio, physics) |
| Unity Graphics Test Framework (public docs) | Reference images per platform with tolerances; how they keep visual tests from going flaky |
| NVIDIA FLIP, BSD-3 | Perceptual image difference with a heatmap; replaces exact pixel compare across machines |
| Houdini PDG / TOPs (public docs) | A dependency graph of generation steps with caching, so changing a rule only rebuilds what depends on it |
| OpenUSD, modified Apache-2.0 | Layer composition: generated base, rules, overrides by path; text `.usda` that diffs well |
| RenderDoc, MIT | Frame captures readable from its Python API: an agent can inspect draw calls and textures of a bad frame |
| Tracy profiler, BSD-3 | Zone timings exportable as data, for frame budgets as tests |
| Bevy Remote Protocol (already in use) and Model Context Protocol | Wrap the live game and `de` as MCP tools |

## 2. Terrain: from 30 m data to ground you can walk on

| Source | What to take |
| --- | --- |
| Strugar, "Continuous Distance-Dependent Level of Detail" (CDLOD, 2010) | LOD for large heightfields without cracks |
| Losasso and Hoppe, "Geometry Clipmaps" (2004) | Alternative LOD; compare cost on our island sizes |
| `bevy_terrain` (kurtkuehnert), MIT/Apache | A working Bevy implementation of large-terrain LOD to read before writing ours |
| Godot Terrain3D, MIT | Practical tooling: texture painting, holes, collision on clipmaps |
| Mei et al., "Fast Hydraulic Erosion Simulation and Visualization on GPU" (2007) | Add erosion detail below DEM resolution so gullies look carved, not smoothed |
| Cordonnier et al., "Large Scale Terrain Generation from Tectonic Uplift and Fluvial Erosion" (2016) | How rivers and ridges shape each other; use to amplify real DEM plausibly |
| Sebastian Lague's erosion project, MIT | Simple droplet erosion that's easy to test |

## 3. Water: sea, lagoon, streams and waterfalls

| Source | What to take |
| --- | --- |
| Tessendorf, "Simulating Ocean Water" (2001) | FFT ocean spectrum, the standard for open sea |
| "Wakes, Explosions and Lighting: Interactive Water Simulation in Atlas" (GDC 2019) | Combining FFT ocean with local interaction and shoreline |
| Crest ocean v4 (Unity), MIT | Shoreline foam, depth-based colour, LOD for water; v5 is commercial, ideas only |
| Vlachos, "Water Flow in Portal 2" (SIGGRAPH 2010) | Flow maps for rivers and streams |
| O'Callaghan and Mark (1984) D8 flow, Barnes et al. Priority-Flood (2014) | Derive the real stream network and catchments from the DEM, so streams and waterfalls are where they really are |
| Lagarde, "Water drop" blog series (2012-13) | Wet surfaces, puddles, rain on materials |

## 4. Sky, light and atmosphere

| Source | What to take |
| --- | --- |
| Hillaire, "A Scalable and Production Ready Sky and Atmosphere Rendering Technique" (EGSR 2020) | Physically based sky at any time of day; Bevy's `Atmosphere` is based on it, so start there |
| Bruneton, precomputed atmospheric scattering, BSD | Reference implementation to validate our sky against |
| Schneider, "The Real-time Volumetric Cloudscapes of Horizon Zero Dawn" (SIGGRAPH 2015) and Nubis talks | Volumetric clouds; Faroese weather is mostly clouds and fog, so this matters a lot |
| Hillaire, "Physically Based Sky, Atmosphere and Cloud Rendering in Frostbite" (2016) | Fog and clouds lit consistently with the sky |
| Lumen talks (SIGGRAPH 2022), Majercik et al. DDGI (2019), Sannikov Radiance Cascades (2023), Bevy Solari | Options for global illumination in valleys; pick by cost on C's GPU |
| AgX (Blender, open) and Bevy's tonemappers | Tonemapping and HDR10 output for C's OLED |
| Baranoski et al., "A Simple Physically-Based Model for Aurora" (2000) | The aurora phenomenon from the design doc |

## 5. Vegetation and ground cover

| Source | What to take |
| --- | --- |
| Wohllaib, "Procedural Grass in Ghost of Tsushima" (GDC 2021) | Millions of grass blades with wind, the core look of the Faroes |
| Jahrmann and Wimmer, "Responsive Real-Time Grass Rendering for General 3D Scenes" (2017) | Blade physics and LOD |
| GPU Gems 3, ch. 16 "Vegetation Procedural Animation and Shading in Crysis" | Wind on vegetation in layers |
| Runions et al., "Modeling Trees with a Space Colonization Algorithm" (2007) | Trees and shrubs as code, for Kauai later |
| Cordonnier et al., "Authoring Landscapes by Combining Ecosystem and Terrain Erosion Simulation" (2017) | Vegetation that follows water, slope and exposure |
| ESA WorldCover 10 m, CC BY 4.0; Sentinel-2 imagery, free and open | Where grass, rock and water really are, and their real colour |

## 6. Animals and groups

| Source | What to take |
| --- | --- |
| Reynolds, "Flocks, Herds, and Schools" (1987) | Boids for seabird flocks and sheep herds |
| Rosen, "An Indie Approach to Procedural Animation" (GDC 2014) | Convincing animation from very few poses |
| Clavet, "Motion Matching" (GDC 2016) and Holden's open motion-matching articles and code (check) | Natural locomotion for larger animals |
| Field guides and published colony data for Faroese seabirds (puffin, fulmar, gannet) | Rules for where and when animals appear |

## 7. A large world and photoreal capture

| Source | What to take |
| --- | --- |
| `big_space` (Bevy), MIT/Apache | Floating origin, so island-hopping doesn't lose precision far from the origin |
| OGC 3D Tiles spec (open) | Tiling and streaming a world much bigger than memory |
| Kerbl et al., "3D Gaussian Splatting" (2023): original code is non-commercial, ideas only; `gsplat` (nerfstudio), Apache-2.0; `bevy_gaussian_splatting`, MIT/Apache | Photoreal close-ups from C's own drone footage, per the design doc |
| OpenStreetMap, ODbL | Paths, buildings and the real names of places |

## 8. Sound

| Source | What to take |
| --- | --- |
| Farnell, *Designing Sound* (book) | Wind, water and birds as procedural audio driven by the world's own data |
| `kira`, MIT/Apache | Rust audio with tweens and clocks, for an adaptive score |

## Study note template

```markdown
# <topic>

- Problem in Discover Earth: <what the player sees that is wrong or missing today>
- Sources read: <links>
- Core idea: <two or three sentences>
- Cost: <GPU ms on C's PC, memory, code size>
- Why it works: <the insight>
- What we take: <idea / algorithm / code under licence X>
- How it fits our data model: <which content file and schema it reads or adds>
- Proof: <the views, sheets and metrics that show it worked>
```
