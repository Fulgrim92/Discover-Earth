//! A heightfield in metres, laid out in world space.
//!
//! World axes (Bevy's): +X east, +Y up, +Z south. The terrain is centred on the origin, so
//! pixel (0, 0), the north-west corner, sits at (-width/2, h, -depth/2). Sea level is y = 0.

/// Heights in metres on a regular grid, row 0 = north.
#[derive(Clone, Debug)]
pub struct Heightfield {
    pub width: usize,
    pub depth: usize,
    /// Metres between columns (east-west) and rows (north-south).
    pub spacing: [f32; 2],
    pub heights: Vec<f32>,
}

impl Heightfield {
    /// From a 16-bit greyscale PNG whose 0..65535 maps linearly onto `range` metres.
    pub fn from_png16(bytes: &[u8], range: [f32; 2], spacing: [f32; 2]) -> Result<Self, String> {
        let mut dec = png::Decoder::new(std::io::Cursor::new(bytes));
        dec.set_transformations(png::Transformations::IDENTITY);
        let mut reader = dec.read_info().map_err(|e| e.to_string())?;
        let info = reader.info();
        if info.bit_depth != png::BitDepth::Sixteen || info.color_type != png::ColorType::Grayscale {
            return Err(format!("heightmap must be 16-bit greyscale, got {:?} {:?}", info.bit_depth, info.color_type));
        }
        let (width, depth) = (info.width as usize, info.height as usize);
        let mut buf = vec![0; reader.output_buffer_size().ok_or("heightmap too large")?];
        reader.next_frame(&mut buf).map_err(|e| e.to_string())?;
        let scale = (range[1] - range[0]) / 65535.0;
        let heights = buf[..width * depth * 2]
            .chunks_exact(2)
            .map(|b| range[0] + f32::from(u16::from_be_bytes([b[0], b[1]])) * scale)
            .collect();
        Ok(Self { width, depth, spacing, heights })
    }

    /// Size in metres, east-west and north-south.
    pub fn extent(&self) -> [f32; 2] {
        [(self.width - 1) as f32 * self.spacing[0], (self.depth - 1) as f32 * self.spacing[1]]
    }

    pub fn at(&self, col: usize, row: usize) -> f32 {
        self.heights[row.min(self.depth - 1) * self.width + col.min(self.width - 1)]
    }

    /// World x, z of a grid point.
    pub fn world_xz(&self, col: usize, row: usize) -> [f32; 2] {
        let [w, d] = self.extent();
        [col as f32 * self.spacing[0] - w / 2.0, row as f32 * self.spacing[1] - d / 2.0]
    }

    /// Whether world x, z lies over the heightfield.
    pub fn contains(&self, x: f32, z: f32) -> bool {
        let [w, d] = self.extent();
        x.abs() <= w / 2.0 && z.abs() <= d / 2.0
    }

    /// Ground height at world x, z (bilinear; clamped at the edges).
    pub fn height(&self, x: f32, z: f32) -> f32 {
        let [w, d] = self.extent();
        let fx = ((x + w / 2.0) / self.spacing[0]).clamp(0.0, (self.width - 1) as f32);
        let fz = ((z + d / 2.0) / self.spacing[1]).clamp(0.0, (self.depth - 1) as f32);
        let (c, r) = (fx.floor() as usize, fz.floor() as usize);
        let (tx, tz) = (fx - c as f32, fz - r as f32);
        let top = self.at(c, r) * (1.0 - tx) + self.at(c + 1, r) * tx;
        let bottom = self.at(c, r + 1) * (1.0 - tx) + self.at(c + 1, r + 1) * tx;
        top * (1.0 - tz) + bottom * tz
    }

    /// Unit surface normal at a grid point (central differences).
    pub fn normal(&self, col: usize, row: usize) -> [f32; 3] {
        let l = self.at(col.saturating_sub(1), row);
        let r = self.at(col + 1, row);
        let u = self.at(col, row.saturating_sub(1));
        let d = self.at(col, row + 1);
        let n = [(l - r) / (2.0 * self.spacing[0]), 1.0, (u - d) / (2.0 * self.spacing[1])];
        let len = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
        [n[0] / len, n[1] / len, n[2] / len]
    }

    pub fn max_height(&self) -> f32 {
        self.heights.iter().copied().fold(f32::MIN, f32::max)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ramp() -> Heightfield {
        // 3x3, rising 10 m per column eastwards, 10 m spacing.
        let heights = (0..9).map(|i| (i % 3) as f32 * 10.0).collect();
        Heightfield { width: 3, depth: 3, spacing: [10.0, 10.0], heights }
    }

    #[test]
    fn centred_and_bilinear() {
        let h = ramp();
        assert_eq!(h.extent(), [20.0, 20.0]);
        assert_eq!(h.world_xz(0, 0), [-10.0, -10.0]);
        assert!((h.height(0.0, 0.0) - 10.0).abs() < 1e-5);
        assert!((h.height(-5.0, 3.0) - 5.0).abs() < 1e-5);
        assert!((h.height(99.0, 0.0) - 20.0).abs() < 1e-5, "clamped at the edge");
    }

    #[test]
    fn normal_leans_downhill() {
        let n = ramp().normal(1, 1);
        assert!(n[0] < 0.0 && n[1] > 0.0 && n[2].abs() < 1e-6, "{n:?}");
    }
}
