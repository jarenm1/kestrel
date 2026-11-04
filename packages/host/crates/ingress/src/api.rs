//! Client for the host agent's local API on its Unix socket (docs/nest.md, "Host agent local API").

use std::fmt;
use std::path::PathBuf;

use bytes::Bytes;
use http::header::{CONTENT_TYPE, HOST};
use http::{Method, Request, StatusCode};
use http_body_util::{BodyExt, Full};
use hyper::client::conn::http1;
use hyper_util::rt::TokioIo;
use serde::{Deserialize, Serialize};
use tokio::net::UnixStream;

pub struct HostApi {
    socket: PathBuf,
}

/// `GET /v1/boxes/:boxId/route`. `upstream` is `http://10.77.x.y:8787` when the VM has an address.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteReply {
    pub state: String,
    #[serde(default)]
    pub upstream: Option<String>,
}

/// `POST /v1/boxes/:boxId/wake`, answered once the box is running.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WakeReply {
    pub upstream: String,
}

/// One box in `POST /v1/ingress/activity`.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityEntry {
    pub box_id: String,
    pub open_connections: usize,
    /// Milliseconds since the Unix epoch.
    pub last_request_at: u64,
}

#[derive(Serialize)]
struct ActivityBody<'a> {
    boxes: &'a [ActivityEntry],
}

#[derive(Debug)]
pub enum ApiError {
    Transport(String),
    Status(StatusCode),
    Decode(String),
}

impl fmt::Display for ApiError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Transport(e) => write!(f, "host API unreachable: {e}"),
            Self::Status(status) => write!(f, "host API answered {status}"),
            Self::Decode(e) => write!(f, "host API reply did not decode: {e}"),
        }
    }
}

impl HostApi {
    pub fn new(socket: PathBuf) -> Self {
        Self { socket }
    }

    /// `Ok(None)` when the host does not know the box.
    pub async fn route(&self, box_id: &str) -> Result<Option<RouteReply>, ApiError> {
        let (status, body) = self
            .call(Method::GET, &format!("/v1/boxes/{box_id}/route"), None)
            .await?;
        optional(status, &body)
    }

    /// `Ok(None)` when the host does not know the box. Otherwise waits until the box is running.
    pub async fn wake(&self, box_id: &str) -> Result<Option<WakeReply>, ApiError> {
        let (status, body) = self
            .call(Method::POST, &format!("/v1/boxes/{box_id}/wake"), None)
            .await?;
        optional(status, &body)
    }

    pub async fn report_activity(&self, boxes: &[ActivityEntry]) -> Result<(), ApiError> {
        let body = serde_json::to_vec(&ActivityBody { boxes })
            .map_err(|e| ApiError::Decode(e.to_string()))?;
        let (status, _) = self
            .call(Method::POST, "/v1/ingress/activity", Some(body))
            .await?;
        if status.is_success() {
            Ok(())
        } else {
            Err(ApiError::Status(status))
        }
    }

    /// One request on its own connection: the socket is local and the calls are rare, so no pooling.
    async fn call(
        &self,
        method: Method,
        path: &str,
        json: Option<Vec<u8>>,
    ) -> Result<(StatusCode, Bytes), ApiError> {
        let transport = |e: &dyn fmt::Display| ApiError::Transport(e.to_string());
        let stream = UnixStream::connect(&self.socket)
            .await
            .map_err(|e| transport(&e))?;
        let (mut sender, connection) = http1::handshake(TokioIo::new(stream))
            .await
            .map_err(|e| transport(&e))?;
        tokio::spawn(async move {
            let _ = connection.await;
        });
        let mut builder = Request::builder()
            .method(method)
            .uri(path)
            .header(HOST, "localhost");
        let payload = match json {
            Some(json) => {
                builder = builder.header(CONTENT_TYPE, "application/json");
                Bytes::from(json)
            }
            None => Bytes::new(),
        };
        let request = builder
            .body(Full::new(payload))
            .map_err(|e| transport(&e))?;
        let response = sender
            .send_request(request)
            .await
            .map_err(|e| transport(&e))?;
        let status = response.status();
        let body = response
            .into_body()
            .collect()
            .await
            .map_err(|e| transport(&e))?
            .to_bytes();
        Ok((status, body))
    }
}

fn optional<T: for<'de> Deserialize<'de>>(
    status: StatusCode,
    body: &[u8],
) -> Result<Option<T>, ApiError> {
    if status == StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !status.is_success() {
        return Err(ApiError::Status(status));
    }
    serde_json::from_slice(body)
        .map(Some)
        .map_err(|e| ApiError::Decode(e.to_string()))
}
