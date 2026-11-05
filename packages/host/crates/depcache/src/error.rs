use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};

/// Why the cache did not serve a request. Upstream and integrity failures are 502: bytes that did not verify are
/// never served.
#[derive(Debug)]
pub enum Error {
    BadRequest(String),
    /// The request carries credentials.
    Refused,
    NotFound(String),
    TooLarge(u64),
    Upstream(String),
    /// Downloads in flight hold the whole cache budget; the request can be retried.
    Busy(String),
    Internal(String),
}

impl IntoResponse for Error {
    fn into_response(self) -> Response {
        let (status, message) = match self {
            Self::BadRequest(m) => (StatusCode::BAD_REQUEST, m),
            Self::Refused => (
                StatusCode::FORBIDDEN,
                "requests with credentials are not cached; use the origin directly".to_owned(),
            ),
            Self::NotFound(m) => (StatusCode::NOT_FOUND, m),
            Self::TooLarge(bytes) => (
                StatusCode::INSUFFICIENT_STORAGE,
                format!("artifact of {bytes} bytes is larger than the cache cap"),
            ),
            Self::Upstream(m) => (StatusCode::BAD_GATEWAY, m),
            Self::Busy(m) => (StatusCode::SERVICE_UNAVAILABLE, m),
            Self::Internal(m) => (StatusCode::INTERNAL_SERVER_ERROR, m),
        };
        (status, message).into_response()
    }
}

impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self {
        Self::Internal(e.to_string())
    }
}

impl From<reqwest::Error> for Error {
    fn from(e: reqwest::Error) -> Self {
        Self::Upstream(e.to_string())
    }
}
