//! Command line. Defaults are the production paths from `packages/protocol/src/guest.ts` and `docs/nest.md`; every
//! path is a flag so the agent can run unprivileged in tests.

use std::path::PathBuf;

use crate::protocol::{
    GUEST_AGENT_BOX_SOCKET, GUEST_AGENT_VSOCK_PORT, NEST_BOX_USER, NEST_VOLUME_MOUNT,
};

pub const USAGE: &str = "\
kestrel-guest-agent [OPTIONS]

  --host-listen vsock:<port>|unix:<path>   host link (default vsock:1024)
  --box-socket <path>                      box link Unix socket (default /run/kestrel-guest/box.sock)
  --box-user <name>                        user the box runs as: owns its home and data, and alone may connect to the box socket (default kestrel-box)
  --box-unit <name>                        systemd unit of the box (default kestrel-box.service)
  --box-health-url <url>                   http:// URL polled by configure (default http://127.0.0.1:8787/api/health)
  --volume-device <path>                   user volume (default /dev/disk/by-id/virtio-kestrel-volume)
  --swap-device <path>                     swap disk (default /dev/disk/by-id/virtio-kestrel-swap)
  --machine-id <path>                      file holding the clone id (default /etc/machine-id)
  --volume-mount <path>                    where the volume is mounted (default /var/lib/kestrel)
  --box-env-file <path>                    environment file for the box (default <volume-mount>/box.env)
  --net-iface <name>                       guest NIC (default: first non-loopback interface)
  --resolv-conf <path>                     (default /etc/resolv.conf)
  --nix-store <path>                       the overlay mounted on the Nix store (default /nix/store)
  --nix-lower <path>                       read-only lower of that overlay (default /nix/.ro-store/store)
  --nix-tmp-upper <path>                   tmpfs upper of that overlay, moved to the volume (default /nix/.rw-store/store)
  --dry-run-system                         log mount/ip/systemctl/modprobe/clock instead of running them
  -h, --help
";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostListen {
    Vsock(u32),
    Unix(PathBuf),
}

#[derive(Debug, Clone)]
pub struct Config {
    pub host_listen: HostListen,
    pub box_socket: PathBuf,
    pub box_user: String,
    pub box_unit: String,
    pub box_health_url: String,
    pub volume_device: PathBuf,
    pub swap_device: PathBuf,
    pub machine_id: PathBuf,
    pub volume_mount: PathBuf,
    pub box_env_file: PathBuf,
    pub net_iface: Option<String>,
    pub resolv_conf: PathBuf,
    pub nix_store: PathBuf,
    pub nix_lower: PathBuf,
    pub nix_tmp_upper: PathBuf,
    pub dry_run: bool,
}

impl Config {
    /// Where the box keeps its home (package-manager configs, Nix user config). Under the volume.
    pub fn box_home(&self) -> PathBuf {
        self.volume_mount.join("home")
    }

    /// The box's `CLOUDAGENTS_DATA_DIR`: `NEST_VOLUME_MOUNT`/box. Under the volume.
    pub fn data_dir(&self) -> PathBuf {
        self.volume_mount.join("box")
    }

    /// Upper and work directories of the Nix store overlay once it lives on the volume.
    pub fn nix_volume_upper(&self) -> PathBuf {
        self.volume_mount.join(".nix-rw").join("upper")
    }

    pub fn nix_volume_work(&self) -> PathBuf {
        self.volume_mount.join(".nix-rw").join("work")
    }
}

pub enum Parsed {
    Run(Box<Config>),
    Help,
}

