//! Discover Earth's 3D client: one island drawn with Bevy from `de_world` data.
//!
//! The same [`ScenePlugin`] runs in the window (`discover-earth`) and offscreen (`de-shot`), so
//! what an agent captures is what a player sees. Game code here only spawns entities and
//! moves the camera; it never touches the GPU directly.

pub mod capture;
pub mod fly;
pub mod scene;

pub use scene::{CameraRig, Ground, IslandSource, ScenePlugin};

use bevy::prelude::*;

/// Place a camera transform at `pos` looking at `look_at`, with +Y up.
pub fn look(pos: [f32; 3], look_at: [f32; 3]) -> Transform {
    Transform::from_translation(Vec3::from(pos)).looking_at(Vec3::from(look_at), Vec3::Y)
}
