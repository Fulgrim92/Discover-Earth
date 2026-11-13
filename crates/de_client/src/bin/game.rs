//! Discover Earth in a window. `discover-earth [island]` (default: the first island).
//!
//! You fly a camera drone: see `de_client::drone` for the controls.
//!
//! While it runs, the Bevy Remote Protocol listens on http://127.0.0.1:15702, so an agent can
//! query and change the live world (`world.query`, `world.insert_components`, ...): see
//! docs/agents.md.

use bevy::{
    prelude::*,
    remote::{RemotePlugin, http::RemoteHttpPlugin},
    render::{
        RenderPlugin,
        settings::{Backends, WgpuSettings},
    },
};
use de_client::{IslandSource, ScenePlugin, drone::PilotPlugin};

fn main() -> AppExit {
    let content = de_world::content_dir();
    let id = std::env::args().nth(1).or_else(|| de_world::island_ids(&content).into_iter().next());
    let Some(id) = id else {
        eprintln!("no islands under {}", content.join("islands").display());
        return AppExit::error();
    };
    App::new()
        .add_plugins(
            DefaultPlugins
                .set(WindowPlugin {
                    primary_window: Some(Window { title: "Discover Earth".into(), ..default() }),
                    ..default()
                })
                .set(RenderPlugin { render_creation: render_settings().into(), ..default() }),
        )
        .add_plugins((RemotePlugin::default(), RemoteHttpPlugin::default()))
        .insert_resource(IslandSource { content, id })
        .add_plugins((ScenePlugin, PilotPlugin))
        .run()
}

/// On Windows the window draws with DirectX 12 unless `WGPU_BACKEND` says otherwise: on an
/// AMD RX 6650 XT (driver 26.10.1) Vulkan reports no present modes for the window's surface
/// and Bevy panics on start. Offscreen captures (`de-shot`) have no surface and keep Vulkan.
fn render_settings() -> WgpuSettings {
    let mut settings = WgpuSettings::default();
    if cfg!(windows) && std::env::var_os("WGPU_BACKEND").is_none() {
        settings.backends = Some(Backends::DX12);
    }
    settings
}
