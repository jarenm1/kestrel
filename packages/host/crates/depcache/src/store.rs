//! On-disk state. Everything the cache keeps on disk is an entry in one least-recently-used index capped at `cap`
//! bytes: artifacts (`blobs/<algo>/<hex>`), link records (`links/`) and metadata (`meta/*.head`, `meta/*.body`).
//! A download in flight holds a reservation against the cap until it commits or fails. Every change to a file and to
//! the index happens under the index lock, so eviction, sweeps and commits never interleave. Metadata is stored as a
//! small header (`*.head`) and a body (`*.body`), so freshness checks never read the body. Links and metadata whose
//! fetch is past the TTL are swept.

use std::collections::{BTreeMap, HashMap};
use std::fs::{self, File};
use std::io::{self, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};
use tempfile::{NamedTempFile, TempPath};
use tracing::{info, warn};

use crate::cache::now_secs;
use crate::digest::{Algo, Expected};
use crate::error::Error;

/// An artifact a metadata document lists. Served only while `source` is fresh and its latest fetch still lists the
/// artifact with `expected`.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Link {
    pub upstream: String,
    #[serde(flatten)]
    pub expected: Expected,
    /// Cache key of the metadata document whose fetch wrote this link.
    pub source: String,
    /// `fetched_at` of that fetch.
    pub fetched_at: u64,
}

#[derive(Serialize, Deserialize)]
pub struct MetaHead {
    pub fetched_at: u64,
    pub content_type: String,
    /// Kind and key of every link this fetch wrote. The document is served only while all of them exist.
    pub links: Vec<(String, String)>,
}

pub struct Cached {
    pub fetched_at: u64,
    pub content_type: String,
    pub body: Vec<u8>,
}

#[derive(Default)]
struct Lru {
    tick: u64,
    /// Bytes of every committed file.
    bytes: u64,
    /// Bytes promised to downloads in flight.
    reserved: u64,
    /// path -> (tick, size)
    by_path: HashMap<PathBuf, (u64, u64)>,
    by_tick: BTreeMap<u64, PathBuf>,
}

impl Lru {
    fn insert(&mut self, path: PathBuf, size: u64) {
        self.remove(&path);
        self.tick += 1;
        self.bytes += size;
        self.by_tick.insert(self.tick, path.clone());
        self.by_path.insert(path, (self.tick, size));
    }

    fn touch(&mut self, path: &Path) {
        let Some(entry) = self.by_path.get_mut(path) else {
            return;
        };
        self.by_tick.remove(&entry.0);
        self.tick += 1;
        entry.0 = self.tick;
        self.by_tick.insert(self.tick, path.to_owned());
    }

    fn contains(&self, path: &Path) -> bool {
        self.by_path.contains_key(path)
    }

    fn remove(&mut self, path: &Path) {
        if let Some((tick, size)) = self.by_path.remove(path) {
            self.by_tick.remove(&tick);
            self.bytes -= size;
        }
    }

    /// Least recently used paths to delete so that committed bytes plus reservations fit `limit`.
    fn victims(&self, limit: u64) -> Vec<PathBuf> {
        let mut used = self.bytes + self.reserved;
        let mut victims = Vec::new();
        for path in self.by_tick.values() {
            if used <= limit {
                break;
            }
            used -= self.by_path[path].1;
            victims.push(path.clone());
        }
        victims
    }
}

pub struct Store {
    root: PathBuf,
    cap: u64,
    metadata_ttl: Duration,
    /// The index and every change to the files it tracks. Held for each such change, so eviction, sweeps and commits
    /// never interleave.
    lru: Arc<Mutex<Lru>>,
    /// Unix time of the last sweep.
    last_sweep: AtomicU64,
}

/// Budget held for a download in flight. It counts against the cap until the download commits or is dropped.
pub struct Reservation {
    lru: Arc<Mutex<Lru>>,
    bytes: u64,
}

impl Reservation {
    fn release(&mut self) -> u64 {
        std::mem::take(&mut self.bytes)
    }
}

impl Drop for Reservation {
    fn drop(&mut self) {
        let bytes = self.release();
        if bytes > 0 {
            lock_index(&self.lru).reserved -= bytes;
        }
    }
}

fn lock_index(lru: &Mutex<Lru>) -> MutexGuard<'_, Lru> {
    lru.lock().expect("lru lock")
}

