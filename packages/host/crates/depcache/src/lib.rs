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

pub use error::Error;

/// Runtime configuration. Upstream bases have no trailing slash.
#[derive(Clone, Debug)]
pub struct Config {
    /// Origin VMs use to reach this cache; written into rewritten metadata.
    pub public_base_url: String,
    /// How long fetched metadata is served before it is refetched.
    pub metadata_ttl: Duration,
    pub npm_registry: String,
    pub pypi_index: String,
    pub pypi_files: String,
    pub crates_index: String,
    /// Base of `.crate` downloads, including the `/crates` path segment.
    pub crates_static: String,
}

pub struct AppState {
    pub config: Config,
    pub store: store::Store,
    pub client: reqwest::Client,
    pub flights: flight::Flights,
}

impl AppState {
    pub fn new(config: Config, storage_dir: &Path, max_artifact_bytes: u64) -> io::Result<Self> {
        let client = reqwest::Client::builder()
            .user_agent(concat!("kestrel-depcache/", env!("CARGO_PKG_VERSION")))
            .connect_timeout(Duration::from_secs(10))
            .read_timeout(Duration::from_secs(60))
            .build()
            .map_err(io::Error::other)?;
        Ok(Self {
            config,
            store: store::Store::open(storage_dir, max_artifact_bytes)?,
            client,
            flights: flight::Flights::default(),
        })
    }
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
        npm_registry: "https://registry.npmjs.org".to_owned(),
        pypi_index: "https://pypi.org".to_owned(),
        pypi_files: "https://files.pythonhosted.org".to_owned(),
        crates_index: "https://index.crates.io".to_owned(),
        crates_static: "https://static.crates.io/crates".to_owned(),
    }
}
