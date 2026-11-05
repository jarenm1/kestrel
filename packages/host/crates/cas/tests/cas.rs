use std::sync::Arc;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use axum::Router;
use http_body_util::BodyExt;
use kestrel_cas::{router, Config, Store};
use sha2::{Digest, Sha256};
use tower::ServiceExt;

const CAP: u64 = 1 << 20;

fn digest(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn config(dir: &tempfile::TempDir, cap_bytes: u64, max_object_bytes: u64) -> Config {
    Config {
        storage_dir: dir.path().to_path_buf(),
        cap_bytes,
        max_object_bytes,
    }
}

fn app(dir: &tempfile::TempDir) -> Router {
    router(Arc::new(Store::open(config(dir, CAP, CAP)).unwrap()))
}

async fn send(app: &Router, method: &str, uri: &str, body: &'static [u8]) -> (StatusCode, Vec<u8>) {
    let request = Request::builder()
        .method(method)
        .uri(uri)
        .body(Body::from(body))
        .unwrap();
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, bytes.to_vec())
}

#[tokio::test]
async fn blob_is_stored_under_its_digest_and_read_back() {
    let dir = tempfile::tempdir().unwrap();
    let app = app(&dir);
    let hash = digest(b"hello");
    let uri = format!("/blobs/sha256/{hash}");

    assert_eq!(
        send(&app, "PUT", &uri, b"hello").await.0,
        StatusCode::CREATED
    );
    assert_eq!(send(&app, "PUT", &uri, b"hello").await.0, StatusCode::OK);
    assert_eq!(
        send(&app, "GET", &uri, b"").await,
        (StatusCode::OK, b"hello".to_vec())
    );
}

#[tokio::test]
async fn head_reports_size_and_digest_without_a_body() {
    let dir = tempfile::tempdir().unwrap();
    let app = app(&dir);
    let hash = digest(b"hello");
    let uri = format!("/blobs/sha256/{hash}");
    send(&app, "PUT", &uri, b"hello").await;

    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("HEAD")
                .uri(&uri)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["content-length"], "5");
    assert_eq!(response.headers()["etag"], format!("\"{hash}\"").as_str());
    assert!(response
        .into_body()
        .collect()
        .await
        .unwrap()
        .to_bytes()
        .is_empty());
}

#[tokio::test]
async fn body_that_does_not_match_its_digest_is_refused_and_not_stored() {
    let dir = tempfile::tempdir().unwrap();
    let app = app(&dir);
    let claimed = digest(b"hello");

    let (status, _) = send(&app, "PUT", &format!("/blobs/sha256/{claimed}"), b"goodbye").await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        send(&app, "GET", &format!("/blobs/sha256/{claimed}"), b"")
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    assert!(std::fs::read_dir(dir.path().join("tmp"))
        .unwrap()
        .next()
        .is_none());
}

#[tokio::test]
async fn malformed_digests_are_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let app = app(&dir);
    for bad in ["abc", &"A".repeat(64), &"g".repeat(64)] {
        let (status, _) = send(&app, "GET", &format!("/blobs/sha256/{bad}"), b"").await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "digest {bad}");
    }
}

#[tokio::test]
async fn ref_points_a_key_at_its_blob_and_can_be_overwritten_and_deleted() {
    let dir = tempfile::tempdir().unwrap();
    let app = app(&dir);
    let uri = "/refs/sccache/ab/cd.o";

    assert_eq!(send(&app, "PUT", uri, b"one").await.0, StatusCode::OK);
    assert_eq!(
        send(&app, "GET", uri, b"").await,
        (StatusCode::OK, b"one".to_vec())
    );

    send(&app, "PUT", uri, b"two").await;
    assert_eq!(
        send(&app, "GET", uri, b"").await,
        (StatusCode::OK, b"two".to_vec())
    );

    assert_eq!(
        send(&app, "DELETE", uri, b"").await.0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(send(&app, "GET", uri, b"").await.0, StatusCode::NOT_FOUND);
    assert_eq!(
        send(&app, "DELETE", uri, b"").await.0,
        StatusCode::NO_CONTENT
    );
}

#[tokio::test]
async fn ref_names_cannot_escape_the_refs_directory() {
    let dir = tempfile::tempdir().unwrap();
    let app = app(&dir);
    for uri in [
        "/refs/ns/a/%2E%2E/x",
        "/refs/%2Ehidden/x",
        "/refs/ns/a//b",
        "/refs/ns/a/./b",
    ] {
        let (status, _) = send(&app, "PUT", uri, b"x").await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "uri {uri}");
    }
    assert!(!dir.path().join("x").exists());
}

#[tokio::test]
async fn key_that_collides_with_a_directory_is_a_conflict() {
    let dir = tempfile::tempdir().unwrap();
    let app = app(&dir);

    assert_eq!(
        send(&app, "PUT", "/refs/ns/a/b", b"x").await.0,
        StatusCode::OK
    );
    assert_eq!(
        send(&app, "PUT", "/refs/ns/a", b"y").await.0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        send(&app, "GET", "/refs/ns/a/b", b"").await,
        (StatusCode::OK, b"x".to_vec())
    );
}

#[tokio::test]
async fn oversized_body_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(config(&dir, CAP, 4)).unwrap();
    let app = router(Arc::new(store));

    assert_eq!(
        send(&app, "PUT", "/refs/ns/big", b"12345").await.0,
        StatusCode::PAYLOAD_TOO_LARGE
    );
    assert_eq!(
        send(&app, "GET", "/refs/ns/big", b"").await.0,
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
async fn least_recently_used_blobs_are_evicted_to_fit_the_cap() {
    let dir = tempfile::tempdir().unwrap();
    // Two 6-byte blobs fit in 13 bytes; a third forces one out.
    let store = Store::open(config(&dir, 13, 10)).unwrap();
    let app = router(Arc::new(store));
    let a = digest(b"aaaaaa");
    let b = digest(b"bbbbbb");
    let c = digest(b"cccccc");

    send(&app, "PUT", &format!("/blobs/sha256/{a}"), b"aaaaaa").await;
    send(&app, "PUT", &format!("/blobs/sha256/{b}"), b"bbbbbb").await;
    // Reading `a` makes `b` the least recently used.
    send(&app, "GET", &format!("/blobs/sha256/{a}"), b"").await;
    send(&app, "PUT", &format!("/blobs/sha256/{c}"), b"cccccc").await;

    assert_eq!(
        send(&app, "GET", &format!("/blobs/sha256/{a}"), b"")
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(
        send(&app, "GET", &format!("/blobs/sha256/{b}"), b"")
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        send(&app, "GET", &format!("/blobs/sha256/{c}"), b"")
            .await
            .0,
        StatusCode::OK
    );
}

#[tokio::test]
async fn blobs_and_refs_survive_a_restart() {
    let dir = tempfile::tempdir().unwrap();
    {
        let app = app(&dir);
        send(&app, "PUT", "/refs/ns/key", b"persisted").await;
    }
    let app = app(&dir);
    assert_eq!(
        send(&app, "GET", "/refs/ns/key", b"").await,
        (StatusCode::OK, b"persisted".to_vec())
    );
}

#[tokio::test]
async fn store_rejects_a_blob_cap_below_the_object_cap() {
    let dir = tempfile::tempdir().unwrap();
    assert!(Store::open(config(&dir, 4, 8)).is_err());
}
