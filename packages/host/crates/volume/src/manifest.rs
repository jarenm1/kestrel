//! Manifests and object-store key layout. A manifest lists every 4 MiB chunk of a volume by content-keyed name; a zero
//! chunk is `null` and needs no object. The manifest key is the `volumeRef` the control plane records.

use anyhow::{Context, Result, bail, ensure};
use serde::{Deserialize, Serialize};

pub const CHUNK_SIZE: u64 = 4 * 1024 * 1024;
pub const MANIFEST_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub version: u32,
    pub box_id: String,
    pub size_bytes: u64,
    pub chunk_size: u64,
    pub chunks: Vec<Option<String>>,
    pub created_at: String,
}

impl Manifest {
    pub fn new(
        box_id: &str,
        size_bytes: u64,
        chunks: Vec<Option<String>>,
        created_at: String,
    ) -> Self {
        Self {
            version: MANIFEST_VERSION,
            box_id: box_id.to_owned(),
            size_bytes,
            chunk_size: CHUNK_SIZE,
            chunks,
            created_at,
        }
    }

    pub fn parse(bytes: &[u8], box_id: &str) -> Result<Self> {
        let manifest: Manifest =
            serde_json::from_slice(bytes).context("manifest is not valid JSON")?;
        ensure!(
            manifest.version == MANIFEST_VERSION,
            "unsupported manifest version {}",
            manifest.version
        );
        ensure!(
            manifest.box_id == box_id,
            "manifest belongs to box {}, not {box_id}",
            manifest.box_id
        );
        ensure!(
            manifest.chunk_size == CHUNK_SIZE,
            "unsupported chunk size {}",
            manifest.chunk_size
        );
        let expected = chunk_count(manifest.size_bytes);
        ensure!(
            manifest.chunks.len() as u64 == expected,
            "manifest lists {} chunks, expected {expected}",
            manifest.chunks.len()
        );
        Ok(manifest)
    }
}

pub fn chunk_count(size_bytes: u64) -> u64 {
    size_bytes.div_ceil(CHUNK_SIZE)
}

/// Box ids name object-store prefixes, so they are restricted to a safe alphabet.
pub fn validate_box_id(box_id: &str) -> Result<()> {
    ensure!(
        !box_id.is_empty()
            && box_id.len() <= 128
            && box_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'),
        "invalid box id {box_id:?}"
    );
    Ok(())
}

pub fn chunk_key(box_id: &str, name: &str) -> String {
    format!("boxes/{box_id}/chunks/{name}")
}

pub fn manifest_key(box_id: &str, n: u64) -> String {
    format!("boxes/{box_id}/manifests/{n}.json")
}

pub fn manifests_prefix(box_id: &str) -> String {
    format!("boxes/{box_id}/manifests/")
}

/// The manifest number of a key under `boxes/<box>/manifests/`, if it is one.
pub fn manifest_number(box_id: &str, key: &str) -> Option<u64> {
    key.strip_prefix(&manifests_prefix(box_id))?
        .strip_suffix(".json")?
        .parse()
        .ok()
}

/// A `volumeRef` is only usable for the box it was taken for.
pub fn check_ref(box_id: &str, volume_ref: &str) -> Result<()> {
    match manifest_number(box_id, volume_ref) {
        Some(_) => Ok(()),
        None => bail!("volume ref {volume_ref:?} is not a manifest of box {box_id}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chunk_count_rounds_up() {
        assert_eq!(chunk_count(0), 0);
        assert_eq!(chunk_count(1), 1);
        assert_eq!(chunk_count(CHUNK_SIZE), 1);
        assert_eq!(chunk_count(CHUNK_SIZE + 1), 2);
    }

    #[test]
    fn manifest_rejects_wrong_box_and_wrong_length() {
        let m = Manifest::new("box-a", CHUNK_SIZE * 2, vec![None, None], "t".into());
        let bytes = serde_json::to_vec(&m).unwrap();
        assert!(Manifest::parse(&bytes, "box-a").is_ok());
        assert!(Manifest::parse(&bytes, "box-b").is_err());
        let short = Manifest::new("box-a", CHUNK_SIZE * 2, vec![None], "t".into());
        assert!(Manifest::parse(&serde_json::to_vec(&short).unwrap(), "box-a").is_err());
    }

    #[test]
    fn refs_are_bound_to_their_box() {
        let key = manifest_key("box-a", 3);
        assert_eq!(manifest_number("box-a", &key), Some(3));
        assert!(check_ref("box-a", &key).is_ok());
        assert!(check_ref("box-b", &key).is_err());
        assert!(check_ref("box-a", "boxes/box-a/chunks/abc").is_err());
    }

    #[test]
    fn box_ids_are_restricted() {
        assert!(validate_box_id("abc-123_x").is_ok());
        assert!(validate_box_id("").is_err());
        assert!(validate_box_id("a/b").is_err());
        assert!(validate_box_id("..").is_err());
    }
}