pub fn parse<I: IntoIterator<Item = String>>(args: I) -> Result<Parsed, String> {
    let mut host_listen = HostListen::Vsock(GUEST_AGENT_VSOCK_PORT);
    let mut box_socket = PathBuf::from(GUEST_AGENT_BOX_SOCKET);
    let mut box_user = NEST_BOX_USER.to_string();
    let mut box_unit = "kestrel-box.service".to_string();
    let mut box_health_url = "http://127.0.0.1:8787/api/health".to_string();
    let mut volume_device = PathBuf::from("/dev/disk/by-id/virtio-kestrel-volume");
    let mut swap_device = PathBuf::from("/dev/disk/by-id/virtio-kestrel-swap");
    let mut machine_id = PathBuf::from("/etc/machine-id");
    let mut volume_mount = PathBuf::from(NEST_VOLUME_MOUNT);
    let mut box_env_file: Option<PathBuf> = None;
    let mut net_iface = None;
    let mut resolv_conf = PathBuf::from("/etc/resolv.conf");
    let mut nix_store = PathBuf::from("/nix/store");
    let mut nix_lower = PathBuf::from("/nix/.ro-store/store");
    let mut nix_tmp_upper = PathBuf::from("/nix/.rw-store/store");
    let mut dry_run = false;

    let mut it = args.into_iter();
    while let Some(arg) = it.next() {
        let (flag, inline) = match arg.split_once('=') {
            Some((f, v)) if f.starts_with("--") => (f.to_string(), Some(v.to_string())),
            _ => (arg.clone(), None),
        };
        let mut value = |name: &str| -> Result<String, String> {
            match inline.clone() {
                Some(v) => Ok(v),
                None => it.next().ok_or_else(|| format!("{name} needs a value")),
            }
        };
        match flag.as_str() {
            "-h" | "--help" => return Ok(Parsed::Help),
            "--dry-run-system" => dry_run = true,
            "--host-listen" => host_listen = parse_listen(&value("--host-listen")?)?,
            "--box-socket" => box_socket = PathBuf::from(value("--box-socket")?),
            "--box-user" => box_user = value("--box-user")?,
            "--box-unit" => box_unit = value("--box-unit")?,
            "--box-health-url" => box_health_url = value("--box-health-url")?,
            "--volume-device" => volume_device = PathBuf::from(value("--volume-device")?),
            "--swap-device" => swap_device = PathBuf::from(value("--swap-device")?),
            "--machine-id" => machine_id = PathBuf::from(value("--machine-id")?),
            "--volume-mount" => volume_mount = PathBuf::from(value("--volume-mount")?),
            "--box-env-file" => box_env_file = Some(PathBuf::from(value("--box-env-file")?)),
            "--net-iface" => net_iface = Some(value("--net-iface")?),
            "--resolv-conf" => resolv_conf = PathBuf::from(value("--resolv-conf")?),
            "--nix-store" => nix_store = PathBuf::from(value("--nix-store")?),
            "--nix-lower" => nix_lower = PathBuf::from(value("--nix-lower")?),
            "--nix-tmp-upper" => nix_tmp_upper = PathBuf::from(value("--nix-tmp-upper")?),
            other => return Err(format!("unknown argument {other}")),
        }
    }
    if !box_health_url.starts_with("http://") {
        return Err("--box-health-url must be an http:// URL".into());
    }
    let box_env_file = box_env_file.unwrap_or_else(|| volume_mount.join("box.env"));
    Ok(Parsed::Run(Box::new(Config {
        host_listen,
        box_socket,
        box_user,
        box_unit,
        box_health_url,
        volume_device,
        swap_device,
        machine_id,
        volume_mount,
        box_env_file,
        net_iface,
        resolv_conf,
        nix_store,
        nix_lower,
        nix_tmp_upper,
        dry_run,
    })))
}

fn parse_listen(value: &str) -> Result<HostListen, String> {
    if let Some(port) = value.strip_prefix("vsock:") {
        let port: u32 = port
            .parse()
            .map_err(|_| format!("bad vsock port {port:?}"))?;
        Ok(HostListen::Vsock(port))
    } else if let Some(path) = value.strip_prefix("unix:") {
        if path.is_empty() {
            return Err("unix: needs a path".into());
        }
        Ok(HostListen::Unix(PathBuf::from(path)))
    } else {
        Err(format!(
            "--host-listen must be vsock:<port> or unix:<path>, got {value:?}"
        ))
    }
}
