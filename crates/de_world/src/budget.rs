//! The game's priorities and budgets as data (`content/budget.json`, `de schema budget`), and the
//! frame-time report `de-shot --bench` writes against them.
//!
//! The order of the priorities is the rule for every trade-off: look first, then stable frame
//! pacing on the reference machine, then a small build. Frame time is judged only on the
//! reference machine (its GPU and resolution), since numbers from another GPU or from the
//! software renderer in the cloud say nothing about it; the report still records them.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::path::Path;

/// `content/budget.json`.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Budget {
    /// What wins when two goals conflict, first first. Read before any trade-off.
    pub priorities: Vec<String>,
    /// The machine frame time is judged on.
    pub reference: Reference,
    /// Frame-time limits during a bench flight on the reference machine.
    pub frame: FrameBudget,
    /// Largest shipped content (`content/` without the calibration-only folders), MB.
    pub content_mb: f64,
    /// Folders under `content/` used only to calibrate the look (reference photos), not shipped.
    #[serde(default)]
    pub calibration_only: Vec<String>,
}

/// The reference machine.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Reference {
    /// Part of the GPU's adapter name as wgpu reports it, matched without case, e.g. "RX 6650 XT".
    pub gpu: String,
    /// Render size in pixels.
    pub size: [u32; 2],
    /// Display refresh rate the game should hold, Hz.
    pub refresh_hz: f64,
    /// Whether C has confirmed these numbers; until then a pass is provisional.
    #[serde(default)]
    pub confirmed: bool,
}

/// Limits for one bench flight, milliseconds.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct FrameBudget {
    /// Mean GPU time per frame.
    pub gpu_avg_ms: f64,
    /// No frame's GPU time over this (the frame interval at the refresh rate).
    pub gpu_max_ms: f64,
    /// 99th percentile of whole-frame time (CPU and waiting), which catches hitches such as
    /// allocations, asset loads and pipeline compiles.
    pub frame_p99_ms: f64,
}

impl Budget {
    pub fn load(content: &Path) -> Result<Self, String> {
        let path = content.join("budget.json");
        let text = std::fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
        serde_json::from_str(&text).map_err(|e| format!("{}: {e} (see `de schema budget`)", path.display()))
    }

    /// Problems a human should fix, one line each.
    pub fn check(&self) -> Vec<String> {
        let mut out = Vec::new();
        if self.priorities.is_empty() {
            out.push("budget.json: `priorities` is empty; list what wins a trade-off, first first".into());
        }
        let f = &self.frame;
        for (name, v) in [("gpu_avg_ms", f.gpu_avg_ms), ("gpu_max_ms", f.gpu_max_ms), ("frame_p99_ms", f.frame_p99_ms)]
        {
            if v.is_nan() || v <= 0.0 {
                out.push(format!("budget.json: frame.{name} is {v}; use a positive number of milliseconds"));
            }
        }
        if f.gpu_avg_ms > f.gpu_max_ms {
            out.push("budget.json: frame.gpu_avg_ms is above frame.gpu_max_ms; the mean can't exceed the limit".into());
        }
        if self.reference.refresh_hz <= 0.0 || self.reference.size.contains(&0) {
            out.push("budget.json: reference needs a size and a refresh_hz above 0".into());
        }
        out
    }

    /// Whether a bench on this adapter at this size can be judged against the budget.
    pub fn is_reference(&self, adapter: &str, size: [u32; 2]) -> bool {
        adapter.to_lowercase().contains(&self.reference.gpu.to_lowercase()) && size == self.reference.size
    }
}

/// Summary of one series of milliseconds.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Stats {
    pub n: usize,
    pub avg: f64,
    pub p50: f64,
    pub p99: f64,
    pub max: f64,
}

impl Stats {
    pub fn of(values: &[f64]) -> Self {
        if values.is_empty() {
            return Self::default();
        }
        let mut s = values.to_vec();
        s.sort_by(f64::total_cmp);
        let at = |q: f64| s[((s.len() - 1) as f64 * q).round() as usize];
        Self {
            n: s.len(),
            avg: s.iter().sum::<f64>() / s.len() as f64,
            p50: at(0.5),
            p99: at(0.99),
            max: s[s.len() - 1],
        }
    }
}

/// `<out>/bench.json`, written by `de-shot --bench`.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct BenchReport {
    pub steps: String,
    pub adapter: String,
    pub backend: String,
    pub size: [u32; 2],
    /// Frames left out at the start (pipeline compiles, first uploads).
    pub warmup_frames: usize,
    /// Whole-frame time, from one main-loop frame to the next.
    pub frame_ms: Stats,
    /// GPU time per frame from timestamp queries (sum of the top-level passes). Empty where the
    /// adapter has no timestamp queries.
    pub gpu_ms: Stats,
    /// Mean GPU time per pass, slowest first.
    pub passes: Vec<(String, f64)>,
    /// The frames over the GPU limit (index after warm-up, ms), at most 20.
    pub slow_frames: Vec<(usize, f64)>,
    pub verdict: Verdict,
}

/// How a bench went against the budget.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Verdict {
    /// Inside every limit on the reference machine.
    Pass,
    /// Over at least one limit on the reference machine; each line names it.
    Fail(Vec<String>),
    /// Not the reference GPU or size, or no GPU timings: recorded, not judged.
    NotJudged(String),
}

