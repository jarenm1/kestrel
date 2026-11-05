//! `kestrel-depcache`: read-only, verifying cache of npm, PyPI and crates.io artifacts for Nest VMs.
//! Contract: `docs/nest.md`, "Dependency cache".

pub mod cache;
pub mod crates;
pub mod digest;
pub mod error;
pub mod flight;
pub mod npm;
pub mod pypi;
pub mod store;

use std::io;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::Request;
use axum::http::header::{ACCEPT, AUTHORIZATION, COOKIE, PROXY_AUTHORIZATION};
use axum::http::HeaderMap;
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use reqwest::redirect::Policy;
use reqwest::Url;

pub use error::Error;

/// Longest redirect chain followed to an upstream artifact.
const MAX_REDIRECTS: usize = 10;

/// Metadata fetches allowed in flight at once.
const MAX_METADATA_FETCHES: usize = 8;

/// Runtime configuration. Upstream bases have no trailing slash.
#[derive(Clone, Debug)]
pub struct Config {
    /// Origin VMs use to reach this cache; written into rewritten metadata.
    pub public_base_url: String,
    /// How long fetched metadata is served before it is refetched.
    pub metadata_ttl: Duration,
    /// Largest metadata document accepted from upstream. Metadata is held in memory while it is rewritten.
    pub max_metadata_bytes: u64,
    pub npm_registry: String,
    pub pypi_index: String,
    pub pypi_files: String,
    pub crates_index: String,
    /// Base of `.crate` downloads, including the `/crates` path segment.
    pub crates_static: String,
    /// Permits plain `http` upstreams. Off in production: upstream bytes are only trusted through their digests, and
    /// the transport is still expected to be TLS.
    pub allow_http_upstreams: bool,
}

impl Config {
    fn upstream_bases(&self) -> [&str; 5] {
        [
            &self.npm_registry,
            &self.pypi_index,
            &self.pypi_files,
            &self.crates_index,
            &self.crates_static,
        ]
    }
}

pub struct AppState {
    pub config: Config,
    pub store: store::Store,
    /// Largest single artifact that is downloaded; the store's cap bounds the total.
    pub max_artifact_bytes: u64,
    /// Bounds metadata fetches in flight. Each holds up to `max_metadata_bytes` in memory while it is read.
    pub metadata_slots: tokio::sync::Semaphore,
    pub client: reqwest::Client,
    pub flights: flight::Flights,
}

fn invalid(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message.into())
}

impl AppState {
    /// `cache_bytes` caps the artifact store; `max_artifact_bytes` caps one artifact and must fit within it.
    pub fn new(
        config: Config,
        storage_dir: &Path,
        cache_bytes: u64,
        max_artifact_bytes: u64,
    ) -> io::Result<Self> {
        if max_artifact_bytes > cache_bytes {
            return Err(invalid("max_artifact_bytes must not exceed the cache size"));
        }
        let mut origins: Vec<Url> = Vec::new();
        for base in config.upstream_bases() {
            let url = Url::parse(base).map_err(|e| invalid(format!("{base} is not a URL: {e}")))?;
            if url.scheme() != "https" && !config.allow_http_upstreams {
                return Err(invalid(format!(
                    "{base} is not https; pass --allow-http-upstreams to use plain http"
                )));
            }
            origins.push(url);
        }
        let client = reqwest::Client::builder()
            .user_agent(concat!("kestrel-depcache/", env!("CARGO_PKG_VERSION")))
            .connect_timeout(Duration::from_secs(10))
            .read_timeout(Duration::from_secs(60))
            .https_only(!config.allow_http_upstreams)
            .redirect(redirect_policy(origins))
            .build()
            .map_err(io::Error::other)?;
        let metadata_ttl = config.metadata_ttl;
        Ok(Self {
            config,
            store: store::Store::open(storage_dir, cache_bytes, metadata_ttl)?,
            max_artifact_bytes,
            metadata_slots: tokio::sync::Semaphore::new(MAX_METADATA_FETCHES),
            client,
            flights: flight::Flights::default(),
        })
    }
}

/// Follows redirects only to configured upstream origins, so an upstream cannot send the cache to another host.
fn redirect_policy(origins: Vec<Url>) -> Policy {
    Policy::custom(move |attempt| {
        if attempt.previous().len() >= MAX_REDIRECTS {
            attempt.error("too many redirects")
        } else if origins
            .iter()
            .any(|base| base.origin() == attempt.url().origin())
        {
            attempt.follow()
        } else {
            attempt.error("redirect to an origin that is not a configured upstream")
        }
    })
}

pub fn router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/healthz", get(|| async { "ok" }))
        .route("/npm/{*rest}", get(npm::serve))
        .route("/pypi/simple/{*rest}", get(pypi::simple))
        .route("/pypi/files/{*rest}", get(pypi::file))
        .route("/crates/index/{*rest}", get(crates::index))
        .route("/crates/dl/{*rest}", get(crates::download))
        .layer(middleware::from_fn(refuse_credentials))
        .with_state(state)
}

/// Requests carrying credentials never reach the cache or the upstream: private packages go to the origin directly.
async fn refuse_credentials(request: Request, next: Next) -> Response {
    let headers = request.headers();
    if [AUTHORIZATION, PROXY_AUTHORIZATION, COOKIE]
        .iter()
        .any(|name| headers.contains_key(name))
    {
        tracing::warn!(
            "refused {} {}: request carries credentials",
            request.method(),
            request.uri().path()
        );
        return Error::Refused.into_response();
    }
    next.run(request).await
}

/// A request path that can name a cache entry: non-empty segments of ASCII letters, digits and `-._~@+`, no `.`/`..`.
pub fn is_safe_path(path: &str) -> bool {
    !path.is_empty()
        && path.split('/').all(|segment| {
            !segment.is_empty()
                && segment != "."
                && segment != ".."
                && segment.bytes().all(|b| {
                    b.is_ascii_alphanumeric()
                        || matches!(b, b'-' | b'.' | b'_' | b'~' | b'@' | b'+')
                })
        })
}

pub fn accept_header(headers: &HeaderMap) -> &str {
    headers
        .get(ACCEPT)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
}

#[cfg(test)]
pub(crate) fn test_config() -> Config {
    Config {
        public_base_url: "http://169.254.0.1:3141".to_owned(),
        metadata_ttl: Duration::from_secs(300),
        max_metadata_bytes: 128 << 20,
        npm_registry: "https://registry.npmjs.org".to_owned(),
        pypi_index: "https://pypi.org".to_owned(),
        pypi_files: "https://files.pythonhosted.org".to_owned(),
        crates_index: "https://index.crates.io".to_owned(),
        crates_static: "https://static.crates.io/crates".to_owned(),
        allow_http_upstreams: false,
    }
}
