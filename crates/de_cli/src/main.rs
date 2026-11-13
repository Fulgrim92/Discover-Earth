//! `de`: Discover Earth's command line, the first thing an agent runs.
//!
//!   de capabilities [prefix] [--json]   what the engine and game can do
//!   de schema terrain|steps|drone       JSON schema for a content file
//!   de validate                         check every island, drone.json and step list
//!   de islands                          list islands with size and views
//!   de sense <dir>                      rebuild sensor packs and clip reports for a capture
//!   de sweep <view> --set a.b=1,2,3     render a view over values and lay them out as one sheet
//!   de compare <ref-dir> <dir>          perceptual difference (FLIP) per shot, with heatmaps
//!   de taste --sheet .. --pick ..       record a look decision in docs/taste.jsonl

mod compare;
mod sweep;

use std::{
    path::{Path, PathBuf},
    process::ExitCode,
};

use clap::{Parser, Subcommand, ValueEnum};
use de_world::{DroneConfig, Island, StepList, WorldModule};
use forge_core::{ForgeApp, headless_app};

#[derive(Parser)]
#[command(name = "de", about = "Discover Earth: the command line for people and agents")]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// List capabilities, optionally only ids starting with a prefix (e.g. `world.steps.`).
    Capabilities {
        prefix: Option<String>,
        #[arg(long)]
        json: bool,
    },
    /// Print a JSON schema.
    Schema { kind: SchemaKind },
    /// Validate every island and every step list under content/. Exit 1 on any problem.
    Validate,
    /// List islands.
    Islands,
    /// Rebuild sensor packs and clip reports for a capture folder (de-shot does this itself).
    Sense {
        /// The folder de-shot wrote (with shots.json).
        dir: PathBuf,
        /// Island the capture was taken on.
        #[arg(long, default_value = "saksun")]
        island: String,
    },
    /// Render one view with terrain.json values swept, as one labelled sheet (out/sweep/sheet.png).
    /// Example: de sweep valley --set look.fog_half_m=4000,12000,30000 --set look.sun_elevation_deg=12,30
    Sweep {
        view: String,
        /// `path=v1,v2,...` into terrain.json; give one (a row) or two (a grid: across, down).
        #[arg(long = "set", required = true)]
        sets: Vec<String>,
        #[arg(long, default_value = "saksun")]
        island: String,
        /// sketch (320x180, no shadows), check (1280x720) or hero (1920x1080).
        #[arg(long, default_value = "check")]
        tier: String,
        #[arg(long, default_value = "out/sweep")]
        out: PathBuf,
    },
    /// Compare every shot in two capture folders with FLIP; writes heatmaps, before|after sheets
    /// and compare.json to --out. Exit 1 if any shot changed (unless --report).
    Compare {
        reference: PathBuf,
        test: PathBuf,
        #[arg(long, default_value = "out/compare")]
        out: PathBuf,
        /// Only report; exit 0 even if shots changed.
        #[arg(long)]
        report: bool,
    },
    /// Append a look decision to docs/taste.jsonl, so later sessions know what was liked and why.
    Taste {
        /// The sheet the choice was made from.
        #[arg(long)]
        sheet: String,
        /// The cell or option that was picked (e.g. `#3` or `look.fog_half_m=12000`).
        #[arg(long)]
        pick: String,
        /// Options that were rejected, if worth remembering.
        #[arg(long)]
        reject: Vec<String>,
        /// Why, in the chooser's words.
        #[arg(long)]
        why: String,
        /// Who chose.
        #[arg(long, default_value = "C")]
        by: String,
    },
}

#[derive(Clone, Copy, ValueEnum)]
enum SchemaKind {
    /// content/islands/<id>/terrain.json
    Terrain,
    /// content/shots/*.json
    Steps,
    /// content/drone.json
    Drone,
}

fn app() -> ForgeApp {
    let mut app = headless_app();
    app.add_module(&WorldModule).expect("world module builds");
    app
}

