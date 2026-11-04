//! Metadata and artifacts. Metadata is fetched through a single-flight lock, rewritten to point at this cache, and
//! recorded as links. An artifact is served only through a link that is current: its source metadata is fresh and
//! its latest fetch still lists the artifact with the same digest. Bytes are verified against that digest on every
//! serve, so a corrupted or tampered blob is refetched instead of served.

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
use crate::store::{Cached, Link};
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

fn is_fresh(state: &AppState, fetched_at: u64) -> bool {
    now_secs().saturating_sub(fetched_at) < state.config.metadata_ttl.as_secs()
}

/// Returns the metadata document under `kind/variant/key`, fetching and rewriting it when it is missing or older than
/// the TTL. `upstream` is the origin URL; `accept` is sent upstream.
pub async fn metadata(
    state: &AppState,
    kind: &str,
    variant: &str,
    key: &str,
    upstream: &str,
    accept: &str,
    rewrite: Rewrite,
) -> Result<Cached, Error> {
    let cache_key = format!("{kind}/{variant}/{key}");
    if let Some(cached) = fresh_metadata(state, &cache_key)? {
        return Ok(cached);
    }
    let _flight = state.flights.lock(&format!("meta:{cache_key}")).await;
    if let Some(cached) = fresh_metadata(state, &cache_key)? {
        return Ok(cached);
    }
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
    let body = response.bytes().await?;
    let rewritten =
        rewrite(&state.config, upstream, &body, &content_type).map_err(Error::Upstream)?;
    let fetched_at = now_secs();
    info!(
        "fetched {cache_key}: {} artifacts listed",
        rewritten.links.len()
    );
    for (link_kind, link_key, artifact) in rewritten.links {
        let link = Link {
            upstream: artifact.upstream,
            expected: artifact.expected,
            source: cache_key.clone(),
            fetched_at,
        };
        state.store.write_link(link_kind, &link_key, &link)?;
    }
    let cached = Cached {
        fetched_at,
        content_type: rewritten.content_type,
        body: rewritten.body,
    };
    state.store.write_meta(&cache_key, &cached)?;
    Ok(cached)
}

fn fresh_metadata(state: &AppState, cache_key: &str) -> Result<Option<Cached>, Error> {
    Ok(state
        .store
        .read_meta(cache_key)?
        .filter(|cached| is_fresh(state, cached.fetched_at)))
}

/// A link is current when its source metadata is fresh and that metadata's latest fetch wrote this same link.
fn link_is_current(state: &AppState, link: &Link) -> io::Result<bool> {
    Ok(state
        .store
        .read_meta_head(&link.source)?
        .is_some_and(|head| head.fetched_at == link.fetched_at && is_fresh(state, head.fetched_at)))
}

/// The current link for `kind/key`. When there is none, `refresh` (the fetch of the metadata that lists it) runs
/// once; the link is then looked up again. A listing that dropped the artifact is a 404 even if its bytes are stored.
pub async fn resolve_link(
    state: &AppState,
    kind: &str,
    key: &str,
    refresh: impl Future<Output = Result<Cached, Error>>,
) -> Result<Link, Error> {
    if let Some(link) = state.store.read_link(kind, key)? {
        if link_is_current(state, &link)? {
            return Ok(link);
        }
    }
    refresh.await?;
    match state.store.read_link(kind, key)? {
        Some(link) if link_is_current(state, &link)? => Ok(link),
        _ => Err(Error::NotFound(format!(
            "{key} is not listed by its upstream any more"
        ))),
    }
}

/// Opens the artifact a current link names, verified against the link's digest. Downloads it first when it is not
/// stored or fails verification. Returns the file and its length.
pub async fn artifact(
    state: &Arc<AppState>,
    kind: &str,
    key: &str,
    link: &Link,
) -> Result<(File, u64), Error> {
    let path = state.store.blob_path(&link.expected);
    let _flight = state
        .flights
        .lock(&format!("blob:{}", path.display()))
        .await;
    let verifying = Arc::clone(state);
    let (verify_path, expected) = (path.clone(), link.expected.clone());
    let stored =
        tokio::task::spawn_blocking(move || verify_stored(&verifying, &verify_path, &expected))
            .await
            .map_err(|e| Error::Internal(e.to_string()))??;
    match stored {
        Some(found) => Ok(found),
        None => download(state, kind, key, link, &path).await,
    }
}

/// Re-hashes a stored blob. A missing or corrupted blob yields `None`, and a corrupted one is removed.
fn verify_stored(
    state: &AppState,
    path: &Path,
    expected: &Expected,
) -> Result<Option<(File, u64)>, Error> {
    let mut file = match File::open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            state.store.forget_blob(path);
            return Ok(None);
        }
        Err(e) => return Err(e.into()),
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
        state.store.forget_blob(path);
        return Ok(None);
    }
    file.seek(SeekFrom::Start(0))?;
    state.store.touch_blob(path);
    Ok(Some((file, len)))
}

/// Streams the artifact into a temporary file, hashing as it goes. Only bytes that match the digest are committed.
async fn download(
    state: &AppState,
    kind: &str,
    key: &str,
    link: &Link,
    path: &Path,
) -> Result<(File, u64), Error> {
    let response = state.client.get(&link.upstream).send().await?;
    let status = response.status();
    if !status.is_success() {
        return Err(Error::Upstream(format!(
            "{} answered {status}",
            link.upstream
        )));
    }
    let cap = state.store.cap();
    if let Some(declared) = response.content_length() {
        if declared > cap {
            return Err(Error::TooLarge(declared));
        }
    }
    let tmp = state.store.new_tmp()?;
    let mut out = tokio::fs::File::from_std(tmp.reopen()?);
    let mut hasher = Hasher::new(link.expected.algo);
    let mut size = 0u64;
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        size += chunk.len() as u64;
        if size > cap {
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
    state.store.commit_blob(tmp, &link.expected, size)?;
    info!("stored {kind} {key}: {size} bytes, verified {algo}");
    Ok((File::open(path)?, size))
}

/// Streams a verified artifact to the client.
pub fn file_response(file: File, len: u64) -> Response {
    let body = Body::from_stream(ReaderStream::new(tokio::fs::File::from_std(file)));
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
