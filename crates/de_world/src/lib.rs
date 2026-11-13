//! Discover Earth's world as data: island terrain manifests, their heightfields, and the
//! step lists that drive captures. Nothing here draws; the client and the CLI build on it,
//! and every test runs without a GPU.

pub mod drone;
pub mod island;
pub mod module;
pub mod steps;
pub mod terrain;

pub use drone::{DroneConfig, DroneState, FlightMode, Sticks};
pub use island::{Island, LoadError, Vec3, View};
pub use module::WorldModule;
pub use steps::{Step, StepList};
pub use terrain::Heightfield;

use std::path::{Path, PathBuf};

/// The repo's `content/` folder: `DE_CONTENT` if set, else the one next to this crate.
pub fn content_dir() -> PathBuf {
    std::env::var_os("DE_CONTENT")
        .map(PathBuf::from)
        .unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")).join("../../content"))
}

/// Ids of every island under `content/islands/`, sorted.
pub fn island_ids(content: &Path) -> Vec<String> {
    let mut ids: Vec<String> = std::fs::read_dir(content.join("islands"))
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.path().join("terrain.json").is_file())
        .filter_map(|e| e.file_name().into_string().ok())
        .collect();
    ids.sort();
    ids
}
