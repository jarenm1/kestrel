//! `kestrel-guest-agent`: runs as root inside each Nest VM. Serves the host (vsock, or a Unix socket for tests) and
//! the box (Unix socket). Contract: `packages/protocol/src/guest.ts`. Design: `docs/nest.md`.

mod app;
mod args;
mod configure;
mod gpu;
mod http;
mod link;
mod protocol;
mod status;
mod system;
mod vsock;

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::time::Duration;

use tokio::net::UnixListener;
use tokio::time::sleep;

use crate::app::{serve_box, serve_host, App};
use crate::args::{parse, Config, HostListen, Parsed, USAGE};
use crate::protocol::GUEST_PROTOCOL;
use crate::system::{chown, ensure_dir, log, lookup_user, remove_if_exists, Owner, Res, System};
use crate::vsock::VsockListener;

#[tokio::main]
async fn main() {
    if let Err(e) = run().await {
        log(format!("fatal: {e}"));
        std::process::exit(1);
    }
}

async fn run() -> Res<()> {
    let cfg = match parse(std::env::args().skip(1))? {
        Parsed::Help => {
            print!("{USAGE}");
            return Ok(());
        }
        Parsed::Run(cfg) => *cfg,
    };
    let sys = System {
        dry_run: cfg.dry_run,
    };
    let box_uid = lookup_user(&cfg.box_user)?.uid;
    let box_listener = bind_box_socket(&cfg, &sys, box_uid)?;
    let host = HostListener::bind(&cfg.host_listen)?;
    let app = App::new(cfg, sys)?;
    log(format!("ready (protocol {GUEST_PROTOCOL})"));

    let box_app = app.clone();
    tokio::spawn(async move {
        loop {
            match box_listener.accept().await {
                Ok((stream, _)) => match stream.peer_cred() {
                    Ok(cred) if cred.uid() == box_uid => serve_box(&box_app, stream),
                    Ok(cred) => log(format!("refused a box connection from uid {}", cred.uid())),
                    Err(e) => log(format!("box socket: peer credentials: {e}")),
                },
                Err(e) => {
                    log(format!("box socket: {e}"));
                    sleep(Duration::from_millis(100)).await;
                }
            }
        }
    });

    loop {
        let accepted = match &host {
            HostListener::Vsock(listener) => listener
                .accept()
                .await
                .map(|stream| serve_host(&app, stream)),
            HostListener::Unix(listener) => listener
                .accept()
                .await
                .map(|(stream, _)| serve_host(&app, stream)),
        };
        if let Err(e) = accepted {
            log(format!("host link: {e}"));
            sleep(Duration::from_millis(100)).await;
        }
    }
}

enum HostListener {
    Vsock(VsockListener),
    Unix(UnixListener),
}

impl HostListener {
    fn bind(listen: &HostListen) -> Res<Self> {
        match listen {
            HostListen::Vsock(port) => VsockListener::bind(*port)
                .map(Self::Vsock)
                .map_err(|e| format!("listen on vsock port {port}: {e}")),
            HostListen::Unix(path) => {
                remove_if_exists(path)?;
                UnixListener::bind(path)
                    .map(Self::Unix)
                    .map_err(|e| format!("bind {}: {e}", path.display()))
            }
        }
    }
}

/// The box socket is owned by the box user and mode 0600, so only that uid can connect; the accept loop checks the peer's
/// uid as well. Its directory is root-owned and 0711: the box user reaches the socket, nobody can list it. A stale socket
/// from a previous run is replaced.
fn bind_box_socket(cfg: &Config, sys: &System, box_uid: u32) -> Res<UnixListener> {
    let socket = cfg.box_socket.as_path();
    if let Some(parent) = socket.parent() {
        ensure_dir(parent, 0o711, None)?;
    }
    remove_if_exists(socket)?;
    let listener =
        UnixListener::bind(socket).map_err(|e| format!("bind {}: {e}", socket.display()))?;
    fs::set_permissions(socket, fs::Permissions::from_mode(0o600))
        .map_err(|e| format!("chmod {}: {e}", socket.display()))?;
    if sys.dry_run {
        log("[dry-run] not changing the box socket owner");
    } else {
        // A gid of u32::MAX is `-1` to chown(2): the group stays as it is.
        chown(
            socket,
            Owner {
                uid: box_uid,
                gid: u32::MAX,
            },
        )?;
    }
    Ok(listener)
}
