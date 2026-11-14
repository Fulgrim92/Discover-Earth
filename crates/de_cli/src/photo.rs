//! `de photo solve` and `de photo match`: real photos as the target for the look.
//!
//! `solve` finds each reference photo's camera from its skyline (`de_world::photo::solve`) and
//! writes it into `content/references/<island>/references.json`, with an overlay per photo
//! (photo skyline red, heightfield skyline green) to check it by eye.
//!
//! `match` renders every solved photo's camera with `de-shot` (optionally with `--set` look
//! overrides, as an overlay like `de sweep`), measures each render against its photo and writes
//! `<out>/<id>.match.png` (photo | render, region colours, palettes), `<out>/match.json`,
//! `<out>/match.md` and `<out>/sheet.png` (every photo, one row each). With `--ref <dir>` from an
//! earlier run, it adds that run's render as "before" and reports the change in the gap.

use std::{
    path::{Path, PathBuf},
    process::Command,
};

use de_world::{
    Island,
    image::Rgba,
    photo::{self, Match, References},
    sense::World,
};
use serde_json::Value;

use crate::sweep::{parse_axis, set_path};

fn load(content: &Path, island: &str) -> Result<(Island, de_world::Heightfield, References), String> {
    let isl = Island::load(content, island).map_err(|e| e.to_string())?;
    let field = isl.heightfield(content, island).map_err(|e| e.to_string())?;
    let refs = References::load(content, island)?.ok_or_else(|| {
        format!("no content/references/{island}/references.json: add photos there, then `python3 scripts/truth/photos.py {island}`")
    })?;
    Ok((isl, field, refs))
}

pub fn solve(content: &Path, island: &str, only: &[String], out: &Path) -> Result<String, String> {
    let (isl, field, mut refs) = load(content, island)?;
    std::fs::create_dir_all(out).map_err(|e| e.to_string())?;
    let dir = References::dir(content, island);
    let mut md = format!("# Camera solve: {} reference photos\n\n", isl.name);
    md.push_str("Skyline overlays: red is the photo's skyline, green the heightfield's from the solved camera.\n\n");
    md.push_str("| photo | pos (x, y, z) | heading | pitch | roll | fov | median error | inliers |\n");
    md.push_str("| --- | --- | --- | --- | --- | --- | --- | --- |\n");
    for p in refs.photos.iter_mut() {
        if !only.is_empty() && !only.contains(&p.id) {
            continue;
        }
        let img = photo::load_jpeg(&dir.join(format!("{}.jpg", p.id)))?;
        eprintln!("{}: solving ...", p.id);
        let r = photo::solve(&isl, &field, p, &img)?;
        let c = &r.camera;
        photo::overlay(&img, &r).save(&out.join(format!("{}.solve.png", p.id)))?;
        md.push_str(&format!(
            "| {} | {:.0}, {:.0}, {:.0} | {:.1}° | {:.1}° | {:.1}° | {:.1}° | {:.2}° | {:.0}% |\n",
            p.id,
            c.pos[0],
            c.pos[1],
            c.pos[2],
            c.heading_deg,
            c.pitch_deg,
            c.roll_deg,
            c.fov_y_deg,
            c.median_error_deg,
            c.inliers * 100.0
        ));
        p.camera = Some(r.camera);
    }
    refs.save(content)?;
    md.push_str(&format!("\nWrote the cameras to {}.\n", dir.join("references.json").display()));
    std::fs::write(out.join("solve.md"), &md).map_err(|e| e.to_string())?;
    Ok(md)
}

pub struct MatchArgs {
    pub island: String,
    pub sets: Vec<String>,
    pub width: u32,
    pub out: PathBuf,
    pub reference: Option<PathBuf>,
}

