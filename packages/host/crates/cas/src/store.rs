//! On-disk layout under `storage_dir`:
//!
//! - `blobs/sha256/<aa>/<hash>`: immutable bytes named by their SHA-256. Written to `tmp/`, hashed while streamed, then
//!   renamed into place, so a blob is never visible half-written and its name always matches its bytes.
//! - `refs/<namespace>/<key>`: a text file holding the hash of the blob a key points to. Replaced by rename.
//! - `tmp/`: staging. Emptied at start, since no write survives a restart.
//!
//! The blob index (sizes and recency, for LRU eviction) lives in memory and is rebuilt from `blobs/` at start.

use std::collections::{BTreeSet, HashMap};
use std::fs;
use std::io::{self, ErrorKind};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::UNIX_EPOCH;

use axum::body::Bytes;
use futures_util::{Stream, StreamExt};
use sha2::{Digest, Sha256};
use tokio::fs::File;
use tokio::io::AsyncWriteExt;
use tracing::{debug, info, warn};

use crate::error::Error;

/// Longest accepted ref key, in bytes.
const MAX_KEY_BYTES: usize = 1024;

#[derive(Clone, Debug)]
pub struct Config {
    pub storage_dir: PathBuf,
    /// Total size of blobs. Least recently used blobs are evicted above it.
    pub cap_bytes: u64,
    /// Largest blob accepted. Must not exceed `cap_bytes`.
    pub max_object_bytes: u64,
}

pub struct Store {
    config: Config,
    index: Mutex<Index>,
    next_tmp: AtomicU64,
}

#[derive(Default)]
struct Index {
    blobs: HashMap<String, Blob>,
    /// Blobs ordered by last use, oldest first. Eviction takes the first entry.
    by_use: BTreeSet<(u64, String)>,
    total: u64,
    clock: u64,
}

struct Blob {
    size: u64,
    used: u64,
}

/// A body hashed and written under `tmp/`, not yet visible under its digest.
struct Staged {
    tmp: PathBuf,
    hash: String,
    size: u64,
}

impl Store {
    pub fn open(config: Config) -> io::Result<Self> {
        if config.max_object_bytes > config.cap_bytes {
            return Err(io::Error::new(
                ErrorKind::InvalidInput,
                "max_object_bytes must not exceed cap_bytes",
            ));
        }
        let blobs = blobs_dir(&config.storage_dir);
        let tmp = config.storage_dir.join("tmp");
        fs::create_dir_all(&blobs)?;
        fs::create_dir_all(config.storage_dir.join("refs"))?;
        // Leftovers from a previous run. A missing directory is the normal first start.
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp)?;

        let mut found = Vec::new();
        for prefix in fs::read_dir(&blobs)? {
            let prefix = prefix?;
            if !prefix.file_type()?.is_dir() {
                continue;
            }
            for entry in fs::read_dir(prefix.path())? {
                let entry = entry?;
                let name = entry.file_name();
                let Some(hash) = name.to_str().filter(|h| is_hash(h)) else {
                    continue;
                };
                let meta = entry.metadata()?;
                if !meta.is_file() {
                    continue;
                }
                let modified = meta.modified().unwrap_or(UNIX_EPOCH);
                found.push((modified, hash.to_owned(), meta.len()));
            }
        }
        // Oldest first, so the recency order after a restart matches the files' modification times.
        found.sort();
        let mut index = Index::default();
        for (_, hash, size) in found {
            index.insert(hash, size);
        }
        index.evict(&config.storage_dir, config.cap_bytes);
        info!(
            storage_dir = %config.storage_dir.display(),
            blobs = index.blobs.len(),
            size_mb = index.total / (1024 * 1024),
            cap_mb = config.cap_bytes / (1024 * 1024),
            "opened CAS store"
        );

