//! The player's camera in the window: fly with WASD, Q/E down/up, drag with the right mouse
//! button to look, Shift to go fast. The camera never goes below the ground.

use bevy::{input::mouse::AccumulatedMouseMotion, prelude::*};

use crate::scene::{CameraRig, Ground};

pub struct FlyPlugin;

impl Plugin for FlyPlugin {
    fn build(&self, app: &mut App) {
        app.add_systems(Update, fly);
    }
}

fn fly(
    time: Res<Time>,
    keys: Res<ButtonInput<KeyCode>>,
    buttons: Res<ButtonInput<MouseButton>>,
    motion: Res<AccumulatedMouseMotion>,
    ground: Option<Res<Ground>>,
    mut cams: Query<&mut Transform, With<CameraRig>>,
) {
    let Ok(mut t) = cams.single_mut() else { return };
    if buttons.pressed(MouseButton::Right) && motion.delta != Vec2::ZERO {
        let (mut yaw, mut pitch, _) = t.rotation.to_euler(EulerRot::YXZ);
        yaw -= motion.delta.x * 0.003;
        pitch = (pitch - motion.delta.y * 0.003).clamp(-1.5, 1.5);
        t.rotation = Quat::from_euler(EulerRot::YXZ, yaw, pitch, 0.0);
    }
    let mut dir = Vec3::ZERO;
    let (fwd, right) = (t.forward().as_vec3(), t.right().as_vec3());
    for (key, v) in [
        (KeyCode::KeyW, fwd),
        (KeyCode::KeyS, -fwd),
        (KeyCode::KeyD, right),
        (KeyCode::KeyA, -right),
        (KeyCode::KeyE, Vec3::Y),
        (KeyCode::KeyQ, -Vec3::Y),
    ] {
        if keys.pressed(key) {
            dir += v;
        }
    }
    let speed = if keys.pressed(KeyCode::ShiftLeft) { 900.0 } else { 120.0 };
    t.translation += dir.normalize_or_zero() * speed * time.delta_secs();
    if let Some(g) = ground {
        let floor = g.field.height(t.translation.x, t.translation.z).max(crate::scene::SEA_LEVEL_M) + 2.0;
        t.translation.y = t.translation.y.max(floor);
    }
}
