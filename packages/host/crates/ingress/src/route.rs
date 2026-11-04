//! Which box a request is for, whether it may reach the box at all, and where the box's upstream is. A running box
//! is routed from a short cache; a suspended one is woken once for all requests that arrive meanwhile.

use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tokio::sync::watch;
use tokio::time::timeout;

use crate::api::HostApi;

/// How long a route to a running box stays cached. Short: a suspended VM stops answering at once, and a failed connect
/// invalidates the entry anyway.
const ROUTE_CACHE_TTL: Duration = Duration::from_secs(2);
/// Longest a request waits for a suspended box to come up before it gets 503.
pub const WAKE_TIMEOUT: Duration = Duration::from_secs(60);
/// Bound on a host API call that is not a wake.
pub const API_TIMEOUT: Duration = Duration::from_secs(10);

const MAX_LABEL: usize = 63;

/// Validates the nest domain suffix (`<host slug>.<nest domain>`) and returns it with a leading dot, ready to strip
/// from a Host header.
pub fn parse_domain_suffix(raw: &str) -> Result<String, String> {
    let raw = raw.to_ascii_lowercase();
    if raw.split('.').count() < 2 || !raw.split('.').all(is_dns_label) {
        return Err(format!(
            "domain suffix {raw:?} must be DNS labels, at least two, e.g. slug.nest.example.com"
        ));
    }
    Ok(format!(".{raw}"))
}

fn is_dns_label(label: &str) -> bool {
    let bytes = label.as_bytes();
    (1..=MAX_LABEL).contains(&bytes.len())
        && bytes
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
        && !label.starts_with('-')
        && !label.ends_with('-')
}

/// The box a Host header names: `<box>.<suffix>`, port ignored. The box id must be a single DNS label.
pub fn box_id_from_host(host: &str, domain_suffix: &str) -> Option<String> {
    let host = host.to_ascii_lowercase();
    let name = host
        .split_once(':')
        .map_or(host.as_str(), |(name, _port)| name);
    let box_id = name.strip_suffix(domain_suffix)?;
    is_dns_label(box_id).then(|| box_id.to_owned())
}

