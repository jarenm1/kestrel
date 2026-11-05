//! Object storage behind a small key/value interface: a local directory (`file://`, tests and single host) or an
//! S3-compatible bucket (`s3://`, Cloudflare R2 in production). Keys are logical (`boxes/<box>/...`); the URL's path is a
//! prefix in front of them.

use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::thread;
use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail, ensure};
use reqwest::StatusCode;
use reqwest::blocking::{Client, RequestBuilder, Response};
use rusty_s3::actions::{DeleteObject, GetObject, HeadObject, ListObjectsV2, PutObject};
use rusty_s3::{Bucket, Credentials, S3Action, UrlStyle};
use url::Url;

const PRESIGN_TTL: Duration = Duration::from_secs(300);
const MAX_ATTEMPTS: u32 = 5;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);

pub trait Store: Send + Sync {
    fn put(&self, key: &str, bytes: &[u8]) -> Result<()>;
    fn get(&self, key: &str) -> Result<Option<Vec<u8>>>;
    fn exists(&self, key: &str) -> Result<bool>;
    /// Every key that starts with `prefix`, in no particular order.
    fn list(&self, prefix: &str) -> Result<Vec<String>>;
    /// Deleting a missing key succeeds.
    fn delete(&self, key: &str) -> Result<()>;
}

/// Opens the store named by `url`: `file:///dir` or `s3://bucket/prefix`.
pub fn open(url: &str) -> Result<Box<dyn Store>> {
    let url = Url::parse(url).with_context(|| format!("invalid store URL {url:?}"))?;
    match url.scheme() {
        "file" => {
            let root = url
                .to_file_path()
                .map_err(|()| anyhow!("file store URL must be an absolute local path"))?;
            Ok(Box::new(FileStore::new(root)))
        }
        "s3" => {
            let bucket = url
                .host_str()
                .ok_or_else(|| anyhow!("s3 store URL needs a bucket"))?;
            let prefix = url.path().trim_matches('/').to_owned();
            Ok(Box::new(S3Store::from_env(bucket, &prefix)?))
        }
        other => bail!("unsupported store scheme {other:?}; use file:// or s3://"),
    }
}

/// Rejects keys that could leave the store: every key lives under `boxes/` and has no empty, `.` or `..` segment.
fn check_key(key: &str) -> Result<()> {
    ensure!(
        key.starts_with("boxes/"),
        "store key {key:?} is outside boxes/"
    );
    for segment in key.split('/') {
        ensure!(
            !segment.is_empty() && segment != "." && segment != ".." && !segment.contains('\\'),
            "store key {key:?} has an invalid segment"
        );
    }
    Ok(())
}

fn check_prefix(prefix: &str) -> Result<()> {
    check_key(prefix.strip_suffix('/').unwrap_or(prefix))
}

pub struct FileStore {
    root: PathBuf,
}

impl FileStore {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    fn path(&self, key: &str) -> Result<PathBuf> {
        check_key(key)?;
        Ok(self.root.join(key))
    }
}

impl Store for FileStore {
    /// Writes to a staging file, fsyncs it, renames it into place and fsyncs the directory, so a reader sees either
    /// the old object or the whole new one.
    fn put(&self, key: &str, bytes: &[u8]) -> Result<()> {
        let path = self.path(key)?;
        let parent = path.parent().expect("keys have a parent directory");
        fs::create_dir_all(parent).with_context(|| format!("creating {}", parent.display()))?;
        let staging_dir = self.root.join(".staging");
        fs::create_dir_all(&staging_dir)
            .with_context(|| format!("creating {}", staging_dir.display()))?;
        let mut token = [0u8; 8];
        getrandom::fill(&mut token).map_err(|e| anyhow!("random staging name: {e}"))?;
        let staged = staging_dir.join(hex::encode(token));
        let mut file = fs::File::create_new(&staged)
            .with_context(|| format!("creating {}", staged.display()))?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&staged, &path).with_context(|| format!("renaming into {}", path.display()))?;
        fs::File::open(parent)?.sync_all()?;
        Ok(())
    }

    fn get(&self, key: &str) -> Result<Option<Vec<u8>>> {
        match fs::read(self.path(key)?) {
            Ok(bytes) => Ok(Some(bytes)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e).with_context(|| format!("reading {key}")),
        }
    }

    fn exists(&self, key: &str) -> Result<bool> {
        Ok(self.path(key)?.is_file())
    }

    fn list(&self, prefix: &str) -> Result<Vec<String>> {
        check_prefix(prefix)?;
        let dir_part = match prefix.rfind('/') {
            Some(i) => &prefix[..=i],
            None => prefix,
        };
        let mut keys = Vec::new();
        let mut pending = vec![self.root.join(dir_part)];
        while let Some(dir) = pending.pop() {
            let entries = match fs::read_dir(&dir) {
                Ok(entries) => entries,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Err(e) => return Err(e).with_context(|| format!("listing {}", dir.display())),
            };
            for entry in entries {
                let path = entry?.path();
                if path.is_dir() {
                    pending.push(path);
                } else if let Ok(rel) = path.strip_prefix(&self.root) {
                    let key = rel.to_string_lossy().into_owned();
                    if key.starts_with(prefix) {
                        keys.push(key);
                    }
                }
            }
        }
        Ok(keys)
    }

    fn delete(&self, key: &str) -> Result<()> {
        match fs::remove_file(self.path(key)?) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e).with_context(|| format!("deleting {key}")),
        }
    }
}

