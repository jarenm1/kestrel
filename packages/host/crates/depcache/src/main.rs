use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use clap::Parser;
use kestrel_depcache::{router, AppState, Config};
use tracing_subscriber::EnvFilter;

const MIB: u64 = 1 << 20;
const GIB: u64 = 1 << 30;

/// Read-only, verifying dependency cache for Nest VMs (npm, PyPI, crates.io).
#[derive(Parser)]
#[command(version, about)]
struct Args {
    /// Address to listen on (the host's gateway address shared with the VMs).
    #[arg(long, default_value = "169.254.0.1:3141")]
    listen: SocketAddr,
    /// Directory for blobs, link records, cached metadata and temporary files.
    #[arg(long, default_value = "/var/lib/kestrel-depcache")]
    storage_dir: PathBuf,
    /// Origin VMs use to reach this cache; written into rewritten metadata.
    #[arg(long, default_value = "http://169.254.0.1:3141")]
    public_base_url: String,
    /// Total size of stored artifacts; least recently used artifacts are evicted above it.
    #[arg(long, default_value_t = 20 * GIB)]
    cache_bytes: u64,
    /// Largest single artifact downloaded; must not exceed `--cache-bytes`.
    #[arg(long, default_value_t = 4 * GIB)]
    max_artifact_bytes: u64,
    /// How long fetched metadata (packuments, simple pages, index files) is served before refetching.
    #[arg(long, default_value_t = 300)]
    metadata_ttl_secs: u64,
    /// Largest metadata document accepted from upstream; metadata is held in memory while it is rewritten.
    #[arg(long, default_value_t = 128 * MIB)]
    max_metadata_bytes: u64,
    #[arg(long, default_value = "https://registry.npmjs.org")]
    npm_registry: String,
    #[arg(long, default_value = "https://pypi.org")]
    pypi_index: String,
    #[arg(long, default_value = "https://files.pythonhosted.org")]
    pypi_files: String,
    #[arg(long, default_value = "https://index.crates.io")]
    crates_index: String,
    #[arg(long, default_value = "https://static.crates.io/crates")]
    crates_static: String,
    /// Permit plain `http` upstreams (test setups only; production upstreams are https).
    #[arg(long)]
    allow_http_upstreams: bool,
}

fn origin(url: String) -> String {
    url.trim_end_matches('/').to_owned()
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();
    let args = Args::parse();
    let config = Config {
        public_base_url: origin(args.public_base_url),
        metadata_ttl: std::time::Duration::from_secs(args.metadata_ttl_secs),
        max_metadata_bytes: args.max_metadata_bytes,
        npm_registry: origin(args.npm_registry),
        pypi_index: origin(args.pypi_index),
        pypi_files: origin(args.pypi_files),
        crates_index: origin(args.crates_index),
        crates_static: origin(args.crates_static),
        allow_http_upstreams: args.allow_http_upstreams,
    };
    let state = Arc::new(AppState::new(
        config,
        &args.storage_dir,
        args.cache_bytes,
        args.max_artifact_bytes,
    )?);
    let listener = tokio::net::TcpListener::bind(args.listen).await?;
    tracing::info!(
        "listening on {} (storage {})",
        args.listen,
        args.storage_dir.display()
    );
    axum::serve(listener, router(state)).await?;
    Ok(())
}
