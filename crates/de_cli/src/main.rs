//! `de`: Discover Earth's command line, the first thing an agent runs.
//!
//!   de capabilities [prefix] [--json]   what the engine and game can do
//!   de schema terrain|steps|drone|references      JSON schema for a content file
//!   de validate                         check every island, drone.json and step list
//!   de islands                          list islands with size and views
//!   de sense <dir>                      rebuild sensor packs and clip reports for a capture
//!   de sweep <view> --set a.b=1,2,3     render a view over values and lay them out as one sheet
//!   de compare <ref-dir> <dir>          perceptual difference (FLIP) per shot, with heatmaps
//!   de taste --sheet .. --pick ..       record a look decision in docs/taste.jsonl
//!   de water [island]                   streams, waterfalls and lakes from the terrain, with a map
//!   de photo solve|match                cameras of real photos from their skylines; render vs photo

mod compare;
mod photo;
mod sweep;

use std::{
    path::{Path, PathBuf},
    process::ExitCode,
};

use clap::{Parser, Subcommand, ValueEnum};
use de_world::{DroneConfig, Island, StepList, WorldModule};

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
    /// Compare an island's ground with the satellite (needs `scripts/truth/fetch.py <island>`):
    /// layer albedos now vs fitted, land-cover agreement, and top-down maps in out/truth/<island>/.
    /// With --apply, writes the fitted albedos into terrain.json.
    Truth {
        #[arg(default_value = "saksun")]
        island: String,
        #[arg(long)]
        apply: bool,
        #[arg(long, default_value = "out/truth")]
        out: PathBuf,
    },
    /// Find an island's streams, waterfalls and lakes from its terrain under rules.json; writes
    /// water.json, map.png (against WorldCover's water when truth data exists), water.md and
    /// falls.steps.json (a step list with one shot per waterfall) to out/water/<island>/.
    Water {
        #[arg(default_value = "saksun")]
        island: String,
        #[arg(long, default_value = "out/water")]
        out: PathBuf,
        /// A folder where de-shot rendered falls.steps.json: lay its shots out as falls.sheet.png.
        #[arg(long)]
        shots: Option<PathBuf>,
    },
    /// Real photos of the island (content/references/<island>/): solve their cameras from the
    /// skyline, then measure renders from those cameras against them.
    Photo {
        #[command(subcommand)]
        cmd: PhotoCmd,
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

#[derive(Subcommand)]
enum PhotoCmd {
    /// Find each photo's camera by fitting its skyline to the heightfield's; writes `camera`
    /// into references.json and skyline overlays (photo red, heightfield green) to --out.
    Solve {
        /// Only these photo ids (default: all).
        ids: Vec<String>,
        #[arg(long, default_value = "saksun")]
        island: String,
        #[arg(long, default_value = "out/photo/solve")]
        out: PathBuf,
    },
    /// Render every solved photo's camera and measure it against the photo (colour, lightness,
    /// palette per sky/sea/land region). Writes <id>.match.png, sheet.png, match.json, match.md.
    /// Example: de photo match --set look.fog_half_m=6000 --ref out/photo/before --out out/photo/after
    Match {
        #[arg(long, default_value = "saksun")]
        island: String,
        /// `path=value` into terrain.json, rendered through an overlay (content/ is untouched).
        #[arg(long = "set")]
        sets: Vec<String>,
        /// Render width in pixels (height follows the photo).
        #[arg(long, default_value_t = 960)]
        width: u32,
        #[arg(long, default_value = "out/photo/match")]
        out: PathBuf,
        /// An earlier `de photo match --out` folder: adds its renders as "before" and the change in gap.
        #[arg(long = "ref")]
        reference: Option<PathBuf>,
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
    /// content/islands/<id>/rules.json
    Rules,
    /// content/references/<island>/references.json
    References,
}

/// Every module and capability, sorted by id.
fn catalogue() -> (Vec<de_world::Module>, Vec<de_world::Capability>) {
    let mut caps = WorldModule.capabilities();
    caps.sort_by(|a, b| a.id.cmp(&b.id));
    (vec![WorldModule.manifest()], caps)
}

fn main() -> ExitCode {
    let content = de_world::content_dir();
    match Cli::parse().cmd {
        Cmd::Capabilities { prefix, json } => {
            let (modules, all) = catalogue();
            let caps: Vec<_> = all.iter().filter(|c| c.id.starts_with(prefix.as_deref().unwrap_or(""))).collect();
            if json {
                let doc = serde_json::json!({ "modules": modules, "capabilities": caps });
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
                SchemaKind::Rules => schemars::schema_for!(de_world::water::Rules),
                SchemaKind::References => schemars::schema_for!(de_world::photo::References),
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
        Cmd::Truth { island, apply, out } => match truth(&content, &island, apply, &out.join(&island)) {
            Ok(text) => {
                print!("{text}");
                ExitCode::SUCCESS
            }
            Err(e) => {
                eprintln!("{e}");
                ExitCode::FAILURE
            }
        },
        Cmd::Water { island, out, shots } => match water(&content, &island, &out.join(&island), shots.as_deref()) {
            Ok(text) => {
                print!("{text}");
                ExitCode::SUCCESS
            }
            Err(e) => {
                eprintln!("{e}");
                ExitCode::FAILURE
            }
        },
        Cmd::Photo { cmd } => {
            let res = match cmd {
                PhotoCmd::Solve { ids, island, out } => photo::solve(&content, &island, &ids, &out),
                PhotoCmd::Match { island, sets, width, out, reference } => {
                    photo::run(&content, &photo::MatchArgs { island, sets, width, out, reference })
                }
            };
            match res {
                Ok(text) => {
                    print!("{text}");
                    ExitCode::SUCCESS
                }
                Err(e) => {
                    eprintln!("{e}");
                    ExitCode::FAILURE
                }
            }
        }
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

fn truth(content: &Path, id: &str, apply: bool, out: &Path) -> Result<String, String> {
    use de_world::truth;
    let island = Island::load(content, id).map_err(|e| e.to_string())?;
    let field = island.heightfield(content, id).map_err(|e| e.to_string())?;
    let t = truth::Truth::load(content, id, &island)?.ok_or_else(|| {
        format!("islands/{id} has no satellite.png/landcover.png: run `python3 scripts/truth/fetch.py {id}`")
    })?;
    let fit = truth::fit(&island, &field, &t);
    let agree = truth::agreement(&island, &field, &t);
    std::fs::create_dir_all(out).map_err(|e| e.to_string())?;
    let fitted: [de_world::Vec3; 4] = std::array::from_fn(|i| fit.layers[truth::LAYERS[i]].fitted);
    let [sat, now, after, cover] = truth::maps(&island, &field, &t, &fitted);
    let cells = [
        de_world::image::Cell { image: sat, label: "SATELLITE".into() },
        de_world::image::Cell { image: now, label: format!("OURS NOW DE {:.1}", fit.mean_delta_e_now) },
        de_world::image::Cell { image: after, label: format!("OURS FITTED DE {:.1}", fit.mean_delta_e_fitted) },
        de_world::image::Cell { image: cover, label: format!("LAND COVER {:.0}% AGREE", agree.agree * 100.0) },
    ];
    de_world::image::sheet(&format!("{id}: ground from above"), &cells, 4, 400).save(&out.join("map.png"))?;
    let report = serde_json::json!({ "fit": fit, "agreement": agree });
    std::fs::write(out.join("truth.json"), serde_json::to_string_pretty(&report).expect("serialises"))
        .map_err(|e| e.to_string())?;

    let mut text = format!("# {} vs the satellite\n\n", island.name);
    text.push_str(&format!(
        "Mean colour gap over land (ΔE): {:.1} now, {:.1} with fitted albedos ({} samples).\n\n| layer | share | now | fitted | ΔE |\n| --- | --- | --- | --- | --- |\n",
        fit.mean_delta_e_now, fit.mean_delta_e_fitted, fit.samples
    ));
    for l in truth::LAYERS {
        let f = &fit.layers[l];
        text.push_str(&format!(
            "| {l} | {:.0}% | {:?} | {:?} | {:.1} |\n",
            f.share * 100.0,
            f.now,
            f.fitted,
            f.delta_e
        ));
    }
    text.push_str(&format!("\nLand cover agrees with our layers on {:.0}% of land.\n", agree.agree * 100.0));
    for (layer, under) in &agree.under {
        let mut v: Vec<_> = under.iter().filter(|(_, s)| **s >= 0.02).collect();
        v.sort_by(|a, b| b.1.total_cmp(a.1));
        text.push_str(&format!(
            "- where we draw {layer}: {}\n",
            v.iter().map(|(k, s)| format!("{k} {:.0}%", **s * 100.0)).collect::<Vec<_>>().join(", ")
        ));
    }
    text.push_str(&format!("\nMaps: {}\n", out.join("map.png").display()));
    if apply {
        let path = content.join("islands").join(id).join("terrain.json");
        let mut doc: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
        for (i, l) in truth::LAYERS.iter().enumerate() {
            // Three decimals, written as the decimal you read (not the f32's binary expansion).
            let v: Vec<f64> = fitted[i].iter().map(|&c| (f64::from(c) * 1000.0).round() / 1000.0).collect();
            if doc.get("look").is_none() {
                doc["look"] = serde_json::json!({});
            }
            doc["look"][*l] = serde_json::json!(v);
        }
        std::fs::write(&path, serde_json::to_string_pretty(&doc).expect("serialises") + "\n")
            .map_err(|e| e.to_string())?;
        text.push_str(&format!("Wrote the fitted albedos to {}.\n", path.display()));
    }
    std::fs::write(out.join("truth.md"), &text).map_err(|e| e.to_string())?;
    Ok(text)
}

fn water(content: &Path, id: &str, out: &Path, shots: Option<&Path>) -> Result<String, String> {
    use de_world::water::{Rules, Water};
    let island = Island::load(content, id).map_err(|e| e.to_string())?;
    let field = island.heightfield(content, id).map_err(|e| e.to_string())?;
    let rules = Rules::load(content, id)?;
    let water = Water::find(&field, &rules.water);
    let truth = de_world::truth::Truth::load(content, id, &island)?;
    std::fs::create_dir_all(out).map_err(|e| e.to_string())?;
    water.map(&field, truth.as_ref(), 2).save(&out.join("map.png"))?;
    let check = truth.as_ref().map(|t| water.cover_check(&field, t));
    let report = serde_json::json!({ "water": water, "cover_check": check });
    std::fs::write(out.join("water.json"), serde_json::to_string_pretty(&report).expect("serialises"))
        .map_err(|e| e.to_string())?;

    // One shot per waterfall, for de-shot.
    let views = water.fall_views(&field);
    let mut steps = vec![];
    for v in &views {
        steps.push(serde_json::json!({ "camera": { "pos": v.pos, "look_at": v.look_at } }));
        steps.push(serde_json::json!({ "wait": 2 }));
        steps.push(serde_json::json!({ "shot": v.name }));
    }
    let list = serde_json::json!({ "island": id, "size": [960, 540], "steps": steps });
    std::fs::write(out.join("falls.steps.json"), serde_json::to_string_pretty(&list).expect("serialises"))
        .map_err(|e| e.to_string())?;

    let mut text = format!("# Water of {}\n\n{}\n\n", island.name, water.text);
    text.push_str(&format!("Streams end in: {:?}.\n", water.ends()));
    if let Some(c) = &check {
        text.push_str(&format!(
            "WorldCover sees {:.0} m² of inland water; {:.0}% of it lies in our lakes or streams, and {:.0}% of our lake area is water there too.\n",
            c.cover_water_m2,
            c.ours_found * 100.0,
            c.lakes_confirmed * 100.0
        ));
        for (at, area) in c.missed.iter().take(5) {
            text.push_str(&format!("- missed: {area:.0} m² of water around ({:.0}, {:.0})\n", at[0], at[1]));
        }
    }
    text.push_str(&format!(
        "\nMap: {}\nWaterfall shots: cargo run -q -p de_client --bin de-shot -- {} out/falls\n",
        out.join("map.png").display(),
        out.join("falls.steps.json").display()
    ));
    if let Some(dir) = shots {
        let mut cells = Vec::new();
        for f in &water.falls {
            let png = dir.join(format!("fall{}.png", f.id));
            if let Ok(image) = de_world::image::Rgba::load(&png) {
                let label = format!("FALL {} {:.0}M{}", f.id, f.drop_m, if f.into_sea { " INTO SEA" } else { "" });
                cells.push(de_world::image::Cell { image, label });
            }
        }
        if cells.is_empty() {
            return Err(format!("no fall<N>.png in {}: render falls.steps.json there first", dir.display()));
        }
        let sheet = out.join("falls.sheet.png");
        de_world::image::sheet(&format!("{id}: every waterfall the terrain makes"), &cells, 3, 480).save(&sheet)?;
        text.push_str(&format!("Waterfall sheet: {}\n", sheet.display()));
    }
    std::fs::write(out.join("water.md"), &text).map_err(|e| e.to_string())?;
    Ok(text)
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
        if let Err(e) = de_world::water::Rules::load(content, id) {
            out.push(format!("{e} (see `de schema rules`)"));
        }
        match de_world::photo::References::load(content, id) {
            Ok(Some(r)) => out.extend(r.check(content, &island)),
            Ok(None) => {}
            Err(e) => out.push(e),
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
        let (_, caps) = super::catalogue();
        let ids: std::collections::BTreeSet<_> = caps.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(ids.len(), caps.len(), "duplicate capability ids");
        assert!(ids.contains("module.de_world"));
        assert!(ids.contains("world.steps.fly"));
    }
}
