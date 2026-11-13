//! A camera drone you fly like a real consumer drone in its stabilised mode.
//!
//! Sticks are mode 2, the default on handheld drone controllers and on VR controllers'
//! thumbsticks: the left stick climbs and yaws, the right stick flies forward, back and
//! sideways. Let go and the drone brakes and holds its position, as GPS-assisted drones do.
//! The camera hangs on a gimbal that keeps the horizon level; a separate input tilts it.
//!
//! Everything here is plain arithmetic on a fixed time step with wind from `forge_core::Rng`,
//! so the same inputs give the same flight, in tests, in captures and in the game.

use forge_core::Rng;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{Heightfield, Vec3};

/// Stick positions, each -1..1. Mode 2: `throttle` and `yaw` on the left stick, `pitch` and
/// `roll` on the right. `gimbal` tilts the camera (+ up, - down).
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(default, deny_unknown_fields)]
pub struct Sticks {
    /// Climb (+) or descend (-).
    pub throttle: f32,
    /// Turn right (+) or left (-).
    pub yaw: f32,
    /// Fly forward (+) or back (-).
    pub pitch: f32,
    /// Fly right (+) or left (-).
    pub roll: f32,
    /// Tilt the camera up (+) or down (-).
    pub gimbal: f32,
}

impl Sticks {
    /// Each stick clamped to -1..1, with a small dead zone so a resting thumbstick holds still.
    pub fn cleaned(self, dead_zone: f32) -> Self {
        let c = |v: f32| {
            let v = v.clamp(-1.0, 1.0);
            if v.abs() <= dead_zone { 0.0 } else { (v.abs() - dead_zone) / (1.0 - dead_zone) * v.signum() }
        };
        Self {
            throttle: c(self.throttle),
            yaw: c(self.yaw),
            pitch: c(self.pitch),
            roll: c(self.roll),
            gimbal: c(self.gimbal),
        }
    }
}

/// How one flight mode handles (`content/drone.json`, `de schema drone`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct FlightMode {
    pub name: String,
    /// Top speed over ground, m/s.
    pub max_speed: f32,
    /// Top climb and descent speed, m/s.
    pub max_climb: f32,
    /// Top turn rate, degrees per second.
    pub max_yaw_deg: f32,
    /// How fast speed builds towards what the sticks ask, m/s².
    pub accel: f32,
    /// How fast it brakes when the sticks centre, m/s².
    pub brake: f32,
    /// How fast the turn rate follows the stick, degrees/s².
    pub yaw_accel_deg: f32,
    /// Stick response curve: 1 is linear, higher makes small stick moves gentler.
    pub expo: f32,
    /// How far the view rolls into a sideways move, degrees per m/s² of sideways acceleration.
    pub bank_deg: f32,
}

/// The whole drone (`content/drone.json`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DroneConfig {
    /// Flight modes, slowest first. The first is the one you take off in.
    pub modes: Vec<FlightMode>,
    /// Lowest the drone flies above ground or sea, metres.
    pub min_clearance_m: f32,
    /// Highest it flies above sea level, metres.
    pub max_altitude_m: f32,
    /// Gimbal tilt range, degrees (down is negative).
    pub gimbal_range_deg: [f32; 2],
    /// Gimbal tilt speed at full stick, degrees per second.
    pub gimbal_speed_deg: f32,
    /// Stick dead zone, 0..1.
    pub dead_zone: f32,
    /// Typical wind speed, m/s; gusts wander around it.
    pub wind_mps: f32,
    /// How strongly the drone holds against wind (0 drifts freely, 1 never drifts).
    pub wind_hold: f32,
}

impl DroneConfig {
    pub fn load(content: &std::path::Path) -> Result<Self, String> {
        let path = content.join("drone.json");
        let text = std::fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
        serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))
    }

    pub fn mode(&self, name: &str) -> Option<usize> {
        self.modes.iter().position(|m| m.name == name)
    }

    /// Problems as readable lines; empty means valid.
    pub fn check(&self) -> Vec<String> {
        let mut out = Vec::new();
        if self.modes.is_empty() {
            out.push("drone.json: no flight modes".into());
        }
        for m in &self.modes {
            for (field, v) in [
                ("max_speed", m.max_speed),
                ("max_climb", m.max_climb),
                ("max_yaw_deg", m.max_yaw_deg),
                ("accel", m.accel),
                ("brake", m.brake),
                ("yaw_accel_deg", m.yaw_accel_deg),
                ("expo", m.expo),
            ] {
                if v <= 0.0 {
                    out.push(format!("drone.json: mode `{}` {field} must be above 0, is {v}", m.name));
                }
            }
        }
        if self.gimbal_range_deg[0] >= self.gimbal_range_deg[1] {
            out.push("drone.json: gimbal_range_deg must be [low, high] with low < high".into());
        }
        if !(0.0..1.0).contains(&self.dead_zone) {
            out.push("drone.json: dead_zone must be in 0..1".into());
        }
        out
    }
}

