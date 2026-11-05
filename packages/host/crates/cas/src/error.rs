use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use std::io;

/// Why the store did not serve or accept a request.
#[derive(Debug)]
pub enum Error {
    /// The request is malformed: bad name, bad digest, or a body that does not match its digest.
    BadRequest(String),
    NotFound(String),
    /// A ref path collides with another key (a file where a directory is needed, or the reverse).
    Conflict(String),
    /// The body exceeds the largest accepted blob.
    TooLarge(u64),
    Internal(String),
}

impl IntoResponse for Error {
    fn into_response(self) -> Response {
        let (status, message) = match self {
            Self::BadRequest(m) => (StatusCode::BAD_REQUEST, m),
            Self::NotFound(m) => (StatusCode::NOT_FOUND, m),
            Self::Conflict(m) => (StatusCode::CONFLICT, m),
            Self::TooLarge(max) => (
                StatusCode::PAYLOAD_TOO_LARGE,
                format!("body exceeds the {max}-byte blob limit"),
            ),
            Self::Internal(m) => (StatusCode::INTERNAL_SERVER_ERROR, m),
        };
        (status, message).into_response()
    }
}

impl From<io::Error> for Error {
    fn from(e: io::Error) -> Self {
        Self::Internal(e.to_string())
    }
}
