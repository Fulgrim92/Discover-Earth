//! Step lists: what a headless capture does, frame by frame.
//!
//! `de-shot` (crates/de_client) plays one against the real 3D client at a fixed 60 frames a
//! second of game time, so the same list gives the same pixels on every run on one machine.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::island::Vec3;

/// A capture script (`content/shots/*.json`).
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct StepList {
    /// Island id under `content/islands/`.
    pub island: String,
    /// Frame size in pixels.
    #[serde(default = "default_size")]
    pub size: [u32; 2],
    pub steps: Vec<Step>,
}

fn default_size() -> [u32; 2] {
    [1280, 720]
}

/// One step. Exactly one key per object, e.g. `{"view": "valley"}` or `{"shot": "valley"}`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum Step {
    /// Jump the camera to a named view of the island.
    View(String),
    /// Jump the camera to a position, looking at a point. `fov_y_deg` changes the lens (vertical
    /// field of view) from then on; `roll_deg` turns the camera about its view direction
    /// (positive tips the right side down), e.g. to match a reference photo.
    Camera {
        pos: Vec3,
        look_at: Vec3,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        fov_y_deg: Option<f32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        roll_deg: Option<f32>,
    },
    /// Let this many frames of game time pass.
    Wait(u32),
    /// Save the next frame as `<out>/<name>.png`.
    Shot(String),
    /// Fly from the current camera to a view over `frames` frames (smoothstep), saving each
    /// frame and joining them into `<out>/<name>.mp4` at 30 fps (needs ffmpeg).
    Fly { name: String, to: String, frames: u32 },
    /// Fly the drone with these sticks held for `frames` frames (`de schema drone`), like a
    /// pilot would. With `mode` it first switches flight mode; with `clip` it saves every frame
    /// and `<out>/<clip>.mp4`. The camera starts from wherever the last step left it.
    Drone {
        frames: u32,
        #[serde(default)]
        sticks: crate::Sticks,
        #[serde(default)]
        mode: Option<String>,
        #[serde(default)]
        clip: Option<String>,
    },
    /// Print the camera, drone and ground height under it as one JSON line on stdout.
    State,
}

impl StepList {
    /// Flight modes the list asks for that `drone.json` lacks.
    pub fn missing_modes(&self, drone: &crate::DroneConfig) -> Vec<String> {
        self.steps
            .iter()
            .filter_map(|s| match s {
                Step::Drone { mode: Some(m), .. } if drone.mode(m).is_none() => Some(m.clone()),
                _ => None,
            })
            .collect()
    }

    /// Names of views the list uses that the island lacks.
    pub fn missing_views(&self, island: &crate::Island) -> Vec<String> {
        self.steps
            .iter()
            .filter_map(|s| match s {
                Step::View(v) | Step::Fly { to: v, .. } => Some(v),
                _ => None,
            })
            .filter(|v| island.view(v).is_none())
            .cloned()
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_one_key_steps() {
        let s: StepList = serde_json::from_str(
            r#"{"island":"x","steps":[{"view":"a"},{"wait":3},{"shot":"a"},{"fly":{"name":"f","to":"b","frames":60}},"state",{"drone":{"frames":10,"sticks":{"pitch":1},"mode":"sport"}}]}"#,
        )
        .unwrap();
        assert_eq!(s.size, [1280, 720]);
        assert_eq!(s.steps[1], Step::Wait(3));
        assert_eq!(s.steps[4], Step::State);
        assert!(matches!(&s.steps[5], Step::Drone { frames: 10, sticks, .. } if sticks.pitch == 1.0));
    }

    #[test]
    fn rejects_typos() {
        assert!(serde_json::from_str::<Step>(r#"{"shoot":"a"}"#).is_err());
    }
}