/// Where the drone is and how it is moving.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct DroneState {
    /// World metres: x east, y up, z south.
    pub pos: Vec3,
    /// Velocity over ground, m/s.
    pub vel: Vec3,
    /// Heading in radians: 0 faces north (-Z), and it grows clockwise seen from above (east is +π/2).
    pub yaw: f32,
    /// Current turn rate, rad/s.
    pub yaw_rate: f32,
    /// Camera tilt in radians (down is negative).
    pub gimbal: f32,
    /// View roll in radians from banking into sideways moves.
    pub bank: f32,
    /// Index into `DroneConfig::modes`.
    pub mode: usize,
    /// Wind now and the gust it is drifting towards, m/s (x, z).
    pub wind: [f32; 2],
    wind_target: [f32; 2],
    gust_left: f32,
    rng: Rng,
}

impl DroneState {
    /// A hovering drone at `pos` looking at `look_at`, in the first flight mode.
    pub fn looking(pos: Vec3, look_at: Vec3, seed: u32) -> Self {
        let d = [look_at[0] - pos[0], look_at[1] - pos[1], look_at[2] - pos[2]];
        let flat = (d[0] * d[0] + d[2] * d[2]).sqrt().max(1e-6);
        Self {
            pos,
            vel: [0.0; 3],
            yaw: d[0].atan2(-d[2]),
            yaw_rate: 0.0,
            gimbal: d[1].atan2(flat),
            bank: 0.0,
            mode: 0,
            wind: [0.0; 2],
            wind_target: [0.0; 2],
            gust_left: 0.0,
            rng: Rng::new(seed),
        }
    }

    /// Unit vector the drone faces, flat (x, z).
    pub fn forward(&self) -> [f32; 2] {
        [self.yaw.sin(), -self.yaw.cos()]
    }

    /// Unit vector to the drone's right, flat (x, z).
    pub fn right(&self) -> [f32; 2] {
        [self.yaw.cos(), self.yaw.sin()]
    }

    /// Speed over ground, m/s.
    pub fn speed(&self) -> f32 {
        (self.vel[0] * self.vel[0] + self.vel[2] * self.vel[2]).sqrt()
    }

