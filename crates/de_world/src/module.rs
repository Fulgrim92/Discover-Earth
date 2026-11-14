//! What the game can do, as a list an agent reads first (`de capabilities`). Add an entry here
//! whenever you add a feature, a content file, a step or a command.

use serde::Serialize;

/// The crate that provides a capability, and its layer: data (`de_world`), game (`de_client`)
/// or tool (`de_cli`).
#[derive(Clone, Debug, Serialize)]
pub struct Module {
    pub name: String,
    pub version: String,
    pub layer: String,
    pub summary: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CapabilityKind {
    /// Code that runs: a simulation, a renderer feature, a sensor.
    System,
    /// Something written as data in `content/`.
    Content,
    /// A JSON schema (`de schema ...`).
    Schema,
    /// A command or capture step.
    Command,
}

#[derive(Clone, Debug, Serialize)]
pub struct Capability {
    pub id: String,
    pub kind: CapabilityKind,
    pub module: String,
    pub summary: String,
}

pub struct WorldModule;

const NAME: &str = "de_world";

impl WorldModule {
    pub fn manifest(&self) -> Module {
        Module {
            name: NAME.into(),
            version: env!("CARGO_PKG_VERSION").into(),
            layer: "gameplay".into(),
            summary: "Island data: real-terrain heightfields, views, looks and capture step lists".into(),
        }
    }

    pub fn capabilities(&self) -> Vec<Capability> {
        use CapabilityKind::*;
        let c = |id: &str, kind, summary: &str| Capability {
            id: id.into(),
            kind,
            module: NAME.into(),
            summary: summary.into(),
        };
        vec![
            c("module.de_world", System, "Island data: terrain, views, looks, drone, step lists, sensors"),
            c(
                "world.terrain.heightfield",
                System,
                "16-bit PNG heightfield in metres, centred on the origin; bilinear height and normals",
            ),
            c(
                "world.terrain.import",
                Command,
                "scripts/terrain/import.py: cut an island out of a Copernicus GLO-30 DEM tile",
            ),
            c("world.island.views", Content, "Named camera views per island; the first is the spawn point"),
            c("world.island.look", Content, "Sun, sky, fog, ground and sea colours per island"),
            c("world.schema.terrain", Schema, "JSON schema for content/islands/<id>/terrain.json"),
            c("world.schema.steps", Schema, "JSON schema for capture step lists (content/shots/*.json)"),
            c("world.steps.view", Command, "Step: jump the camera to a named view"),
            c(
                "world.steps.camera",
                Command,
                "Step: place the camera at a position looking at a point, optionally with fov and roll",
            ),
            c("world.steps.wait", Command, "Step: let frames of game time pass"),
            c("world.steps.shot", Command, "Step: save the next frame as a PNG"),
            c("world.steps.fly", Command, "Step: fly to a view, saving every frame and an mp4"),
            c(
                "world.steps.drone",
                Command,
                "Step: fly the drone with stick inputs held for some frames, optionally recording a clip",
            ),
            c("world.steps.state", Command, "Step: print camera, drone and ground height as JSON"),
            c(
                "world.drone.flight",
                System,
                "Mode-2 camera drone: stabilised velocity control, braking hover, expo, wind, ground clearance",
            ),
            c("world.drone.modes", Content, "Flight modes (cine, normal, sport) as data in content/drone.json"),
            c(
                "world.drone.gimbal",
                System,
                "Level-horizon gimbal with tilt control and a slight bank into sideways moves",
            ),
            c("world.schema.drone", Schema, "JSON schema for content/drone.json"),
            c(
                "world.sense.pack",
                System,
                "Per shot: class, depth, normal and sun-shadow buffers, stats JSON and a text description (sense.md)",
            ),
            c(
                "world.sense.motion",
                System,
                "Per clip: keyframe sheet, flicker score and map, jumps, speed and altitude",
            ),
            c("world.sense.tiers", Command, "de-shot --tier sketch|check|hero: 320x180 without shadows, 720p, 1080p"),
            c("tool.sweep", Command, "de sweep: render a view over terrain.json values as one labelled sheet"),
            c("tool.compare", Command, "de compare: perceptual (FLIP) difference per shot with heatmaps"),
            c(
                "world.truth.satellite",
                Content,
                "Per island: Sentinel-2 ground albedo and ESA WorldCover land cover (scripts/truth/fetch.py)",
            ),
            c(
                "world.truth.shot",
                System,
                "Per shot: view painted with satellite colour, land cover, per-layer colour gap (ΔE)",
            ),
            c("tool.truth", Command, "de truth: fit ground layer albedos to the satellite; maps and agreement"),
            c(
                "world.water.find",
                System,
                "Streams, waterfalls and lakes from the terrain: priority-flood fill, D8 flow, catchment area",
            ),
            c(
                "world.water.rules",
                Content,
                "content/islands/<id>/rules.json: water thresholds and overrides (remove/add streams, drop lakes)",
            ),
            c("world.schema.rules", Schema, "JSON schema for content/islands/<id>/rules.json"),
            c("tool.water", Command, "de water: water report, map vs WorldCover water, a shot list per waterfall"),
            c(
                "world.truth.photos",
                Content,
                "Per island: CC-licensed reference photos with credit and solved cameras (content/references/)",
            ),
            c("tool.photo.solve", Command, "de photo solve: find a photo's camera by fitting its skyline to the DEM"),
            c(
                "tool.photo.match",
                Command,
                "de photo match: render each photo's camera; colour, lightness and palette gap vs the photo",
            ),
            c(
                "world.look.cinema",
                Content,
                "Film look per island: physical atmosphere, tonemapper, bloom, grade, volumetric mist (look.cinema)",
            ),
            c(
                "world.look.clouds",
                Content,
                "Volumetric cloud layer per island: cover, base/top height, wind, light, shadows on the ground (look.clouds)",
            ),
            c("world.sun", Content, "Sun azimuth and elevation for a place and a UTC time (de_world::sun, NOAA)"),
            c(
                "tool.photo.light",
                Command,
                "de photo match --photo-light: each render at its photo's sun, EXIF exposure and cloud cover",
            ),
            c("tool.taste", Command, "de taste: record a look decision in docs/taste.jsonl"),
        ]
    }
}
