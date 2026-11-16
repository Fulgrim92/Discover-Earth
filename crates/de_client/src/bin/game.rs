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
        settings::{Backends, Dx12Compiler, WgpuSettings},
    },
};
use std::path::Path;

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
///
/// DirectX 12 compiles shaders with DXC when `scripts/dxc/fetch.py` has put dxcompiler.dll
/// next to the game: with the old FXC compiler the island takes 20-60 s to appear.
fn render_settings() -> WgpuSettings {
    let mut settings = WgpuSettings::default();
    if cfg!(windows) && std::env::var_os("WGPU_BACKEND").is_none() {
        settings.backends = Some(Backends::DX12);
    }
    if cfg!(windows) && std::env::var_os("WGPU_DX12_COMPILER").is_none() {
        let exe_dir = std::env::current_exe().ok().and_then(|exe| exe.parent().map(Path::to_path_buf));
        settings.dx12_shader_compiler = dx12_compiler(exe_dir.as_deref());
        match &settings.dx12_shader_compiler {
            Dx12Compiler::DynamicDxc { dxc_path } => eprintln!("DirectX 12 shaders: DXC ({dxc_path})"),
            _ => eprintln!(
                "DirectX 12 shaders: FXC, slow (the island can take a minute to appear); \
                 run `python scripts/dxc/fetch.py` for DXC"
            ),
        }
    }
    settings
}

/// DXC from dxcompiler.dll next to the game (dxil.dll, which it loads to sign shaders, has to
/// sit there too), else FXC.
fn dx12_compiler(exe_dir: Option<&Path>) -> Dx12Compiler {
    let found = exe_dir
        .map(|dir| dir.join("dxcompiler.dll"))
        .filter(|dll| dll.is_file() && dll.with_file_name("dxil.dll").is_file());
    match found {
        Some(dll) => Dx12Compiler::DynamicDxc { dxc_path: dll.to_string_lossy().into_owned() },
        None => Dx12Compiler::Fxc,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dxc_only_when_both_dlls_are_next_to_the_game() {
        let dir = std::env::temp_dir().join(format!("de-dxc-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(matches!(dx12_compiler(None), Dx12Compiler::Fxc));
        assert!(matches!(dx12_compiler(Some(&dir)), Dx12Compiler::Fxc));
        std::fs::write(dir.join("dxcompiler.dll"), b"").unwrap();
        assert!(matches!(dx12_compiler(Some(&dir)), Dx12Compiler::Fxc), "dxil.dll missing");
        std::fs::write(dir.join("dxil.dll"), b"").unwrap();
        match dx12_compiler(Some(&dir)) {
            Dx12Compiler::DynamicDxc { dxc_path } => assert!(dxc_path.ends_with("dxcompiler.dll")),
            other => panic!("expected DXC, got {other:?}"),
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
