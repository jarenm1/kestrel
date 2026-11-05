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
use crate::files::{FileLock, create_unnamed, link_unnamed, suffixed, write_file_atomic};
use crate::manifest::{
    CHUNK_SIZE, Manifest, check_ref, chunk_key, manifest_key, manifest_number, manifests_prefix,
    random_token,
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

/// Removes a path when dropped.
pub struct Cleanup(PathBuf);

impl Cleanup {
    pub fn new(path: PathBuf) -> Self {
        Self(path)
    }
}

impl Drop for Cleanup {
    fn drop(&mut self) {
        fs::remove_file(&self.0).ok();
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

/// Fetches and authenticates one chunk. Chunks are stored zero-padded to `CHUNK_SIZE`, so callers truncate to the chunk's
/// length. A missing or corrupt chunk is an error, never a silent zero.
pub fn fetch_chunk(store: &dyn Store, box_id: &str, key: &BoxKey, name: &str) -> Result<Vec<u8>> {
    let sealed = store
        .get(&chunk_key(box_id, name))?
        .ok_or_else(|| anyhow!("chunk {name} is missing from the store"))?;
    let plaintext = key
        .open_chunk(name, &sealed)
        .with_context(|| format!("chunk {name}"))?;
    ensure!(
        plaintext.len() == CHUNK_SIZE as usize,
        "chunk {name} has {} bytes, expected {CHUNK_SIZE}",
        plaintext.len()
    );
    Ok(plaintext)
}

pub fn chunk_len(size: u64, index: usize) -> usize {
    let start = index as u64 * CHUNK_SIZE;
    (size - start).min(CHUNK_SIZE) as usize
}

/// The newest manifest for `box_id`: its number, its object key, and the manifest, which must open under `key`.
pub fn latest_manifest(
    store: &dyn Store,
    box_id: &str,
    key: &BoxKey,
) -> Result<Option<(u64, String, Manifest)>> {
    let mut newest: Option<(u64, String)> = None;
    for object_key in store.list(&manifests_prefix(box_id))? {
        if let Some(n) = manifest_number(box_id, &object_key) {
            let candidate = (n, object_key);
            if newest.as_ref().is_none_or(|best| candidate > *best) {
                newest = Some(candidate);
            }
        }
    }
    let Some((n, object)) = newest else {
        return Ok(None);
    };
    let bytes = store
        .get(&object)?
        .ok_or_else(|| anyhow!("manifest {object} is missing"))?;
    let manifest = Manifest::open(&bytes, key, box_id, &object)?;
    Ok(Some((n, object, manifest)))
}

/// Backs up the volume at `path`. The snapshot, the baseline, and the box lock live in `state_dir`, which must be on the
/// same reflink filesystem as the volume.
pub fn backup(
    path: &Path,
    box_id: &str,
    state_dir: &Path,
    store: &dyn Store,
    key: &BoxKey,
) -> Result<BackupOutput> {
    let _lock = FileLock::acquire(&state_dir.join(format!("{box_id}.lock")))?;
    let prev = latest_manifest(store, box_id, key)?;
    let snap_path = state_dir.join(format!("{box_id}.snap"));
    let base_path = state_dir.join(format!("{box_id}.base"));
    let ref_path = state_dir.join(format!("{box_id}.base.ref"));

    extents::snapshot(path, &snap_path)?;
    let _snap_guard = Cleanup::new(snap_path.clone());
    let snap = File::open(&snap_path)
        .with_context(|| format!("opening snapshot {}", snap_path.display()))?;
    let size = snap.metadata()?.len();
    let chunk_count = size.div_ceil(CHUNK_SIZE) as usize;

    // The baseline is only usable when it is the exact file the newest manifest describes.
    let base_ok = match &prev {
        Some((_, object, manifest)) => {
            manifest.size_bytes == size
                && fs::read_to_string(&ref_path).is_ok_and(|r| r.trim() == object.as_str())
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
            chunks[index] = prev.as_ref().and_then(|(_, _, m)| m.chunks[index].clone());
        } else if is_data[index] {
            to_read.push(index);
        }
    }

    let previous_names: HashSet<&str> = prev
        .iter()
        .flat_map(|(_, _, m)| m.chunks.iter().flatten())
        .map(String::as_str)
        .collect();
    let uploads = parallel_map(to_read, |index| {
        let mut buf = vec![0u8; CHUNK_SIZE as usize];
        snap.read_exact_at(
            &mut buf[..chunk_len(size, index)],
            index as u64 * CHUNK_SIZE,
        )?;
        if buf.iter().all(|b| *b == 0) {
            return Ok((index, None, 0u64, false));
        }
        // Chunks are padded to CHUNK_SIZE before naming and sealing, so stored sizes do not reveal the last chunk's length.
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

    let number = prev.as_ref().map_or(1, |(n, _, _)| n + 1);
    let manifest = Manifest::new(box_id, size, chunks, jiff::Timestamp::now().to_string());
    let manifest_ref = manifest_key(box_id, number, &random_token()?);
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

    // Held for the whole restore, so a concurrent restore or lazy open of `dest` is refused. The lock file stays beside
    // `dest`, as the lazy volume's does.
    let _lock = FileLock::try_acquire(&suffixed(dest, ".lock"))?;
    ensure!(!dest.exists(), "{} already exists", dest.display());
    // The image is written unnamed and linked to `dest` only once complete, so `dest` never holds a partial restore and
    // a crash leaves nothing behind.
    let file = create_unnamed(dest)?;
    file.set_len(manifest.size_bytes)?;
    let work: Vec<(usize, String)> = manifest
        .chunks
        .iter()
        .enumerate()
        .filter_map(|(index, name)| name.clone().map(|name| (index, name)))
        .collect();
    parallel_map(work, |(index, name)| {
        let mut plaintext = fetch_chunk(store, box_id, key, &name)?;
        plaintext.truncate(chunk_len(manifest.size_bytes, index));
        file.write_all_at(&plaintext, index as u64 * CHUNK_SIZE)?;
        Ok(())
    })?;
    file.sync_all()?;
    // Refuses to link if `dest` appeared meanwhile, so a restore never replaces an existing file.
    link_unnamed(&file, dest)?;
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

        let first = backup(&path, BOX, dir.path(), &store, &key).unwrap();
        assert_eq!(first.chunks, 4);

        let file = fs::OpenOptions::new().write(true).open(&path).unwrap();
        file.write_all_at(&[0xEE; 16], CHUNK_SIZE * 2 + 100)
            .unwrap();
        file.sync_all().unwrap();
        drop(file);

        let second = backup(&path, BOX, dir.path(), &store, &key).unwrap();
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
        backup(&path, BOX, dir.path(), &store, &key).unwrap();
        let again = backup(&path, BOX, dir.path(), &store, &key).unwrap();
        assert_eq!(again.chunks, 0);
        assert_eq!(again.bytes_uploaded, 0);
    }

    #[test]
    fn restore_rejects_a_tampered_chunk() {
        let dir = tempfile::tempdir().unwrap();
        let store = FileStore::new(dir.path().join("store"));
        let key = box_key(dir.path(), BOX);
        let path = volume(dir.path(), 1);
        let out = backup(&path, BOX, dir.path(), &store, &key).unwrap();
        let manifest = latest_manifest(&store, BOX, &key).unwrap().unwrap().2;
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
    fn restore_never_replaces_an_existing_destination() {
        let dir = tempfile::tempdir().unwrap();
        let store = FileStore::new(dir.path().join("store"));
        let key = box_key(dir.path(), BOX);
        let path = volume(dir.path(), 1);
        let out = backup(&path, BOX, dir.path(), &store, &key).unwrap();
        let dest = dir.path().join("restored.raw");
        fs::write(&dest, b"keep").unwrap();
        assert!(restore(&out.volume_ref, BOX, &store, &key, &dest).is_err());
        assert_eq!(fs::read(&dest).unwrap(), b"keep");
    }

    #[test]
    fn concurrent_restores_of_one_destination_leave_one_intact_image() {
        let dir = tempfile::tempdir().unwrap();
        let store = FileStore::new(dir.path().join("store"));
        let key = box_key(dir.path(), BOX);
        let path = volume(dir.path(), 4);
        let out = backup(&path, BOX, dir.path(), &store, &key).unwrap();
        let dest = dir.path().join("restored.raw");
        let (first, second) = thread::scope(|scope| {
            let a = scope.spawn(|| restore(&out.volume_ref, BOX, &store, &key, &dest));
            let b = scope.spawn(|| restore(&out.volume_ref, BOX, &store, &key, &dest));
            (a.join().unwrap(), b.join().unwrap())
        });
        assert!(
            first.is_ok() != second.is_ok(),
            "exactly one restore must succeed"
        );
        assert_eq!(fs::read(&dest).unwrap(), fs::read(&path).unwrap());
    }

    #[test]
    fn restore_rejects_a_tampered_or_replayed_manifest() {
        let dir = tempfile::tempdir().unwrap();
        let store = FileStore::new(dir.path().join("store"));
        let key = box_key(dir.path(), BOX);
        let path = volume(dir.path(), 1);
        let out = backup(&path, BOX, dir.path(), &store, &key).unwrap();
        let stored = dir.path().join("store").join(&out.volume_ref);
        let original = fs::read(&stored).unwrap();
        let dest = dir.path().join("restored.raw");

        let replayed = manifest_key(BOX, 9, "0123456789abcdef");
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
        backup(&path, BOX, dir.path(), &store, &key).unwrap();
        delete(BOX, &store).unwrap();
        assert!(store.list(&format!("boxes/{BOX}/")).unwrap().is_empty());
        assert!(latest_manifest(&store, BOX, &key).unwrap().is_none());
    }

    #[test]
    fn a_manifest_key_is_never_reused_after_deletion() {
        let dir = tempfile::tempdir().unwrap();
        let store = FileStore::new(dir.path().join("store"));
        let key = box_key(dir.path(), BOX);
        let path = volume(dir.path(), 1);
        let first = backup(&path, BOX, dir.path(), &store, &key)
            .unwrap()
            .volume_ref;
        store.delete(&first).unwrap();
        let second = backup(&path, BOX, dir.path(), &store, &key)
            .unwrap()
            .volume_ref;
        assert_ne!(first, second);
        let dest = dir.path().join("restored.raw");
        assert!(restore(&first, BOX, &store, &key, &dest).is_err());
    }

    #[test]
    fn stored_chunks_are_all_the_same_size_and_restore_exactly() {
        let dir = tempfile::tempdir().unwrap();
        let store = FileStore::new(dir.path().join("store"));
        let key = box_key(dir.path(), BOX);
        let path = dir.path().join("volume.raw");
        fs::write(&path, vec![0x5A; CHUNK_SIZE as usize + 100]).unwrap();
        let volume_ref = backup(&path, BOX, dir.path(), &store, &key)
            .unwrap()
            .volume_ref;
        let manifest = latest_manifest(&store, BOX, &key).unwrap().unwrap().2;
        let sizes: HashSet<usize> = manifest
            .chunks
            .iter()
            .flatten()
            .map(|name| store.get(&chunk_key(BOX, name)).unwrap().unwrap().len())
            .collect();
        assert_eq!(
            sizes.len(),
            1,
            "stored sizes must not reveal the last chunk's length"
        );
        let restored = dir.path().join("restored.raw");
        restore(&volume_ref, BOX, &store, &key, &restored).unwrap();
        assert_eq!(fs::read(&path).unwrap(), fs::read(&restored).unwrap());
    }

    #[test]
    fn a_file_lock_blocks_a_second_acquire_until_released() {
        let dir = tempfile::tempdir().unwrap();
        let lock_path = dir.path().join("box-a.lock");
        let held = FileLock::acquire(&lock_path).unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        let contender = thread::spawn(move || {
            let _again = FileLock::acquire(&lock_path).unwrap();
            tx.send(()).unwrap();
        });
        assert!(
            rx.recv_timeout(std::time::Duration::from_millis(200))
                .is_err(),
            "a second lock must wait for the first"
        );
        drop(held);
        rx.recv_timeout(std::time::Duration::from_secs(10))
            .expect("the second lock is acquired after release");
        contender.join().unwrap();
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

    #[test]
    fn a_file_at_the_old_staging_name_is_never_touched() {
        let dir = tempfile::tempdir().unwrap();
        let store = FileStore::new(dir.path().join("store"));
        let key = box_key(dir.path(), BOX);
        let path = volume(dir.path(), 1);
        let out = backup(&path, BOX, dir.path(), &store, &key).unwrap();
        let dest = dir.path().join("restored.raw");
        let other = dir.path().join("restored.raw.partial");
        fs::write(&other, b"keep").unwrap();
        restore(&out.volume_ref, BOX, &store, &key, &dest).unwrap();
        assert_eq!(fs::read(&other).unwrap(), b"keep");
        assert_eq!(fs::read(&dest).unwrap(), fs::read(&path).unwrap());
    }
}
