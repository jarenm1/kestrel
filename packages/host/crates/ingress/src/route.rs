//! Which box a request is for, whether it may reach the box at all, and where the box's upstream is. A running box
//! is routed from a short cache; a suspended one is woken once for all requests that arrive meanwhile.

use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tokio::sync::{watch, Semaphore};
use tokio::time::timeout;

use crate::activity::{ActivityGuard, Tracker};
use crate::api::{HostApi, RouteReply};

/// How long a route to a running box stays cached. Short: a suspended VM stops answering at once, and a failed connect
/// invalidates the entry anyway.
const ROUTE_CACHE_TTL: Duration = Duration::from_secs(2);
/// How long a host that is not a box (or a deleted one) stays known as missing, so repeated requests for it do not
/// each call the host agent. Short: a box the host has only just learned of must not answer 404 for long.
const MISSING_CACHE_TTL: Duration = Duration::from_secs(1);
/// Most entries the route cache holds. Host names come from clients, so the cache must not grow without bound.
const MAX_CACHED_ROUTES: usize = 4096;
/// Most host API route lookups in flight. A request that finds them all busy gets 503 instead of queueing another call.
const MAX_CONCURRENT_LOOKUPS: usize = 32;
/// Most wakes in flight at once. A wake past this fails fast with 503, so a burst across many suspended boxes cannot
/// pile up host calls.
const MAX_CONCURRENT_WAKES: usize = 32;
/// Most requests held waiting on a wake at once. Past this a request gets 503 instead of holding a connection open.
const MAX_HELD_REQUESTS: usize = 256;
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

/// `/mcp` and `/broker`, and everything under them, never reach a box through ingress. A box may match the path as
/// sent or after resolving its dot segments, so both spellings are checked, on the decoded path: `/%6dcp`, `//mcp`,
/// `/mcp/../..` and `/x/../mcp` are all caught. A matrix parameter (`/mcp;a=b`) belongs to its segment, so it does
/// not hide the name.
pub fn is_blocked_path(path: &str) -> bool {
    let decoded = percent_decode(path);
    blocked_first_segment(&decoded, false) || blocked_first_segment(&decoded, true)
}

