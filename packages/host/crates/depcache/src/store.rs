//! On-disk state. Artifacts are content-addressed (`blobs/<algo>/<hex>`) and evicted least recently used above a byte
//! cap. Link records say which artifact a metadata document lists under a key; metadata is stored as a small header
//! (`*.head`) and a body (`*.body`), so freshness checks never read the body.

use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};
use tempfile::NamedTempFile;
use tracing::{info, warn};

use crate::digest::{Algo, Expected};

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
}

pub struct Cached {
    pub fetched_at: u64,
    pub content_type: String,
    pub body: Vec<u8>,
}

#[derive(Default)]
struct Lru {
    tick: u64,
    bytes: u64,
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

    fn remove(&mut self, path: &Path) {
        if let Some((tick, size)) = self.by_path.remove(path) {
            self.by_tick.remove(&tick);
            self.bytes -= size;
        }
    }

    /// Least recently used paths to delete so the total fits `cap`, never `keep`.
    fn victims(&self, cap: u64, keep: &Path) -> Vec<PathBuf> {
        let mut bytes = self.bytes;
        let mut victims = Vec::new();
        for path in self.by_tick.values() {
            if bytes <= cap {
                break;
            }
            if path.as_path() == keep {
                continue;
            }
            bytes -= self.by_path[path].1;
            victims.push(path.clone());
        }
        victims
    }
}

pub struct Store {
    root: PathBuf,
    cap: u64,
    lru: Mutex<Lru>,
}

impl Store {
    pub fn open(root: &Path, cap: u64) -> io::Result<Self> {
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
            lru: Mutex::default(),
        };
        store.index_existing_blobs()?;
        Ok(store)
    }

    /// Adopts blobs left by an earlier run, oldest first, and evicts down to the cap.
    fn index_existing_blobs(&self) -> io::Result<()> {
        let mut found = Vec::new();
        for algo in [Algo::Sha512, Algo::Sha256, Algo::Sha1] {
            let dir = self.root.join("blobs").join(algo.name());
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
        let mut lru = self.lru.lock().expect("lru lock");
        for (_, path, size) in found {
            lru.insert(path, size);
        }
        let victims = lru.victims(self.cap, Path::new(""));
        for victim in &victims {
            lru.remove(victim);
        }
        drop(lru);
        remove_evicted(&victims);
        Ok(())
    }

    pub fn cap(&self) -> u64 {
        self.cap
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

    /// Moves a verified download into place and evicts least recently used artifacts above the cap.
    pub fn commit_blob(
        &self,
        tmp: NamedTempFile,
        expected: &Expected,
        size: u64,
    ) -> io::Result<()> {
        let path = self.blob_path(expected);
        tmp.persist(&path).map_err(|e| e.error)?;
        let mut lru = self.lru.lock().expect("lru lock");
        lru.insert(path.clone(), size);
        let victims = lru.victims(self.cap, &path);
        for victim in &victims {
            lru.remove(victim);
        }
        drop(lru);
        remove_evicted(&victims);
        Ok(())
    }

    pub fn touch_blob(&self, path: &Path) {
        self.lru.lock().expect("lru lock").touch(path);
    }

    /// Drops a blob that is missing or failed verification.
    pub fn forget_blob(&self, path: &Path) {
        self.lru.lock().expect("lru lock").remove(path);
        if let Err(e) = fs::remove_file(path) {
            if e.kind() != io::ErrorKind::NotFound {
                warn!("could not remove blob {}: {e}", path.display());
            }
        }
    }

    fn link_path(&self, kind: &str, key: &str) -> PathBuf {
        self.root
            .join("links")
            .join(format!("{}.json", hashed(&format!("{kind}\0{key}"))))
    }

    pub fn read_link(&self, kind: &str, key: &str) -> io::Result<Option<Link>> {
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

    pub fn write_link(&self, kind: &str, key: &str, link: &Link) -> io::Result<()> {
        let bytes = serde_json::to_vec(link).map_err(io::Error::other)?;
        self.write_atomic(&self.link_path(kind, key), &bytes)
    }

    fn meta_path(&self, cache_key: &str, part: &str) -> PathBuf {
        self.root
            .join("meta")
            .join(format!("{}.{part}", hashed(cache_key)))
    }

    pub fn read_meta_head(&self, cache_key: &str) -> io::Result<Option<MetaHead>> {
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

    pub fn read_meta(&self, cache_key: &str) -> io::Result<Option<Cached>> {
        let Some(head) = self.read_meta_head(cache_key)? else {
            return Ok(None);
        };
        let Some(body) = read_optional(&self.meta_path(cache_key, "body"))? else {
            return Ok(None);
        };
        Ok(Some(Cached {
            fetched_at: head.fetched_at,
            content_type: head.content_type,
            body,
        }))
    }

    /// The body goes first, so a header never describes a body that is not yet written.
    pub fn write_meta(&self, cache_key: &str, cached: &Cached) -> io::Result<()> {
        self.write_atomic(&self.meta_path(cache_key, "body"), &cached.body)?;
        let head = MetaHead {
            fetched_at: cached.fetched_at,
            content_type: cached.content_type.clone(),
        };
        let bytes = serde_json::to_vec(&head).map_err(io::Error::other)?;
        self.write_atomic(&self.meta_path(cache_key, "head"), &bytes)
    }

    fn write_atomic(&self, path: &Path, bytes: &[u8]) -> io::Result<()> {
        let mut tmp = self.new_tmp()?;
        tmp.write_all(bytes)?;
        tmp.as_file().sync_data()?;
        tmp.persist(path).map_err(|e| e.error)?;
        Ok(())
    }
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
