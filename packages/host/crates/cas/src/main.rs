use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use clap::Parser;
use kestrel_cas::{router, Config, Store};
use tracing_subscriber::EnvFilter;

const GIB: u64 = 1 << 30;

/// Content-addressed blob store and key refs for Nest VMs.
#[derive(Parser)]
#[command(version, about)]
struct Args {
    /// Address to listen on (the host's gateway address shared with the VMs).
    #[arg(long, default_value = "169.254.0.1:8585")]
    listen: SocketAddr,
    /// Directory for blobs, refs and staging files.
    #[arg(long, default_value = "/var/cache/kestrel-cas")]
    storage_dir: PathBuf,
    /// Total size of stored blobs; least recently used blobs are evicted above it.
    #[arg(long, default_value_t = 20 * GIB)]
    cache_bytes: u64,
    /// Largest single blob accepted; must not exceed `--cache-bytes`.
    #[arg(long, default_value_t = 4 * GIB)]
    max_object_bytes: u64,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();
    let args = Args::parse();
    let store = Store::open(Config {
        storage_dir: args.storage_dir.clone(),
        cap_bytes: args.cache_bytes,
        max_object_bytes: args.max_object_bytes,
    })?;
    let listener = tokio::net::TcpListener::bind(args.listen).await?;
    tracing::info!(
        "listening on {} (storage {})",
        args.listen,
        args.storage_dir.display()
    );
    axum::serve(listener, router(Arc::new(store))).await?;
    Ok(())
}
