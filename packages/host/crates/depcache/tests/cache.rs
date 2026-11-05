//! End-to-end tests: a real cache server in front of a mock upstream that serves whatever a test sets.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::State;
use axum::http::{header, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::Router;
use base64::Engine as _;
use kestrel_depcache::{router, AppState, Config};
use serde_json::{json, Value};
use sha2::{Digest, Sha256, Sha512};
use tokio::net::TcpListener;

#[derive(Clone)]
enum Reply {
    Body(&'static str, Vec<u8>),
    Redirect(String),
}

#[derive(Default)]
struct Upstream {
    routes: Mutex<HashMap<String, Reply>>,
    hits: Mutex<HashMap<String, usize>>,
}

impl Upstream {
    fn serve(&self, path: &str, content_type: &'static str, body: impl Into<Vec<u8>>) {
        self.routes
            .lock()
            .expect("routes")
            .insert(path.to_owned(), Reply::Body(content_type, body.into()));
    }

    fn redirect(&self, path: &str, to: impl Into<String>) {
        self.routes
            .lock()
            .expect("routes")
            .insert(path.to_owned(), Reply::Redirect(to.into()));
    }

    fn hits(&self, path: &str) -> usize {
        self.hits
            .lock()
            .expect("hits")
            .get(path)
            .copied()
            .unwrap_or(0)
    }
}

async fn serve_upstream(State(upstream): State<Arc<Upstream>>, uri: Uri) -> Response {
    let path = uri.path().to_owned();
    *upstream
        .hits
        .lock()
        .expect("hits")
        .entry(path.clone())
        .or_default() += 1;
    let found = upstream.routes.lock().expect("routes").get(&path).cloned();
    match found {
        Some(Reply::Body(content_type, body)) => {
            ([(header::CONTENT_TYPE, content_type)], body).into_response()
        }
        Some(Reply::Redirect(to)) => (StatusCode::FOUND, [(header::LOCATION, to)]).into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

struct Harness {
    /// Base URL of the cache.
    cache: String,
    /// Base URL of the mock upstream.
    up: String,
    upstream: Arc<Upstream>,
    dir: tempfile::TempDir,
    client: reqwest::Client,
}

async fn listen() -> (TcpListener, String) {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let base = format!("http://{}", listener.local_addr().expect("addr"));
    (listener, base)
}

async fn spawn_upstream() -> (Arc<Upstream>, String) {
    let upstream = Arc::new(Upstream::default());
    let (listener, base) = listen().await;
    let router = Router::new()
        .fallback(serve_upstream)
        .with_state(upstream.clone());
    tokio::spawn(async move { axum::serve(listener, router).await.expect("upstream serve") });
    (upstream, base)
}

fn config_for(
    public_base_url: &str,
    up: &str,
    metadata_ttl: Duration,
    allow_http_upstreams: bool,
    max_metadata_bytes: u64,
) -> Config {
    Config {
        public_base_url: public_base_url.to_owned(),
        metadata_ttl,
        npm_registry: format!("{up}/npm"),
        pypi_index: format!("{up}/pypi"),
        pypi_files: format!("{up}/files"),
        crates_index: format!("{up}/index"),
        crates_static: format!("{up}/static/crates"),
        allow_http_upstreams,
        max_metadata_bytes,
    }
}

async fn start(metadata_ttl: Duration, cache_bytes: u64) -> Harness {
    start_with(metadata_ttl, cache_bytes, cache_bytes).await
}

async fn start_with(metadata_ttl: Duration, cache_bytes: u64, max_artifact_bytes: u64) -> Harness {
    start_full(
        metadata_ttl,
        cache_bytes,
        max_artifact_bytes,
        DEFAULT_METADATA,
    )
    .await
}

async fn start_full(
    metadata_ttl: Duration,
    cache_bytes: u64,
    max_artifact_bytes: u64,
    max_metadata_bytes: u64,
) -> Harness {
    let (upstream, up) = spawn_upstream().await;
    let (cache_listener, cache) = listen().await;
    let dir = tempfile::tempdir().expect("tempdir");
    let config = config_for(&cache, &up, metadata_ttl, true, max_metadata_bytes);
    let state = Arc::new(
        AppState::new(config, dir.path(), cache_bytes, max_artifact_bytes).expect("state"),
    );
    tokio::spawn(async move {
        axum::serve(cache_listener, router(state))
            .await
            .expect("cache serve")
    });

    let client = reqwest::Client::builder()
        .no_proxy()
        .build()
        .expect("client");
    Harness {
        cache,
        up,
        upstream,
        dir,
        client,
    }
}

impl Harness {
    async fn get(&self, path: &str) -> (u16, Vec<u8>) {
        let response = self
            .client
            .get(format!("{}{path}", self.cache))
            .send()
            .await
            .expect("send");
        let status = response.status().as_u16();
        (status, response.bytes().await.expect("body").to_vec())
    }

    fn blob(&self, algo: &str, hex: &str) -> PathBuf {
        self.dir.path().join("blobs").join(algo).join(hex)
    }
}

fn sri512(bytes: &[u8]) -> String {
    format!(
        "sha512-{}",
        base64::engine::general_purpose::STANDARD.encode(Sha512::digest(bytes))
    )
}

fn sha512_hex(bytes: &[u8]) -> String {
    hex::encode(Sha512::digest(bytes))
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

/// An npm packument listing `(version, tarball URL, integrity)`.
fn packument(name: &str, versions: &[(&str, String, String)]) -> Vec<u8> {
    let versions: serde_json::Map<String, Value> = versions
        .iter()
        .map(|(version, tarball, integrity)| {
            (
                version.to_string(),
                json!({ "dist": { "tarball": tarball, "integrity": integrity } }),
            )
        })
        .collect();
    json!({ "name": name, "versions": versions })
        .to_string()
        .into_bytes()
}

const FOREVER: Duration = Duration::from_secs(300);
const BIG: u64 = 1 << 30;
const DEFAULT_METADATA: u64 = 128 << 20;

#[tokio::test]
async fn npm_tarball_is_served_verified_and_cached() {
    let h = start(FOREVER, BIG).await;
    let tgz = b"pkg one tarball".to_vec();
    let tarball = format!("{}/npm/pkg/-/pkg-1.0.0.tgz", h.up);
    h.upstream.serve(
        "/npm/pkg",
        "application/json",
        packument("pkg", &[("1.0.0", tarball, sri512(&tgz))]),
    );
    h.upstream.serve(
        "/npm/pkg/-/pkg-1.0.0.tgz",
        "application/octet-stream",
        tgz.clone(),
    );

    let (status, doc) = h.get("/npm/pkg").await;
    assert_eq!(status, 200);
    let doc: Value = serde_json::from_slice(&doc).expect("packument json");
    assert_eq!(
        doc["versions"]["1.0.0"]["dist"]["tarball"],
        format!("{}/npm/pkg/-/pkg-1.0.0.tgz", h.cache)
    );

    for _ in 0..2 {
        assert_eq!(h.get("/npm/pkg/-/pkg-1.0.0.tgz").await, (200, tgz.clone()));
    }
    assert_eq!(
        h.upstream.hits("/npm/pkg/-/pkg-1.0.0.tgz"),
        1,
        "second request is served from the store"
    );
}

#[tokio::test]
async fn tampered_blob_is_refetched_not_served() {
    let h = start(FOREVER, BIG).await;
    let tgz = b"pkg tampered tarball".to_vec();
    let tarball = format!("{}/npm/pkg/-/pkg-1.0.0.tgz", h.up);
    h.upstream.serve(
        "/npm/pkg",
        "application/json",
        packument("pkg", &[("1.0.0", tarball, sri512(&tgz))]),
    );
    h.upstream.serve(
        "/npm/pkg/-/pkg-1.0.0.tgz",
        "application/octet-stream",
        tgz.clone(),
    );

    assert_eq!(h.get("/npm/pkg/-/pkg-1.0.0.tgz").await, (200, tgz.clone()));
    std::fs::write(h.blob("sha512", &sha512_hex(&tgz)), b"not the tarball").expect("tamper");

    assert_eq!(h.get("/npm/pkg/-/pkg-1.0.0.tgz").await, (200, tgz.clone()));
    assert_eq!(
        h.upstream.hits("/npm/pkg/-/pkg-1.0.0.tgz"),
        2,
        "the corrupted blob was refetched"
    );
}

#[tokio::test]
async fn upstream_bytes_that_do_not_match_are_refused_and_not_stored() {
    let h = start(FOREVER, BIG).await;
    let listed = b"the bytes the packument lists".to_vec();
    let tarball = format!("{}/npm/pkg/-/pkg-1.0.0.tgz", h.up);
    h.upstream.serve(
        "/npm/pkg",
        "application/json",
        packument("pkg", &[("1.0.0", tarball, sri512(&listed))]),
    );
    h.upstream.serve(
        "/npm/pkg/-/pkg-1.0.0.tgz",
        "application/octet-stream",
        b"other bytes".to_vec(),
    );

    assert_eq!(h.get("/npm/pkg/-/pkg-1.0.0.tgz").await.0, 502);
    assert!(
        !h.blob("sha512", &sha512_hex(&listed)).exists(),
        "nothing unverified is stored"
    );
}

#[tokio::test]
async fn artifact_dropped_by_its_listing_stops_being_served() {
    let h = start(Duration::from_secs(1), BIG).await;
    let tgz = b"pkg withdrawn tarball".to_vec();
    let tarball = format!("{}/npm/pkg/-/pkg-1.0.0.tgz", h.up);
    h.upstream.serve(
        "/npm/pkg",
        "application/json",
        packument("pkg", &[("1.0.0", tarball, sri512(&tgz))]),
    );
    h.upstream.serve(
        "/npm/pkg/-/pkg-1.0.0.tgz",
        "application/octet-stream",
        tgz.clone(),
    );
    assert_eq!(h.get("/npm/pkg/-/pkg-1.0.0.tgz").await, (200, tgz.clone()));

    h.upstream
        .serve("/npm/pkg", "application/json", packument("pkg", &[]));
    tokio::time::sleep(Duration::from_millis(1100)).await;
    assert_eq!(
        h.get("/npm/pkg").await.0,
        200,
        "the packument is refetched after the TTL"
    );

    assert_eq!(
        h.get("/npm/pkg/-/pkg-1.0.0.tgz").await.0,
        404,
        "the listing no longer names it"
    );
    assert!(
        h.blob("sha512", &sha512_hex(&tgz)).exists(),
        "the bytes stay stored; only the listing gates serving"
    );
}

#[tokio::test]
async fn pypi_file_is_linked_by_its_page_and_served_by_path() {
    let h = start(FOREVER, BIG).await;
    let whl = b"six wheel bytes".to_vec();
    let file_url = format!("{}/files/packages/six-1.0-py3-none-any.whl", h.up);
    let page = format!(
        r#"<a href="{file_url}#sha256={}">six-1.0-py3-none-any.whl</a>"#,
        sha256_hex(&whl)
    );
    h.upstream
        .serve("/pypi/simple/six/", "text/html", page.into_bytes());
    h.upstream.serve(
        "/files/packages/six-1.0-py3-none-any.whl",
        "application/octet-stream",
        whl.clone(),
    );

    let (status, html) = h.get("/pypi/simple/six/").await;
    assert_eq!(status, 200);
    let link = format!(
        "{}/pypi/files/six/packages/six-1.0-py3-none-any.whl#sha256={}",
        h.cache,
        sha256_hex(&whl)
    );
    assert!(String::from_utf8(html).expect("utf8").contains(&link));

    assert_eq!(
        h.get("/pypi/files/six/packages/six-1.0-py3-none-any.whl")
            .await,
        (200, whl)
    );
}

#[tokio::test]
async fn expired_pypi_file_link_recovers_its_project_from_the_url() {
    let h = start(Duration::from_secs(1), BIG).await;
    let whl = b"six expiring wheel".to_vec();
    let file_url = format!("{}/files/packages/six-1.0-py3-none-any.whl", h.up);
    let page = format!(
        r#"<a href="{file_url}#sha256={}">six-1.0-py3-none-any.whl</a>"#,
        sha256_hex(&whl)
    );
    h.upstream
        .serve("/pypi/simple/six/", "text/html", page.into_bytes());
    h.upstream.serve(
        "/files/packages/six-1.0-py3-none-any.whl",
        "application/octet-stream",
        whl.clone(),
    );
    h.upstream
        .serve("/npm/other", "application/json", packument("other", &[]));

    let (status, html) = h.get("/pypi/simple/six/").await;
    assert_eq!(status, 200);
    let link = format!(
        "{}/pypi/files/six/packages/six-1.0-py3-none-any.whl#sha256={}",
        h.cache,
        sha256_hex(&whl)
    );
    assert!(String::from_utf8(html).expect("utf8").contains(&link));

    // Once past the TTL, the next metadata commit sweeps the six page and its file link.
    tokio::time::sleep(Duration::from_millis(1100)).await;
    assert_eq!(h.get("/npm/other").await.0, 200);

    assert_eq!(
        h.get("/pypi/files/six/packages/six-1.0-py3-none-any.whl")
            .await,
        (200, whl),
        "the expired link is rebuilt from the project named in the URL"
    );
    assert_eq!(
        h.upstream.hits("/pypi/simple/six/"),
        2,
        "the project page was refetched for the link"
    );
}

#[tokio::test]
async fn crates_config_index_and_download_are_rewritten_and_verified() {
    let h = start(FOREVER, BIG).await;
    let krate = b"foo crate bytes".to_vec();
    let config = format!(
        r#"{{"dl":"{}/static/crates","api":"https://crates.io"}}"#,
        h.up
    );
    let line = format!(
        r#"{{"name":"foo","vers":"1.0.0","cksum":"{}"}}"#,
        sha256_hex(&krate)
    );
    h.upstream
        .serve("/index/config.json", "application/json", config);
    h.upstream
        .serve("/index/3/f/foo", "text/plain", format!("{line}\n"));
    h.upstream.serve(
        "/static/crates/foo/foo-1.0.0.crate",
        "application/octet-stream",
        krate.clone(),
    );

    let (status, config) = h.get("/crates/index/config.json").await;
    assert_eq!(status, 200);
    let config: Value = serde_json::from_slice(&config).expect("config json");
    assert_eq!(
        config["dl"],
        format!("{}/crates/dl/{{crate}}/{{version}}", h.cache)
    );
    assert_eq!(
        h.get("/crates/index/3/f/foo").await,
        (200, format!("{line}\n").into_bytes())
    );
    assert_eq!(h.get("/crates/dl/foo/1.0.0").await, (200, krate));
}

#[tokio::test]
async fn requests_with_credentials_never_reach_the_cache_or_upstream() {
    let h = start(FOREVER, BIG).await;
    let tgz = b"private tarball".to_vec();
    let tarball = format!("{}/npm/pkg/-/pkg-1.0.0.tgz", h.up);
    h.upstream.serve(
        "/npm/pkg",
        "application/json",
        packument("pkg", &[("1.0.0", tarball, sri512(&tgz))]),
    );

    let response = h
        .client
        .get(format!("{}/npm/pkg", h.cache))
        .header(header::AUTHORIZATION, "Bearer secret")
        .send()
        .await
        .expect("send");
    assert_eq!(response.status().as_u16(), 403);
    assert_eq!(h.upstream.hits("/npm/pkg"), 0);
}

#[tokio::test]
async fn unsafe_and_unlisted_paths_are_rejected() {
    let h = start(FOREVER, BIG).await;
    h.upstream
        .serve("/npm/pkg", "application/json", packument("pkg", &[]));

    assert_eq!(
        h.get("/npm/a%2F..%2Fb").await.0,
        400,
        "an encoded traversal is not a cache key"
    );
    assert_eq!(
        h.get("/npm/pkg/-/missing-1.0.0.tgz").await.0,
        404,
        "a tarball no listing names is not found"
    );
}

#[tokio::test]
async fn least_recently_used_artifacts_are_evicted_above_the_cap() {
    let a = vec![b'a'; 10_000];
    let b = vec![b'b'; 10_000];
    let h = start(FOREVER, 15_000).await;
    let tarball = |v: &str| format!("{}/npm/pkg/-/pkg-{v}.tgz", h.up);
    h.upstream.serve(
        "/npm/pkg",
        "application/json",
        packument(
            "pkg",
            &[
                ("1.0.0", tarball("1.0.0"), sri512(&a)),
                ("1.1.0", tarball("1.1.0"), sri512(&b)),
            ],
        ),
    );
    h.upstream.serve(
        "/npm/pkg/-/pkg-1.0.0.tgz",
        "application/octet-stream",
        a.clone(),
    );
    h.upstream.serve(
        "/npm/pkg/-/pkg-1.1.0.tgz",
        "application/octet-stream",
        b.clone(),
    );

    assert_eq!(h.get("/npm/pkg/-/pkg-1.0.0.tgz").await, (200, a.clone()));
    assert_eq!(h.get("/npm/pkg/-/pkg-1.1.0.tgz").await, (200, b));
    assert!(
        !h.blob("sha512", &sha512_hex(&a)).exists(),
        "the least recently used blob was evicted"
    );

    assert_eq!(h.get("/npm/pkg/-/pkg-1.0.0.tgz").await, (200, a));
    assert_eq!(
        h.upstream.hits("/npm/pkg/-/pkg-1.0.0.tgz"),
        2,
        "an evicted artifact is downloaded again"
    );
}

fn files_under(dir: &std::path::Path) -> usize {
    std::fs::read_dir(dir)
        .expect("read_dir")
        .map(|entry| {
            let path = entry.expect("entry").path();
            if path.is_dir() {
                files_under(&path)
            } else {
                1
            }
        })
        .sum()
}

#[tokio::test]
async fn redirect_to_an_unlisted_origin_is_refused() {
    let h = start(FOREVER, BIG).await;
    let (elsewhere, elsewhere_base) = spawn_upstream().await;
    let tgz = b"redirected tarball".to_vec();
    let tarball = format!("{}/npm/pkg/-/pkg-1.0.0.tgz", h.up);
    h.upstream.serve(
        "/npm/pkg",
        "application/json",
        packument("pkg", &[("1.0.0", tarball, sri512(&tgz))]),
    );
    h.upstream.redirect(
        "/npm/pkg/-/pkg-1.0.0.tgz",
        format!("{elsewhere_base}/steal/pkg-1.0.0.tgz"),
    );
    elsewhere.serve(
        "/steal/pkg-1.0.0.tgz",
        "application/octet-stream",
        tgz.clone(),
    );

    assert_eq!(h.get("/npm/pkg/-/pkg-1.0.0.tgz").await.0, 502);
    assert_eq!(
        elsewhere.hits("/steal/pkg-1.0.0.tgz"),
        0,
        "the cache never contacts an origin that is not configured"
    );
}

#[tokio::test]
async fn redirect_within_the_upstream_origin_is_followed() {
    let h = start(FOREVER, BIG).await;
    let tgz = b"moved tarball".to_vec();
    let tarball = format!("{}/npm/pkg/-/pkg-1.0.0.tgz", h.up);
    h.upstream.serve(
        "/npm/pkg",
        "application/json",
        packument("pkg", &[("1.0.0", tarball, sri512(&tgz))]),
    );
    h.upstream.redirect(
        "/npm/pkg/-/pkg-1.0.0.tgz",
        format!("{}/moved/pkg-1.0.0.tgz", h.up),
    );
    h.upstream.serve(
        "/moved/pkg-1.0.0.tgz",
        "application/octet-stream",
        tgz.clone(),
    );

    assert_eq!(h.get("/npm/pkg/-/pkg-1.0.0.tgz").await, (200, tgz));
}

#[tokio::test]
async fn artifact_above_the_per_artifact_limit_is_refused_and_not_stored() {
    let h = start_with(FOREVER, BIG, 10).await;
    let tgz = b"twenty byte tarball!".to_vec();
    let tarball = format!("{}/npm/pkg/-/pkg-1.0.0.tgz", h.up);
    h.upstream.serve(
        "/npm/pkg",
        "application/json",
        packument("pkg", &[("1.0.0", tarball, sri512(&tgz))]),
    );
    h.upstream.serve(
        "/npm/pkg/-/pkg-1.0.0.tgz",
        "application/octet-stream",
        tgz.clone(),
    );

    assert_eq!(h.get("/npm/pkg/-/pkg-1.0.0.tgz").await.0, 507);
    assert!(
        !h.blob("sha512", &sha512_hex(&tgz)).exists(),
        "an artifact over the limit is not stored"
    );
}

#[tokio::test]
async fn metadata_above_the_limit_is_refused_and_not_stored() {
    let h = start_full(FOREVER, BIG, BIG, 64).await;
    let tgz = b"listed tarball".to_vec();
    let tarball = format!("{}/npm/pkg/-/pkg-1.0.0.tgz", h.up);
    h.upstream.serve(
        "/npm/pkg",
        "application/json",
        packument("pkg", &[("1.0.0", tarball, sri512(&tgz))]),
    );

    assert_eq!(h.get("/npm/pkg").await.0, 502);
    assert_eq!(h.get("/npm/pkg").await.0, 502);
    assert_eq!(
        h.upstream.hits("/npm/pkg"),
        2,
        "an oversized document is not cached, so each request refetches it"
    );
    assert_eq!(
        files_under(&h.dir.path().join("meta")),
        0,
        "nothing oversized is stored"
    );
}

#[tokio::test]
async fn expired_metadata_and_links_are_swept() {
    let h = start(Duration::from_secs(1), BIG).await;
    let tar = |name: &str| format!("{}/npm/{name}/-/{name}-1.0.0.tgz", h.up);
    h.upstream.serve(
        "/npm/a",
        "application/json",
        packument("a", &[("1.0.0", tar("a"), sri512(b"a"))]),
    );
    h.upstream.serve(
        "/npm/b",
        "application/json",
        packument("b", &[("1.0.0", tar("b"), sri512(b"b"))]),
    );

    assert_eq!(h.get("/npm/a").await.0, 200);
    assert_eq!(files_under(&h.dir.path().join("meta")), 2);
    assert_eq!(files_under(&h.dir.path().join("links")), 1);

    tokio::time::sleep(Duration::from_millis(1100)).await;
    assert_eq!(h.get("/npm/b").await.0, 200);
    assert_eq!(
        files_under(&h.dir.path().join("meta")),
        2,
        "a's head and body were swept once past the TTL"
    );
    assert_eq!(
        files_under(&h.dir.path().join("links")),
        1,
        "a's link was swept once past the TTL"
    );
}

#[test]
fn plain_http_upstreams_need_the_explicit_opt_in() {
    let dir = tempfile::tempdir().expect("tempdir");
    let refused = AppState::new(
        config_for(
            "http://cache",
            "http://up",
            FOREVER,
            false,
            DEFAULT_METADATA,
        ),
        dir.path(),
        BIG,
        BIG,
    );
    assert_eq!(
        refused.err().map(|e| e.kind()),
        Some(std::io::ErrorKind::InvalidInput)
    );
    assert!(AppState::new(
        config_for("http://cache", "http://up", FOREVER, true, DEFAULT_METADATA),
        dir.path(),
        BIG,
        BIG,
    )
    .is_ok());
}

#[test]
fn per_artifact_limit_must_fit_in_the_cache() {
    let dir = tempfile::tempdir().expect("tempdir");
    let refused = AppState::new(
        config_for(
            "http://cache",
            "https://up",
            FOREVER,
            false,
            DEFAULT_METADATA,
        ),
        dir.path(),
        10,
        20,
    );
    assert_eq!(
        refused.err().map(|e| e.kind()),
        Some(std::io::ErrorKind::InvalidInput)
    );
}
