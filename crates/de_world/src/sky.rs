//! The clear daylight sky: how bright and what colour each direction is, for a sun height and a
//! haziness. Preetham, Shirley and Smits, "A Practical Analytic Model for Daylight" (SIGGRAPH
//! 1999): the Perez sky formula with coefficients fitted to turbidity, and the zenith's
//! luminance and chromaticity. The renderer evaluates the same formula per pixel from the
//! numbers here (`clouds.wesl`), so this is also its reference.
//!
//! Good from the sun a few degrees up to overhead; it has no twilight.

/// Perez coefficients A..E for one channel.
pub type Perez = [f32; 5];

/// Everything the renderer needs for one sky: Perez coefficients for luminance Y and
/// chromaticity x, y, and each channel's zenith value already divided by the formula at the
/// zenith, so `value(dir) = scale * perez(theta, gamma)`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Sky {
    pub y: Perez,
    pub cx: Perez,
    pub cy: Perez,
    /// Zenith luminance (cd/m²), x and y, each over the formula's value at the zenith.
    pub scale: [f32; 3],
}

impl Sky {
    /// The sky for a sun `sun_elevation_deg` above the horizon and a `turbidity` (2 very clear
    /// .. 3 clear .. 6 hazy .. 10 thick haze).
    pub fn new(sun_elevation_deg: f32, turbidity: f32) -> Self {
        let t = turbidity.clamp(1.7, 12.0);
        let theta_s = (90.0 - sun_elevation_deg.clamp(0.5, 90.0)).to_radians();
        let y = [
            0.1787 * t - 1.4630,
            -0.3554 * t + 0.4275,
            -0.0227 * t + 5.3251,
            0.1206 * t - 2.5771,
            -0.0670 * t + 0.3703,
        ];
        let cx = [
            -0.0193 * t - 0.2592,
            -0.0665 * t + 0.0008,
            -0.0004 * t + 0.2125,
            -0.0641 * t - 0.8989,
            -0.0033 * t + 0.0452,
        ];
        let cy = [
            -0.0167 * t - 0.2608,
            -0.0950 * t + 0.0092,
            -0.0079 * t + 0.2102,
            -0.0441 * t - 1.6537,
            -0.0109 * t + 0.0529,
        ];

        let chi = (4.0 / 9.0 - t / 120.0) * (std::f32::consts::PI - 2.0 * theta_s);
        // kcd/m² in the paper.
        let yz = ((4.0453 * t - 4.9710) * chi.tan() - 0.2155 * t + 2.4192) * 1000.0;
        let (s, s2, s3) = (theta_s, theta_s * theta_s, theta_s * theta_s * theta_s);
        let xz = t * t * (0.00166 * s3 - 0.00375 * s2 + 0.00209 * s)
            + t * (-0.02903 * s3 + 0.06377 * s2 - 0.03202 * s + 0.00394)
            + (0.11693 * s3 - 0.21196 * s2 + 0.06052 * s + 0.25886);
        let yz_c = t * t * (0.00275 * s3 - 0.00610 * s2 + 0.00317 * s)
            + t * (-0.04214 * s3 + 0.08970 * s2 - 0.04153 * s + 0.00516)
            + (0.15346 * s3 - 0.26756 * s2 + 0.06670 * s + 0.26688);
        let at_zenith = |p: &Perez| perez(p, 0.0, theta_s);
        Self { y, cx, cy, scale: [yz.max(0.0) / at_zenith(&y), xz / at_zenith(&cx), yz_c / at_zenith(&cy)] }
    }

    /// Luminance (cd/m²) and chromaticity x, y of the sky `theta` from the zenith and `gamma`
    /// from the sun (radians). Below the horizon it gives the horizon's value.
    pub fn xyy(&self, theta: f32, gamma: f32) -> [f32; 3] {
        let theta = theta.min(std::f32::consts::FRAC_PI_2 - 0.01);
        [
            self.scale[0] * perez(&self.y, theta, gamma),
            self.scale[1] * perez(&self.cx, theta, gamma),
            self.scale[2] * perez(&self.cy, theta, gamma),
        ]
    }

    /// Linear sRGB radiance (cd/m² scale) of the sky in a direction.
    pub fn rgb(&self, theta: f32, gamma: f32) -> [f32; 3] {
        xyy_to_linear_srgb(self.xyy(theta, gamma))
    }
}

/// The Perez formula: (1 + A e^(B / cos θ)) (1 + C e^(D γ) + E cos² γ).
pub fn perez(p: &Perez, theta: f32, gamma: f32) -> f32 {
    let cos_t = theta.cos().max(0.01);
    let cos_g = gamma.cos();
    (1.0 + p[0] * (p[1] / cos_t).exp()) * (1.0 + p[2] * (p[3] * gamma).exp() + p[4] * cos_g * cos_g)
}

/// CIE xyY to linear sRGB (D65).
pub fn xyy_to_linear_srgb([lum, x, y]: [f32; 3]) -> [f32; 3] {
    let y = y.max(1e-4);
    let (cx, cy, cz) = (x / y * lum, lum, (1.0 - x - y) / y * lum);
    [
        (3.2406 * cx - 1.5372 * cy - 0.4986 * cz).max(0.0),
        (-0.9689 * cx + 1.8758 * cy + 0.0415 * cz).max(0.0),
        (0.0557 * cx - 0.2040 * cy + 1.0570 * cz).max(0.0),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zenith_matches_the_paper() {
        // Preetham et al. figure 9 / table: turbidity 2, sun 45° up: zenith about 8 kcd/m²,
        // x about 0.24, y about 0.25.
        let sky = Sky::new(45.0, 2.0);
        let [l, x, y] = sky.xyy(0.0, 45f32.to_radians());
        assert!((4000.0..12000.0).contains(&l), "zenith {l}");
        assert!((0.22..0.27).contains(&x) && (0.23..0.28).contains(&y), "x {x} y {y}");
    }

    #[test]
    fn blue_overhead_whiter_at_the_horizon_and_bright_by_the_sun() {
        let sky = Sky::new(34.0, 3.0);
        let zen = sky.rgb(0.0, 56f32.to_radians());
        assert!(zen[2] > zen[0] * 1.3, "zenith should be blue: {zen:?}");
        // Looking away from the sun, low down: paler (less blue relative to red) than overhead.
        let low = sky.rgb(85f32.to_radians(), 150f32.to_radians());
        assert!(low[2] / low[0] < zen[2] / zen[0], "horizon {low:?} zenith {zen:?}");
        // Near the sun much brighter than away from it.
        let near = sky.rgb(60f32.to_radians(), 5f32.to_radians());
        let away = sky.rgb(60f32.to_radians(), 120f32.to_radians());
        assert!(near[1] > 2.0 * away[1]);
        // Haze makes it whiter.
        let hazy = Sky::new(34.0, 8.0).rgb(0.0, 56f32.to_radians());
        assert!(hazy[2] / hazy[0] < zen[2] / zen[0]);
    }

    #[test]
    fn follows_the_sun() {
        // A higher sun lights the sky more.
        let low = Sky::new(10.0, 3.0).xyy(0.0, 80f32.to_radians())[0];
        let high = Sky::new(50.0, 3.0).xyy(0.0, 40f32.to_radians())[0];
        assert!(high > low * 1.5, "low {low} high {high}");
    }
}
