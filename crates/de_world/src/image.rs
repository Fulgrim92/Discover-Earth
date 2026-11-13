//! Plain RGBA images for the capture tools: read and write PNGs, scale, draw labels and lay
//! out contact sheets. No GPU, so sheets and stats can be made anywhere from files on disk.

use std::path::Path;

/// An 8-bit sRGB RGBA image, rows top to bottom.
#[derive(Clone, Debug, PartialEq)]
pub struct Rgba {
    pub width: u32,
    pub height: u32,
    pub pixels: Vec<[u8; 4]>,
}

impl Rgba {
    pub fn new(width: u32, height: u32, fill: [u8; 4]) -> Self {
        Self { width, height, pixels: vec![fill; (width * height) as usize] }
    }

    pub fn get(&self, x: u32, y: u32) -> [u8; 4] {
        self.pixels[(y.min(self.height - 1) * self.width + x.min(self.width - 1)) as usize]
    }

    pub fn set(&mut self, x: u32, y: u32, c: [u8; 4]) {
        if x < self.width && y < self.height {
            self.pixels[(y * self.width + x) as usize] = c;
        }
    }

    /// Reads an 8-bit RGB or RGBA PNG (16-bit is reduced to 8).
    pub fn load(path: &Path) -> Result<Self, String> {
        let file = std::fs::File::open(path).map_err(|e| format!("{}: {e}", path.display()))?;
        let mut dec = png::Decoder::new(std::io::BufReader::new(file));
        dec.set_transformations(png::Transformations::normalize_to_color8());
        let mut reader = dec.read_info().map_err(|e| format!("{}: {e}", path.display()))?;
        let mut buf = vec![0; reader.output_buffer_size().ok_or("image too large")?];
        let info = reader.next_frame(&mut buf).map_err(|e| format!("{}: {e}", path.display()))?;
        let px = |c: &[u8]| match c.len() {
            1 => [c[0], c[0], c[0], 255],
            2 => [c[0], c[0], c[0], c[1]],
            3 => [c[0], c[1], c[2], 255],
            _ => [c[0], c[1], c[2], c[3]],
        };
        let n = info.color_type.samples();
        let pixels = buf[..info.buffer_size()].chunks_exact(n).map(px).collect();
        Ok(Self { width: info.width, height: info.height, pixels })
    }

    pub fn save(&self, path: &Path) -> Result<(), String> {
        let file = std::fs::File::create(path).map_err(|e| format!("{}: {e}", path.display()))?;
        let mut enc = png::Encoder::new(std::io::BufWriter::new(file), self.width, self.height);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        let mut w = enc.write_header().map_err(|e| e.to_string())?;
        let bytes: Vec<u8> = self.pixels.iter().flatten().copied().collect();
        w.write_image_data(&bytes).map_err(|e| e.to_string())
    }

    /// Box-filtered resize (area average when shrinking).
    pub fn resize(&self, width: u32, height: u32) -> Self {
        let mut out = Self::new(width, height, [0, 0, 0, 255]);
        let (sx, sy) = (self.width as f32 / width as f32, self.height as f32 / height as f32);
        for y in 0..height {
            for x in 0..width {
                let (x0, y0) = ((x as f32 * sx) as u32, (y as f32 * sy) as u32);
                let (x1, y1) = ((((x + 1) as f32 * sx) as u32).max(x0 + 1), (((y + 1) as f32 * sy) as u32).max(y0 + 1));
                let mut acc = [0u32; 4];
                let mut n = 0;
                for yy in y0..y1.min(self.height) {
                    for xx in x0..x1.min(self.width) {
                        let p = self.get(xx, yy);
                        (0..4).for_each(|i| acc[i] += u32::from(p[i]));
                        n += 1;
                    }
                }
                let n = n.max(1);
                out.set(x, y, acc.map(|a| (a / n) as u8));
            }
        }
        out
    }

    /// Copy `src` onto this image with its top-left corner at (x, y).
    pub fn blit(&mut self, src: &Rgba, x: u32, y: u32) {
        for sy in 0..src.height {
            for sx in 0..src.width {
                self.set(x + sx, y + sy, src.get(sx, sy));
            }
        }
    }