        Ok(Self {
            config,
            index: Mutex::new(index),
            next_tmp: AtomicU64::new(0),
        })
    }

    /// Stores a blob that must hash to `hash`. Returns whether it was new.
    pub async fn put_blob<S, E>(&self, hash: &str, body: S) -> Result<bool, Error>
    where
        S: Stream<Item = Result<Bytes, E>> + Send,
        E: std::error::Error + Send + Sync + 'static,
    {
        validate_hash(hash)?;
        let staged = self.stage(body).await?;
        if staged.hash != hash {
            let computed = staged.hash.clone();
            self.discard(&staged).await;
            return Err(Error::BadRequest(format!(
                "body hashes to {computed}, not {hash}"
            )));
        }
        self.commit(staged).await
    }

    /// Stores `body` as a blob and points `namespace/key` at it. Returns the blob's hash.
    pub async fn put_ref<S, E>(&self, namespace: &str, key: &str, body: S) -> Result<String, Error>
    where
        S: Stream<Item = Result<Bytes, E>> + Send,
        E: std::error::Error + Send + Sync + 'static,
    {
        let path = ref_path(&self.config.storage_dir, namespace, key)?;
        let staged = self.stage(body).await?;
        let hash = staged.hash.clone();
        self.commit(staged).await?;
        self.write_ref(&path, &hash).await?;
        debug!(namespace, key, hash = %hash, "stored ref");
        Ok(hash)
    }

    pub async fn open_blob(&self, hash: &str) -> Result<(File, u64), Error> {
        validate_hash(hash)?;
        if !self.lock().touch(hash) {
            return Err(Error::NotFound(format!("no blob {hash}")));
        }
        open_file(&blob_path(&self.config.storage_dir, hash), hash).await
    }

    /// Opens the blob a key points at. Returns the file, its size and its hash.
    pub async fn open_ref(&self, namespace: &str, key: &str) -> Result<(File, u64, String), Error> {
        let path = ref_path(&self.config.storage_dir, namespace, key)?;
        let text = match tokio::fs::read_to_string(&path).await {
            Ok(text) => text,
            Err(e) if matches!(e.kind(), ErrorKind::NotFound | ErrorKind::IsADirectory) => {
                return Err(Error::NotFound(format!("no ref {namespace}/{key}")));
            }
            Err(e) => return Err(e.into()),
        };
        let hash = text.trim_end().to_owned();
        if !is_hash(&hash) {
            return Err(Error::Internal(format!("ref {namespace}/{key} is corrupt")));
        }
        let (file, size) = self.open_blob(&hash).await?;
        Ok((file, size, hash))
    }

    /// Removes a ref. The blob stays until eviction. Removing a missing ref succeeds.
    pub async fn delete_ref(&self, namespace: &str, key: &str) -> Result<(), Error> {
        let path = ref_path(&self.config.storage_dir, namespace, key)?;
        match tokio::fs::remove_file(&path).await {
            Ok(()) => Ok(()),
            Err(e) if matches!(e.kind(), ErrorKind::NotFound | ErrorKind::IsADirectory) => Ok(()),
            Err(e) => Err(e.into()),
        }
    }

    fn lock(&self) -> MutexGuard<'_, Index> {
        // The index holds no invariant a panic could leave half-written beyond a stale recency, so a poisoned lock
        // is still usable.
        self.index.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn tmp_path(&self) -> PathBuf {
        let n = self.next_tmp.fetch_add(1, Ordering::Relaxed);
        self.config
            .storage_dir
            .join("tmp")
            .join(format!("{}-{n}.tmp", std::process::id()))
    }

    /// Streams `body` into a temporary file while hashing it. A failed body leaves nothing behind.
    async fn stage<S, E>(&self, body: S) -> Result<Staged, Error>
    where
        S: Stream<Item = Result<Bytes, E>> + Send,
        E: std::error::Error + Send + Sync + 'static,
    {
        let tmp = self.tmp_path();
        match self.write_tmp(&tmp, body).await {
            Ok((hash, size)) => Ok(Staged { tmp, hash, size }),
            Err(e) => {
                let _ = tokio::fs::remove_file(&tmp).await;
                Err(e)
            }
        }
    }

    async fn write_tmp<S, E>(&self, tmp: &Path, body: S) -> Result<(String, u64), Error>
    where
        S: Stream<Item = Result<Bytes, E>> + Send,
        E: std::error::Error + Send + Sync + 'static,
    {
        let mut body = Box::pin(body);
        let mut file = File::create(tmp).await?;
        let mut hasher = Sha256::new();
        let mut size = 0u64;
        while let Some(chunk) = body.next().await {
            let chunk = chunk.map_err(|e| Error::BadRequest(format!("reading body: {e}")))?;
            size += chunk.len() as u64;
            if size > self.config.max_object_bytes {
                return Err(Error::TooLarge(self.config.max_object_bytes));
            }
            hasher.update(&chunk);
            file.write_all(&chunk).await?;
        }
        file.sync_all().await?;
        Ok((hex::encode(hasher.finalize()), size))
    }

    async fn discard(&self, staged: &Staged) {
        let _ = tokio::fs::remove_file(&staged.tmp).await;
    }

    /// Moves a staged body to its digest path and indexes it. Renames even when the blob exists, so the file is
    /// present whenever the index says so.
    async fn commit(&self, staged: Staged) -> Result<bool, Error> {
        let dest = blob_path(&self.config.storage_dir, &staged.hash);
        let renamed = async {
            if let Some(parent) = dest.parent() {
                tokio::fs::create_dir_all(parent).await?;
            }
            tokio::fs::rename(&staged.tmp, &dest).await
        }
        .await;
        if let Err(e) = renamed {
            self.discard(&staged).await;
            return Err(e.into());
        }

        let mut index = self.lock();
        let created = index.insert(staged.hash, staged.size);
        index.evict(&self.config.storage_dir, self.config.cap_bytes);
        Ok(created)
    }

    async fn write_ref(&self, path: &Path, hash: &str) -> Result<(), Error> {
        let tmp = self.tmp_path();
        let written = async {
            if let Some(parent) = path.parent() {
                tokio::fs::create_dir_all(parent).await?;
            }
            tokio::fs::write(&tmp, format!("{hash}\n")).await?;
            tokio::fs::rename(&tmp, path).await
        }
        .await;
        match written {
            Ok(()) => Ok(()),
            Err(e) => {
                let _ = tokio::fs::remove_file(&tmp).await;
                Err(match e.kind() {
                    ErrorKind::NotADirectory
                    | ErrorKind::IsADirectory
                    | ErrorKind::AlreadyExists => {
                        Error::Conflict(format!("key collides with another key: {e}"))
                    }
                    _ => e.into(),
                })
            }
        }
    }
}

