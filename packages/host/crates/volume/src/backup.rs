//! Point-in-time backups of a volume file into a store, and restores of them.
//!
//! A backup takes a copy-on-write snapshot of the volume, compares it chunk by chunk with the baseline left by the previous
//! backup (see `extents`), uploads only chunks whose content is new to the store, and then writes a new manifest. The
//! manifest is the commit point: the baseline advances only after the manifest is stored.

use std::collections::HashSet;
use std::fs::{self, File};
use std::os::unix::fs::FileExt;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::thread;

use anyhow::{Context, Result, anyhow, ensure};
use serde::Serialize;

use crate::crypto::BoxKey;
use crate::extents;
use crate::files::{suffixed, write_file_atomic};
use crate::manifest::{
    CHUNK_SIZE, Manifest, check_ref, chunk_key, manifest_key, manifest_number, manifests_prefix,
};
use crate::store::Store;

const WORKERS: usize = 8;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupOutput {
    pub volume_ref: String,
    pub bytes_uploaded: u64,
    pub chunks: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreOutput {
    pub bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteOutput {
    pub deleted: u64,
}

/// Removes a path when dropped unless disarmed.
pub struct Cleanup(Option<PathBuf>);

impl Cleanup {
    pub fn new(path: PathBuf) -> Self {
        Self(Some(path))
    }

    pub fn disarm(&mut self) {
        self.0 = None;
    }
}

impl Drop for Cleanup {
    fn drop(&mut self) {
        if let Some(path) = self.0.take() {
            fs::remove_file(path).ok();
        }
    }
}

/// Runs `f` over `items` on up to `WORKERS` threads and returns the results in input order. The first error stops
/// new work and is returned.
pub fn parallel_map<T: Send, R: Send>(
    items: Vec<T>,
    f: impl Fn(T) -> Result<R> + Sync,
) -> Result<Vec<R>> {
    let total = items.len();
    let queue = Mutex::new(items.into_iter().enumerate());
    let done = Mutex::new(Vec::with_capacity(total));
    let failed: Mutex<Option<anyhow::Error>> = Mutex::new(None);
    thread::scope(|scope| {
        for _ in 0..WORKERS.min(total) {
            scope.spawn(|| {
                loop {
                    if failed.lock().expect("failure slot").is_some() {
                        return;
                    }
                    let next = queue.lock().expect("work queue").next();
                    let Some((index, item)) = next else { return };
                    match f(item) {
                        Ok(result) => done.lock().expect("results").push((index, result)),
                        Err(err) => {
                            let mut slot = failed.lock().expect("failure slot");
                            if slot.is_none() {
                                *slot = Some(err);
                            }
                            return;
                        }
                    }
                }
            });
        }
    });
    if let Some(err) = failed.into_inner().expect("failure slot") {
        return Err(err);
    }
    let mut done = done.into_inner().expect("results");
    done.sort_by_key(|(index, _)| *index);
    Ok(done.into_iter().map(|(_, result)| result).collect())
}

/// Fetches and authenticates one chunk. A missing or corrupt chunk is an error, never a silent zero.
pub fn fetch_chunk(
    store: &dyn Store,
    box_id: &str,
    key: &BoxKey,
    name: &str,
    expected_len: usize,
) -> Result<Vec<u8>> {
    let sealed = store
        .get(&chunk_key(box_id, name))?
        .ok_or_else(|| anyhow!("chunk {name} is missing from the store"))?;
    let plaintext = key
        .open_chunk(name, &sealed)
        .with_context(|| format!("chunk {name}"))?;
    ensure!(
        plaintext.len() == expected_len,
        "chunk {name} has {} bytes, expected {expected_len}",
        plaintext.len()
    );
    Ok(plaintext)
}

pub fn chunk_len(size: u64, index: usize) -> usize {
    let start = index as u64 * CHUNK_SIZE;
    (size - start).min(CHUNK_SIZE) as usize
}

/// The newest manifest for `box_id`, with its number. It must open under `key`.
pub fn latest_manifest(
    store: &dyn Store,
    box_id: &str,
    key: &BoxKey,
) -> Result<Option<(u64, Manifest)>> {
    let mut newest: Option<u64> = None;
    for object_key in store.list(&manifests_prefix(box_id))? {
        if let Some(n) = manifest_number(box_id, &object_key) {
            newest = Some(newest.map_or(n, |current| current.max(n)));
        }
    }
    let Some(n) = newest else { return Ok(None) };
    let object = manifest_key(box_id, n);
    let bytes = store
        .get(&object)?
        .ok_or_else(|| anyhow!("manifest {object} is missing"))?;
    Ok(Some((n, Manifest::open(&bytes, key, box_id, &object)?)))
}

pub fn backup(path: &Path, box_id: &str, store: &dyn Store, key: &BoxKey) -> Result<BackupOutput> {
    let prev = latest_manifest(store, box_id, key)?;
    let snap_path = suffixed(path, ".snap");
    let base_path = suffixed(path, ".base");
    let ref_path = suffixed(path, ".base.ref");

    extents::snapshot(path, &snap_path)?;
    let _snap_guard = Cleanup::new(snap_path.clone());
    let snap = File::open(&snap_path)
        .with_context(|| format!("opening snapshot {}", snap_path.display()))?;
    let size = snap.metadata()?.len();
    let chunk_count = size.div_ceil(CHUNK_SIZE) as usize;

    // The baseline is only usable when it is the exact file the newest manifest describes.
    let base_ok = match &prev {
        Some((n, manifest)) => {
            manifest.size_bytes == size
                && fs::read_to_string(&ref_path).is_ok_and(|r| r.trim() == manifest_key(box_id, *n))
                && fs::metadata(&base_path).is_ok_and(|m| m.len() == size)
        }
        None => false,
    };

    let snap_sigs = extents::chunk_signatures(&snap, size)?;
    let base_sigs = if base_ok {
        Some(extents::chunk_signatures(&File::open(&base_path)?, size)?)
    } else {
        None
    };
    let mut is_data = vec![false; chunk_count];
    for index in extents::data_chunks(&snap, size)? {
        is_data[index] = true;
    }

    let mut chunks: Vec<Option<String>> = vec![None; chunk_count];
    let mut to_read = Vec::new();
    for index in 0..chunk_count {
        let unchanged = base_sigs
            .as_ref()
            .is_some_and(|base| base[index] == snap_sigs[index]);
        if unchanged {
            chunks[index] = prev.as_ref().and_then(|(_, m)| m.chunks[index].clone());
        } else if is_data[index] {
            to_read.push(index);
        }
    }

    let previous_names: HashSet<&str> = prev
        .iter()
        .flat_map(|(_, m)| m.chunks.iter().flatten())
        .map(String::as_str)
        .collect();
    let uploads = parallel_map(to_read, |index| {
        let mut buf = vec![0u8; chunk_len(size, index)];
        snap.read_exact_at(&mut buf, index as u64 * CHUNK_SIZE)?;
        if buf.iter().all(|b| *b == 0) {
            return Ok((index, None, 0u64, false));
        }
        let name = key.chunk_name(&buf);
        if previous_names.contains(name.as_str()) || store.exists(&chunk_key(box_id, &name))? {
            return Ok((index, Some(name), 0, false));
        }
        let sealed = key.seal(&name, &buf)?;
        store.put(&chunk_key(box_id, &name), &sealed)?;
        Ok((index, Some(name), sealed.len() as u64, true))
    })?;

    let mut bytes_uploaded = 0u64;
    let mut chunks_uploaded = 0u64;
    for (index, name, sealed_len, uploaded) in uploads {
        chunks[index] = name;
        bytes_uploaded += sealed_len;
        chunks_uploaded += u64::from(uploaded);
    }

    let number = prev.as_ref().map_or(1, |(n, _)| n + 1);
    let manifest = Manifest::new(box_id, size, chunks, jiff::Timestamp::now().to_string());
    let manifest_ref = manifest_key(box_id, number);
    store.put(&manifest_ref, &manifest.seal(key, &manifest_ref)?)?;

    fs::rename(&snap_path, &base_path)
        .with_context(|| format!("promoting snapshot to {}", base_path.display()))?;
    write_file_atomic(&ref_path, manifest_ref.as_bytes())?;

    Ok(BackupOutput {
        volume_ref: manifest_ref,
        bytes_uploaded,
        chunks: chunks_uploaded,
    })
}

pub fn restore(
    volume_ref: &str,
    box_id: &str,
    store: &dyn Store,
    key: &BoxKey,
    dest: &Path,
) -> Result<RestoreOutput> {
    check_ref(box_id, volume_ref)?;
    let bytes = store
        .get(volume_ref)?
        .ok_or_else(|| anyhow!("manifest {volume_ref} is missing"))?;
    let manifest = Manifest::open(&bytes, key, box_id, volume_ref)?;

    let file = File::create_new(dest).with_context(|| format!("creating {}", dest.display()))?;
    let mut guard = Cleanup::new(dest.to_path_buf());
    file.set_len(manifest.size_bytes)?;
    let work: Vec<(usize, String)> = manifest
        .chunks
        .iter()
        .enumerate()
        .filter_map(|(index, name)| name.clone().map(|name| (index, name)))
        .collect();
    parallel_map(work, |(index, name)| {
        let plaintext = fetch_chunk(
            store,
            box_id,
            key,
            &name,
            chunk_len(manifest.size_bytes, index),
        )?;
        file.write_all_at(&plaintext, index as u64 * CHUNK_SIZE)?;
        Ok(())
    })?;
    file.sync_all()?;
    guard.disarm();
    Ok(RestoreOutput {
        bytes: manifest.size_bytes,
    })
}

pub fn delete(box_id: &str, store: &dyn Store) -> Result<DeleteOutput> {
    let prefix = format!("boxes/{box_id}/");
    let keys = store.list(&prefix)?;
    for key in &keys {
        ensure!(
            key.starts_with(&prefix),
            "store listed {key} outside {prefix}"
        );
        store.delete(key)?;
    }
    Ok(DeleteOutput {
        deleted: keys.len() as u64,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::FileStore;
    use crate::testutil::{BOX, box_key, volume};
    use anyhow::bail;

    #[test]
    fn incremental_backup_uploads_only_changed_chunks_and_restores_exactly() {
        let dir = tempfile::tempdir().unwrap();
        let store = FileStore::new(dir.path().join("store"));
        let key = box_key(dir.path(), BOX);
        let path = volume(dir.path(), 4);

        let first = backup(&path, BOX, &store, &key).unwrap();
        assert_eq!(first.chunks, 4);

        let file = fs::OpenOptions::new().write(true).open(&path).unwrap();
        file.write_all_at(&[0xEE; 16], CHUNK_SIZE * 2 + 100)
            .unwrap();
        file.sync_all().unwrap();
        drop(file);

        let second = backup(&path, BOX, &store, &key).unwrap();
        assert_eq!(second.chunks, 1, "only the modified chunk should upload");
        assert_ne!(second.volume_ref, first.volume_ref);

        let restored = dir.path().join("restored.raw");
        let out = restore(&second.volume_ref, BOX, &store, &key, &restored).unwrap();
        assert_eq!(out.bytes, 4 * CHUNK_SIZE);
        assert_eq!(fs::read(&path).unwrap(), fs::read(&restored).unwrap());
    }

    #[test]
    fn unchanged_volume_uploads_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let store = FileStore::new(dir.path().join("store"));
        let key = box_key(dir.path(), BOX);
        let path = volume(dir.path(), 2);
        backup(&path, BOX, &store, &key).unwrap();
        let again = backup(&path, BOX, &store, &key).unwrap();
        assert_eq!(again.chunks, 0);
        assert_eq!(again.bytes_uploaded, 0);
    }

    #[test]
    fn restore_rejects_a_tampered_chunk() {
        let dir = tempfile::tempdir().unwrap();
        let store = FileStore::new(dir.path().join("store"));
        let key = box_key(dir.path(), BOX);
        let path = volume(dir.path(), 1);
        let out = backup(&path, BOX, &store, &key).unwrap();
        let manifest = latest_manifest(&store, BOX, &key).unwrap().unwrap().1;
        let name = manifest.chunks[0].clone().unwrap();
        let chunk_path = dir.path().join("store").join(chunk_key(BOX, &name));
        let mut bytes = fs::read(&chunk_path).unwrap();
        let last = bytes.len() - 1;
        bytes[last] ^= 1;
        fs::write(&chunk_path, bytes).unwrap();
        let dest = dir.path().join("restored.raw");
        assert!(restore(&out.volume_ref, BOX, &store, &key, &dest).is_err());
        assert!(
            !dest.exists(),
            "a failed restore must not leave a partial file"
        );
    }

    #[test]
    fn restore_rejects_a_tampered_or_replayed_manifest() {
        let dir = tempfile::tempdir().unwrap();
        let store = FileStore::new(dir.path().join("store"));
        let key = box_key(dir.path(), BOX);
        let path = volume(dir.path(), 1);
        let out = backup(&path, BOX, &store, &key).unwrap();
        let stored = dir.path().join("store").join(&out.volume_ref);
        let original = fs::read(&stored).unwrap();
        let dest = dir.path().join("restored.raw");

        let replayed = manifest_key(BOX, 9);
        store.put(&replayed, &original).unwrap();
        assert!(restore(&replayed, BOX, &store, &key, &dest).is_err());
        assert!(!dest.exists());

        let mut bytes = original;
        let last = bytes.len() - 1;
        bytes[last] ^= 1;
        fs::write(&stored, bytes).unwrap();
        assert!(restore(&out.volume_ref, BOX, &store, &key, &dest).is_err());
        assert!(!dest.exists());
    }

    #[test]
    fn delete_removes_every_object_for_the_box() {
        let dir = tempfile::tempdir().unwrap();
        let store = FileStore::new(dir.path().join("store"));
        let key = box_key(dir.path(), BOX);
        let path = volume(dir.path(), 2);
        backup(&path, BOX, &store, &key).unwrap();
        delete(BOX, &store).unwrap();
        assert!(store.list(&format!("boxes/{BOX}/")).unwrap().is_empty());
        assert!(latest_manifest(&store, BOX, &key).unwrap().is_none());
    }

    #[test]
    fn parallel_map_keeps_input_order() {
        let out = parallel_map((0..100).collect(), |i: usize| Ok(i * 2)).unwrap();
        assert_eq!(out, (0..100).map(|i| i * 2).collect::<Vec<_>>());
    }

    #[test]
    fn parallel_map_reports_the_first_error() {
        let err = parallel_map((0..10).collect(), |i: usize| {
            if i == 3 {
                bail!("boom")
            }
            Ok(i)
        });
        assert!(err.is_err());
    }
}
