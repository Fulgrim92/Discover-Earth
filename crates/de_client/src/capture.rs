//! Headless captures: play a [`StepList`] against the scene and save PNGs and mp4s.
//!
//! Time is game time: every frame advances exactly 1/60 s however long it takes to draw, and
//! pipelines compile before the first frame, so a step list gives the same pixels each run on
//! one machine.

use std::{
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
};

use bevy::{
    prelude::*,
    render::view::screenshot::{Screenshot, ScreenshotCaptured, save_to_disk},
};
use de_world::{Step, StepList, sense::CameraShot};

use crate::{
    drone::Drone,
    scene::{CameraRig, Ground},
};

/// The capture being played.
#[derive(Resource)]
pub struct Capture {
    pub steps: StepList,
    pub out: PathBuf,
    pub target: Handle<Image>,
    next: usize,
    wait: u32,
    fly: Option<Fly>,
    piloting: Option<Piloting>,
    /// Screenshots asked for but not yet written.
    pending: Arc<AtomicUsize>,
    /// Clips to join into mp4s once every frame is on disk: (name, frame count). Shared, so
    /// the caller can still read it after `App::run` has torn the world down.
    pub clips: Arc<std::sync::Mutex<Vec<(String, u32)>>>,
    /// Where the camera was for every saved image, in order; `de-shot` writes it to
    /// `shots.json` and builds sensor packs and clip reports from it.
    pub cameras: Arc<std::sync::Mutex<Vec<CameraShot>>>,
    pub frame: u64,
}

struct Piloting {
    sticks: de_world::Sticks,
    frames: u32,
    at: u32,
    clip: Option<String>,
}

struct Fly {
    name: String,
    from: Transform,
    to: Transform,
    frames: u32,
    at: u32,
}

impl Capture {
    pub fn new(steps: StepList, out: PathBuf, target: Handle<Image>) -> Self {
        Self {
            steps,
            out,
            target,
            next: 0,
            // Let shadows and exposure settle before the first step.
            wait: 3,
            fly: None,
            piloting: None,
            pending: Arc::default(),
            clips: Arc::default(),
            cameras: Arc::default(),
            frame: 0,
        }
    }
}

pub struct CapturePlugin;

impl Plugin for CapturePlugin {
    fn build(&self, app: &mut App) {
        app.add_systems(Update, play.run_if(resource_exists::<Ground>).run_if(resource_exists::<Drone>));
    }
}

/// Save the next frame as `<out>/<name>.png` and record where the camera was.
fn shoot(commands: &mut Commands, cap: &Capture, name: String, cam: &Transform) {
    let path = cap.out.join(format!("{name}.png"));
    let (f, u, r) = (cam.forward(), cam.up(), cam.right());
    cap.cameras.lock().expect("cameras lock").push(CameraShot {
        name,
        frame: cap.frame,
        pos: cam.translation.to_array(),
        forward: f.to_array(),
        up: u.to_array(),
        right: r.to_array(),
        fov_y_deg: crate::scene::FOV_Y_DEG,
        size: cap.steps.size,
    });
    cap.pending.fetch_add(1, Ordering::SeqCst);
    let pending = cap.pending.clone();
    commands.spawn(Screenshot::image(cap.target.clone())).observe(save_to_disk(path)).observe(
        move |_: On<ScreenshotCaptured>| {
            pending.fetch_sub(1, Ordering::SeqCst);
        },
    );
}

fn play(
    mut commands: Commands,
    mut cap: ResMut<Capture>,
    ground: Res<Ground>,
    mut drone: ResMut<Drone>,
    mut cams: Query<&mut Transform, With<CameraRig>>,
    mut exit: MessageWriter<AppExit>,
) {
    cap.frame += 1;
    let Ok(mut cam) = cams.single_mut() else { return };

    if let Some(mut fly) = cap.fly.take() {
        fly.at += 1;
        let t = fly.at as f32 / fly.frames as f32;
        let s = t * t * (3.0 - 2.0 * t);
        cam.translation = fly.from.translation.lerp(fly.to.translation, s);
        cam.rotation = fly.from.rotation.slerp(fly.to.rotation, s);
        shoot(&mut commands, &cap, format!("{}/frame_{:04}", fly.name, fly.at), &cam);
        if fly.at >= fly.frames {
            cap.clips.lock().expect("clips lock").push((fly.name, fly.frames));
            drone.place(&cam);
        } else {
            cap.fly = Some(fly);
        }
        return;
    }
    if let Some(mut p) = cap.piloting.take() {
        p.at += 1;
        let d = &mut *drone;
        d.state.step(&d.cfg, Some(&ground.field), p.sticks, 1.0 / 60.0);
        *cam = d.camera();
        if let Some(clip) = &p.clip {
            shoot(&mut commands, &cap, format!("{clip}/frame_{:04}", p.at), &cam);
        }
        if p.at >= p.frames {
            if let Some(clip) = p.clip {
                cap.clips.lock().expect("clips lock").push((clip, p.frames));
            }
        } else {
            cap.piloting = Some(p);
        }
        return;
    }
    if cap.wait > 0 {
        cap.wait -= 1;
        return;
    }
    let Some(step) = cap.steps.steps.get(cap.next).cloned() else {
        // Done once every screenshot is on disk.
        if cap.pending.load(Ordering::SeqCst) == 0 {
            exit.write(AppExit::Success);
        }
        return;
    };
    cap.next += 1;
    let view = |name: &str| {
        let v = ground.island.view(name).unwrap_or_else(|| panic!("no view `{name}` on this island"));
        crate::look(v.pos, v.look_at)
    };
    match step {
        Step::View(name) => {
            *cam = view(&name);
            drone.place(&cam);
        }
        Step::Camera { pos, look_at } => {
            *cam = crate::look(pos, look_at);
            drone.place(&cam);
        }
        Step::Drone { frames, sticks, mode, clip } => {
            if let Some(m) = mode {
                drone.state.mode = drone.cfg.mode(&m).unwrap_or_else(|| panic!("no flight mode `{m}` in drone.json"));
            }
            if let Some(c) = &clip {
                std::fs::create_dir_all(cap.out.join(c)).expect("create clip folder");
            }
            cap.piloting = Some(Piloting { sticks, frames: frames.max(1), at: 0, clip });
        }
        Step::Wait(frames) => cap.wait = frames,
        Step::Shot(name) => {
            shoot(&mut commands, &cap, name, &cam);
            // One frame for the shot to be taken before the camera moves again.
            cap.wait = 1;
        }
        Step::Fly { name, to, frames } => {
            std::fs::create_dir_all(cap.out.join(&name)).expect("create clip folder");
            cap.fly = Some(Fly { name, from: *cam, to: view(&to), frames: frames.max(1), at: 0 });
        }
        Step::State => {
            let p = cam.translation;
            let ground_m = ground.field.height(p.x, p.z);
            let f = cam.forward();
            println!(
                "{}",
                serde_json::json!({
                    "frame": cap.frame,
                    "camera": { "pos": [p.x, p.y, p.z], "forward": [f.x, f.y, f.z] },
                    "ground_m": ground_m,
                    "altitude_m": p.y - ground_m,
                    "over_land": ground.field.contains(p.x, p.z) && ground_m > 0.5,
                    "drone": {
                        "mode": drone.cfg.modes[drone.state.mode].name,
                        "speed_mps": drone.state.speed(),
                        "vel": drone.state.vel,
                        "heading_deg": drone.state.yaw.to_degrees(),
                        "gimbal_deg": drone.state.gimbal.to_degrees(),
                    },
                })
            );
        }
    }
}