pub fn run(content: &Path, a: &MatchArgs) -> Result<String, String> {
    let (isl, field, refs) = load(content, &a.island)?;
    let dir = References::dir(content, &a.island);
    std::fs::create_dir_all(&a.out).map_err(|e| e.to_string())?;

    // Look overrides go into an overlay terrain.json, as in `de sweep`.
    let mut doc: Value = serde_json::to_value(&isl).map_err(|e| e.to_string())?;
    for s in &a.sets {
        let axis = parse_axis(s)?;
        if axis.values.len() != 1 {
            return Err(format!("`{s}`: photo match takes one value per --set (use de sweep for several)"));
        }
        set_path(&mut doc, &axis.path, axis.values[0].clone())?;
    }
    let isl: Island = serde_json::from_value(doc.clone()).map_err(|e| format!("--set: {e}"))?;
    let overlay = a.out.join("overlay");
    if !a.sets.is_empty() {
        let tj = overlay.join("islands").join(&a.island);
        std::fs::create_dir_all(&tj).map_err(|e| e.to_string())?;
        std::fs::write(tj.join("terrain.json"), serde_json::to_string_pretty(&doc).expect("serialises"))
            .map_err(|e| e.to_string())?;
    }
    let shot = std::env::current_exe().map_err(|e| e.to_string())?.with_file_name(if cfg!(windows) {
        "de-shot.exe"
    } else {
        "de-shot"
    });
    if !shot.is_file() {
        return Err(format!("{} is missing: run `cargo build -p de_client --bin de-shot` first", shot.display()));
    }
    let before: Option<Vec<Match>> = a
        .reference
        .as_ref()
        .map(|r| {
            let path = r.join("match.json");
            std::fs::read_to_string(&path)
                .map_err(|e| format!("{}: {e}", path.display()))
                .and_then(|t| serde_json::from_str(&t).map_err(|e| format!("{}: {e}", path.display())))
        })
        .transpose()?;

    let rules = de_world::water::Rules::load(content, &a.island)?;
    let water = de_world::water::Water::find(&field, &rules.water);
    let surface = de_world::Surface::new(&field, &isl.look, &a.island, Some((&water, rules.water.channel_depth_m)));
    let world = World::new(&isl, &field).with_water(&water).with_surface(&surface);
    let mut results = Vec::new();
    let mut rows = Vec::new();
    for p in &refs.photos {
        let Some(cam) = &p.camera else {
            eprintln!("{}: no camera yet; run `de photo solve` first (skipped)", p.id);
            continue;
        };
        let img = photo::load_jpeg(&dir.join(format!("{}.jpg", p.id)))?;
        let w = a.width;
        let h = ((img.height as f32 * w as f32 / img.width as f32).round() as u32) & !1;
        let steps = serde_json::json!({
            "island": a.island,
            "size": [w, h],
            "steps": [
                {"camera": {"pos": cam.pos, "look_at": cam.look_at(), "fov_y_deg": cam.fov_y_deg, "roll_deg": cam.roll_deg}},
                {"wait": 2},
                {"shot": p.id},
            ],
        });
        let work = a.out.join("work");
        std::fs::create_dir_all(&work).map_err(|e| e.to_string())?;
        let steps_path = work.join(format!("{}.steps.json", p.id));
        std::fs::write(&steps_path, steps.to_string()).map_err(|e| e.to_string())?;
        eprintln!("{}: rendering ...", p.id);
        let log = work.join(format!("{}.log", p.id));
        let mut cmd = Command::new(&shot);
        cmd.arg(&steps_path).arg(&a.out).arg("--no-sense").env("DE_CONTENT", content);
        if !a.sets.is_empty() {
            cmd.env("DE_OVERLAY", &overlay);
        }
        let status = cmd
            .stdout(std::process::Stdio::null())
            .stderr(std::fs::File::create(&log).map_err(|e| e.to_string())?)
            .status()
            .map_err(|e| e.to_string())?;
        if !status.success() {
            return Err(format!("{}: de-shot failed, see {}", p.id, log.display()));
        }
        let render = Rgba::load(&a.out.join(format!("{}.png", p.id)))?;
        let (rw, rh, reg) = photo::regions(&world, &cam.shot(&p.id, [w, h]), 320, &rules.grass);
        let m = photo::compare(&p.id, &img, &render, rw, rh, &reg);
        regions_overlay(&img, &render, rw, rh, &reg).save(&a.out.join(format!("{}.regions.png", p.id)))?;
        let old = before.as_ref().and_then(|b| b.iter().find(|o| o.id == p.id));
        let old_render = a.reference.as_ref().and_then(|r| Rgba::load(&r.join(format!("{}.png", p.id))).ok());
        let credit = p.source.as_ref().map(|s| s.credit.clone()).unwrap_or_default();
        let card = card(&img, &render, old_render.as_ref(), &m, old, &credit);
        card.save(&a.out.join(format!("{}.match.png", p.id)))?;
        rows.push(card);
        results.push((m, old.cloned()));
    }
    if results.is_empty() {
        return Err("no photo has a camera yet: run `de photo solve` first".into());
    }
    // One sheet with every card, stacked.
    let width = rows.iter().map(|r| r.width).max().unwrap_or(0);
    let height: u32 = rows.iter().map(|r| r.height + 6).sum();
    let mut sheet = Rgba::new(width, height, [24, 24, 28, 255]);
    let mut y = 0;
    for r in &rows {
        sheet.blit(r, 0, y);
        y += r.height + 6;
    }
    sheet.save(&a.out.join("sheet.png"))?;
    let only: Vec<&Match> = results.iter().map(|(m, _)| m).collect();
    std::fs::write(a.out.join("match.json"), serde_json::to_string_pretty(&only).expect("serialises"))
        .map_err(|e| e.to_string())?;

    let mut md = format!("# Renders vs photos: {}\n\n", isl.name);
    if !a.sets.is_empty() {
        md.push_str(&format!("With {}.\n\n", a.sets.join(", ")));
    }
    md.push_str(
        "Gap = mean of region colour ΔE, lightness (L*) distribution distance and palette ΔE; lower is closer to the photo.\n\n",
    );
    md.push_str("| photo | gap | colour ΔE | lightness | palette ΔE | worst region |");
    md.push_str(if before.is_some() {
        " gap before | change |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n"
    } else {
        "\n| --- | --- | --- | --- | --- | --- |\n"
    });
    let (mut sum, mut sum_old, mut better) = (0.0, 0.0, 0);
    for (m, old) in &results {
        let worst = m
            .regions
            .iter()
            .max_by(|a, b| (a.colour_de * a.coverage).total_cmp(&(b.colour_de * b.coverage)))
            .map(|r| {
                format!(
                    "{} (photo {:?} vs render {:?}, L* {:.0} vs {:.0})",
                    r.region, r.photo_mean, r.render_mean, r.photo_lightness[1], r.render_lightness[1]
                )
            })
            .unwrap_or_default();
        md.push_str(&format!(
            "| {} | {:.1} | {:.1} | {:.1} | {:.1} | {worst} |",
            m.id, m.gap, m.colour_de, m.lightness_gap, m.palette_de
        ));
        sum += m.gap;
        if let Some(o) = old {
            md.push_str(&format!(" {:.1} | {:+.1} |", o.gap, m.gap - o.gap));
            sum_old += o.gap;
            better += usize::from(m.gap < o.gap);
        }
        md.push('\n');
    }
    let n = results.len() as f32;
    md.push_str(&format!("\nMean gap {:.2} over {} photos.", sum / n, results.len()));
    if before.is_some() {
        md.push_str(&format!(" Before: {:.2}. Closer on {better} of {}.", sum_old / n, results.len()));
    }
    md.push_str(&format!("\n\nSheet: {}\n", a.out.join("sheet.png").display()));
    std::fs::write(a.out.join("match.md"), &md).map_err(|e| e.to_string())?;
    Ok(md)
}

