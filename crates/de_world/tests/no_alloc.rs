//! Steady frames allocate nothing: the world code the client runs every frame (drone flight,
//! ground height, cloud density) must not touch the heap once it is set up, since heap work in
//! the frame loop shows up as hitches in frame pacing (content/budget.json, priority 2).
//!
//! `stats_alloc` counts every allocation through the global allocator; this file holds one test,
//! so nothing else runs while it counts.

use std::alloc::System;

use de_world::{DroneConfig, DroneState, Island, Sticks, clouds};
use stats_alloc::{INSTRUMENTED_SYSTEM, Region, StatsAlloc};

#[global_allocator]
static GLOBAL: &StatsAlloc<System> = &INSTRUMENTED_SYSTEM;

/// Heap allocations (and reallocations) made while `f` runs.
fn allocations(f: impl FnOnce()) -> usize {
    let region = Region::new(GLOBAL);
    f();
    let c = region.change();
    c.allocations + c.reallocations
}

#[test]
fn a_second_of_frames_allocates_nothing() {
    let content = de_world::content_dir();
    let id = de_world::island_ids(&content).into_iter().next().expect("an island");
    let island = Island::load(&content, &id).expect("island loads");
    let field = island.heightfield(&content, &id).expect("heightfield loads");
    let cfg = DroneConfig::load(&content).expect("drone.json loads");
    let view = &island.views[0];
    let mut drone = DroneState::looking(view.pos, view.look_at, 7);
    let noise = clouds::Noise::new(clouds::seed(&id));
    let look = &island.look.clouds;
    let sticks = [
        Sticks { pitch: 1.0, ..Default::default() },
        Sticks { yaw: 0.6, throttle: 0.4, ..Default::default() },
        Sticks::default(),
    ];

    // Warm up once outside the count, as a real frame loop would after its first frame.
    drone.step(&cfg, Some(&field), sticks[0], 1.0 / 60.0);

    let mut sink = 0.0f32;
    let n = allocations(|| {
        for frame in 0..60 {
            drone.step(&cfg, Some(&field), sticks[frame / 20], 1.0 / 60.0);
            sink += field.height(drone.pos[0], drone.pos[2]);
            sink += look.density_at(&noise, drone.pos, frame as f32 / 60.0);
        }
    });
    assert!(sink.is_finite());
    assert_eq!(n, 0, "{n} heap allocations in 60 frames of drone flight, ground and cloud sampling");
}
