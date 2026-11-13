//! An island: `content/islands/<id>/terrain.json` plus its heightmap.

use std::path::{Path, PathBuf};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::terrain::Heightfield;

/// A point or direction in world metres: x east, y up, z south.
pub type Vec3 = [f32; 3];

/// One island's terrain manifest (`content/islands/<id>/terrain.json`).
///
/// `scripts/terrain/import.py` writes the generated fields (`heightmap` to `source`) from a DEM
/// tile; `views` and `look` are written by hand and survive a re-import.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Island {
    /// Display name.
    pub name: String,
    /// 16-bit greyscale PNG next to this file; row 0 is north.
    pub heightmap: String,
    /// Width and height of the heightmap in pixels.
    pub size_px: [u32; 2],
    /// Metres per pixel, east-west then north-south.
    pub metres_per_px: [f32; 2],
    /// Heights that pixel values 0 and 65535 stand for, in metres above sea level.
    pub height_range_m: [f32; 2],
    /// Where the heightmap's north-west corner is on Earth.
    pub origin: GeoOrigin,
    /// Where the elevation data came from, with the attribution its licence asks for.
    pub source: Source,
    /// Named camera views, for the spawn point and for captures (`{"view": "<name>"}`).
    /// The first one is where the game starts.
    #[serde(default)]
    pub views: Vec<View>,
    /// How the island is lit and coloured.
    #[serde(default)]
    pub look: Look,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct GeoOrigin {
    pub north_lat: f64,
    pub west_lon: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Source {
    pub dataset: String,
    pub tile: String,
    pub attribution: String,
}

/// A camera placed in world metres, looking at a point.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct View {
    pub name: String,
    pub pos: Vec3,
    pub look_at: Vec3,
}

/// Light and colour for an island. Every field has a default, so `{}` is a valid look.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(default, deny_unknown_fields)]
pub struct Look {
    /// Sun elevation above the horizon, degrees.
    pub sun_elevation_deg: f32,
    /// Sun direction as a compass bearing (0 north, 90 east), degrees.
    pub sun_azimuth_deg: f32,
    /// Sun illuminance in lux.
    pub sun_lux: f32,
    /// Sky and fog colour near the horizon, linear RGB 0..1.
    pub horizon: Vec3,
    /// Distance in metres at which fog hides half the scene.
    pub fog_half_m: f32,
    /// Ground colours by height and slope, linear RGB.
    pub grass: Vec3,
    pub rock: Vec3,
    pub shore: Vec3,
    pub moss: Vec3,
    /// Slope (0 flat .. 1 vertical, from the normal) above which ground turns to rock.
    pub rock_slope: f32,
    /// Sea colour, linear RGB, and how see-through it is (0..1).
    pub sea: Vec3,
    pub sea_alpha: f32,
    /// Terrain mesh vertices per heightmap pixel along each side (1 = one per pixel). Finer
    /// meshes follow the heightmap smoothly and carry `relief_m` of seeded small-scale relief.
    pub subdivide: u32,
    /// Height of the small-scale relief added between heightmap pixels, metres.
    pub relief_m: f32,
    /// Strength of the fine bumps the shader adds to the ground's lighting (0 for none).
    pub detail_normals: f32,
    /// Distance in metres at which the fine detail has faded out.
    pub detail_fade_m: f32,
}

/// Ground layer weights (grass, rock, shore, moss) from height and slope (0 flat .. 1 vertical).
pub fn layer_weights(y: f32, slope: f32, top: f32, look: &Look) -> [f32; 4] {
    let smooth = |a: f32, b: f32, x: f32| {
        let t = ((x - a) / (b - a)).clamp(0.0, 1.0);
        t * t * (3.0 - 2.0 * t)
    };
    let rock = smooth(look.rock_slope * 0.35, look.rock_slope, slope);
    let shore = if y < 8.0 { 1.0 - (y / 8.0).max(0.0) } else { 0.0 };
    let moss = (1.0 - rock) * (0.55 * smooth(0.06, 0.3, slope) + 0.45 * (y / top).clamp(0.0, 1.0));
    let grass = ((1.0 - rock) * (1.0 - shore) - moss).max(0.0);
    let sum = (grass + rock + shore + moss).max(1e-4);
    [grass / sum, rock / sum, shore / sum, moss / sum]
}

