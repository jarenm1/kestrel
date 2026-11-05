//! `kestrel-cas`: content-addressed blobs and namespaced key refs, shared by the VMs on one host.
//! Contract: `docs/nest.md`, "Build cache".
//!
//! - `/blobs/sha256/<hash>`: bytes named by their digest. A PUT is accepted only when the body hashes to the name.
//! - `/refs/<namespace>/<key>`: a key holding the bytes of a blob. A PUT stores the body and points the key at it.
//!
//! Bodies stream to disk and are never held in memory. The store is not an authenticated service: the host firewall
//! lets only guests reach it, and refs are not yet bound to the VM that wrote them.

pub mod error;
pub mod store;

use std::sync::Arc;

use axum::body::Body;
use axum::extract::{Path, Request, State};
use axum::http::{header, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use tokio::fs::File;
use tokio_util::io::ReaderStream;

pub use error::Error;
pub use store::{Config, Store};

pub fn router(store: Arc<Store>) -> Router {
    Router::new()
        .route("/healthz", get(|| async { "ok" }))
        .route("/blobs/sha256/{hash}", get(get_blob).put(put_blob))
        .route(
            "/refs/{namespace}/{*key}",
            get(get_ref).put(put_ref).delete(delete_ref),
        )
        .with_state(store)
}

async fn get_blob(
    State(store): State<Arc<Store>>,
    Path(hash): Path<String>,
    method: Method,
) -> Result<Response, Error> {
    let (file, size) = store.open_blob(&hash).await?;
    Ok(object_response(file, size, &hash, method == Method::HEAD))
}

async fn put_blob(
    State(store): State<Arc<Store>>,
    Path(hash): Path<String>,
    request: Request,
) -> Result<StatusCode, Error> {
    let created = store
        .put_blob(&hash, request.into_body().into_data_stream())
        .await?;
    Ok(if created {
        StatusCode::CREATED
    } else {
        StatusCode::OK
    })
}

async fn get_ref(
    State(store): State<Arc<Store>>,
    Path((namespace, key)): Path<(String, String)>,
    method: Method,
) -> Result<Response, Error> {
    let (file, size, hash) = store.open_ref(&namespace, &key).await?;
    Ok(object_response(file, size, &hash, method == Method::HEAD))
}

async fn put_ref(
    State(store): State<Arc<Store>>,
    Path((namespace, key)): Path<(String, String)>,
    request: Request,
) -> Result<StatusCode, Error> {
    store
        .put_ref(&namespace, &key, request.into_body().into_data_stream())
        .await?;
    Ok(StatusCode::OK)
}

async fn delete_ref(
    State(store): State<Arc<Store>>,
    Path((namespace, key)): Path<(String, String)>,
) -> Result<StatusCode, Error> {
    store.delete_ref(&namespace, &key).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// The digest is the ETag, so a client can check what it received against the name it asked for.
fn object_response(file: File, size: u64, hash: &str, head: bool) -> Response {
    let body = if head {
        Body::empty()
    } else {
        Body::from_stream(ReaderStream::new(file))
    };
    (
        [
            (header::CONTENT_LENGTH, size.to_string()),
            (header::CONTENT_TYPE, "application/octet-stream".to_owned()),
            (header::ETAG, format!("\"{hash}\"")),
        ],
        body,
    )
        .into_response()
}
