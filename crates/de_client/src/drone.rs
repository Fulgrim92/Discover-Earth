//! The drone the player flies, and the camera on its gimbal.
//!
//! Controls (mode 2, as on drone remotes and VR controller thumbsticks):
//!
//! | Input | Gamepad | Keyboard and mouse |
//! | --- | --- | --- |
//! | Climb / descend | left stick up / down | Space / C |
//! | Turn | left stick left / right | Q / E, or drag with the right mouse button |
//! | Forward / back | right stick up / down | W / S |
//! | Sideways | right stick left / right | A / D |
//! | Tilt camera | right trigger up, left trigger down | R / F, or drag with the right mouse button |
//! | Flight mode | right bumper faster, left bumper slower | 1 cine, 2 normal, 3 sport |
//!
//! The flight itself is `de_world::DroneState`, the same code captures and tests fly.

use bevy::{input::mouse::AccumulatedMouseMotion, prelude::*};
use de_world::{DroneConfig, DroneState, Sticks};

use crate::scene::{CameraRig, Ground, IslandSource};

/// The drone, its tuning and the sticks it last read.
#[derive(Resource, Clone, Debug)]
pub struct Drone {
    pub cfg: DroneConfig,
    pub state: DroneState,
    pub sticks: Sticks,
}

impl Drone {
    /// Put the drone where a camera transform is, hovering, keeping its mode.
    pub fn place(&mut self, t: &Transform) {
        let ahead = t.translation + t.forward().as_vec3();
        let mode = self.state.mode;
        self.state = DroneState::looking(t.translation.into(), ahead.into(), seed(&self.state));
        self.state.mode = mode;
    }

    /// The camera's transform for the drone's current state.
    pub fn camera(&self) -> Transform {
        let s = &self.state;
        Transform::from_translation(Vec3::from(s.pos)).with_rotation(Quat::from_euler(
            EulerRot::YXZ,
            -s.yaw,
            s.gimbal,
            -s.bank,
        ))
    }
}

fn seed(s: &DroneState) -> u32 {
    s.pos.iter().fold(0x9e37_79b9u32, |a, v| a.rotate_left(5) ^ v.to_bits())
}

/// Sets up the drone at the island's first view. Shared by the game and captures.
pub struct DronePlugin;

impl Plugin for DronePlugin {
    fn build(&self, app: &mut App) {
        app.add_systems(PostStartup, spawn_drone);
    }
}

fn spawn_drone(mut commands: Commands, source: Res<IslandSource>, cams: Query<&Transform, With<CameraRig>>) {
    let cfg = DroneConfig::load(&source.content).unwrap_or_else(|e| panic!("{e}"));
    let t = cams.single().copied().unwrap_or_default();
    let mut drone = Drone { state: DroneState::looking([0.0; 3], [0.0, 0.0, -1.0], 1), cfg, sticks: Sticks::default() };
    drone.place(&t);
    commands.insert_resource(drone);
}

/// Reads the player's controls and flies the drone each frame (the window game only).
pub struct PilotPlugin;

impl Plugin for PilotPlugin {
    fn build(&self, app: &mut App) {
        app.add_plugins(DronePlugin)
            .add_systems(Update, (read_sticks, fly, hud).chain().run_if(resource_exists::<Drone>))
            .add_systems(Startup, spawn_hud);
    }
}

fn read_sticks(
    keys: Res<ButtonInput<KeyCode>>,
    buttons: Res<ButtonInput<MouseButton>>,
    motion: Res<AccumulatedMouseMotion>,
    pads: Query<&Gamepad>,
    mut drone: ResMut<Drone>,
) {
    let key = |k: KeyCode| if keys.pressed(k) { 1.0 } else { 0.0 };
    let mut s = Sticks {
        throttle: key(KeyCode::Space) - key(KeyCode::KeyC),
        yaw: key(KeyCode::KeyE) - key(KeyCode::KeyQ),
        pitch: key(KeyCode::KeyW) - key(KeyCode::KeyS),
        roll: key(KeyCode::KeyD) - key(KeyCode::KeyA),
        gimbal: key(KeyCode::KeyR) - key(KeyCode::KeyF),
    };
    if buttons.pressed(MouseButton::Right) {
        s.yaw += motion.delta.x * 0.05;
        s.gimbal -= motion.delta.y * 0.05;
    }
    let modes = drone.cfg.modes.len();
    for (i, k) in [KeyCode::Digit1, KeyCode::Digit2, KeyCode::Digit3].into_iter().enumerate() {
        if keys.just_pressed(k) && i < modes {
            drone.state.mode = i;
        }
    }
    for pad in &pads {
        let (l, r) = (pad.left_stick(), pad.right_stick());
        s.throttle += l.y;
        s.yaw += l.x;
        s.pitch += r.y;
        s.roll += r.x;
        let trig = |b| pad.get(b).unwrap_or(0.0);
        s.gimbal += trig(GamepadButton::RightTrigger2) - trig(GamepadButton::LeftTrigger2);
        if pad.just_pressed(GamepadButton::RightTrigger) {
            drone.state.mode = (drone.state.mode + 1).min(modes - 1);
        }
        if pad.just_pressed(GamepadButton::LeftTrigger) {
            drone.state.mode = drone.state.mode.saturating_sub(1);
        }
    }
    drone.sticks = s;
}

fn fly(
    time: Res<Time>,
    ground: Option<Res<Ground>>,
    mut drone: ResMut<Drone>,
    mut cams: Query<&mut Transform, With<CameraRig>>,
) {
    // Fixed slices of at most 1/60 s, so a slow frame flies the same path as fast ones.
    let mut left = time.delta_secs().min(0.25);
    let drone = &mut *drone;
    while left > 0.0 {
        let dt = left.min(1.0 / 60.0);
        drone.state.step(&drone.cfg, ground.as_deref().map(|g| &g.field), drone.sticks, dt);
        left -= dt;
    }
    if let Ok(mut t) = cams.single_mut() {
        *t = drone.camera();
    }
}

#[derive(Component)]
struct Hud;

fn spawn_hud(mut commands: Commands) {
    commands.spawn((
        Hud,
        Text::new(""),
        TextFont { font_size: bevy::text::FontSize::Px(16.0), ..default() },
        TextColor(Color::srgba(1.0, 1.0, 1.0, 0.85)),
        Node { position_type: PositionType::Absolute, left: px(16), bottom: px(14), ..default() },
    ));
}

fn hud(drone: Res<Drone>, ground: Option<Res<Ground>>, mut text: Query<&mut Text, With<Hud>>) {
    let Ok(mut text) = text.single_mut() else { return };
    let s = &drone.state;
    let agl = ground.map_or(s.pos[1], |g| s.pos[1] - g.field.height(s.pos[0], s.pos[2]).max(0.0));
    let heading = (s.yaw.to_degrees() + 360.0) % 360.0;
    text.0 = format!(
        "{}   {:>4.1} m/s   H {:>4.0} m   ALT {:>4.0} m   HDG {:>3.0}   GIMBAL {:>3.0}",
        drone.cfg.modes[s.mode].name.to_uppercase(),
        s.speed(),
        agl,
        s.pos[1],
        heading,
        s.gimbal.to_degrees()
    );
}
