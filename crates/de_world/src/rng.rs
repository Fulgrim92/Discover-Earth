//! Seeded random numbers. All randomness in the game goes through this, seeded from content,
//! so the same content gives the same world and the same captures on every run.
//!
//! SplitMix64 (Steele, Lea and Flood, 2014): tiny, fast, and good enough for scenery and wind.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// A seeded random number generator. Its whole state is one number, so it saves and restores
/// with the rest of the world.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: impl Into<u64>) -> Self {
        Self(seed.into())
    }

    pub fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    /// Uniform in 0..1.
    pub fn next_f64(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 / (1u64 << 53) as f64
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seeded_and_in_range() {
        let a: Vec<u64> = {
            let mut r = Rng::new(7u32);
            (0..5).map(|_| r.next_u64()).collect()
        };
        let b: Vec<u64> = {
            let mut r = Rng::new(7u32);
            (0..5).map(|_| r.next_u64()).collect()
        };
        assert_eq!(a, b);
        assert_ne!(a[0], Rng::new(8u32).next_u64());
        let mut r = Rng::new(1u64);
        let v: Vec<f64> = (0..10_000).map(|_| r.next_f64()).collect();
        assert!(v.iter().all(|x| (0.0..1.0).contains(x)));
        let mean = v.iter().sum::<f64>() / v.len() as f64;
        assert!((mean - 0.5).abs() < 0.02, "{mean}");
    }

    #[test]
    fn known_first_value() {
        // SplitMix64's published first output for seed 0.
        assert_eq!(Rng::new(0u64).next_u64(), 0xE220_A839_7B1D_CDAF);
    }
}