fn blocked_first_segment(decoded: &str, resolve_dots: bool) -> bool {
    let mut segments: Vec<&str> = Vec::new();
    for segment in decoded.split('/') {
        let name = segment.split(';').next().unwrap_or("");
        match name {
            "" | "." => {}
            ".." if resolve_dots => {
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

/// Where a request for a box goes now. `Upstream` carries the box's activity guard, which must live as long as the
/// request does (the response body, or the upgraded connection).
pub enum Resolved {
    Upstream {
        upstream: String,
        guard: ActivityGuard,
    },
    NotFound,
    Unavailable,
}

/// What a health probe learns about a box. A probe never wakes a box and is never counted as activity.
pub enum Probe {
    Running(String),
    /// The box exists but is not running; the state is the host's (suspended, parked, starting, ...).
    NotRunning(String),
    NotFound,
    Unavailable,
}

#[derive(Clone)]
enum Cached {
    Upstream(String),
    Missing,
}

#[derive(Clone)]
enum WakeOutcome {
    Ready(String),
    NotFound,
    Failed,
}

pub struct Router {
    api: Arc<HostApi>,
    activity: Arc<Tracker>,
    /// Host name to what it resolved to, and when that answer stops being trusted.
    routes: Mutex<HashMap<String, (Cached, Instant)>>,
    lookups: Semaphore,
    wakes: Arc<WakeGate>,
    wake_slots: Arc<Semaphore>,
    held: Semaphore,
}

impl Router {
    pub fn new(api: Arc<HostApi>, activity: Arc<Tracker>) -> Self {
        Self {
            api,
            activity,
            routes: Mutex::new(HashMap::new()),
            lookups: Semaphore::new(MAX_CONCURRENT_LOOKUPS),
            wakes: Arc::new(WakeGate::default()),
            wake_slots: Arc::new(Semaphore::new(MAX_CONCURRENT_WAKES)),
            held: Semaphore::new(MAX_HELD_REQUESTS),
        }
    }

    /// Where a request for `box_id` goes. The box's activity is counted from the moment the host confirms the box
    /// exists, so a request held while the box wakes keeps it awake. Unknown boxes never reach the tracker.
    pub async fn resolve(&self, box_id: &str) -> Resolved {
        match self.cached(box_id) {
            Some(Cached::Upstream(upstream)) => {
                return Resolved::Upstream {
                    upstream,
                    guard: self.activity.request_started(box_id),
                };
            }
            Some(Cached::Missing) => return Resolved::NotFound,
            None => {}
        }
        let route = match self.lookup(box_id).await {
            Ok(Some(route)) => route,
            Ok(None) => {
                self.store(box_id, Cached::Missing, MISSING_CACHE_TTL);
                return Resolved::NotFound;
            }
            Err(()) => return Resolved::Unavailable,
        };
        let guard = self.activity.request_started(box_id);
        match route.state.as_str() {
            "running" => match route.upstream {
                Some(upstream) => self.routed(box_id, upstream, guard),
                None => Resolved::Unavailable,
            },
            "suspended" | "parked" => {
                let Ok(_held) = self.held.try_acquire() else {
                    return Resolved::Unavailable;
                };
                match self.wake(box_id).await {
                    WakeOutcome::Ready(upstream) => self.routed(box_id, upstream, guard),
                    WakeOutcome::NotFound => {
                        self.store(box_id, Cached::Missing, MISSING_CACHE_TTL);
                        Resolved::NotFound
                    }
                    WakeOutcome::Failed => Resolved::Unavailable,
                }
            }
            _ => Resolved::Unavailable,
        }
    }

    /// What the host says about `box_id`, without waking it or counting it as activity. The health endpoint uses this:
    /// the app polls it, so it must neither keep an idle box awake nor wake a suspended one.
    pub async fn probe(&self, box_id: &str) -> Probe {
        match self.lookup(box_id).await {
            Err(()) => Probe::Unavailable,
            Ok(None) => Probe::NotFound,
            Ok(Some(route)) if route.state == "running" => match route.upstream {
                Some(upstream) => Probe::Running(upstream),
                None => Probe::Unavailable,
            },
            Ok(Some(route)) => Probe::NotRunning(route.state),
        }
    }

    /// Asks the host about `box_id`. `Ok(None)` for a box it does not know, or one that is deleted. A failed or timed-out
    /// call is `Err`. Never wakes a box.
    async fn lookup(&self, box_id: &str) -> Result<Option<RouteReply>, ()> {
        let Ok(slot) = self.lookups.try_acquire() else {
            return Err(());
        };
        let answer = timeout(API_TIMEOUT, self.api.route(box_id)).await;
        drop(slot);
        match answer {
            Ok(Ok(route)) => Ok(route.filter(|route| route.state != "deleted")),
            Ok(Err(e)) => {
                eprintln!("kestrel-ingress: route {box_id}: {e}");
                Err(())
            }
            Err(_) => {
                eprintln!("kestrel-ingress: route {box_id}: host API timed out");
                Err(())
            }
        }
    }

    /// Forgets the route to a box whose upstream just refused a connection.
    pub fn invalidate(&self, box_id: &str) {
        self.routes.lock().unwrap().remove(box_id);
    }

    fn routed(&self, box_id: &str, upstream: String, guard: ActivityGuard) -> Resolved {
        self.store(box_id, Cached::Upstream(upstream.clone()), ROUTE_CACHE_TTL);
        Resolved::Upstream { upstream, guard }
    }

    async fn wake(&self, box_id: &str) -> WakeOutcome {
        let api = Arc::clone(&self.api);
        let key = box_id.to_owned();
        let slots = Arc::clone(&self.wake_slots);
        self.wakes
            .run(box_id, move || async move {
                let Ok(_slot) = slots.try_acquire_owned() else {
                    eprintln!("kestrel-ingress: wake {key}: too many wakes in flight");
                    return WakeOutcome::Failed;
                };
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
            .await
    }

    fn cached(&self, box_id: &str) -> Option<Cached> {
        let mut routes = self.routes.lock().unwrap();
        let entry = routes.get(box_id).cloned();
        match entry {
            Some((value, expires)) if Instant::now() < expires => Some(value),
            Some(_) => {
                routes.remove(box_id);
                None
            }
            None => None,
        }
    }

    /// Remembers an answer for `ttl`. Past the cap, expired entries are dropped first; if the cache is still full, the
    /// answer is not kept and the next request asks the host again.
    fn store(&self, box_id: &str, value: Cached, ttl: Duration) {
        let mut routes = self.routes.lock().unwrap();
        if routes.len() >= MAX_CACHED_ROUTES && !routes.contains_key(box_id) {
            let now = Instant::now();
            routes.retain(|_, (_, expires)| *expires > now);
            if routes.len() >= MAX_CACHED_ROUTES {
                return;
            }
        }
        routes.insert(box_id.to_owned(), (value, Instant::now() + ttl));
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
    use std::convert::Infallible;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use bytes::Bytes;
    use http::{Request, Response};
    use http_body_util::Full;
    use hyper::body::Incoming;
    use hyper::server::conn::http1;
    use hyper::service::service_fn;
    use hyper_util::rt::TokioIo;
    use tokio::net::UnixListener;

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
            "/mcp;a=1",
            "/Broker;jsessionid=9/x",
            "/mcp;/tools",
            "/mcp/x/../..",
            "/a/../../mcp",
        ] {
            assert!(is_blocked_path(path), "{path} should be blocked");
        }
        for path in [
            "/",
            "/api/health",
            "/mcpx",
            "/mc",
            "/x/mcp",
            "/brokerage",
            "/x;/mcp",
        ] {
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

    static SOCKETS: AtomicUsize = AtomicUsize::new(0);

    /// A host agent stand-in on a Unix socket. `answer(method, path)` gives the status and body of each reply; the
    /// returned counter counts the requests it received.
    async fn fake_host(
        answer: fn(&str, &str) -> (u16, &'static str),
    ) -> (PathBuf, Arc<AtomicUsize>) {
        let n = SOCKETS.fetch_add(1, Ordering::SeqCst);
        let path = std::env::temp_dir().join(format!(
            "kestrel-ingress-test-{}-{n}.sock",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&path);
        let listener = UnixListener::bind(&path).expect("bind fake host");
        let calls = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&calls);
        tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                let counter = Arc::clone(&counter);
                tokio::spawn(async move {
                    let service = service_fn(move |req: Request<Incoming>| {
                        let counter = Arc::clone(&counter);
                        async move {
                            counter.fetch_add(1, Ordering::SeqCst);
                            let (status, body) = answer(req.method().as_str(), req.uri().path());
                            Ok::<_, Infallible>(
                                Response::builder()
                                    .status(status)
                                    .body(Full::new(Bytes::from(body)))
                                    .expect("response"),
                            )
                        }
                    });
                    let _ = http1::Builder::new()
                        .serve_connection(TokioIo::new(stream), service)
                        .await;
                });
            }
        });
        (path, calls)
    }

    fn host_answer(method: &str, path: &str) -> (u16, &'static str) {
        match (method, path) {
            ("GET", "/v1/boxes/box1/route") => (
                200,
                r#"{"state":"running","upstream":"http://10.77.0.2:8787"}"#,
            ),
            ("GET", "/v1/boxes/asleep/route") => (200, r#"{"state":"suspended"}"#),
            ("GET", "/v1/boxes/parked/route") => (200, r#"{"state":"parked"}"#),
            ("POST", "/v1/boxes/asleep/wake") => (200, r#"{"upstream":"http://10.77.0.3:8787"}"#),
            _ => (404, "{}"),
        }
    }

    fn router_for(socket: PathBuf, tracker: &Arc<Tracker>) -> Router {
        Router::new(Arc::new(HostApi::new(socket)), Arc::clone(tracker))
    }

    #[tokio::test]
    async fn an_unknown_box_is_looked_up_once_and_never_tracked() {
        let (socket, calls) = fake_host(host_answer).await;
        let tracker = Arc::new(Tracker::default());
        let router = router_for(socket, &tracker);
        for _ in 0..3 {
            assert!(matches!(router.resolve("ghost").await, Resolved::NotFound));
        }
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(tracker.tracked(), 0);
    }

    #[tokio::test]
    async fn a_running_box_is_routed_from_cache_and_counted_while_a_request_holds_it() {
        let (socket, calls) = fake_host(host_answer).await;
        let tracker = Arc::new(Tracker::default());
        let router = router_for(socket, &tracker);
        let Resolved::Upstream { upstream, guard } = router.resolve("box1").await else {
            panic!("box1 should route");
        };
        assert_eq!(upstream, "http://10.77.0.2:8787");
        assert_eq!(tracker.open_connections("box1"), 1);
        drop(guard);
        assert_eq!(tracker.open_connections("box1"), 0);

        assert!(matches!(
            router.resolve("box1").await,
            Resolved::Upstream { .. }
        ));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn the_request_that_wakes_a_suspended_box_counts_as_its_activity() {
        let (socket, _calls) = fake_host(host_answer).await;
        let tracker = Arc::new(Tracker::default());
        let router = router_for(socket, &tracker);
        let Resolved::Upstream { upstream, guard } = router.resolve("asleep").await else {
            panic!("asleep should wake and route");
        };
        assert_eq!(upstream, "http://10.77.0.3:8787");
        assert_eq!(tracker.open_connections("asleep"), 1);
        drop(guard);
    }

    #[tokio::test]
    async fn a_health_probe_reports_a_sleeping_box_without_waking_it() {
        let (socket, calls) = fake_host(host_answer).await;
        let tracker = Arc::new(Tracker::default());
        let router = router_for(socket, &tracker);
        assert!(matches!(router.probe("asleep").await, Probe::NotRunning(s) if s == "suspended"));
        assert!(matches!(router.probe("parked").await, Probe::NotRunning(s) if s == "parked"));
        assert_eq!(
            calls.load(Ordering::SeqCst),
            2,
            "one route lookup each, and no wake"
        );
        assert_eq!(tracker.tracked(), 0);
    }

    #[tokio::test]
    async fn a_health_probe_of_a_running_box_is_not_activity() {
        let (socket, _calls) = fake_host(host_answer).await;
        let tracker = Arc::new(Tracker::default());
        let router = router_for(socket, &tracker);
        let Probe::Running(upstream) = router.probe("box1").await else {
            panic!("box1 should probe as running");
        };
        assert_eq!(upstream, "http://10.77.0.2:8787");
        assert!(matches!(router.probe("ghost").await, Probe::NotFound));
        assert_eq!(tracker.tracked(), 0);
    }
}