impl BenchReport {
    /// Fill in `slow_frames` and `verdict` from the samples and the budget.
    pub fn judge(&mut self, budget: &Budget, gpu: &[f64]) {
        let f = &budget.frame;
        self.slow_frames =
            gpu.iter().copied().enumerate().filter(|&(_, ms)| ms > f.gpu_max_ms).take(20).collect::<Vec<_>>();
        self.verdict = if !budget.is_reference(&self.adapter, self.size) {
            Verdict::NotJudged(format!(
                "reference is `{}` at {}x{}; this ran on `{}` at {}x{}",
                budget.reference.gpu,
                budget.reference.size[0],
                budget.reference.size[1],
                self.adapter,
                self.size[0],
                self.size[1]
            ))
        } else if self.gpu_ms.n == 0 {
            Verdict::NotJudged("no GPU timestamp queries on this adapter".into())
        } else {
            let mut over = Vec::new();
            if self.gpu_ms.avg > f.gpu_avg_ms {
                over.push(format!("GPU mean {:.2} ms over {:.2}", self.gpu_ms.avg, f.gpu_avg_ms));
            }
            if self.gpu_ms.max > f.gpu_max_ms {
                over.push(format!("GPU max {:.2} ms over {:.2}", self.gpu_ms.max, f.gpu_max_ms));
            }
            if self.frame_ms.p99 > f.frame_p99_ms {
                over.push(format!("frame p99 {:.2} ms over {:.2}", self.frame_ms.p99, f.frame_p99_ms));
            }
            if over.is_empty() { Verdict::Pass } else { Verdict::Fail(over) }
        }
    }
}

/// Bytes under `content/` by top-level folder (and `.` for loose files), sorted by name.
pub fn content_sizes(content: &Path) -> Vec<(String, u64)> {
    fn walk(p: &Path) -> u64 {
        match std::fs::metadata(p) {
            Ok(m) if m.is_dir() => std::fs::read_dir(p).into_iter().flatten().flatten().map(|e| walk(&e.path())).sum(),
            Ok(m) => m.len(),
            Err(_) => 0,
        }
    }
    let mut out = std::collections::BTreeMap::<String, u64>::new();
    for e in std::fs::read_dir(content).into_iter().flatten().flatten() {
        let p = e.path();
        let key = if p.is_dir() { e.file_name().to_string_lossy().into_owned() } else { ".".into() };
        *out.entry(key).or_default() += walk(&p);
    }
    out.into_iter().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn budget() -> Budget {
        Budget::load(&crate::content_dir()).expect("content/budget.json loads")
    }

    #[test]
    fn shipped_budget_is_sane() {
        let b = budget();
        assert_eq!(b.check(), Vec::<String>::new());
        assert_eq!(b.priorities.first().map(String::as_str), Some("visual quality"));
    }

    #[test]
    fn stats_pick_the_right_ranks() {
        let v: Vec<f64> = (1..=100).map(f64::from).collect();
        let s = Stats::of(&v);
        assert_eq!((s.n, s.p50.round(), s.p99, s.max), (100, 51.0, 99.0, 100.0));
        assert!((s.avg - 50.5).abs() < 1e-9);
        assert_eq!(Stats::of(&[]), Stats::default());
    }

    fn report(adapter: &str, size: [u32; 2], gpu: &[f64], frame: &[f64]) -> BenchReport {
        let b = budget();
        let mut r = BenchReport {
            steps: "x".into(),
            adapter: adapter.into(),
            backend: "vulkan".into(),
            size,
            warmup_frames: 0,
            frame_ms: Stats::of(frame),
            gpu_ms: Stats::of(gpu),
            passes: vec![],
            slow_frames: vec![],
            verdict: Verdict::Pass,
        };
        r.judge(&b, gpu);
        r
    }

    #[test]
    fn judges_only_on_the_reference_machine() {
        let b = budget();
        let size = b.reference.size;
        let gpu = format!("AMD Radeon {} (RADV NAVI23)", b.reference.gpu);
        let fast = vec![b.frame.gpu_avg_ms * 0.5; 200];
        assert_eq!(report(&gpu, size, &fast, &fast).verdict, Verdict::Pass);

        let mut slow = fast.clone();
        slow[7] = b.frame.gpu_max_ms * 2.0;
        let r = report(&gpu, size, &slow, &fast);
        assert!(matches!(&r.verdict, Verdict::Fail(v) if v.len() == 1 && v[0].contains("GPU max")), "{:?}", r.verdict);
        assert_eq!(r.slow_frames, vec![(7, b.frame.gpu_max_ms * 2.0)]);

        assert!(matches!(report("llvmpipe (LLVM 19)", size, &slow, &fast).verdict, Verdict::NotJudged(_)));
        assert!(matches!(report(&gpu, [1280, 720], &slow, &fast).verdict, Verdict::NotJudged(_)));
        assert!(matches!(report(&gpu, size, &[], &fast).verdict, Verdict::NotJudged(_)));
    }

    #[test]
    fn shipped_content_fits_its_size_budget() {
        let content = crate::content_dir();
        let b = budget();
        let shipped: u64 =
            content_sizes(&content).into_iter().filter(|(k, _)| !b.calibration_only.contains(k)).map(|(_, v)| v).sum();
        let mb = shipped as f64 / 1e6;
        assert!(mb <= b.content_mb, "shipped content is {mb:.1} MB, budget {} MB", b.content_mb);
    }
}
