//! Manifests and object-store key layout. A manifest lists every 4 MiB chunk of a volume by content-keyed name; a zero
//! chunk is `null` and needs no object. A manifest is stored sealed under its own key, so it opens only for the box and
//! only under the manifest number it was written as. The manifest key is the `volumeRef` the control plane records.

use anyhow::{Context, Result, anyhow, bail, ensure};
use serde::{Deserialize, Serialize};

use crate::crypto::BoxKey;

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

    /// The stored form of this manifest, sealed under `object_key` (its `boxes/<box>/manifests/<n>.json` key).
    pub fn seal(&self, key: &BoxKey, object_key: &str) -> Result<Vec<u8>> {
        key.seal(object_key, &serde_json::to_vec(self)?)
    }

    /// Opens the stored manifest `object_key`. It fails unless the object was sealed under this box's key for exactly
    /// this key, so a manifest cannot be altered, replayed under another number, or taken from another box.
    pub fn open(sealed: &[u8], key: &BoxKey, box_id: &str, object_key: &str) -> Result<Self> {
        let bytes = key
            .open(object_key, sealed)
            .with_context(|| format!("manifest {object_key}"))?;
        let manifest: Manifest =
            serde_json::from_slice(&bytes).context("manifest is not valid JSON")?;
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

/// The object key of manifest `n`. The random `token` makes each manifest object unique, so a key never names different
/// content, even after the manifest with the same number is deleted.
pub fn manifest_key(box_id: &str, n: u64, token: &str) -> String {
    format!("boxes/{box_id}/manifests/{n}-{token}.json")
}

/// A fresh random token for a manifest key: 8 random bytes in hex.
pub fn random_token() -> Result<String> {
    let mut bytes = [0u8; 8];
    getrandom::fill(&mut bytes).map_err(|e| anyhow!("random manifest token: {e}"))?;
    Ok(hex::encode(bytes))
}

pub fn manifests_prefix(box_id: &str) -> String {
    format!("boxes/{box_id}/manifests/")
}

/// The manifest number of a key under `boxes/<box>/manifests/`, if the key is exactly one `manifest_key` makes.
pub fn manifest_number(box_id: &str, key: &str) -> Option<u64> {
    let name = key
        .strip_prefix(&manifests_prefix(box_id))?
        .strip_suffix(".json")?;
    let (number, token) = name.split_once('-')?;
    let n: u64 = number.parse().ok()?;
    let token_ok = token.len() == 16
        && token
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
    (token_ok && manifest_key(box_id, n, token) == key).then_some(n)
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
    use crate::testutil::{BOX, box_key};

    const TOKEN: &str = "0123456789abcdef";

    fn sealed_two_chunk_manifest(key: &BoxKey, object: &str) -> (Manifest, Vec<u8>) {
        let manifest = Manifest::new(BOX, CHUNK_SIZE * 2, vec![None, None], "t".into());
        let sealed = manifest.seal(key, object).unwrap();
        (manifest, sealed)
    }

    #[test]
    fn chunk_count_rounds_up() {
        assert_eq!(chunk_count(0), 0);
        assert_eq!(chunk_count(1), 1);
        assert_eq!(chunk_count(CHUNK_SIZE), 1);
        assert_eq!(chunk_count(CHUNK_SIZE + 1), 2);
    }

    #[test]
    fn sealed_manifest_opens_under_its_own_key() {
        let dir = tempfile::tempdir().unwrap();
        let key = box_key(dir.path(), BOX);
        let object = manifest_key(BOX, 3, TOKEN);
        let (manifest, sealed) = sealed_two_chunk_manifest(&key, &object);
        assert_eq!(
            Manifest::open(&sealed, &key, BOX, &object).unwrap(),
            manifest
        );
    }

    #[test]
    fn manifest_rejects_tampering_replay_and_other_boxes() {
        let dir = tempfile::tempdir().unwrap();
        let key = box_key(dir.path(), BOX);
        let object = manifest_key(BOX, 3, TOKEN);
        let (_, sealed) = sealed_two_chunk_manifest(&key, &object);

        let mut tampered = sealed.clone();
        let last = tampered.len() - 1;
        tampered[last] ^= 1;
        assert!(Manifest::open(&tampered, &key, BOX, &object).is_err());

        assert!(
            Manifest::open(
                &sealed,
                &key,
                BOX,
                &manifest_key(BOX, 3, "fedcba9876543210")
            )
            .is_err()
        );

        let other = box_key(dir.path(), "box-b");
        assert!(Manifest::open(&sealed, &other, "box-b", &object).is_err());

        let plain = serde_json::to_vec(&Manifest::new(
            BOX,
            CHUNK_SIZE * 2,
            vec![None, None],
            "t".into(),
        ))
        .unwrap();
        assert!(Manifest::open(&plain, &key, BOX, &object).is_err());
    }

    #[test]
    fn manifest_rejects_a_wrong_chunk_count() {
        let dir = tempfile::tempdir().unwrap();
        let key = box_key(dir.path(), BOX);
        let object = manifest_key(BOX, 1, TOKEN);
        let short = Manifest::new(BOX, CHUNK_SIZE * 2, vec![None], "t".into());
        let sealed = short.seal(&key, &object).unwrap();
        assert!(Manifest::open(&sealed, &key, BOX, &object).is_err());
    }

    #[test]
    fn refs_are_bound_to_their_box() {
        let key = manifest_key("box-a", 3, TOKEN);
        assert_eq!(manifest_number("box-a", &key), Some(3));
        assert_eq!(
            manifest_number("box-a", "boxes/box-a/manifests/3.json"),
            None
        );
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
