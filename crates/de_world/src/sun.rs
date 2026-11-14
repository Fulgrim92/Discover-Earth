//! Where the sun is: azimuth and elevation for a place and a moment, so a render can be lit as
//! the real place was when a photo was taken.
//!
//! NOAA's solar position equations (from Meeus, "Astronomical Algorithms", 1991), good to a few
//! hundredths of a degree for 1800-2100, which is far finer than the light needs.

/// A moment in UTC, parsed from `YYYY-MM-DDTHH:MM:SSZ` (seconds and `Z` optional).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Utc {
    pub year: i32,
    pub month: u32,
    pub day: u32,
    pub hour: u32,
    pub minute: u32,
    pub second: u32,
}

impl Utc {
    pub fn parse(s: &str) -> Result<Self, String> {
        let bad = || format!("`{s}` is not a UTC time like 2019-05-20T16:54:07Z");
        let s2 = s.trim().trim_end_matches('Z');
        let (date, time) = s2.split_once('T').ok_or_else(bad)?;
        let d: Vec<&str> = date.split('-').collect();
        let t: Vec<&str> = time.split(':').collect();
        if d.len() != 3 || !(2..=3).contains(&t.len()) {
            return Err(bad());
        }
        let n = |x: &str| x.parse::<u32>().map_err(|_| bad());
        let u = Self {
            year: d[0].parse().map_err(|_| bad())?,
            month: n(d[1])?,
            day: n(d[2])?,
            hour: n(t[0])?,
            minute: n(t[1])?,
            second: if t.len() == 3 { n(t[2])? } else { 0 },
        };
        if !(1..=12).contains(&u.month) || !(1..=31).contains(&u.day) || u.hour > 23 || u.minute > 59 || u.second > 60 {
            return Err(bad());
        }
        Ok(u)
    }

    /// Julian day number, with the time of day as a fraction.
    pub fn julian_day(&self) -> f64 {
        let (mut y, mut m) = (self.year as f64, self.month as f64);
        if m <= 2.0 {
            y -= 1.0;
            m += 12.0;
        }
        let a = (y / 100.0).floor();
        let b = 2.0 - a + (a / 4.0).floor();
        let day = self.day as f64 + (self.hour as f64 + (self.minute as f64 + self.second as f64 / 60.0) / 60.0) / 24.0;
        (365.25 * (y + 4716.0)).floor() + (30.6001 * (m + 1.0)).floor() + day + b - 1524.5
    }
}