/// Photo | render, each tinted by the region it is measured in (sky blue, sea cyan, land near
/// green, land far orange; skipped pixels dark), so a wrong region split shows before its numbers are trusted.
fn regions_overlay(photo: &Rgba, render: &Rgba, w: u32, h: u32, reg: &[u8]) -> Rgba {
    const TINT: [[f32; 3]; 4] = [[80.0, 140.0, 255.0], [0.0, 230.0, 230.0], [60.0, 220.0, 60.0], [255.0, 150.0, 40.0]];
    let tint = |img: &Rgba| {
        let mut out = img.resize(w, h);
        for (px, &k) in out.pixels.iter_mut().zip(reg) {
            let Some(t) = TINT.get(k as usize) else {
                *px = [px[0] / 3, px[1] / 3, px[2] / 3, 255];
                continue;
            };
            for c in 0..3 {
                px[c] = (0.55 * px[c] as f32 + 0.45 * t[c]) as u8;
            }
        }
        out
    };
    let mut sheet = Rgba::new(2 * w + 4, h, [24, 24, 28, 255]);
    sheet.blit(&tint(photo), 0, 0);
    sheet.blit(&tint(render), w + 4, 0);
    sheet
}

/// One photo's card: photo | (before) | render on top, then per-region colours and palettes.
fn card(photo: &Rgba, render: &Rgba, before: Option<&Rgba>, m: &Match, old: Option<&Match>, credit: &str) -> Rgba {
    let cw = 480u32;
    let ch = (photo.height as f32 * cw as f32 / photo.width as f32).round() as u32;
    let mut imgs = vec![(photo.resize(cw, ch), "PHOTO".to_string())];
    if let (Some(b), Some(o)) = (before, old) {
        imgs.push((b.resize(cw, ch), format!("BEFORE  GAP {:.1}", o.gap)));
    }
    imgs.push((render.resize(cw, ch), format!("RENDER  GAP {:.1}", m.gap)));
    let gap = 4;
    let width = imgs.len() as u32 * (cw + gap) + gap;
    let rows = m.regions.len() as u32 + 2;
    let height = 26 + ch + gap + rows * 20 + 26;
    let mut out = Rgba::new(width, height, [24, 24, 28, 255]);
    let white = [235, 235, 235, 255];
    out.text(
        gap + 2,
        6,
        &format!("{}: COLOUR {:.1}  LIGHTNESS {:.1}  PALETTE {:.1}", m.id, m.colour_de, m.lightness_gap, m.palette_de),
        2,
        white,
    );
    for (i, (im, label)) in imgs.iter().enumerate() {
        let x = gap + i as u32 * (cw + gap);
        out.blit(im, x, 26);
        out.label(x + 4, 30, label, 2);
    }
    let mut y = 26 + ch + gap + 4;
    let sw = |out: &mut Rgba, x: u32, y: u32, c: [u8; 3]| out.fill_rect(x, y, 40, 16, [c[0], c[1], c[2], 255]);
    for r in &m.regions {
        out.text(gap + 2, y + 2, &r.region.replace('_', " "), 2, white);
        sw(&mut out, 150, y, r.photo_mean);
        sw(&mut out, 194, y, r.render_mean);
        out.text(
            244,
            y + 2,
            &format!(
                "{:>3.0}%  DE {:>4.1}  L* {:.0}/{:.0}/{:.0} VS {:.0}/{:.0}/{:.0}",
                r.coverage * 100.0,
                r.colour_de,
                r.photo_lightness[0],
                r.photo_lightness[1],
                r.photo_lightness[2],
                r.render_lightness[0],
                r.render_lightness[1],
                r.render_lightness[2]
            ),
            2,
            white,
        );
        y += 20;
    }
    for (label, pal) in [("photo", &m.photo_palette), ("render", &m.render_palette)] {
        out.text(gap + 2, y + 2, label, 2, white);
        for (i, c) in pal.iter().enumerate() {
            out.fill_rect(150 + i as u32 * 44, y, 40, 16, [c[0], c[1], c[2], 255]);
        }
        y += 20;
    }
    let max = (width.saturating_sub(8) / 6) as usize;
    let credit: String = ascii(credit).chars().take(max).collect();
    out.text(gap + 2, y + 6, &credit, 1, [170, 170, 170, 255]);
    out
}

/// The built-in font is ASCII: spell Faroese and other letters without accents.
fn ascii(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            'á' | 'à' | 'â' | 'ä' | 'å' => "a".into(),
            'Á' | 'Å' | 'Ä' => "A".into(),
            'æ' => "ae".into(),
            'Æ' => "AE".into(),
            'ð' => "d".into(),
            'Ð' => "D".into(),
            'é' | 'è' | 'ê' => "e".into(),
            'í' | 'ì' => "i".into(),
            'ó' | 'ö' | 'ø' | 'ô' => "o".into(),
            'Ó' | 'Ö' | 'Ø' => "O".into(),
            'ú' | 'ü' => "u".into(),
            'Ú' | 'Ü' => "U".into(),
            'ý' => "y".into(),
            'ß' => "ss".into(),
            c if c.is_ascii() => c.to_string(),
            _ => "?".into(),
        })
        .collect()
}
