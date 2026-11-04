//! Digests the cache verifies downloads against: npm `dist.integrity` (SRI), PyPI `#sha256=` fragments, and crates.io
//! `cksum`. A download is stored only when its bytes hash to the digest. SHA-1 is not accepted anywhere: npm's
//! `dist.shasum` is not verified, so a packument that lists only that is not rewritten.

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256, Sha512};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Algo {
    Sha512,
    Sha256,
}

impl Algo {
    pub fn name(self) -> &'static str {
        match self {
            Self::Sha512 => "sha512",
            Self::Sha256 => "sha256",
        }
    }

    fn from_sri_name(name: &str) -> Option<Self> {
        match name {
            "sha512" => Some(Self::Sha512),
            "sha256" => Some(Self::Sha256),
            _ => None,
        }
    }

    fn digest_len(self) -> usize {
        match self {
            Self::Sha512 => 64,
            Self::Sha256 => 32,
        }
    }

    /// Preference when an SRI string lists several algorithms.
    fn strength(self) -> u8 {
        match self {
            Self::Sha512 => 2,
            Self::Sha256 => 1,
        }
    }
}

/// The digest a download must match, as lowercase hex.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Expected {
    pub algo: Algo,
    pub hex: String,
}

/// Parses an SRI `integrity` value (`sha512-<base64>`, possibly several space-separated entries, each with optional
/// `?options`) and returns the strongest entry that can be verified. Unknown or malformed entries are ignored; `None`
/// means nothing in it is verifiable.
pub fn parse_sri(integrity: &str) -> Option<Expected> {
    integrity
        .split_ascii_whitespace()
        .filter_map(|entry| {
            let entry = entry.split('?').next()?;
            let (name, encoded) = entry.split_once('-')?;
            let algo = Algo::from_sri_name(name)?;
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(encoded)
                .ok()?;
            (bytes.len() == algo.digest_len()).then(|| Expected {
                algo,
                hex: hex::encode(bytes),
            })
        })
        .max_by_key(|expected| expected.algo.strength())
}

/// A bare hex digest of the given algorithm (PyPI `sha256=` fragments, crates.io `cksum`).
pub fn parse_hex(algo: Algo, hex: &str) -> Option<Expected> {
    (hex.len() == algo.digest_len() * 2 && hex.bytes().all(|b| b.is_ascii_hexdigit())).then(|| {
        Expected {
            algo,
            hex: hex.to_ascii_lowercase(),
        }
    })
}

/// Incremental hasher for one algorithm.
pub enum Hasher {
    Sha512(Sha512),
    Sha256(Sha256),
}

impl Hasher {
    pub fn new(algo: Algo) -> Self {
        match algo {
            Algo::Sha512 => Self::Sha512(Sha512::new()),
            Algo::Sha256 => Self::Sha256(Sha256::new()),
        }
    }

    pub fn update(&mut self, data: &[u8]) {
        match self {
            Self::Sha512(h) => h.update(data),
            Self::Sha256(h) => h.update(data),
        }
    }

    pub fn finish_hex(self) -> String {
        match self {
            Self::Sha512(h) => hex::encode(h.finalize()),
            Self::Sha256(h) => hex::encode(h.finalize()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sri(algo_name: &str, bytes: &[u8]) -> String {
        let encoded = match algo_name {
            "sha512" => base64::engine::general_purpose::STANDARD.encode(Sha512::digest(bytes)),
            "sha1" => base64::engine::general_purpose::STANDARD.encode([0u8; 20]),
            _ => unreachable!("test helper only knows sha512 and sha1"),
        };
        format!("{algo_name}-{encoded}")
    }

    #[test]
    fn sri_picks_the_strongest_verifiable_entry() {
        let data = b"hello";
        let integrity = format!("{} {}", sri("sha1", data), sri("sha512", data));
        let expected = parse_sri(&integrity).expect("verifiable");
        assert_eq!(expected.algo, Algo::Sha512);
        assert_eq!(expected.hex, hex::encode(Sha512::digest(data)));
    }

    #[test]
    fn sri_without_sha256_or_sha512_is_not_verifiable() {
        assert_eq!(parse_sri(&sri("sha1", b"hello")), None);
    }

    #[test]
    fn sri_rejects_unknown_algorithms_wrong_lengths_and_garbage() {
        let short = format!(
            "sha512-{}",
            base64::engine::general_purpose::STANDARD.encode([0u8; 32])
        );
        assert_eq!(parse_sri(&short), None);
        assert_eq!(parse_sri("md5-AAAAAAAAAAAAAAAAAAAAAA=="), None);
        assert_eq!(parse_sri("not an integrity value"), None);
    }

    #[test]
    fn hex_digests_are_length_checked_and_lowercased() {
        let upper = "2CF24DBA5FB0A30E26E83B2AC5B9E29E1B161E5C1FA7425E73043362938B9824";
        assert_eq!(
            parse_hex(Algo::Sha256, upper).map(|e| e.hex),
            Some(upper.to_ascii_lowercase())
        );
        assert_eq!(parse_hex(Algo::Sha256, &upper[..63]), None);
        assert_eq!(parse_hex(Algo::Sha256, &"z".repeat(64)), None);
    }

    #[test]
    fn hasher_produces_the_standard_digest() {
        let mut hasher = Hasher::new(Algo::Sha256);
        hasher.update(b"hel");
        hasher.update(b"lo");
        assert_eq!(
            hasher.finish_hex(),
            "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
        );
    }
}