/// The sun seen from `lat`, `lon` (degrees, east positive) at `when`: compass azimuth (0 north,
/// 90 east) and elevation above the horizon, degrees, with atmospheric refraction.
pub fn position(lat: f64, lon: f64, when: &Utc) -> (f64, f64) {
    let jc = (when.julian_day() - 2_451_545.0) / 36_525.0;
    let rad = f64::to_radians;
    let deg = f64::to_degrees;

    let l0 = (280.46646 + jc * (36000.76983 + jc * 0.0003032)).rem_euclid(360.0);
    let m = 357.52911 + jc * (35999.05029 - 0.0001537 * jc);
    let e = 0.016708634 - jc * (0.000042037 + 0.0000001267 * jc);
    let c = rad(m).sin() * (1.914602 - jc * (0.004817 + 0.000014 * jc))
        + rad(2.0 * m).sin() * (0.019993 - 0.000101 * jc)
        + rad(3.0 * m).sin() * 0.000289;
    let true_long = l0 + c;
    let omega = 125.04 - 1934.136 * jc;
    let app_long = true_long - 0.00569 - 0.00478 * rad(omega).sin();
    let obliq0 = 23.0 + (26.0 + (21.448 - jc * (46.815 + jc * (0.00059 - jc * 0.001813))) / 60.0) / 60.0;
    let obliq = obliq0 + 0.00256 * rad(omega).cos();
    let decl = deg((rad(obliq).sin() * rad(app_long).sin()).asin());

    let y = rad(obliq / 2.0).tan().powi(2);
    let eq_time = 4.0
        * deg(y * (2.0 * rad(l0)).sin() - 2.0 * e * rad(m).sin() + 4.0 * e * y * rad(m).sin() * (2.0 * rad(l0)).cos()
            - 0.5 * y * y * (4.0 * rad(l0)).sin()
            - 1.25 * e * e * (2.0 * rad(m)).sin());

    let minutes = when.hour as f64 * 60.0 + when.minute as f64 + when.second as f64 / 60.0;
    let true_solar = (minutes + eq_time + 4.0 * lon).rem_euclid(1440.0);
    let hour_angle = if true_solar / 4.0 < 0.0 { true_solar / 4.0 + 180.0 } else { true_solar / 4.0 - 180.0 };

    let (lat_r, decl_r, ha_r) = (rad(lat), rad(decl), rad(hour_angle));
    let cos_zen = (lat_r.sin() * decl_r.sin() + lat_r.cos() * decl_r.cos() * ha_r.cos()).clamp(-1.0, 1.0);
    let zenith = deg(cos_zen.acos());
    let elevation = 90.0 - zenith;

    // Azimuth from north, clockwise.
    let denom = lat_r.cos() * rad(zenith).sin();
    let az = if denom.abs() < 1e-9 {
        if lat > 0.0 { 180.0 } else { 0.0 }
    } else {
        let a = ((lat_r.sin() * cos_zen - decl_r.sin()) / denom).clamp(-1.0, 1.0);
        let a = deg(a.acos());
        if hour_angle > 0.0 { (a + 180.0).rem_euclid(360.0) } else { (540.0 - a).rem_euclid(360.0) }
    };

    // Refraction lifts the sun near the horizon (about half a degree at the horizon itself).
    let refraction = if elevation > 85.0 {
        0.0
    } else {
        let te = rad(elevation).tan();
        let arcsec = if elevation > 5.0 {
            58.1 / te - 0.07 / te.powi(3) + 0.000086 / te.powi(5)
        } else if elevation > -0.575 {
            1735.0 + elevation * (-518.2 + elevation * (103.4 + elevation * (-12.79 + elevation * 0.711)))
        } else {
            -20.772 / te
        };
        arcsec / 3600.0
    };
    (az, elevation + refraction)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(s: &str) -> Utc {
        Utc::parse(s).unwrap()
    }

    #[test]
    fn julian_day_of_j2000() {
        assert!((at("2000-01-01T12:00:00Z").julian_day() - 2_451_545.0).abs() < 1e-9);
    }

    #[test]
    fn matches_noaa_calculator() {
        // NOAA solar calculator (gml.noaa.gov/grad/solcalc): Greenwich, 2020-06-21 12:00 UTC,
        // elevation 61.9 (with refraction), azimuth about 179.
        let (az, el) = position(51.4769, 0.0, &at("2020-06-21T12:00:00Z"));
        assert!((el - 61.95).abs() < 0.1, "elevation {el}");
        assert!((az - 179.0).abs() < 1.5, "azimuth {az}");
        // Saksun, midsummer evening: low in the north-west.
        let (az, el) = position(62.25, -7.18, &at("2019-06-21T21:00:00Z"));
        assert!((300.0..330.0).contains(&az) && (0.0..8.0).contains(&el), "az {az} el {el}");
        // Winter noon in the Faroes: barely up, in the south.
        let (az, el) = position(62.25, -7.18, &at("2019-12-21T12:30:00Z"));
        assert!((170.0..190.0).contains(&az) && (3.0..6.0).contains(&el), "az {az} el {el}");
    }

    #[test]
    fn parse_rejects_nonsense() {
        assert!(Utc::parse("2019-05-20").is_err());
        assert!(Utc::parse("2019-13-01T10:00Z").is_err());
        assert_eq!(at("2019-05-20T16:54Z").minute, 54);
    }
}