impl Store {
    pub fn open(root: &Path, cap: u64, metadata_ttl: Duration) -> io::Result<Self> {
        for dir in ["blobs", "links", "meta"] {
            fs::create_dir_all(root.join(dir))?;
        }
        let tmp = root.join("tmp");
        if tmp.exists() {
            fs::remove_dir_all(&tmp)?;
        }
        fs::create_dir_all(&tmp)?;
        let store = Self {
            root: root.to_owned(),
            cap,
            metadata_ttl,
            lru: Arc::default(),
            last_sweep: AtomicU64::new(0),
        };
        store.index_existing()?;
        store.sweep_if_due();
        Ok(store)
    }

    /// Adopts files left by an earlier run, oldest first, and evicts down to the cap.
    fn index_existing(&self) -> io::Result<()> {
        let mut dirs = vec![self.root.join("meta"), self.root.join("links")];
        for algo in [Algo::Sha512, Algo::Sha256] {
            dirs.push(self.root.join("blobs").join(algo.name()));
        }
        let mut found = Vec::new();
        for dir in dirs {
            fs::create_dir_all(&dir)?;
            for entry in fs::read_dir(&dir)? {
                let entry = entry?;
                let meta = entry.metadata()?;
                if meta.is_file() {
                    found.push((
                        meta.modified().unwrap_or(UNIX_EPOCH),
                        entry.path(),
                        meta.len(),
                    ));
                }
            }
        }
        found.sort_by_key(|(mtime, _, _)| *mtime);
        let mut lru = lock_index(&self.lru);
        for (_, path, size) in found {
            lru.insert(path, size);
        }
        self.evict(&mut lru, self.cap);
        Ok(())
    }

    /// Deletes least recently used files until the index fits `limit`. A file leaves the index and the disk together.
    fn evict(&self, lru: &mut Lru, limit: u64) {
        let victims = lru.victims(limit);
        for victim in &victims {
            lru.remove(victim);
        }
        remove_evicted(&victims);
    }

    pub fn blob_path(&self, expected: &Expected) -> PathBuf {
        self.root
            .join("blobs")
            .join(expected.algo.name())
            .join(&expected.hex)
    }

    /// A temporary file on the store's filesystem, so committing it is a rename.
    pub fn new_tmp(&self) -> io::Result<NamedTempFile> {
        NamedTempFile::new_in(self.root.join("tmp"))
    }

    /// Reserves `bytes` of the cap for a download, evicting least recently used files to make room. `None` when
    /// downloads in flight already hold the room.
    pub fn reserve(&self, bytes: u64) -> Option<Reservation> {
        let mut lru = lock_index(&self.lru);
        if lru.reserved + bytes > self.cap {
            return None;
        }
        lru.reserved += bytes;
        self.evict(&mut lru, self.cap);
        Some(Reservation {
            lru: Arc::clone(&self.lru),
            bytes,
        })
    }

    /// Moves a verified download into place in place of its reservation, evicts least recently used files above the
    /// cap, and returns the committed file positioned at its start.
    pub fn commit_blob(
        &self,
        tmp: NamedTempFile,
        expected: &Expected,
        size: u64,
        mut reservation: Reservation,
    ) -> io::Result<File> {
        let path = self.blob_path(expected);
        let mut lru = lock_index(&self.lru);
        let mut file = tmp.persist(&path).map_err(|e| e.error)?;
        lru.reserved -= reservation.release();
        lru.insert(path, size);
        self.evict(&mut lru, self.cap);
        drop(lru);
        file.seek(SeekFrom::Start(0))?;
        Ok(file)
    }

    pub fn touch_blob(&self, path: &Path) {
        lock_index(&self.lru).touch(path);
    }

    /// Drops a blob that is missing or failed verification.
    pub fn forget_blob(&self, path: &Path) {
        drop_file(&mut lock_index(&self.lru), path);
    }

    fn link_path(&self, kind: &str, key: &str) -> PathBuf {
        self.root
            .join("links")
            .join(format!("{}.json", hashed(&format!("{kind}\0{key}"))))
    }

    fn read_link(&self, kind: &str, key: &str) -> io::Result<Option<Link>> {
        let Some(bytes) = read_optional(&self.link_path(kind, key))? else {
            return Ok(None);
        };
        match serde_json::from_slice(&bytes) {
            Ok(link) => Ok(Some(link)),
            Err(e) => {
                warn!("ignoring unreadable link {kind} {key}: {e}");
                Ok(None)
            }
        }
    }