impl Index {
    /// Adds a blob as most recently used. Returns false when it was already indexed (and touches it).
    fn insert(&mut self, hash: String, size: u64) -> bool {
        if self.touch(&hash) {
            return false;
        }
        self.clock += 1;
        self.by_use.insert((self.clock, hash.clone()));
        self.blobs.insert(
            hash,
            Blob {
                size,
                used: self.clock,
            },
        );
        self.total += size;
        true
    }

    /// Marks a blob as most recently used. Returns false when it is not indexed.
    fn touch(&mut self, hash: &str) -> bool {
        let Some(blob) = self.blobs.get_mut(hash) else {
            return false;
        };
        self.by_use.remove(&(blob.used, hash.to_owned()));
        self.clock += 1;
        blob.used = self.clock;
        self.by_use.insert((blob.used, hash.to_owned()));
        true
    }

    /// Deletes least recently used blobs until the total fits `cap`. Files are removed under the lock, so an insert
    /// of the same digest cannot race with the unlink.
    fn evict(&mut self, storage_dir: &Path, cap: u64) {
        while self.total > cap {
            let Some((_, hash)) = self.by_use.pop_first() else {
                break;
            };
            let Some(blob) = self.blobs.remove(&hash) else {
                continue;
            };
            self.total -= blob.size;
            if let Err(e) = fs::remove_file(blob_path(storage_dir, &hash)) {
                if e.kind() != ErrorKind::NotFound {
                    warn!(hash = %hash, error = %e, "could not remove evicted blob");
                }
            }
            debug!(hash = %hash, size = blob.size, "evicted blob");
        }
    }
}

