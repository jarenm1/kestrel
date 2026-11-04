//! Health check of the box: a plain `http://` GET with `Connection: close`. The box listens on the VM's loopback.

use std::time::{Duration, Instant};

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::time::{sleep, timeout};

use crate::system::{log, Res};

const IO_TIMEOUT: Duration = Duration::from_secs(5);
const RESPONSE_CAP: u64 = 8 * 1024;

/// Split `http://host[:port]/path` into `host:port` and the request path.
pub fn parse_http_url(url: &str) -> Res<(String, String)> {
    let rest = url
        .strip_prefix("http://")
        .ok_or("health URL must be an http:// URL")?;
    let (authority, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, "/"),
    };
    if authority.is_empty() {
        return Err(format!("health URL {url:?} has no host"));
    }
    let addr = if authority.contains(':') {
        authority.to_string()
    } else {
        format!("{authority}:80")
    };
    Ok((addr, path.to_string()))
}

/// The HTTP status code of one GET.
pub async fn get_status(url: &str) -> Res<u16> {
    let (addr, path) = parse_http_url(url)?;
    let mut stream = timeout(IO_TIMEOUT, TcpStream::connect(&addr))
        .await
        .map_err(|_| format!("connect {addr} timed out"))?
        .map_err(|e| format!("connect {addr}: {e}"))?;
    let request = format!("GET {path} HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\n\r\n");
    timeout(IO_TIMEOUT, stream.write_all(request.as_bytes()))
        .await
        .map_err(|_| format!("write to {addr} timed out"))?
        .map_err(|e| format!("write to {addr}: {e}"))?;
    let mut response = Vec::new();
    timeout(
        IO_TIMEOUT,
        (&mut stream).take(RESPONSE_CAP).read_to_end(&mut response),
    )
    .await
    .map_err(|_| format!("read from {addr} timed out"))?
    .map_err(|e| format!("read from {addr}: {e}"))?;
    let status_line = response.split(|&b| b == b'\n').next().unwrap_or_default();
    let status_line =
        std::str::from_utf8(status_line).map_err(|_| "non-UTF-8 status line".to_string())?;
    status_line
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse().ok())
        .ok_or_else(|| format!("no HTTP status in {status_line:?}"))
}

/// Poll the health URL until it answers 200 or `budget` runs out.
pub async fn wait_healthy(url: &str, budget: Duration) -> Res<()> {
    let deadline = Instant::now() + budget;
    loop {
        let last = match get_status(url).await {
            Ok(200) => return Ok(()),
            Ok(code) => format!("HTTP {code}"),
            Err(e) => e,
        };
        if Instant::now() >= deadline {
            return Err(format!(
                "box did not become healthy within {}s: {last}",
                budget.as_secs()
            ));
        }
        log(format!("waiting for box health: {last}"));
        sleep(Duration::from_secs(1)).await;
    }
}