    /// Advance by `dt` seconds with the given sticks.
    pub fn step(&mut self, cfg: &DroneConfig, ground: Option<&Heightfield>, sticks: Sticks, dt: f32) {
        let s = sticks.cleaned(cfg.dead_zone);
        let m = &cfg.modes[self.mode.min(cfg.modes.len() - 1)];
        let curve = |v: f32| v.abs().powf(m.expo) * v.signum();

        // Turn: the rate eases towards what the stick asks.
        let want_yaw = curve(s.yaw) * m.max_yaw_deg.to_radians();
        self.yaw_rate = approach(self.yaw_rate, want_yaw, m.yaw_accel_deg.to_radians() * dt);
        self.yaw = wrap(self.yaw + self.yaw_rate * dt);

        // Move: velocity eases towards the stick's target; centred sticks brake.
        let (f, r) = (self.forward(), self.right());
        let (fw, rt) = (curve(s.pitch) * m.max_speed, curve(s.roll) * m.max_speed);
        let mut want = [f[0] * fw + r[0] * rt, curve(s.throttle) * m.max_climb, f[1] * fw + r[1] * rt];
        let flat = (want[0] * want[0] + want[2] * want[2]).sqrt();
        if flat > m.max_speed {
            want[0] *= m.max_speed / flat;
            want[2] *= m.max_speed / flat;
        }
        let before = self.vel;
        let h_rate = if fw == 0.0 && rt == 0.0 { m.brake } else { m.accel };
        let v_rate = if s.throttle == 0.0 { m.brake } else { m.accel };
        let (vx, vz) = approach2([self.vel[0], self.vel[2]], [want[0], want[2]], h_rate * dt);
        self.vel = [vx, approach(self.vel[1], want[1], v_rate * dt), vz];

        // Wind: gusts wander every few seconds; the drone holds against most of it.
        self.gust_left -= dt;
        if self.gust_left <= 0.0 {
            let ang = self.rng.next_f64() as f32 * std::f32::consts::TAU;
            let strength = cfg.wind_mps * (0.5 + self.rng.next_f64() as f32);
            self.wind_target = [ang.cos() * strength, ang.sin() * strength];
            self.gust_left = 2.0 + self.rng.next_f64() as f32 * 3.0;
        }
        let k = (dt * 0.6).min(1.0);
        self.wind[0] += (self.wind_target[0] - self.wind[0]) * k;
        self.wind[1] += (self.wind_target[1] - self.wind[1]) * k;
        let drift = 1.0 - cfg.wind_hold.clamp(0.0, 1.0);

        for i in 0..3 {
            self.pos[i] += self.vel[i] * dt;
        }
        self.pos[0] += self.wind[0] * drift * dt;
        self.pos[2] += self.wind[1] * drift * dt;

        // Bank the view a little into sideways acceleration, like a gimbal that lags.
        let side_accel = ((self.vel[0] - before[0]) * r[0] + (self.vel[2] - before[2]) * r[1]) / dt.max(1e-6);
        let want_bank = (side_accel * m.bank_deg).to_radians().clamp(-0.12, 0.12);
        self.bank += (want_bank - self.bank) * (dt * 6.0).min(1.0);

        // Gimbal.
        let [lo, hi] = cfg.gimbal_range_deg;
        self.gimbal =
            (self.gimbal + s.gimbal * cfg.gimbal_speed_deg.to_radians() * dt).clamp(lo.to_radians(), hi.to_radians());

        // Never into the ground or the sea, never above the ceiling.
        let floor = ground.map_or(0.0, |g| g.height(self.pos[0], self.pos[2]).max(0.0)) + cfg.min_clearance_m;
        if self.pos[1] < floor {
            self.pos[1] = floor;
            self.vel[1] = self.vel[1].max(0.0);
        }
        if self.pos[1] > cfg.max_altitude_m {
            self.pos[1] = cfg.max_altitude_m;
            self.vel[1] = self.vel[1].min(0.0);
        }
    }
}

fn approach(v: f32, target: f32, max_step: f32) -> f32 {
    v + (target - v).clamp(-max_step, max_step)
}

fn approach2(v: [f32; 2], target: [f32; 2], max_step: f32) -> (f32, f32) {
    let d = [target[0] - v[0], target[1] - v[1]];
    let len = (d[0] * d[0] + d[1] * d[1]).sqrt();
    if len <= max_step { (target[0], target[1]) } else { (v[0] + d[0] / len * max_step, v[1] + d[1] / len * max_step) }
}