    pub fn fill_rect(&mut self, x: u32, y: u32, w: u32, h: u32, c: [u8; 4]) {
        for yy in y..y + h {
            for xx in x..x + w {
                self.set(xx, yy, c);
            }
        }
    }

    /// Draw `text` with the built-in 5x7 font at `scale`, on a dark box so it reads on any image.
    pub fn label(&mut self, x: u32, y: u32, text: &str, scale: u32) {
        let w = text_width(text, scale);
        self.fill_rect(x, y, w + 4 * scale, 9 * scale + 2 * scale, [0, 0, 0, 200]);
        self.text(x + 2 * scale, y + 2 * scale, text, scale, [255, 255, 255, 255]);
    }

    pub fn text(&mut self, x: u32, y: u32, text: &str, scale: u32, c: [u8; 4]) {
        let mut cx = x;
        for ch in text.chars() {
            let rows = glyph(ch.to_ascii_uppercase());
            for (ry, row) in rows.iter().enumerate() {
                for rx in 0..5 {
                    if row & (0b10000 >> rx) != 0 {
                        self.fill_rect(cx + rx * scale, y + ry as u32 * scale, scale, scale, c);
                    }
                }
            }
            cx += 6 * scale;
        }
    }
}

pub fn text_width(text: &str, scale: u32) -> u32 {
    (text.chars().count() as u32 * 6).saturating_sub(1) * scale
}

/// Relative luminance (Rec. 709) of an sRGB pixel, 0..1, computed on linear values.
pub fn luminance(p: [u8; 4]) -> f32 {
    let lin = |c: u8| {
        let c = f32::from(c) / 255.0;
        if c <= 0.04045 { c / 12.92 } else { ((c + 0.055) / 1.055).powf(2.4) }
    };
    0.2126 * lin(p[0]) + 0.7152 * lin(p[1]) + 0.0722 * lin(p[2])
}

/// Perceptual lightness of an sRGB pixel, 0..1 (gamma-encoded luma; what "brightness" looks like).
pub fn luma(p: [u8; 4]) -> f32 {
    (0.2126 * f32::from(p[0]) + 0.7152 * f32::from(p[1]) + 0.0722 * f32::from(p[2])) / 255.0
}

/// One cell of a contact sheet: an image and the label drawn on it.
pub struct Cell {
    pub image: Rgba,
    pub label: String,
}

/// Lay `cells` out in a grid `cols` wide, each scaled to `cell_w` pixels wide, with a title bar.
pub fn sheet(title: &str, cells: &[Cell], cols: usize, cell_w: u32) -> Rgba {
    let cols = cols.max(1).min(cells.len().max(1));
    let rows = cells.len().div_ceil(cols).max(1);
    let aspect = cells.first().map(|c| c.image.height as f32 / c.image.width as f32).unwrap_or(0.5625);
    let cell_h = (cell_w as f32 * aspect).round() as u32;
    let (gap, top) = (4, 30);
    let width = cols as u32 * (cell_w + gap) + gap;
    let height = top + rows as u32 * (cell_h + gap) + gap;
    let mut out = Rgba::new(width, height, [24, 24, 28, 255]);
    out.text(gap + 4, 8, title, 2, [235, 235, 235, 255]);
    for (i, cell) in cells.iter().enumerate() {
        let (c, r) = ((i % cols) as u32, (i / cols) as u32);
        let (x, y) = (gap + c * (cell_w + gap), top + r * (cell_h + gap));
        out.blit(&cell.image.resize(cell_w, cell_h), x, y);
        out.label(x + 4, y + 4, &cell.label, 2);
    }
    out
}