async fn open_file(path: &Path, hash: &str) -> Result<(File, u64), Error> {
    let file = match File::open(path).await {
        Ok(file) => file,
        Err(e) if e.kind() == ErrorKind::NotFound => {
            return Err(Error::NotFound(format!("no blob {hash}")));
        }
        Err(e) => return Err(e.into()),
    };
    let size = file.metadata().await?.len();
    Ok((file, size))
}

fn blobs_dir(storage_dir: &Path) -> PathBuf {
    storage_dir.join("blobs").join("sha256")
}

fn blob_path(storage_dir: &Path, hash: &str) -> PathBuf {
    blobs_dir(storage_dir).join(&hash[0..2]).join(hash)
}

/// `refs/<namespace>/<key segments...>`. Both are validated, so the joined path stays under `refs/`.
fn ref_path(storage_dir: &Path, namespace: &str, key: &str) -> Result<PathBuf, Error> {
    validate_namespace(namespace)?;
    validate_key(key)?;
    let mut path = storage_dir.join("refs").join(namespace);
    for segment in key.split('/') {
        path.push(segment);
    }
    Ok(path)
}

fn is_hash(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn validate_hash(hash: &str) -> Result<(), Error> {
    if is_hash(hash) {
        Ok(())
    } else {
        Err(Error::BadRequest(
            "digest must be 64 lowercase hex characters".to_owned(),
        ))
    }
}

fn is_name_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_')
}

fn validate_namespace(namespace: &str) -> Result<(), Error> {
    if namespace.is_empty()
        || namespace.len() > 63
        || namespace.starts_with('.')
        || !namespace.bytes().all(is_name_byte)
    {
        return Err(Error::BadRequest(
            "namespace must be 1 to 63 characters of [A-Za-z0-9._-] and not start with '.'"
                .to_owned(),
        ));
    }
    Ok(())
}

fn validate_key(key: &str) -> Result<(), Error> {
    if key.is_empty() || key.len() > MAX_KEY_BYTES {
        return Err(Error::BadRequest(format!(
            "key must be 1 to {MAX_KEY_BYTES} bytes"
        )));
    }
    for segment in key.split('/') {
        if segment.is_empty()
            || segment == "."
            || segment == ".."
            || !segment.bytes().all(is_name_byte)
        {
            return Err(Error::BadRequest(
                "key segments must be non-empty, not '.' or '..', and use [A-Za-z0-9._-]"
                    .to_owned(),
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_cannot_escape_the_refs_directory() {
        let root = Path::new("/store");
        assert!(ref_path(root, "ns", "a/b.o").is_ok());
        assert!(ref_path(root, "ns", "../x").is_err());
        assert!(ref_path(root, "ns", "a//b").is_err());
        assert!(ref_path(root, "ns", "a/./b").is_err());
        assert!(ref_path(root, "ns", "/abs").is_err());
        assert!(ref_path(root, "..", "x").is_err());
        assert!(ref_path(root, ".hidden", "x").is_err());
        assert!(ref_path(root, "ns/x", "y").is_err());
    }

    #[test]
    fn digests_must_be_lowercase_hex() {
        assert!(is_hash(&"a".repeat(64)));
        assert!(!is_hash(&"A".repeat(64)));
        assert!(!is_hash(&"a".repeat(63)));
    }
}
