//! Metadata and artifacts. Metadata is fetched through a single-flight lock, rewritten to point at this cache, and
//! recorded as links. An artifact is served only through a link that is current: its source metadata is fresh and
//! its latest fetch still lists the artifact with the same digest. Bytes are verified against that digest on every
//! serve, so a corrupted or tampered blob is refetched instead of served. All disk access runs on the blocking pool
//! through `on_store`.

use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::Path;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::body::Body;
use axum::http::{header, HeaderValue};
use axum::response::{IntoResponse, Response};
use futures_util::{Future, StreamExt};
use tokio::io::AsyncWriteExt;
use tokio_util::io::ReaderStream;
use tracing::{info, warn};

use crate::digest::{Expected, Hasher};
use crate::error::Error;
use crate::store::{new_generation, Cached, Link, Pin, Store};
use crate::{AppState, Config};

/// An artifact a metadata document lists, with the digest its bytes must have.
pub struct Artifact {
    pub upstream: String,
    pub expected: Expected,
}

/// What a rewriter produces from an upstream document: the body to serve, and the artifacts it lists as
/// `(link kind, link key, artifact)`.
pub struct Rewritten {
    pub body: Vec<u8>,
    pub content_type: String,
    pub links: Vec<(&'static str, String, Artifact)>,
}

pub type Rewrite = fn(&Config, &str, &[u8], &str) -> Result<Rewritten, String>;

pub fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Runs a store operation on the blocking pool, so disk I/O never stalls the async runtime.
pub async fn on_store<T: Send + 'static>(
    state: &Arc<AppState>,
    op: impl FnOnce(&Store) -> Result<T, Error> + Send + 'static,
) -> Result<T, Error> {
    let state = Arc::clone(state);
    tokio::task::spawn_blocking(move || op(&state.store))
        .await
        .map_err(|e| Error::Internal(e.to_string()))?
}