pub struct S3Store {
    client: Client,
    bucket: Bucket,
    credentials: Credentials,
    prefix: String,
}

impl S3Store {
    fn from_env(bucket: &str, prefix: &str) -> Result<Self> {
        let endpoint =
            std::env::var("KESTREL_S3_ENDPOINT").context("KESTREL_S3_ENDPOINT is not set")?;
        let endpoint = Url::parse(&endpoint).context("KESTREL_S3_ENDPOINT is not a URL")?;
        let region = std::env::var("KESTREL_S3_REGION").unwrap_or_else(|_| "auto".to_owned());
        let key_id = std::env::var("KESTREL_S3_ACCESS_KEY_ID")
            .context("KESTREL_S3_ACCESS_KEY_ID is not set")?;
        let secret = std::env::var("KESTREL_S3_SECRET_ACCESS_KEY")
            .context("KESTREL_S3_SECRET_ACCESS_KEY is not set")?;
        let bucket = Bucket::new(endpoint, UrlStyle::Path, bucket.to_owned(), region)
            .context("invalid S3 endpoint or bucket")?;
        let prefix = if prefix.is_empty() {
            String::new()
        } else {
            format!("{prefix}/")
        };
        Ok(Self {
            client: Client::builder()
                .timeout(REQUEST_TIMEOUT)
                .build()
                .context("building HTTP client")?,
            bucket,
            credentials: Credentials::new(key_id, secret),
            prefix,
        })
    }

    fn object(&self, key: &str) -> Result<String> {
        check_key(key)?;
        Ok(format!("{}{key}", self.prefix))
    }

    /// Sends a request, retrying transport errors, 429 and 5xx with backoff. The caller checks the final status.
    fn send(&self, what: &str, build: impl Fn() -> RequestBuilder) -> Result<Response> {
        let mut attempt = 0;
        loop {
            attempt += 1;
            let outcome = build().send();
            let retry = match &outcome {
                Err(_) => true,
                Ok(resp) => {
                    resp.status().is_server_error()
                        || resp.status() == StatusCode::TOO_MANY_REQUESTS
                }
            };
            if retry && attempt < MAX_ATTEMPTS {
                thread::sleep(Duration::from_millis(200 * 2u64.pow(attempt)));
                continue;
            }
            return outcome.map_err(|e| anyhow!("{what}: {}", e.without_url()));
        }
    }
}

fn expect_success(resp: Response, what: &str) -> Result<Response> {
    let status = resp.status();
    ensure!(status.is_success(), "{what}: HTTP {status}");
    Ok(resp)
}

impl Store for S3Store {
    fn put(&self, key: &str, bytes: &[u8]) -> Result<()> {
        let object = self.object(key)?;
        let resp = self.send(&format!("put {key}"), || {
            let url =
                PutObject::new(&self.bucket, Some(&self.credentials), &object).sign(PRESIGN_TTL);
            self.client.put(url).body(bytes.to_vec())
        })?;
        expect_success(resp, &format!("put {key}"))?;
        Ok(())
    }