impl Default for Look {
    fn default() -> Self {
        Self {
            sun_elevation_deg: 24.0,
            sun_azimuth_deg: 220.0,
            sun_lux: 30_000.0,
            horizon: [0.62, 0.72, 0.82],
            fog_half_m: 30_000.0,
            grass: [0.11, 0.165, 0.05],
            rock: [0.115, 0.105, 0.09],
            shore: [0.17, 0.16, 0.14],
            moss: [0.055, 0.08, 0.03],
            rock_slope: 0.38,
            sea: [0.012, 0.045, 0.065],
            sea_alpha: 0.92,
            subdivide: 2,
            relief_m: 1.5,
            detail_normals: 0.35,
            detail_fade_m: 900.0,
        }
    }
}

#[derive(Debug)]
pub enum LoadError {
    Io(PathBuf, std::io::Error),
    Json(PathBuf, serde_json::Error),
    Heightmap(PathBuf, String),
}

impl std::fmt::Display for LoadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(p, e) => write!(f, "{}: {e}", p.display()),
            Self::Json(p, e) => write!(f, "{}: {e}", p.display()),
            Self::Heightmap(p, e) => write!(f, "{}: {e}", p.display()),
        }
    }
}

impl std::error::Error for LoadError {}

impl Island {
    /// Reads `content/islands/<id>/terrain.json`, or the same path under `$DE_OVERLAY` when that
    /// folder has one (how `de sweep` tries variants without touching `content/`).
    pub fn load(content: &Path, id: &str) -> Result<Self, LoadError> {
        let rel = Path::new("islands").join(id).join("terrain.json");
        let path = std::env::var_os("DE_OVERLAY")
            .map(|o| PathBuf::from(o).join(&rel))
            .filter(|p| p.is_file())
            .unwrap_or_else(|| content.join(&rel));
        let text = std::fs::read_to_string(&path).map_err(|e| LoadError::Io(path.clone(), e))?;
        serde_json::from_str(&text).map_err(|e| LoadError::Json(path, e))
    }

    /// Reads the island's heightmap.
    pub fn heightfield(&self, content: &Path, id: &str) -> Result<Heightfield, LoadError> {
        let path = content.join("islands").join(id).join(&self.heightmap);
        let bytes = std::fs::read(&path).map_err(|e| LoadError::Io(path.clone(), e))?;
        let h = Heightfield::from_png16(&bytes, self.height_range_m, self.metres_per_px)
            .map_err(|e| LoadError::Heightmap(path.clone(), e))?;
        if [h.width as u32, h.depth as u32] != self.size_px {
            return Err(LoadError::Heightmap(
                path,
                format!("is {}x{} px, terrain.json says {:?}", h.width, h.depth, self.size_px),
            ));
        }
        Ok(h)
    }

    pub fn view(&self, name: &str) -> Option<&View> {
        self.views.iter().find(|v| v.name == name)
    }

    /// Problems a person or agent should fix, as readable lines. Empty means valid.
    pub fn check(&self, h: &Heightfield) -> Vec<String> {
        let mut out = Vec::new();
        if !(1..=4).contains(&self.look.subdivide) {
            out.push(format!("look.subdivide must be 1..=4, is {}", self.look.subdivide));
        }
        if self.views.is_empty() {
            out.push("no views: add at least one (the first is the spawn point)".into());
        }
        let mut names = std::collections::BTreeSet::new();
        for v in &self.views {
            if !names.insert(&v.name) {
                out.push(format!("view `{}` is defined twice", v.name));
            }
            let [x, y, z] = v.pos;
            if !h.contains(x, z) {
                let [w, d] = h.extent();
                out.push(format!(
                    "view `{}` pos ({x}, {z}) is off the terrain, which spans x and z within ±{:.0} and ±{:.0} m",
                    v.name,
                    w / 2.0,
                    d / 2.0
                ));
            } else if y < h.height(x, z) + 1.0 {
                out.push(format!("view `{}` is underground: y {y} m, ground there is {:.0} m", v.name, h.height(x, z)));
            }
            if v.pos == v.look_at {
                out.push(format!("view `{}` looks at its own position", v.name));
            }
        }
        out
    }
}
