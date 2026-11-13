//! The world as a Forge module, so its features show up in `de capabilities`.

use forge_core::{Capability, CapabilityKind, ForgeModule, Layer, ModuleManifest};

pub struct WorldModule;

const NAME: &str = "de_world";

impl ForgeModule for WorldModule {
    fn manifest(&self) -> ModuleManifest {
        ModuleManifest {
            name: NAME.into(),
            version: env!("CARGO_PKG_VERSION").into(),
            layer: Layer::Gameplay,
            summary: "Island data: real-terrain heightfields, views, looks and capture step lists".into(),
            depends_on: vec!["forge_core".into()],
        }
    }

    fn capabilities(&self) -> Vec<Capability> {
        use CapabilityKind::*;
        let c = |id: &str, kind, summary: &str| Capability::new(id, kind, NAME, summary);
        vec![
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
            c("world.steps.camera", Command, "Step: place the camera at a position looking at a point"),
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
        ]
    }
}
