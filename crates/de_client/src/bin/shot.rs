//! `de-shot <steps.json> <out-dir> [--tier sketch|check|hero] [--no-sense] [--bench]`: play a
//! step list offscreen and save its PNGs and mp4s, then a sensor pack per shot and a report per
//! clip (`<out>/sense.md` first).
//!
//! `--bench` flies the same list without saving anything and writes `<out>/bench.json`: frame
//! time, GPU time per pass and heap allocations per frame, judged against
//! `content/budget.json` when it runs on the reference GPU at the reference size.
//!
//! The real client, drawn by the GPU into an image (software Vulkan without a GPU), at 60
//! frames a second of game time. See docs/agents.md and `de schema steps`.
//!
//! Tiers: `sketch` is 320x180 without shadows (layout, "is it there"), `check` is 1280x720,
//! `hero` is 1920x1080. Without `--tier` the step list's `size` is used.

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
    bench::{BenchLog, BenchPlugin},
    capture::{Capture, CapturePlugin},
    drone::DronePlugin,
    scene::{CameraTarget, Sketch},
};
use de_world::StepList;
use stats_alloc::{INSTRUMENTED_SYSTEM, StatsAlloc};

/// Counts allocations so `--bench` can report them per frame; otherwise the system allocator.
#[global_allocator]
static GLOBAL: &StatsAlloc<std::alloc::System> = &INSTRUMENTED_SYSTEM;

fn allocations() -> u64 {
    let s = GLOBAL.stats();
    (s.allocations + s.reallocations) as u64
}

/// Frames left out of a bench at the start: pipeline compiles, first uploads, grass streaming in.
const WARMUP_FRAMES: usize = 60;

fn main() -> AppExit {
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    let bench = take_flag(&mut args, "--bench");
    let no_sense = take_flag(&mut args, "--no-sense") || bench;
    let tier = match take_opt(&mut args, "--tier").as_deref() {
        None => None,
        Some("sketch") => Some(([320, 180], true)),
        Some("check") => Some(([1280, 720], false)),
        Some("hero") => Some(([1920, 1080], false)),
        Some(t) => {
            eprintln!("unknown tier `{t}`: use sketch, check or hero");
            return AppExit::error();
        }
    };
    let [steps, out] = args.as_slice() else {
        eprintln!("usage: de-shot <steps.json> <out-dir> [--tier sketch|check|hero] [--no-sense] [--bench]");
        return AppExit::error();
    };
    let text = std::fs::read_to_string(steps).unwrap_or_else(|e| panic!("{steps}: {e}"));
    let mut list: StepList = serde_json::from_str(&text).unwrap_or_else(|e| panic!("{steps}: {e}"));
    let sketch = tier.is_some_and(|t| t.1);
    if let Some((size, _)) = tier {
        list.size = size;
    }
    let island_id = list.island.clone();
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

    app.insert_resource(IslandSource { content: content.clone(), id: list.island.clone() })
        .insert_resource(CameraTarget(Some(target.clone())));
    if sketch {
        app.insert_resource(Sketch);
    }
    let size = list.size;
    let mut capture = Capture::new(list, out.clone(), target);
    capture.bench = bench;
    let log = std::sync::Arc::new(std::sync::Mutex::new(BenchLog::default()));
    if bench {
        app.add_plugins(BenchPlugin { log: log.clone(), allocs: Some(allocations) });
    }
    let clips = capture.clips.clone();
    let cameras = capture.cameras.clone();
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
    if bench {
        let log = log.lock().expect("bench log");
        return write_bench(&log, steps, size, &content, &out).unwrap_or_else(|e| {
            eprintln!("{e}");
            AppExit::error()
        });
    }
    let cameras = cameras.lock().expect("cameras lock").clone();
    std::fs::write(out.join("shots.json"), serde_json::to_string_pretty(&cameras).expect("serialises"))
        .expect("write shots.json");
    if !no_sense {
        match de_world::pack::write(&out, &content, &island_id) {
            Ok(_) => println!("{}", out.join("sense.md").display()),
            Err(e) => {
                eprintln!("sensor packs failed: {e}");
                return AppExit::error();
            }
        }
    }
    exit
}

/// Write `<out>/bench.json` and print its verdict. Fails the run only if the budget is broken
/// on the reference machine.
fn write_bench(
    log: &BenchLog,
    steps: &str,
    size: [u32; 2],
    content: &std::path::Path,
    out: &std::path::Path,
) -> Result<AppExit, String> {
    use de_world::budget::{BenchReport, Budget, Stats, Verdict};
    let budget = Budget::load(content)?;
    let skip = |v: &[f64]| v.get(WARMUP_FRAMES.min(v.len())..).unwrap_or_default().to_vec();
    let (frame, gpu) = (skip(&log.frame_ms), skip(&log.gpu_ms));
    let allocs: Vec<f64> = log.allocs.iter().skip(WARMUP_FRAMES).map(|&a| a as f64).collect();
    let mut passes: Vec<(String, f64)> = log
        .passes
        .iter()
        .map(|(k, &(sum, n))| (k.clone(), (sum / n.max(1) as f64 * 1000.0).round() / 1000.0))
        .collect();
    passes.sort_by(|a, b| b.1.total_cmp(&a.1));
    let mut report = BenchReport {
        steps: steps.to_string(),
        adapter: log.adapter.clone(),
        backend: log.backend.clone(),
        size,
        warmup_frames: WARMUP_FRAMES,
        frame_ms: Stats::of(&frame),
        gpu_ms: Stats::of(&gpu),
        passes,
        slow_frames: vec![],
        verdict: Verdict::Pass,
    };
    report.judge(&budget, &gpu);
    let mut doc = serde_json::to_value(&report).map_err(|e| e.to_string())?;
    doc["allocs_per_frame"] = serde_json::to_value(Stats::of(&allocs)).map_err(|e| e.to_string())?;
    doc["budget"] = serde_json::to_value(&budget.frame).map_err(|e| e.to_string())?;
    doc["reference_confirmed"] = budget.reference.confirmed.into();
    let path = out.join("bench.json");
    std::fs::write(&path, serde_json::to_string_pretty(&doc).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let f = &report.frame_ms;
    let g = &report.gpu_ms;
    println!("{} on {} ({}), {}x{}", path.display(), report.adapter, report.backend, size[0], size[1]);
    println!("frame  avg {:.2}  p99 {:.2}  max {:.2} ms over {} frames", f.avg, f.p99, f.max, f.n);
    if g.n > 0 {
        println!("GPU    avg {:.2}  p99 {:.2}  max {:.2} ms", g.avg, g.p99, g.max);
    } else {
        println!("GPU    no timestamp queries on this adapter");
    }
    println!("verdict: {:?}", report.verdict);
    Ok(if matches!(report.verdict, Verdict::Fail(_)) { AppExit::error() } else { AppExit::Success })
}

fn take_flag(args: &mut Vec<String>, flag: &str) -> bool {
    let had = args.iter().any(|a| a == flag);
    args.retain(|a| a != flag);
    had
}

fn take_opt(args: &mut Vec<String>, opt: &str) -> Option<String> {
    let i = args.iter().position(|a| a == opt)?;
    args.remove(i);
    (i < args.len()).then(|| args.remove(i))
}