    /// The link for `kind/key` when its source metadata is fresh and that metadata's latest fetch wrote this link.
    pub fn current_link(&self, kind: &str, key: &str) -> io::Result<Option<Link>> {
        let Some(link) = self.read_link(kind, key)? else {
            return Ok(None);
        };
        if !self.link_is_current(&link)? {
            return Ok(None);
        }
        lock_index(&self.lru).touch(&self.link_path(kind, key));
        Ok(Some(link))
    }

    fn link_is_current(&self, link: &Link) -> io::Result<bool> {
        Ok(self.read_meta_head(&link.source)?.is_some_and(|head| {
            head.fetched_at == link.fetched_at && self.is_fresh(head.fetched_at)
        }))
    }

    fn meta_path(&self, cache_key: &str, part: &str) -> PathBuf {
        self.root
            .join("meta")
            .join(format!("{}.{part}", hashed(cache_key)))
    }

    fn read_meta_head(&self, cache_key: &str) -> io::Result<Option<MetaHead>> {
        let Some(bytes) = read_optional(&self.meta_path(cache_key, "head"))? else {
            return Ok(None);
        };
        match serde_json::from_slice(&bytes) {
            Ok(head) => Ok(Some(head)),
            Err(e) => {
                warn!("ignoring unreadable metadata header {cache_key}: {e}");
                Ok(None)
            }
        }
    }

    /// The cached document when it is fresh and every link it wrote is still present. A missing link means the fetch
    /// that re-creates it must run again, so the document is not served from cache.
    pub fn read_fresh_meta(&self, cache_key: &str) -> io::Result<Option<Cached>> {
        let Some(head) = self
            .read_meta_head(cache_key)?
            .filter(|head| self.is_fresh(head.fetched_at))
        else {
            return Ok(None);
        };
        let head_path = self.meta_path(cache_key, "head");
        let body_path = self.meta_path(cache_key, "body");
        let link_paths: Vec<PathBuf> = head
            .links
            .iter()
            .map(|(kind, key)| self.link_path(kind, key))
            .collect();
        {
            let mut lru = lock_index(&self.lru);
            if !link_paths.iter().all(|path| lru.contains(path)) {
                return Ok(None);
            }
            lru.touch(&head_path);
            lru.touch(&body_path);
            for path in &link_paths {
                lru.touch(path);
            }
        }
        let Some(body) = read_optional(&body_path)? else {
            return Ok(None);
        };
        Ok(Some(Cached {
            fetched_at: head.fetched_at,
            content_type: head.content_type,
            body,
        }))
    }