/// Returns the metadata document under `kind/variant/key`, fetching and rewriting it when it is missing or older than
/// the TTL. `upstream` is the origin URL; `accept` is sent upstream.
pub async fn metadata(
    state: &Arc<AppState>,
    kind: &str,
    variant: &str,
    key: &str,
    upstream: &str,
    accept: &str,
    rewrite: Rewrite,
) -> Result<Cached, Error> {
    let cache_key = format!("{kind}/{variant}/{key}");
    if let Some(cached) = fresh_metadata(state, &cache_key).await? {
        return Ok(cached);
    }
    let _flight = state.flights.lock(&format!("meta:{cache_key}")).await;
    if let Some(cached) = fresh_metadata(state, &cache_key).await? {
        return Ok(cached);
    }
    let _slot = state
        .metadata_slots
        .acquire()
        .await
        .map_err(|e| Error::Internal(e.to_string()))?;
    let response = state
        .client
        .get(upstream)
        .header(header::ACCEPT, accept)
        .send()
        .await?;
    let status = response.status();
    if status == reqwest::StatusCode::NOT_FOUND {
        return Err(Error::NotFound(format!(
            "{upstream} does not exist upstream"
        )));
    }
    if !status.is_success() {
        return Err(Error::Upstream(format!("{upstream} answered {status}")));
    }
    let content_type = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_owned();
    let body = read_metadata(response, state.config.max_metadata_bytes, upstream).await?;
    let rewritten =
        rewrite(&state.config, upstream, &body, &content_type).map_err(Error::Upstream)?;
    let fetched_at = now_secs();
    let generation = new_generation();
    info!(
        "fetched {cache_key}: {} artifacts listed",
        rewritten.links.len()
    );
    let links: Vec<(&'static str, String, Link)> = rewritten
        .links
        .into_iter()
        .map(|(link_kind, link_key, artifact)| {
            let link = Link {
                upstream: artifact.upstream,
                expected: artifact.expected,
                source: cache_key.clone(),
                fetched_at,
                generation: generation.clone(),
            };
            (link_kind, link_key, link)
        })
        .collect();
    let cached = Cached {
        fetched_at,
        generation,
        content_type: rewritten.content_type,
        body: rewritten.body,
    };
    let commit_key = cache_key.clone();
    on_store(state, move |store| {
        store.commit_metadata(&commit_key, &links, &cached)?;
        Ok(cached)
    })
    .await
}

async fn fresh_metadata(state: &Arc<AppState>, cache_key: &str) -> Result<Option<Cached>, Error> {
    let cache_key = cache_key.to_owned();
    on_store(state, move |store| Ok(store.read_fresh_meta(&cache_key)?)).await
}

/// Reads a metadata document, refusing one over `limit`. Metadata is held in memory until it is rewritten, so the read
/// stops at the limit instead of buffering whatever the upstream sends.
async fn read_metadata(
    response: reqwest::Response,
    limit: u64,
    upstream: &str,
) -> Result<Vec<u8>, Error> {
    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        if (body.len() + chunk.len()) as u64 > limit {
            return Err(Error::Upstream(format!(
                "{upstream} sends more than {limit} bytes of metadata"
            )));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

/// The current link for `kind/key`. When there is none, `refresh` (the fetch of the metadata that lists it) runs
/// once; the link is then looked up again. A listing that dropped the artifact is a 404 even if its bytes are stored.
pub async fn resolve_link(
    state: &Arc<AppState>,
    kind: &'static str,
    key: &str,
    refresh: impl Future<Output = Result<Cached, Error>>,
) -> Result<Link, Error> {
    if let Some(link) = current_link(state, kind, key).await? {
        return Ok(link);
    }
    refresh.await?;
    current_link(state, kind, key)
        .await?
        .ok_or_else(|| Error::NotFound(format!("{key} is not listed by its upstream any more")))
}

async fn current_link(
    state: &Arc<AppState>,
    kind: &'static str,
    key: &str,
) -> Result<Option<Link>, Error> {
    let key = key.to_owned();
    on_store(state, move |store| Ok(store.current_link(kind, &key)?)).await
}

/// Opens the artifact a current link names, verified against the link's digest. Downloads it first when it is not
/// stored or fails verification. Returns the file, its length, and a pin that keeps it cached while it is read.
pub async fn artifact(
    state: &Arc<AppState>,
    kind: &'static str,
    key: &str,
    link: &Link,
) -> Result<(File, u64, Pin), Error> {
    let path = state.store.blob_path(&link.expected);
    let _flight = state
        .flights
        .lock(&format!("blob:{}", path.display()))
        .await;
    let (verify_path, expected) = (path, link.expected.clone());
    let stored = on_store(state, move |store| {
        Ok(verify_stored(store, &verify_path, &expected)?)
    })
    .await?;
    match stored {
        Some(found) => Ok(found),
        None => download(state, kind, key, link).await,
    }
}

/// Re-hashes a stored blob. A missing or corrupted blob yields `None`, and a corrupted one is removed.
fn verify_stored(
    store: &Store,
    path: &Path,
    expected: &Expected,
) -> io::Result<Option<(File, u64, Pin)>> {
    let (mut file, pin) = match store.open_blob(path) {
        Ok(opened) => opened,
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            store.forget_blob(path);
            return Ok(None);
        }
        Err(e) => return Err(e),
    };
    let len = file.metadata()?.len();
    let mut hasher = Hasher::new(expected.algo);
    let mut buf = vec![0u8; 1 << 16];
    loop {
        let read = file.read(&mut buf)?;
        if read == 0 {
            break;
        }
        hasher.update(&buf[..read]);
    }
    if hasher.finish_hex() != expected.hex {
        warn!(
            "stored artifact {} fails verification; removing it",
            path.display()
        );
        store.forget_blob(path);
        return Ok(None);
    }
    file.seek(SeekFrom::Start(0))?;
    Ok(Some((file, len, pin)))
}

/// Streams the artifact into a temporary file, hashing as it goes. Only bytes that match the digest are committed,
/// and the file served is the one committed, not a reopen of its path.
async fn download(
    state: &Arc<AppState>,
    kind: &'static str,
    key: &str,
    link: &Link,
) -> Result<(File, u64, Pin), Error> {
    let response = state.client.get(&link.upstream).send().await?;
    let status = response.status();
    if !status.is_success() {
        return Err(Error::Upstream(format!(
            "{} answered {status}",
            link.upstream
        )));
    }
    let limit = state.max_artifact_bytes;
    let declared = response.content_length();
    if let Some(declared) = declared {
        if declared > limit {
            return Err(Error::TooLarge(declared));
        }
    }
    // Held from here until the download commits or fails, so concurrent downloads cannot together outgrow the cap.
    // A response without a declared length may be as large as the per-artifact limit.
    let budget = declared.unwrap_or(limit);
    let reservation = on_store(state, move |store| Ok(store.reserve(budget)))
        .await?
        .ok_or_else(|| {
            Error::Busy(format!(
                "downloads hold the cache budget; retry {}",
                link.upstream
            ))
        })?;
    let (tmp, out) = on_store(state, |store| {
        let tmp = store.new_tmp()?;
        let out = tmp.reopen()?;
        Ok((tmp, out))
    })
    .await?;
    let mut out = tokio::fs::File::from_std(out);
    let mut hasher = Hasher::new(link.expected.algo);
    let mut size = 0u64;
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        size += chunk.len() as u64;
        if size > budget {
            return Err(Error::TooLarge(size));
        }
        hasher.update(&chunk);
        out.write_all(&chunk).await?;
    }
    out.flush().await?;
    drop(out);
    let algo = link.expected.algo.name();
    if hasher.finish_hex() != link.expected.hex {
        return Err(Error::Upstream(format!(
            "{} does not match the {algo} its metadata lists for it",
            link.upstream
        )));
    }
    let expected = link.expected.clone();
    let (file, pin) = on_store(state, move |store| {
        Ok(store.commit_blob(tmp, &expected, size, reservation)?)
    })
    .await?;
    info!("stored {kind} {key}: {size} bytes, verified {algo}");
    Ok((file, size, pin))
}

/// Streams a verified artifact to the client. The pin is held until the body is dropped, so the file stays cached.
pub fn file_response(file: File, len: u64, pin: Pin) -> Response {
    let stream = ReaderStream::new(tokio::fs::File::from_std(file)).map(move |chunk| {
        let _pinned = &pin;
        chunk
    });
    let body = Body::from_stream(stream);
    let mut response = body.into_response();
    response
        .headers_mut()
        .insert(header::CONTENT_LENGTH, HeaderValue::from(len));
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/octet-stream"),
    );
    response
}

/// Serves rewritten metadata with the upstream content type.
pub fn cached_response(cached: Cached) -> Response {
    let content_type = HeaderValue::try_from(cached.content_type)
        .unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream"));
    ([(header::CONTENT_TYPE, content_type)], cached.body).into_response()
}
