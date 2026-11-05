//! Fixtures shared by the unit tests: a fleet key file, a box key and a volume image with known contents.

use std::fs::{self, File};
use std::io::{Seek, SeekFrom, Write};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use crate::crypto::{BoxKey, FleetKey};
use crate::manifest::CHUNK_SIZE;

pub const BOX: &str = "box-a";

/// The key of `box_id`, derived from a fleet key file written into `dir`.
pub fn box_key(dir: &Path, box_id: &str) -> BoxKey {
    let path = dir.join("volume.key");
    fs::write(&path, [7u8; 32]).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    FleetKey::load(&path).unwrap().box_key(box_id)
}

/// A `volume.raw` in `dir` of `chunks` whole chunks; chunk `i` is filled with `i + 1`.
pub fn volume(dir: &Path, chunks: u64) -> PathBuf {
    let path = dir.join("volume.raw");
    let mut file = File::create(&path).unwrap();
    file.set_len(chunks * CHUNK_SIZE).unwrap();
    for index in 0..chunks {
        file.seek(SeekFrom::Start(index * CHUNK_SIZE)).unwrap();
        file.write_all(&vec![index as u8 + 1; CHUNK_SIZE as usize])
            .unwrap();
    }
    file.sync_all().unwrap();
    path
}

/// The expected contents of [`volume`] with `chunks` chunks.
pub fn volume_bytes(chunks: u64) -> Vec<u8> {
    (0..chunks)
        .flat_map(|index| vec![index as u8 + 1; CHUNK_SIZE as usize])
        .collect()
}
