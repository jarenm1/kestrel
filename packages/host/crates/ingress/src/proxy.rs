//! Forwards a request to a box's VM and streams the answer back. Hop-by-hop headers are dropped, except the ones an
//! upgrade needs; after `101` the two sockets are copied to each other (WebSocket and other upgrades).

use std::convert::Infallible;
use std::pin::Pin;
use std::task::{Context, Poll};
use std::time::Duration;

use bytes::Bytes;
use http::header::{CONNECTION, CONTENT_TYPE, UPGRADE};
use http::{HeaderMap, HeaderName, HeaderValue, Request, Response, StatusCode, Uri};
use http_body::{Body as HttpBody, Frame, SizeHint};
use http_body_util::combinators::BoxBody;
use http_body_util::{BodyExt, Empty, Full};
use hyper::body::Incoming;
use hyper::upgrade::OnUpgrade;
use hyper_util::client::legacy::connect::HttpConnector;
use hyper_util::client::legacy::Client;
use hyper_util::rt::{TokioExecutor, TokioIo};
use tokio::time::timeout;

use crate::activity::ActivityGuard;

pub type Body = BoxBody<Bytes, hyper::Error>;

const X_FORWARDED_PROTO: HeaderName = HeaderName::from_static("x-forwarded-proto");

/// Longest a connect to a box's VM may take. A VM that just suspended or lost its tap never answers the SYN, so
/// without this a stale route would hold the request for the kernel's connect timeout, minutes.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(2);

/// Longest the upstream may take to send response headers. Past it the request fails with 504, so an upstream that
/// accepts the connection and never answers cannot hold its box awake indefinitely.
const RESPONSE_TIMEOUT: Duration = Duration::from_secs(300);

/// Headers that describe one hop, never the end-to-end exchange (RFC 9110 section 7.6.1).
const HOP_BY_HOP: [&str; 8] = [
    "keep-alive",
    "proxy-connection",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
];

pub enum ForwardError {
    /// Nothing was sent: the connect was refused or timed out, so the route is probably stale. The request comes back
    /// when it had no body, the only kind that can be sent again.
    Connect(Option<Box<Request<Incoming>>>),
    /// The upstream sent no response headers within `RESPONSE_TIMEOUT`.
    TimedOut,
    Failed,
}

pub struct Proxy {
    client: Client<HttpConnector, Body>,
}

impl Proxy {
    pub fn new() -> Self {
        let mut connector = HttpConnector::new();
        connector.set_connect_timeout(Some(CONNECT_TIMEOUT));
        Self {
            client: Client::builder(TokioExecutor::new()).build(connector),
        }
    }

    /// Sends `req` to `upstream` (`http://ip:port`). The activity guard, when there is one, lives as long as the response
    /// body or the upgraded connection. A health probe passes none: its requests are not activity.
    pub async fn forward(
        &self,
        upstream: &str,
        mut req: Request<Incoming>,
        guard: Option<ActivityGuard>,
    ) -> Result<Response<Body>, ForwardError> {
        let authority = upstream
            .parse::<Uri>()
            .ok()
            .and_then(|uri| uri.authority().cloned())
            .ok_or(ForwardError::Failed)?;
        let path_and_query = req.uri().path_and_query().map_or("/", |pq| pq.as_str());
        let uri = Uri::builder()
            .scheme("http")
            .authority(authority)
            .path_and_query(path_and_query)
            .build()
            .map_err(|_| ForwardError::Failed)?;

        let upgrade = wants_upgrade(req.headers());
        let mut head = Request::new(());
        *head.method_mut() = req.method().clone();
        *head.version_mut() = req.version();
        *head.uri_mut() = uri;
        *head.headers_mut() = req.headers().clone();
        strip_hop_by_hop(head.headers_mut(), upgrade);
        // Caddy terminates TLS for every box hostname, so the client's scheme is https. Set rather than default, so a
        // client-supplied value is never passed on.
        head.headers_mut()
            .insert(X_FORWARDED_PROTO, HeaderValue::from_static("https"));

        // A request without a body stays whole, so a refused connect can hand it back. A request with a body is
        // consumed by the send and cannot be replayed.
        let (sent, mut inbound, early_upgrade) = if req.body().is_end_stream() {
            (head.map(|()| empty()), Some(req), None)
        } else {
            let early_upgrade = upgrade.then(|| hyper::upgrade::on(&mut req));
            (head.map(|()| req.into_body().boxed()), None, early_upgrade)
        };

        let mut response = match timeout(RESPONSE_TIMEOUT, self.client.request(sent)).await {
            Err(_) => return Err(ForwardError::TimedOut),
            Ok(Ok(response)) => response,
            Ok(Err(e)) if e.is_connect() => {
                return Err(ForwardError::Connect(inbound.map(Box::new)))
            }
            Ok(Err(_)) => return Err(ForwardError::Failed),
        };

        if response.status() == StatusCode::SWITCHING_PROTOCOLS {
            let client_upgrade = early_upgrade
                .or_else(|| inbound.as_mut().filter(|_| upgrade).map(hyper::upgrade::on))
                .ok_or(ForwardError::Failed)?;
            let upstream_upgrade = hyper::upgrade::on(&mut response);
            let (mut parts, _) = response.into_parts();
            strip_hop_by_hop(&mut parts.headers, true);
            tokio::spawn(tunnel(client_upgrade, upstream_upgrade, guard));
            return Ok(Response::from_parts(parts, empty()));
        }

        let (mut parts, body) = response.into_parts();
        strip_hop_by_hop(&mut parts.headers, false);
        let guarded = Guarded {
            inner: body.boxed(),
            _guard: guard,
        };
        Ok(Response::from_parts(parts, BoxBody::new(guarded)))
    }
}

