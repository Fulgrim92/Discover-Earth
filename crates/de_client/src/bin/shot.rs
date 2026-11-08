//! `de-shot <steps.json> <out-dir>`: play a step list offscreen and save its PNGs and mp4s.
//!
//! The real client, drawn by the GPU into an image (software Vulkan without a GPU), at 60
//! frames a second of game time. See docs/agents.md and `de schema steps`.

use std::{path::PathBuf, process::Command, time::Duration};

use bevy::{
    app::ScheduleRunnerPlugin,
    image::Image,
    prelude::*,
    render::{
        RenderPlugin,
        render_resource::{TextureFormat, TextureUsages},
    },
    time::TimeUpdateStrategy,
    window::ExitCondition,
    winit::WinitPlugin,
};
use de_client::{
    IslandSource, ScenePlugin,
    capture::{Capture, CapturePlugin},
    drone::DronePlugin,
    scene::CameraTarget,
};
use de_world::StepList;

fn main() -> AppExit {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [steps, out] = args.as_slice() else {
        eprintln!("usage: de-shot <steps.json> <out-dir>");
        return AppExit::error();
    };
    let text = std::fs::read_to_string(steps).unwrap_or_else(|e| panic!("{steps}: {e}"));
    let list: StepList = serde_json::from_str(&text).unwrap_or_else(|e| panic!("{steps}: {e}"));
    let out = PathBuf::from(out);
    std::fs::create_dir_all(&out).expect("create out dir");
    let content = de_world::content_dir();

    let mut app = App::new();
    app.add_plugins(
        DefaultPlugins
            .set(WindowPlugin { primary_window: None, exit_condition: ExitCondition::DontExit, ..default() })
            .set(RenderPlugin { synchronous_pipeline_compilation: true, ..default() })
            .disable::<WinitPlugin>(),
    )
    .add_plugins(ScheduleRunnerPlugin::run_loop(Duration::ZERO))
    .insert_resource(TimeUpdateStrategy::ManualDuration(Duration::from_secs_f64(1.0 / 60.0)));

    let [w, h] = list.size;
    let mut image = Image::new_target_texture(w, h, TextureFormat::Rgba8UnormSrgb, None);
    image.texture_descriptor.usage |= TextureUsages::COPY_SRC;
    let target = app.world_mut().resource_mut::<Assets<Image>>().add(image);

    app.insert_resource(IslandSource { content, id: list.island.clone() })
        .insert_resource(CameraTarget(Some(target.clone())));
    let capture = Capture::new(list, out.clone(), target);
    let clips = capture.clips.clone();
    app.insert_resource(capture).add_plugins((ScenePlugin, DronePlugin, CapturePlugin));
    let exit = app.run();

    let clips = clips.lock().expect("clips lock").clone();
    for (name, _) in clips {
        let dir = out.join(&name);
        let mp4 = out.join(format!("{name}.mp4"));
        let ok = Command::new("ffmpeg")
            .args(["-y", "-loglevel", "error", "-framerate", "30", "-i"])
            .arg(dir.join("frame_%04d.png"))
            .args(["-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20"])
            .arg(&mp4)
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if ok {
            println!("{}", mp4.display());
        } else {
            eprintln!("ffmpeg failed or is missing; frames are in {}", dir.display());
        }
    }
    exit
}