/// `/mcp` and `/broker`, and everything under them, never reach a box through ingress. The check runs on the decoded,
/// dot-resolved path, so `/%6dcp`, `//mcp` and `/x/../mcp` are caught too.
pub fn is_blocked_path(path: &str) -> bool {
    let decoded = percent_decode(path);
    let mut segments: Vec<&str> = Vec::new();
    for segment in decoded.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                segments.pop();
            }
            other => segments.push(other),
        }
    }
    segments.first().is_some_and(|first| {
        first.eq_ignore_ascii_case("mcp") || first.eq_ignore_ascii_case("broker")
    })
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(high), Some(low)) = (hex_value(bytes[i + 1]), hex_value(bytes[i + 2])) {
                out.push(high * 16 + low);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

/// Where a request for a box goes now.
pub enum Resolved {
    Upstream(String),
    NotFound,
    Unavailable,
}

#[derive(Clone)]
enum WakeOutcome {
    Ready(String),
    NotFound,
    Failed,
}

pub struct Router {
    api: Arc<HostApi>,
    routes: Mutex<HashMap<String, (String, Instant)>>,
    wakes: Arc<WakeGate>,
}

impl Router {
    pub fn new(api: Arc<HostApi>) -> Self {
        Self {
            api,
            routes: Mutex::new(HashMap::new()),
            wakes: Arc::new(WakeGate::default()),
        }
    }

    pub async fn resolve(&self, box_id: &str) -> Resolved {
        if let Some(upstream) = self.cached(box_id) {
            return Resolved::Upstream(upstream);
        }
        let route = match timeout(API_TIMEOUT, self.api.route(box_id)).await {
            Ok(Ok(route)) => route,
            Ok(Err(e)) => {
                eprintln!("kestrel-ingress: route {box_id}: {e}");
                return Resolved::Unavailable;
            }
            Err(_) => {
                eprintln!("kestrel-ingress: route {box_id}: host API timed out");
                return Resolved::Unavailable;
            }
        };
        let Some(route) = route else {
            return Resolved::NotFound;
        };
        match route.state.as_str() {
            "running" => match route.upstream {
                Some(upstream) => {
                    self.remember(box_id, &upstream);
                    Resolved::Upstream(upstream)
                }
                None => Resolved::Unavailable,
            },
            "suspended" | "parked" => self.wake(box_id).await,
            "deleted" => Resolved::NotFound,
            _ => Resolved::Unavailable,
        }
    }

    /// Forgets the route to a box whose upstream just refused a connection.
    pub fn invalidate(&self, box_id: &str) {
        self.routes.lock().unwrap().remove(box_id);
    }

    async fn wake(&self, box_id: &str) -> Resolved {
        let api = Arc::clone(&self.api);
        let key = box_id.to_owned();
        let outcome = self
            .wakes
            .run(box_id, move || async move {
                match timeout(WAKE_TIMEOUT, api.wake(&key)).await {
                    Ok(Ok(Some(reply))) => WakeOutcome::Ready(reply.upstream),
                    Ok(Ok(None)) => WakeOutcome::NotFound,
                    Ok(Err(e)) => {
                        eprintln!("kestrel-ingress: wake {key}: {e}");
                        WakeOutcome::Failed
                    }
                    Err(_) => {
                        eprintln!("kestrel-ingress: wake {key}: timed out");
                        WakeOutcome::Failed
                    }
                }
            })
            .await;
        match outcome {
            WakeOutcome::Ready(upstream) => {
                self.remember(box_id, &upstream);
                Resolved::Upstream(upstream)
            }
            WakeOutcome::NotFound => Resolved::NotFound,
            WakeOutcome::Failed => Resolved::Unavailable,
        }
    }

    fn cached(&self, box_id: &str) -> Option<String> {
        let mut routes = self.routes.lock().unwrap();
        let entry = routes.get(box_id).cloned();
        match entry {
            Some((upstream, at)) if at.elapsed() < ROUTE_CACHE_TTL => Some(upstream),
            Some(_) => {
                routes.remove(box_id);
                None
            }
            None => None,
        }
    }

    fn remember(&self, box_id: &str, upstream: &str) {
        self.routes
            .lock()
            .unwrap()
            .insert(box_id.to_owned(), (upstream.to_owned(), Instant::now()));
    }
}

/// Single-flight wakes: one wake per box at a time, and every request that arrives meanwhile waits for its answer.
#[derive(Default)]
struct WakeGate {
    inflight: Mutex<HashMap<String, watch::Receiver<Option<WakeOutcome>>>>,
}

impl WakeGate {
    async fn run<F, Fut>(self: &Arc<Self>, key: &str, wake: F) -> WakeOutcome
    where
        F: FnOnce() -> Fut + Send + 'static,
        Fut: Future<Output = WakeOutcome> + Send + 'static,
    {
        let mut answer = {
            let mut inflight = self.inflight.lock().unwrap();
            match inflight.get(key) {
                Some(answer) => answer.clone(),
                None => {
                    let (tx, rx) = watch::channel(None);
                    inflight.insert(key.to_owned(), rx.clone());
                    let gate = Arc::clone(self);
                    let key = key.to_owned();
                    tokio::spawn(async move {
                        // Its own task: a panicking wake fails this wake instead of leaving the key stuck in flight.
                        let outcome = match tokio::spawn(wake()).await {
                            Ok(outcome) => outcome,
                            Err(_) => WakeOutcome::Failed,
                        };
                        gate.inflight.lock().unwrap().remove(&key);
                        let _ = tx.send(Some(outcome));
                    });
                    rx
                }
            }
        };
        let outcome = match answer.wait_for(Option::is_some).await {
            Ok(value) => (*value).clone(),
            Err(_) => None,
        };
        outcome.unwrap_or(WakeOutcome::Failed)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;

    const SUFFIX: &str = ".slug.nest.example.com";

    #[test]
    fn box_id_is_the_single_label_under_the_suffix() {
        assert_eq!(
            box_id_from_host("3f2a-b.slug.nest.example.com", SUFFIX).as_deref(),
            Some("3f2a-b")
        );
        assert_eq!(
            box_id_from_host("BOX1.Slug.Nest.Example.Com:8443", SUFFIX).as_deref(),
            Some("box1")
        );
        assert_eq!(box_id_from_host("a.b.slug.nest.example.com", SUFFIX), None);
        assert_eq!(box_id_from_host("slug.nest.example.com", SUFFIX), None);
        assert_eq!(box_id_from_host("-bad.slug.nest.example.com", SUFFIX), None);
        assert_eq!(
            box_id_from_host("bad_id.slug.nest.example.com", SUFFIX),
            None
        );
        assert_eq!(box_id_from_host("box.slug.nest.example.com.", SUFFIX), None);
        assert_eq!(box_id_from_host("box.other.example.org", SUFFIX), None);
        let too_long = format!("{}.slug.nest.example.com", "a".repeat(64));
        assert_eq!(box_id_from_host(&too_long, SUFFIX), None);
    }

    #[test]
    fn domain_suffix_must_be_dns_labels() {
        assert_eq!(
            parse_domain_suffix("Slug.Nest.Example.com").as_deref(),
            Ok(".slug.nest.example.com")
        );
        assert!(parse_domain_suffix("nest").is_err());
        assert!(parse_domain_suffix("a..b").is_err());
        assert!(parse_domain_suffix("-x.b").is_err());
    }

    #[test]
    fn mcp_and_broker_paths_are_blocked_however_they_are_spelled() {
        for path in [
            "/mcp",
            "/mcp/",
            "/mcp/tools",
            "/MCP",
            "/broker",
            "/broker/x",
            "//mcp",
            "/%6dcp",
            "/x/../mcp",
            "/%2Fmcp",
        ] {
            assert!(is_blocked_path(path), "{path} should be blocked");
        }
        for path in ["/", "/api/health", "/mcpx", "/mc", "/x/mcp", "/brokerage"] {
            assert!(!is_blocked_path(path), "{path} should pass");
        }
    }

    async fn fake_wake(calls: Arc<AtomicUsize>) -> WakeOutcome {
        calls.fetch_add(1, Ordering::SeqCst);
        tokio::time::sleep(Duration::from_millis(50)).await;
        WakeOutcome::Ready("http://10.77.0.2:8787".to_owned())
    }

    fn answer(outcome: WakeOutcome) -> Option<String> {
        match outcome {
            WakeOutcome::Ready(upstream) => Some(upstream),
            _ => None,
        }
    }

    #[tokio::test]
    async fn concurrent_requests_share_one_wake() {
        let gate = Arc::new(WakeGate::default());
        let calls = Arc::new(AtomicUsize::new(0));
        let wake = |calls: &Arc<AtomicUsize>| {
            let calls = Arc::clone(calls);
            move || fake_wake(calls)
        };
        let (a, b, c) = tokio::join!(
            gate.run("box", wake(&calls)),
            gate.run("box", wake(&calls)),
            gate.run("box", wake(&calls)),
        );
        for outcome in [a, b, c] {
            assert_eq!(answer(outcome).as_deref(), Some("http://10.77.0.2:8787"));
        }
        assert_eq!(calls.load(Ordering::SeqCst), 1);

        // Once the wake has answered, the next suspended request starts a new one.
        let _ = gate.run("box", wake(&calls)).await;
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn a_panicking_wake_fails_its_waiters_and_frees_the_key() {
        let gate = Arc::new(WakeGate::default());
        let panicked = gate.run("box", || async { panic!("wake blew up") }).await;
        assert!(answer(panicked).is_none());
        let calls = Arc::new(AtomicUsize::new(0));
        let retried = gate.run("box", {
            let calls = Arc::clone(&calls);
            move || fake_wake(calls)
        });
        assert!(answer(retried.await).is_some());
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }
}