/// A complete small response (errors, not-found).
pub fn plain(status: StatusCode, text: &'static str) -> Response<Body> {
    let mut response = Response::new(full(Bytes::from_static(text.as_bytes())));
    *response.status_mut() = status;
    response.headers_mut().insert(
        CONTENT_TYPE,
        HeaderValue::from_static("text/plain; charset=utf-8"),
    );
    response
}

/// A complete small JSON response.
pub fn json(status: StatusCode, body: String) -> Response<Body> {
    let mut response = Response::new(full(Bytes::from(body)));
    *response.status_mut() = status;
    response
        .headers_mut()
        .insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    response
}

fn full(bytes: Bytes) -> Body {
    Full::new(bytes).map_err(never).boxed()
}

fn empty() -> Body {
    Empty::<Bytes>::new().map_err(never).boxed()
}

fn never(infallible: Infallible) -> hyper::Error {
    match infallible {}
}

async fn tunnel(client: OnUpgrade, upstream: OnUpgrade, _guard: Option<ActivityGuard>) {
    let (client, upstream) = match tokio::try_join!(client, upstream) {
        Ok(pair) => pair,
        Err(e) => {
            eprintln!("kestrel-ingress: upgrade failed: {e}");
            return;
        }
    };
    let mut client = TokioIo::new(client);
    let mut upstream = TokioIo::new(upstream);
    let _ = tokio::io::copy_bidirectional(&mut client, &mut upstream).await;
}

/// Keeps the activity guard alive until the response body is dropped or fully read.
struct Guarded {
    inner: Body,
    _guard: Option<ActivityGuard>,
}

impl HttpBody for Guarded {
    type Data = Bytes;
    type Error = hyper::Error;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, hyper::Error>>> {
        Pin::new(&mut self.inner).poll_frame(cx)
    }

    fn is_end_stream(&self) -> bool {
        self.inner.is_end_stream()
    }

    fn size_hint(&self) -> SizeHint {
        self.inner.size_hint()
    }
}

fn wants_upgrade(headers: &HeaderMap) -> bool {
    headers.contains_key(UPGRADE)
        && connection_tokens(headers)
            .iter()
            .any(|token| token == "upgrade")
}

fn connection_tokens(headers: &HeaderMap) -> Vec<String> {
    headers
        .get_all(CONNECTION)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .map(|token| token.trim().to_ascii_lowercase())
        .filter(|token| !token.is_empty())
        .collect()
}

/// Removes hop-by-hop headers and any header the `Connection` header names. With `upgrade`, the `Connection: upgrade`
/// and `Upgrade` headers are kept, since the handshake needs them.
pub fn strip_hop_by_hop(headers: &mut HeaderMap, upgrade: bool) {
    let named = connection_tokens(headers);
    headers.remove(CONNECTION);
    for name in HOP_BY_HOP {
        if !(upgrade && name == "upgrade") {
            headers.remove(name);
        }
    }
    for name in named {
        if !(upgrade && name == "upgrade") {
            headers.remove(name.as_str());
        }
    }
    if upgrade {
        headers.insert(CONNECTION, HeaderValue::from_static("upgrade"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_hop_by_hop_and_headers_the_connection_header_names() {
        let mut headers = HeaderMap::new();
        headers.insert(CONNECTION, HeaderValue::from_static("close, x-private"));
        headers.insert("keep-alive", HeaderValue::from_static("timeout=5"));
        headers.insert("transfer-encoding", HeaderValue::from_static("chunked"));
        headers.insert("te", HeaderValue::from_static("trailers"));
        headers.insert("x-private", HeaderValue::from_static("1"));
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("text/plain"));
        headers.insert(X_FORWARDED_PROTO, HeaderValue::from_static("https"));

        strip_hop_by_hop(&mut headers, false);

        for gone in [
            "connection",
            "keep-alive",
            "transfer-encoding",
            "te",
            "x-private",
        ] {
            assert!(!headers.contains_key(gone), "{gone} should be stripped");
        }
        assert_eq!(headers["content-type"], "text/plain");
        assert_eq!(headers["x-forwarded-proto"], "https");
    }

    #[test]
    fn upgrade_keeps_the_handshake_headers() {
        let mut headers = HeaderMap::new();
        headers.insert(CONNECTION, HeaderValue::from_static("keep-alive, Upgrade"));
        headers.insert(UPGRADE, HeaderValue::from_static("websocket"));
        headers.insert("sec-websocket-key", HeaderValue::from_static("abc"));
        headers.insert("keep-alive", HeaderValue::from_static("timeout=5"));

        strip_hop_by_hop(&mut headers, true);

        assert_eq!(headers[CONNECTION], "upgrade");
        assert_eq!(headers[UPGRADE], "websocket");
        assert_eq!(headers["sec-websocket-key"], "abc");
        assert!(!headers.contains_key("keep-alive"));
    }

    #[test]
    fn upgrade_needs_both_the_upgrade_header_and_the_connection_token() {
        let mut both = HeaderMap::new();
        both.insert(CONNECTION, HeaderValue::from_static("Upgrade"));
        both.insert(UPGRADE, HeaderValue::from_static("websocket"));
        assert!(wants_upgrade(&both));

        let mut token_only = HeaderMap::new();
        token_only.insert(CONNECTION, HeaderValue::from_static("upgrade"));
        assert!(!wants_upgrade(&token_only));

        let mut header_only = HeaderMap::new();
        header_only.insert(UPGRADE, HeaderValue::from_static("websocket"));
        assert!(!wants_upgrade(&header_only));
    }
}