    /// Records one metadata fetch: its links, then its body, then its header. Every file is staged and synced before
    /// the index lock is taken, and then renamed into place in that order, so a durable header never names a link or
    /// body that is missing. A listing that cannot fit beside the downloads in flight is refused whole, never kept in
    /// part.
    pub fn commit_metadata(
        &self,
        cache_key: &str,
        links: &[(&'static str, String, Link)],
        cached: &Cached,
    ) -> Result<(), Error> {
        let head = serde_json::to_vec(&MetaHead {
            fetched_at: cached.fetched_at,
            content_type: cached.content_type.clone(),
            links: links
                .iter()
                .map(|(kind, key, _)| ((*kind).to_owned(), key.clone()))
                .collect(),
        })
        .map_err(io::Error::other)?;
        let link_files = links
            .iter()
            .map(|(kind, key, link)| -> Result<_, serde_json::Error> {
                Ok((self.link_path(kind, key), serde_json::to_vec(link)?))
            })
            .collect::<Result<Vec<_>, _>>()
            .map_err(io::Error::other)?;
        let total = link_files
            .iter()
            .map(|(_, bytes)| bytes.len() as u64)
            .sum::<u64>()
            + cached.body.len() as u64
            + head.len() as u64;
        if total > self.cap {
            return Err(Error::TooLarge(self.cap));
        }
        let mut staged = Vec::with_capacity(link_files.len() + 2);
        for (path, bytes) in link_files {
            staged.push((path, self.stage(&bytes)?, bytes.len() as u64));
        }
        staged.push((
            self.meta_path(cache_key, "body"),
            self.stage(&cached.body)?,
            cached.body.len() as u64,
        ));
        staged.push((
            self.meta_path(cache_key, "head"),
            self.stage(&head)?,
            head.len() as u64,
        ));
        {
            let mut lru = lock_index(&self.lru);
            if total > self.cap.saturating_sub(lru.reserved) {
                return Err(Error::Busy(
                    "downloads hold the cache budget; retry".to_owned(),
                ));
            }
            let mut committed: io::Result<()> = Ok(());
            for (path, tmp, size) in staged {
                match tmp.persist(&path) {
                    Ok(()) => lru.insert(path, size),
                    Err(e) => {
                        committed = Err(e.error);
                        break;
                    }
                }
            }
            self.evict(&mut lru, self.cap);
            committed?;
        }
        self.sweep_if_due();
        Ok(())
    }

    /// Writes and syncs a file under a temporary name, then closes it. It is visible under its final name only once
    /// renamed into place.
    fn stage(&self, bytes: &[u8]) -> io::Result<TempPath> {
        let mut tmp = self.new_tmp()?;
        tmp.write_all(bytes)?;
        tmp.as_file().sync_data()?;
        Ok(tmp.into_temp_path())
    }

    /// Fresh means fetched within the TTL. A fetch time in the future, after the clock moved back, is not fresh.
    fn is_fresh(&self, fetched_at: u64) -> bool {
        let now = now_secs();
        fetched_at <= now && now - fetched_at < self.metadata_ttl.as_secs()
    }

    /// Sweeps at most once per TTL. A failed sweep is logged and retried on a later call.
    fn sweep_if_due(&self) {
        let now = now_secs();
        if now.saturating_sub(self.last_sweep.load(Ordering::Relaxed)) < self.metadata_ttl.as_secs()
        {
            return;
        }
        self.last_sweep.store(now, Ordering::Relaxed);
        if let Err(e) = self.sweep() {
            warn!("metadata sweep failed: {e}");
        }
    }

    /// Deletes what can no longer be served: a header past its TTL with its body, a body whose header is gone, and a
    /// link whose fetch is past its TTL. Runs under the index lock.
    fn sweep(&self) -> io::Result<()> {
        let mut lru = lock_index(&self.lru);
        for entry in fs::read_dir(self.root.join("meta"))? {
            let path = entry?.path();
            match path.extension().and_then(|ext| ext.to_str()) {
                Some("head") => {
                    let head = read_optional(&path)?
                        .and_then(|bytes| serde_json::from_slice::<MetaHead>(&bytes).ok());
                    if !head.is_some_and(|head| self.is_fresh(head.fetched_at)) {
                        drop_file(&mut lru, &path);
                        drop_file(&mut lru, &path.with_extension("body"));
                    }
                }
                Some("body") if !path.with_extension("head").exists() => {
                    drop_file(&mut lru, &path);
                }
                _ => {}
            }
        }
        for entry in fs::read_dir(self.root.join("links"))? {
            let path = entry?.path();
            let link =
                read_optional(&path)?.and_then(|bytes| serde_json::from_slice::<Link>(&bytes).ok());
            if !link.is_some_and(|link| self.is_fresh(link.fetched_at)) {
                drop_file(&mut lru, &path);
            }
        }
        Ok(())
    }
}

/// Removes a file from the index and from the disk.
fn drop_file(lru: &mut Lru, path: &Path) {
    lru.remove(path);
    remove_file_if_exists(path);
}

fn remove_evicted(victims: &[PathBuf]) {
    for victim in victims {
        match fs::remove_file(victim) {
            Ok(()) => info!("evicted {}", victim.display()),
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => warn!("could not evict {}: {e}", victim.display()),
        }
    }
}

fn remove_file_if_exists(path: &Path) {
    if let Err(e) = fs::remove_file(path) {
        if e.kind() != io::ErrorKind::NotFound {
            warn!("could not remove {}: {e}", path.display());
        }
    }
}

fn read_optional(path: &Path) -> io::Result<Option<Vec<u8>>> {
    match fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

fn hashed(s: &str) -> String {
    hex::encode(Sha256::digest(s.as_bytes()))
}

#[cfg(test)]
mod tests {
    use sha2::{Digest, Sha256};

    use super::*;

    fn store(cap: u64) -> (tempfile::TempDir, Store) {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = Store::open(dir.path(), cap, Duration::from_secs(300)).expect("open");
        (dir, store)
    }

    #[test]
    fn metadata_fetched_in_the_future_is_not_fresh() {
        let (_dir, store) = store(1 << 20);
        let cached = Cached {
            fetched_at: now_secs() + 3600,
            content_type: "text/plain".to_owned(),
            body: b"doc".to_vec(),
        };
        store.commit_metadata("k", &[], &cached).expect("commit");
        assert!(store.read_fresh_meta("k").expect("read").is_none());
    }

    #[test]
    fn reservations_hold_the_cap_until_released() {
        let (_dir, store) = store(100);
        let first = store.reserve(60).expect("fits the cap");
        assert!(
            store.reserve(60).is_none(),
            "two downloads cannot both hold 60 of 100 bytes"
        );
        drop(first);
        assert!(store.reserve(60).is_some());
    }

    #[test]
    fn concurrent_commits_keep_the_index_and_the_disk_in_step() {
        let (dir, store) = store(30);
        let payloads: Vec<Vec<u8>> = (0u8..6).map(|i| vec![i; 10]).collect();
        std::thread::scope(|scope| {
            for thread in 0..4usize {
                let (store, payloads) = (&store, &payloads);
                scope.spawn(move || {
                    for round in 0..200 {
                        let payload = &payloads[(thread + round) % payloads.len()];
                        let expected = Expected {
                            algo: Algo::Sha256,
                            hex: hex::encode(Sha256::digest(payload)),
                        };
                        let reservation = loop {
                            match store.reserve(10) {
                                Some(reservation) => break reservation,
                                None => std::thread::yield_now(),
                            }
                        };
                        let mut tmp = store.new_tmp().expect("tmp");
                        std::io::Write::write_all(&mut tmp, payload).expect("write");
                        store
                            .commit_blob(tmp, &expected, 10, reservation)
                            .expect("commit");
                    }
                });
            }
        });

        let lru = lock_index(&store.lru);
        assert_eq!(lru.reserved, 0);
        let indexed_bytes: u64 = lru.by_path.values().map(|(_, size)| size).sum();
        assert_eq!(lru.bytes, indexed_bytes);
        assert!(lru.bytes <= 30);
        let on_disk = fs::read_dir(dir.path().join("blobs").join(Algo::Sha256.name()))
            .expect("read_dir")
            .count();
        assert_eq!(on_disk, lru.by_path.len());
        for path in lru.by_path.keys() {
            assert!(path.exists(), "indexed {} is on disk", path.display());
        }
    }

    #[test]
    fn metadata_is_not_served_once_one_of_its_links_is_evicted() {
        let (_dir, store) = store(1000);
        let listed = vec![3u8; 10];
        let link = Link {
            upstream: "https://up.example/a.tgz".to_owned(),
            expected: Expected {
                algo: Algo::Sha256,
                hex: hex::encode(Sha256::digest(&listed)),
            },
            source: "k".to_owned(),
            fetched_at: now_secs(),
        };
        let cached = Cached {
            fetched_at: now_secs(),
            content_type: "text/plain".to_owned(),
            body: b"doc".to_vec(),
        };
        store
            .commit_metadata("k", &[("npm", "a".to_owned(), link)], &cached)
            .expect("commit");
        assert!(store.read_fresh_meta("k").expect("read").is_some());

        // A blob that fits only once the link is gone, so the link is exactly what gets evicted.
        let link_path = store.link_path("npm", "a");
        let link_len = fs::metadata(&link_path).expect("link on disk").len();
        let rest = lock_index(&store.lru).bytes - link_len;
        let blob = vec![7u8; (1000 - rest) as usize];
        let expected = Expected {
            algo: Algo::Sha256,
            hex: hex::encode(Sha256::digest(&blob)),
        };
        let reservation = store.reserve(blob.len() as u64).expect("reserve");
        let mut tmp = store.new_tmp().expect("tmp");
        std::io::Write::write_all(&mut tmp, &blob).expect("write");
        store
            .commit_blob(tmp, &expected, blob.len() as u64, reservation)
            .expect("commit blob");

        assert!(!link_path.exists(), "the link was evicted");
        assert!(
            store.read_fresh_meta("k").expect("read").is_none(),
            "a listing with an evicted link is refetched, not served"
        );
    }

    #[test]
    fn a_listing_larger_than_the_cache_is_refused_whole() {
        let (_dir, store) = store(64);
        let cached = Cached {
            fetched_at: now_secs(),
            content_type: "text/plain".to_owned(),
            body: vec![b'x'; 100],
        };
        assert!(matches!(
            store.commit_metadata("k", &[], &cached),
            Err(Error::TooLarge(64))
        ));
        assert!(store.read_fresh_meta("k").expect("read").is_none());
    }
}
