//! `de`: Discover Earth's command line, the first thing an agent runs.
//!
//!   de capabilities [prefix] [--json]   what the engine and game can do
//!   de schema terrain|steps|drone       JSON schema for a content file
//!   de validate                         check every island, drone.json and step list
//!   de islands                          list islands with size and views

use std::{path::Path, process::ExitCode};

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