fn wrap(a: f32) -> f32 {
    let t = std::f32::consts::TAU;
    (a + std::f32::consts::PI).rem_euclid(t) - std::f32::consts::PI
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> DroneConfig {
        serde_json::from_str(include_str!("../../../content/drone.json")).unwrap()
    }

    fn fly(d: &mut DroneState, c: &DroneConfig, sticks: Sticks, secs: f32) {
        for _ in 0..(secs * 60.0) as usize {
            d.step(c, None, sticks, 1.0 / 60.0);
        }
    }

    #[test]
    fn shipped_config_is_valid() {
        assert!(cfg().check().is_empty(), "{:?}", cfg().check());
    }

    #[test]
    fn faces_what_it_looks_at() {
        let d = DroneState::looking([0.0, 100.0, 0.0], [100.0, 100.0, 0.0], 1);
        let f = d.forward();
        assert!((f[0] - 1.0).abs() < 1e-5 && f[1].abs() < 1e-5, "{f:?}");
        let r = d.right();
        assert!(r[0].abs() < 1e-5 && (r[1] - 1.0).abs() < 1e-5, "east-facing: right is south, {r:?}");
    }

    #[test]
    fn full_stick_reaches_top_speed_and_no_more() {
        let c = cfg();
        let mut d = DroneState::looking([0.0, 200.0, 0.0], [0.0, 200.0, -10.0], 1);
        fly(&mut d, &c, Sticks { pitch: 1.0, ..default() }, 10.0);
        let top = c.modes[0].max_speed;
        assert!((d.speed() - top).abs() < 0.01, "{} vs {top}", d.speed());
        assert!(d.vel[2] < 0.0, "forward is north");
    }

    #[test]
    fn centred_sticks_brake_to_a_hover() {
        let c = cfg();
        let mut d = DroneState::looking([0.0, 200.0, 0.0], [0.0, 200.0, -10.0], 1);
        fly(&mut d, &c, Sticks { pitch: 1.0, roll: 1.0, throttle: 1.0, ..default() }, 5.0);
        fly(&mut d, &c, Sticks::default(), 5.0);
        assert!(d.speed() < 1e-3 && d.vel[1].abs() < 1e-3, "{:?}", d.vel);
    }

    #[test]
    fn sport_is_faster_than_cine() {
        let c = cfg();
        let top = |mode: &str| {
            let mut d = DroneState::looking([0.0, 200.0, 0.0], [0.0, 200.0, -10.0], 1);
            d.mode = c.mode(mode).unwrap();
            fly(&mut d, &c, Sticks { pitch: 1.0, ..default() }, 2.0);
            d.speed()
        };
        assert!(top("sport") > top("normal") && top("normal") > top("cine"));
    }

    #[test]
    fn small_stick_moves_are_gentle() {
        let c = cfg();
        let mut d = DroneState::looking([0.0, 200.0, 0.0], [0.0, 200.0, -10.0], 1);
        fly(&mut d, &c, Sticks { pitch: 0.3, ..default() }, 10.0);
        assert!(d.speed() < 0.3 * c.modes[0].max_speed, "expo curve: {}", d.speed());
    }

    #[test]
    fn dead_zone_holds_still() {
        let c = cfg();
        let mut d = DroneState::looking([0.0, 200.0, 0.0], [0.0, 200.0, -10.0], 1);
        let mut calm = c.clone();
        calm.wind_mps = 0.0;
        fly(&mut d, &calm, Sticks { pitch: calm.dead_zone * 0.9, yaw: -calm.dead_zone * 0.5, ..default() }, 3.0);
        assert_eq!(d.pos, [0.0, 200.0, 0.0]);
    }

    #[test]
    fn yaw_turns_clockwise() {
        let c = cfg();
        let mut d = DroneState::looking([0.0, 200.0, 0.0], [0.0, 200.0, -10.0], 1);
        fly(&mut d, &c, Sticks { yaw: 1.0, ..default() }, 0.5);
        assert!(d.forward()[0] > 0.0, "turning right from north heads east");
    }

    #[test]
    fn never_below_clearance() {
        let c = cfg();
        let ground = Heightfield { width: 2, depth: 2, spacing: [1000.0, 1000.0], heights: vec![50.0; 4] };
        let mut d = DroneState::looking([0.0, 80.0, 0.0], [0.0, 0.0, -10.0], 1);
        for _ in 0..60 * 30 {
            d.step(&c, Some(&ground), Sticks { throttle: -1.0, ..default() }, 1.0 / 60.0);
        }
        assert!((d.pos[1] - (50.0 + c.min_clearance_m)).abs() < 1e-3, "{}", d.pos[1]);
    }

    #[test]
    fn gimbal_stays_in_range() {
        let c = cfg();
        let mut d = DroneState::looking([0.0, 200.0, 0.0], [0.0, 200.0, -10.0], 1);
        fly(&mut d, &c, Sticks { gimbal: -1.0, ..default() }, 10.0);
        assert!((d.gimbal.to_degrees() - c.gimbal_range_deg[0]).abs() < 1e-3);
    }

    #[test]
    fn same_inputs_same_flight() {
        let c = cfg();
        let run = || {
            let mut d = DroneState::looking([0.0, 200.0, 0.0], [0.0, 200.0, -10.0], 7);
            fly(&mut d, &c, Sticks { pitch: 0.7, yaw: 0.4, throttle: 0.2, ..default() }, 8.0);
            d
        };
        assert_eq!(run(), run());
    }

    fn default() -> Sticks {
        Sticks::default()
    }
}
