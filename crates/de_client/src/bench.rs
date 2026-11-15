//! Frame timing for `de-shot --bench`: whole-frame time from one main-loop frame to the next,
//! GPU time per pass from timestamp queries (Bevy's render diagnostics), and heap allocations
//! per frame where the binary counts them. `de-shot` turns the log into `bench.json` against
//! `content/budget.json` (see [`de_world::budget`]).

use std::{
    collections::{BTreeMap, HashMap},
    sync::{Arc, Mutex},
    time::Instant,
};

use bevy::{diagnostic::DiagnosticsStore, prelude::*, render::renderer::RenderAdapterInfo};

/// What a bench run saw, frame by frame. Shared, so `de-shot` can read it after the app exits.
#[derive(Default, Debug)]
pub struct BenchLog {
    pub adapter: String,
    pub backend: String,
    pub frame_ms: Vec<f64>,
    /// Sum of the top-level passes' GPU time, one entry per frame whose timings arrived.
    pub gpu_ms: Vec<f64>,
    /// Per pass: (total ms, frames).
    pub passes: BTreeMap<String, (f64, usize)>,
    /// Heap allocations per frame (empty unless the binary installs a counter).
    pub allocs: Vec<u64>,
}

/// Records into `log` every frame. `allocs` reads a running allocation count, if any.
pub struct BenchPlugin {
    pub log: Arc<Mutex<BenchLog>>,
    pub allocs: Option<fn() -> u64>,
}

#[derive(Resource, Clone)]
struct Shared(Arc<Mutex<BenchLog>>, Option<fn() -> u64>);

impl Plugin for BenchPlugin {
    fn build(&self, app: &mut App) {
        app.add_plugins(bevy::render::diagnostic::RenderDiagnosticsPlugin)
            .insert_resource(Shared(self.log.clone(), self.allocs))
            .add_systems(Last, record);
    }
}

#[derive(Default)]
struct Seen {
    last: Option<Instant>,
    allocs: u64,
    gpu: HashMap<String, Instant>,
}

fn record(
    shared: Res<Shared>,
    store: Res<DiagnosticsStore>,
    info: Option<Res<RenderAdapterInfo>>,
    mut seen: Local<Seen>,
) {
    let now = Instant::now();
    let mut log = shared.0.lock().expect("bench log");
    if log.adapter.is_empty()
        && let Some(info) = info
    {
        log.adapter = info.name.clone();
        log.backend = format!("{:?}", info.backend).to_lowercase();
    }
    if let Some(last) = seen.last {
        log.frame_ms.push((now - last).as_secs_f64() * 1000.0);
        if let Some(count) = shared.1 {
            let c = count();
            log.allocs.push(c - seen.allocs);
            seen.allocs = c;
        }
    } else if let Some(count) = shared.1 {
        seen.allocs = count();
    }
    seen.last = Some(now);

    // GPU timings arrive a frame or two late; take each pass's newest measurement once.
    let mut total = 0.0;
    let mut fresh = false;
    for d in store.iter() {
        let parts: Vec<&str> = d.path().components().collect();
        if parts.first() != Some(&"render") || parts.last() != Some(&"elapsed_gpu") {
            continue;
        }
        let Some(m) = d.measurement() else { continue };
        let key = parts[1..parts.len() - 1].join("/");
        if seen.gpu.get(&key) == Some(&m.time) {
            continue;
        }
        seen.gpu.insert(key.clone(), m.time);
        let e = log.passes.entry(key).or_default();
        e.0 += m.value;
        e.1 += 1;
        if parts.len() == 3 {
            total += m.value;
            fresh = true;
        }
    }
    if fresh {
        log.gpu_ms.push(total);
    }
}