fn main() -> ExitCode {
    let content = de_world::content_dir();
    match Cli::parse().cmd {
        Cmd::Capabilities { prefix, json } => {
            let app = app();
            let caps: Vec<_> = app.capabilities().with_prefix(prefix.as_deref().unwrap_or("")).collect();
            if json {
                let doc = serde_json::json!({ "modules": app.modules().modules, "capabilities": caps });
                println!("{}", serde_json::to_string_pretty(&doc).expect("serialises"));
            } else {
                for c in caps {
                    println!("{:<34} {}", c.id, c.summary);
                }
            }
            ExitCode::SUCCESS
        }
        Cmd::Schema { kind } => {
            let schema = match kind {
                SchemaKind::Terrain => schemars::schema_for!(Island),
                SchemaKind::Steps => schemars::schema_for!(StepList),
                SchemaKind::Drone => schemars::schema_for!(DroneConfig),
            };
            println!("{}", serde_json::to_string_pretty(&schema).expect("serialises"));
            ExitCode::SUCCESS
        }
        Cmd::Validate => {
            let problems = validate(&content);
            for p in &problems {
                eprintln!("{p}");
            }
            if problems.is_empty() {
                println!("content ok");
                ExitCode::SUCCESS
            } else {
                eprintln!("{} problem(s)", problems.len());
                ExitCode::FAILURE
            }
        }
        Cmd::Sense { dir, island } => match de_world::pack::write(&dir, &content, &island) {
            Ok(md) => {
                print!("{md}");
                ExitCode::SUCCESS
            }
            Err(e) => {
                eprintln!("{e}");
                ExitCode::FAILURE
            }
        },
        Cmd::Sweep { view, sets, island, tier, out } => {
            if sets.len() > 2 {
                eprintln!("sweep takes one or two --set axes");
                return ExitCode::FAILURE;
            }
            let axes = match sets.iter().map(|s| sweep::parse_axis(s)).collect::<Result<Vec<_>, _>>() {
                Ok(a) => a,
                Err(e) => {
                    eprintln!("{e}");
                    return ExitCode::FAILURE;
                }
            };
            match sweep::run(&content, &sweep::Sweep { island, view, axes, tier, out }) {
                Ok(md) => {
                    print!("{md}");
                    ExitCode::SUCCESS
                }
                Err(e) => {
                    eprintln!("{e}");
                    ExitCode::FAILURE
                }
            }
        }
        Cmd::Compare { reference, test, out, report } => match compare::dirs(&reference, &test, &out) {
            Ok(scores) => {
                let mut changed = false;
                for s in &scores {
                    println!("{:<8} {:<28} mean {:.4}  p95 {:.4}  max {:.3}", s.verdict, s.name, s.mean, s.p95, s.max);
                    changed |= s.verdict != "same";
                }
                println!("{}", out.join("compare.json").display());
                if changed && !report { ExitCode::FAILURE } else { ExitCode::SUCCESS }
            }
            Err(e) => {
                eprintln!("{e}");
                ExitCode::FAILURE
            }
        },
        Cmd::Taste { sheet, pick, reject, why, by } => {
            let line = serde_json::json!({
                "date": today(),
                "by": by,
                "sheet": sheet,
                "pick": pick,
                "reject": reject,
                "why": why,
            });
            let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../docs/taste.jsonl");
            use std::io::Write;
            match std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&path)
                .and_then(|mut f| writeln!(f, "{line}"))
            {
                Ok(()) => {
                    println!("{line}");
                    ExitCode::SUCCESS
                }
                Err(e) => {
                    eprintln!("{}: {e}", path.display());
                    ExitCode::FAILURE
                }
            }
        }
        Cmd::Islands => {
            for id in de_world::island_ids(&content) {
                match Island::load(&content, &id) {
                    Ok(i) => println!(
                        "{id:<12} {} ({}x{} px, {:.0} m/px, views: {})",
                        i.name,
                        i.size_px[0],
                        i.size_px[1],
                        i.metres_per_px[0],
                        i.views.iter().map(|v| v.name.as_str()).collect::<Vec<_>>().join(", ")
                    ),
                    Err(e) => println!("{id:<12} {e}"),
                }
            }
            ExitCode::SUCCESS
        }
    }
}

/// Today's UTC date as YYYY-MM-DD.
fn today() -> String {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    // Howard Hinnant's civil-from-days.
    let z = (secs / 86_400) as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}")
}

/// Every problem in content/, one readable line each.
fn validate(content: &Path) -> Vec<String> {
    let mut out = Vec::new();
    let ids = de_world::island_ids(content);
    if ids.is_empty() {
        out.push(format!("no islands under {}", content.join("islands").display()));
    }
    let mut islands = std::collections::BTreeMap::new();
    for id in &ids {
        let island = match Island::load(content, id) {
            Ok(i) => i,
            Err(e) => {
                out.push(e.to_string());
                continue;
            }
        };
        match island.heightfield(content, id) {
            Ok(h) => out.extend(island.check(&h).into_iter().map(|p| format!("islands/{id}: {p}"))),
            Err(e) => out.push(e.to_string()),
        }
        islands.insert(id.clone(), island);
    }
    let drone = match DroneConfig::load(content) {
        Ok(d) => {
            out.extend(d.check());
            Some(d)
        }
        Err(e) => {
            out.push(e);
            None
        }
    };
    let shots = content.join("shots");
    let mut files: Vec<_> = std::fs::read_dir(&shots).into_iter().flatten().flatten().map(|e| e.path()).collect();
    files.sort();
    for path in files.into_iter().filter(|p| p.extension().is_some_and(|e| e == "json")) {
        let name = path.display();
        let list: StepList = match std::fs::read_to_string(&path)
            .map_err(|e| e.to_string())
            .and_then(|t| serde_json::from_str(&t).map_err(|e| e.to_string()))
        {
            Ok(l) => l,
            Err(e) => {
                out.push(format!("{name}: {e}"));
                continue;
            }
        };
        match islands.get(&list.island) {
            None => out.push(format!("{name}: no island `{}` (have: {})", list.island, ids.join(", "))),
            Some(island) => {
                for v in list.missing_views(island) {
                    out.push(format!("{name}: island `{}` has no view `{v}`", list.island));
                }
                if let Some(d) = &drone {
                    let have: Vec<_> = d.modes.iter().map(|m| m.name.as_str()).collect();
                    for m in list.missing_modes(d) {
                        out.push(format!("{name}: no flight mode `{m}` in drone.json (have: {})", have.join(", ")));
                    }
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    #[test]
    fn shipped_content_is_valid() {
        let problems = super::validate(&de_world::content_dir());
        assert!(problems.is_empty(), "{problems:#?}");
    }

    #[test]
    fn capability_ids_are_unique_and_registered() {
        let app = super::app();
        assert!(app.capabilities().contains("module.de_world"));
        assert!(app.capabilities().contains("world.steps.fly"));
    }
}
