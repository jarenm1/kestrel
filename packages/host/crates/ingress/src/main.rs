//! kestrel-ingress: the Nest's HTTP front door. Caddy terminates TLS and passes requests here. Each box's hostname is
//! routed to its VM, requests wait while a suspended box wakes, and activity is reported to the host agent.
//! Design: docs/nest.md, "Ingress".

mod activity;
mod api;
mod proxy;
mod route;

use std::convert::Infallible;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use clap::Parser;
use http::header::{HeaderValue, HOST, RETRY_AFTER};
use http::{Request, Response, StatusCode};
use hyper::body::Incoming;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper_util::rt::TokioIo;
use tokio::net::TcpListener;

use activity::Tracker;
use api::HostApi;
use proxy::{Body, ForwardError, Proxy};
use route::{Resolved, Router};

/// Seconds a client is told to wait before it retries a 503.
const RETRY_AFTER_SECS: &str = "10";

#[derive(Parser)]
#[command(about = "Routes <box>.<domain suffix> to the box's VM, waking it when suspended")]
struct Args {
    /// Address to serve on. Caddy proxies to it.
    #[arg(long, default_value = "127.0.0.1:8081")]
    listen: SocketAddr,
    /// The host agent's local API socket.
    #[arg(long, default_value = "/run/kestrel-host/api.sock")]
    api_socket: PathBuf,
    /// What follows the box id in Host: `<host slug>.<nest domain>`, so a box's Host is `<boxId>.<slug>.<nest domain>`.
    #[arg(long)]
    domain_suffix: String,
}

struct AppState {
    domain_suffix: String,
    router: Router,
    proxy: Proxy,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = Args::parse();
    let domain_suffix = route::parse_domain_suffix(&args.domain_suffix)?;
    let api = Arc::new(HostApi::new(args.api_socket));
    let activity = Arc::new(Tracker::default());
    tokio::spawn(activity::report_loop(
        Arc::clone(&activity),
        Arc::clone(&api),
    ));

    let state = Arc::new(AppState {
        domain_suffix,
        router: Router::new(api, activity),
        proxy: Proxy::new(),
    });
    let listener = TcpListener::bind(args.listen).await?;
    eprintln!("kestrel-ingress: listening on {}", args.listen);

    loop {
        let (stream, peer) = match listener.accept().await {
            Ok(accepted) => accepted,
            Err(e) => {
                eprintln!("kestrel-ingress: accept: {e}");
                tokio::time::sleep(Duration::from_millis(100)).await;
                continue;
            }
        };
        let _ = stream.set_nodelay(true);
        let state = Arc::clone(&state);
        tokio::spawn(async move {
            let service = service_fn(move |req| handle(Arc::clone(&state), req));
            if let Err(e) = http1::Builder::new()
                .serve_connection(TokioIo::new(stream), service)
                .with_upgrades()
                .await
            {
                eprintln!("kestrel-ingress: connection {peer}: {e}");
            }
        });
    }
}

async fn handle(
    state: Arc<AppState>,
    req: Request<Incoming>,
) -> Result<Response<Body>, Infallible> {
    if route::is_blocked_path(req.uri().path()) {
        return Ok(proxy::plain(StatusCode::NOT_FOUND, "not found"));
    }
    let box_id = req
        .headers()
        .get(HOST)
        .and_then(|host| host.to_str().ok())
        .and_then(|host| route::box_id_from_host(host, &state.domain_suffix));
    let Some(box_id) = box_id else {
        return Ok(proxy::plain(StatusCode::NOT_FOUND, "not found"));
    };

    let response = match state.router.resolve(&box_id).await {
        Resolved::Upstream { upstream, guard } => {
            match state.proxy.forward(&upstream, req, guard).await {
                Ok(response) => response,
                Err(ForwardError::Connect) => {
                    state.router.invalidate(&box_id);
                    proxy::plain(StatusCode::BAD_GATEWAY, "upstream unreachable")
                }
                Err(ForwardError::Failed) => {
                    proxy::plain(StatusCode::BAD_GATEWAY, "upstream failed")
                }
            }
        }
        Resolved::NotFound => proxy::plain(StatusCode::NOT_FOUND, "not found"),
        Resolved::Unavailable => {
            let mut response = proxy::plain(
                StatusCode::SERVICE_UNAVAILABLE,
                "box is starting, retry shortly",
            );
            response
                .headers_mut()
                .insert(RETRY_AFTER, HeaderValue::from_static(RETRY_AFTER_SECS));
            response
        }
    };
    Ok(response)
}