/// 5x7 glyphs, one byte per row, high bit on the left. Unknown characters draw as a box.
fn glyph(c: char) -> [u8; 7] {
    match c {
        'A' => [14, 17, 17, 31, 17, 17, 17],
        'B' => [30, 17, 17, 30, 17, 17, 30],
        'C' => [14, 17, 16, 16, 16, 17, 14],
        'D' => [30, 17, 17, 17, 17, 17, 30],
        'E' => [31, 16, 16, 30, 16, 16, 31],
        'F' => [31, 16, 16, 30, 16, 16, 16],
        'G' => [14, 17, 16, 23, 17, 17, 15],
        'H' => [17, 17, 17, 31, 17, 17, 17],
        'I' => [14, 4, 4, 4, 4, 4, 14],
        'J' => [7, 2, 2, 2, 2, 18, 12],
        'K' => [17, 18, 20, 24, 20, 18, 17],
        'L' => [16, 16, 16, 16, 16, 16, 31],
        'M' => [17, 27, 21, 21, 17, 17, 17],
        'N' => [17, 17, 25, 21, 19, 17, 17],
        'O' => [14, 17, 17, 17, 17, 17, 14],
        'P' => [30, 17, 17, 30, 16, 16, 16],
        'Q' => [14, 17, 17, 17, 21, 18, 13],
        'R' => [30, 17, 17, 30, 20, 18, 17],
        'S' => [15, 16, 16, 14, 1, 1, 30],
        'T' => [31, 4, 4, 4, 4, 4, 4],
        'U' => [17, 17, 17, 17, 17, 17, 14],
        'V' => [17, 17, 17, 17, 17, 10, 4],
        'W' => [17, 17, 17, 21, 21, 21, 10],
        'X' => [17, 17, 10, 4, 10, 17, 17],
        'Y' => [17, 17, 10, 4, 4, 4, 4],
        'Z' => [31, 1, 2, 4, 8, 16, 31],
        '0' => [14, 17, 19, 21, 25, 17, 14],
        '1' => [4, 12, 4, 4, 4, 4, 14],
        '2' => [14, 17, 1, 2, 4, 8, 31],
        '3' => [31, 2, 4, 2, 1, 17, 14],
        '4' => [2, 6, 10, 18, 31, 2, 2],
        '5' => [31, 16, 30, 1, 1, 17, 14],
        '6' => [6, 8, 16, 30, 17, 17, 14],
        '7' => [31, 1, 2, 4, 8, 8, 8],
        '8' => [14, 17, 17, 14, 17, 17, 14],
        '9' => [14, 17, 17, 15, 1, 2, 12],
        ' ' => [0; 7],
        '.' => [0, 0, 0, 0, 0, 12, 12],
        ',' => [0, 0, 0, 0, 12, 4, 8],
        ':' => [0, 12, 12, 0, 12, 12, 0],
        '-' => [0, 0, 0, 31, 0, 0, 0],
        '+' => [0, 4, 4, 31, 4, 4, 0],
        '=' => [0, 0, 31, 0, 31, 0, 0],
        '_' => [0, 0, 0, 0, 0, 0, 31],
        '/' => [1, 1, 2, 4, 8, 16, 16],
        '%' => [24, 25, 2, 4, 8, 19, 3],
        '(' => [2, 4, 8, 8, 8, 4, 2],
        ')' => [8, 4, 2, 2, 2, 4, 8],
        '[' => [14, 8, 8, 8, 8, 8, 14],
        ']' => [14, 2, 2, 2, 2, 2, 14],
        '#' => [10, 10, 31, 10, 31, 10, 10],
        '*' => [0, 21, 14, 31, 14, 21, 0],
        _ => [31, 17, 17, 17, 17, 17, 31],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resize_averages() {
        let mut img = Rgba::new(2, 2, [0, 0, 0, 255]);
        img.set(0, 0, [200, 100, 0, 255]);
        let one = img.resize(1, 1);
        assert_eq!(one.pixels[0], [50, 25, 0, 255]);
    }

    #[test]
    fn sheet_lays_out_a_grid() {
        let cells: Vec<Cell> =
            (0..5).map(|i| Cell { image: Rgba::new(160, 90, [i * 40, 0, 0, 255]), label: format!("v{i}") }).collect();
        let s = sheet("test", &cells, 3, 80);
        // 3 columns of 80 + gaps, 2 rows of 45 + gaps + title.
        assert_eq!(s.width, 3 * 84 + 4);
        assert_eq!(s.height, 30 + 2 * 49 + 4);
    }

    #[test]
    fn png_round_trip() {
        let dir = std::env::temp_dir().join(format!("de_img_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut img = Rgba::new(7, 3, [1, 2, 3, 255]);
        img.label(0, 0, "A1", 1);
        let p = dir.join("a.png");
        img.save(&p).unwrap();
        assert_eq!(Rgba::load(&p).unwrap(), img);
    }
}