    fn get(&self, key: &str) -> Result<Option<Vec<u8>>> {
        let object = self.object(key)?;
        let resp = self.send(&format!("get {key}"), || {
            let url =
                GetObject::new(&self.bucket, Some(&self.credentials), &object).sign(PRESIGN_TTL);
            self.client.get(url)
        })?;
        if resp.status() == StatusCode::NOT_FOUND {
            return Ok(None);
        }
        let resp = expect_success(resp, &format!("get {key}"))?;
        let bytes = resp
            .bytes()
            .map_err(|e| anyhow!("reading {key}: {}", e.without_url()))?;
        Ok(Some(bytes.to_vec()))
    }

    fn exists(&self, key: &str) -> Result<bool> {
        let object = self.object(key)?;
        let resp = self.send(&format!("head {key}"), || {
            let url =
                HeadObject::new(&self.bucket, Some(&self.credentials), &object).sign(PRESIGN_TTL);
            self.client.head(url)
        })?;
        match resp.status() {
            StatusCode::NOT_FOUND => Ok(false),
            _ => Ok(expect_success(resp, &format!("head {key}"))?
                .status()
                .is_success()),
        }
    }

    fn list(&self, prefix: &str) -> Result<Vec<String>> {
        check_prefix(prefix)?;
        let full_prefix = format!("{}{prefix}", self.prefix);
        let mut keys = Vec::new();
        let mut token: Option<String> = None;
        loop {
            let resp = self.send(&format!("list {prefix}"), || {
                let mut action = ListObjectsV2::new(&self.bucket, Some(&self.credentials));
                action.with_prefix(full_prefix.clone());
                if let Some(t) = &token {
                    action.with_continuation_token(t.clone());
                }
                self.client.get(action.sign(PRESIGN_TTL))
            })?;
            let text = expect_success(resp, &format!("list {prefix}"))?
                .text()
                .map_err(|e| anyhow!("reading listing of {prefix}: {}", e.without_url()))?;
            let page = ListObjectsV2::parse_response(&text)
                .map_err(|e| anyhow!("parsing listing of {prefix}: {e}"))?;
            for object in page.contents {
                if let Some(key) = object.key.strip_prefix(&self.prefix) {
                    keys.push(key.to_owned());
                }
            }
            match page.next_continuation_token {
                Some(next) => token = Some(next),
                None => return Ok(keys),
            }
        }
    }

    fn delete(&self, key: &str) -> Result<()> {
        let object = self.object(key)?;
        let resp = self.send(&format!("delete {key}"), || {
            let url =
                DeleteObject::new(&self.bucket, Some(&self.credentials), &object).sign(PRESIGN_TTL);
            self.client.delete(url)
        })?;
        if resp.status() == StatusCode::NOT_FOUND {
            return Ok(());
        }
        expect_success(resp, &format!("delete {key}"))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_cannot_escape_the_store() {
        assert!(check_key("boxes/a/chunks/abc").is_ok());
        assert!(check_key("boxes/../secrets").is_err());
        assert!(check_key("boxes/a/./b").is_err());
        assert!(check_key("boxes//a").is_err());
        assert!(check_key("etc/passwd").is_err());
        assert!(check_prefix("boxes/a/manifests/").is_ok());
        assert!(check_prefix("boxes/a/../b/").is_err());
    }

    #[test]
    fn file_store_round_trips_and_lists() {
        let dir = tempfile::tempdir().unwrap();
        let store = FileStore::new(dir.path().to_path_buf());
        store.put("boxes/a/chunks/one", b"1").unwrap();
        store.put("boxes/a/manifests/1.json", b"m").unwrap();
        store.put("boxes/b/chunks/two", b"2").unwrap();
        assert_eq!(
            store.get("boxes/a/chunks/one").unwrap(),
            Some(b"1".to_vec())
        );
        assert_eq!(store.get("boxes/a/chunks/none").unwrap(), None);
        assert!(store.exists("boxes/b/chunks/two").unwrap());
        let mut listed = store.list("boxes/a/").unwrap();
        listed.sort();
        assert_eq!(
            listed,
            vec!["boxes/a/chunks/one", "boxes/a/manifests/1.json"]
        );
        store.delete("boxes/a/chunks/one").unwrap();
        store.delete("boxes/a/chunks/one").unwrap();
        assert!(!store.exists("boxes/a/chunks/one").unwrap());
    }
}
