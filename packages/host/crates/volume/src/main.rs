//! `kestrel-volume`: creates, backs up, restores, and lazily serves a box's volume image.
//! Results are one JSON object on stdout; errors go to stderr with exit status 1.

mod backup;
mod crypto;
mod extents;
mod files;
mod lazy;
mod manifest;
mod store;
#[cfg(test)]
mod testutil;

use std::fs::OpenOptions;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;

use anyhow::{Context, Result, ensure};
use clap::{Args, Parser, Subcommand};
use serde::Serialize;
use signal_hook::consts::{SIGINT, SIGTERM};

use crypto::{BoxKey, FleetKey};

/// The fleet volume key, readable by its owner only.
const DEFAULT_KEY_FILE: &str = "/etc/kestrel-host/volume.key";

#[derive(Parser)]
#[command(
    name = "kestrel-volume",
    version,
    about = "Backs up and restores Nest volume images"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Creates a new sparse volume image of exactly `--size-bytes`.
    Create {
        #[arg(long)]
        path: PathBuf,
        #[arg(long)]
        size_bytes: u64,
    },
    /// Uploads the changed chunks of a volume image and writes a new manifest. The snapshot, baseline, and lock for the box
    /// are kept in `--state-dir`, which must be on the same reflink filesystem as the volume.
    Backup {
        #[arg(long)]
        path: PathBuf,
        #[arg(long)]
        state_dir: PathBuf,
        #[command(flatten)]
        remote: Remote,
    },
    /// Restores a manifest to a new file.
    Restore {
        #[arg(long = "ref")]
        volume_ref: String,
        #[arg(long)]
        dest: PathBuf,
        #[command(flatten)]
        remote: Remote,
    },
    /// Serves a manifest as a ublk block device, fetching chunks on first access, until SIGTERM.
    RestoreLazy {
        #[arg(long = "ref")]
        volume_ref: String,
        #[arg(long)]
        dest: PathBuf,
        #[command(flatten)]
        remote: Remote,
    },
    /// Deletes every object of a box from the store.
    Delete {
        #[arg(long = "box")]
        box_id: String,
        #[arg(long)]
        store: String,
    },
}

#[derive(Args)]
struct Remote {
    /// The box whose chunks and manifests are read or written.
    #[arg(long = "box")]
    box_id: String,
    /// `file:///dir` or `s3://bucket/prefix`.
    #[arg(long)]
    store: String,
    /// Fleet key file (32 raw bytes or 64 hex characters).
    #[arg(long, default_value = DEFAULT_KEY_FILE)]
    key_file: PathBuf,
}

impl Remote {
    fn box_key(&self) -> Result<BoxKey> {
        manifest::validate_box_id(&self.box_id)?;
        Ok(FleetKey::load(&self.key_file)?.box_key(&self.box_id))
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CreateOutput {
    path: String,
    bytes: u64,
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("kestrel-volume: {e:#}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<()> {
    match Cli::parse().command {
        Command::Create { path, size_bytes } => create(&path, size_bytes),
        Command::Backup {
            path,
            state_dir,
            remote,
        } => {
            let key = remote.box_key()?;
            let store = store::open(&remote.store)?;
            print_json(&backup::backup(
                &path,
                &remote.box_id,
                &state_dir,
                store.as_ref(),
                &key,
            )?)
        }
        Command::Restore {
            volume_ref,
            dest,
            remote,
        } => {
            let key = remote.box_key()?;
            let store = store::open(&remote.store)?;
            print_json(&backup::restore(
                &volume_ref,
                &remote.box_id,
                store.as_ref(),
                &key,
                &dest,
            )?)
        }
        Command::RestoreLazy {
            volume_ref,
            dest,
            remote,
        } => {
            let key = remote.box_key()?;
            let store = store::open(&remote.store)?;
            let stop = Arc::new(AtomicBool::new(false));
            signal_hook::flag::register(SIGTERM, Arc::clone(&stop))
                .context("installing the SIGTERM handler")?;
            signal_hook::flag::register(SIGINT, Arc::clone(&stop))
                .context("installing the SIGINT handler")?;
            lazy::restore_lazy(&volume_ref, &remote.box_id, store, key, &dest, &stop)
        }
        Command::Delete { box_id, store } => {
            manifest::validate_box_id(&box_id)?;
            let store = store::open(&store)?;
            print_json(&backup::delete(&box_id, store.as_ref())?)
        }
    }
}

fn create(path: &Path, size_bytes: u64) -> Result<()> {
    ensure!(
        size_bytes > 0 && size_bytes.is_multiple_of(512),
        "--size-bytes must be a positive multiple of 512"
    );
    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .with_context(|| format!("creating {}", path.display()))?;
    file.set_len(size_bytes)?;
    file.sync_all()?;
    print_json(&CreateOutput {
        path: path.display().to_string(),
        bytes: size_bytes,
    })
}

fn print_json<T: Serialize>(value: &T) -> Result<()> {
    println!("{}", serde_json::to_string(value)?);
    Ok(())
}
