//! `configure`: makes a fresh clone or a restored VM this box's VM. Steps the clock, regenerates the machine id,
//! applies the network, sets up swap and the user volume, stacks the Nix store overlay on the volume, writes the
//! box's package configs and environment, then starts the box and waits for its health check.

use std::ffi::{CString, OsStr, OsString};
use std::fs::{self, File};
use std::io::{self, ErrorKind, Read, Write};
use std::net::{Ipv4Addr, Ipv6Addr};
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::ffi::OsStrExt;
use std::path::Path;
use std::time::{Duration, Instant};

use crate::args::Config;
use crate::http::wait_healthy;
use crate::protocol::{ConfigureArgs, GuestNetwork, NEST_BOX_ENV, NEST_VOLUME_SERIAL};
use crate::system::{
    ensure_dir, is_mount_point, log, lookup_user, mount_ext4, mountinfo, probe_fs_type,
    top_mount_has_option, wait_for_path, write_file, Owner, Res, System,
};

const DISK_WAIT: Duration = Duration::from_secs(60);
const HEALTH_WAIT: Duration = Duration::from_secs(50);
/// Everything `configure` waits for, counted from its start. The host gives configure 120 s; this ends before that.
const CONFIGURE_BUDGET: Duration = Duration::from_secs(100);
/// The first MiB of a volume disk must be zero before it is formatted.
const BLANK_CHECK_BYTES: u64 = 1 << 20;

/// The clone id recorded in the machine id, when this VM has been configured before.
pub fn read_clone_id(machine_id: &Path) -> Option<String> {
    let id = fs::read_to_string(machine_id).ok()?;
    let id = id.trim();
    is_clone_id(id).then(|| id.to_string())
}

fn is_clone_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

pub async fn configure(cfg: &Config, sys: &System, args: &ConfigureArgs) -> Res<()> {
    // The host times configure out at 120 s. The waits share one budget that ends first, so a slow disk or box comes
    // back as an error reply rather than as silence the host times out on.
    let deadline = Instant::now() + CONFIGURE_BUDGET;
    validate(args)?;
    sys.set_realtime(args.wall_clock_ms)?;
    write_file(
        &cfg.machine_id,
        &format!("{}\n", args.clone_id),
        0o444,
        None,
    )?;
    sys.run("systemd-random-seed", &["save"]).await?;
    configure_network(cfg, sys, &args.network).await?;
    if sys.dry_run {
        log("[dry-run] not waiting for the volume and swap disks");
    } else {
        tokio::try_join!(
            wait_for_path(&cfg.volume_device, budget_left(deadline, DISK_WAIT)),
            wait_for_path(&cfg.swap_device, budget_left(deadline, DISK_WAIT))
        )?;
    }
    setup_swap(cfg, sys).await?;
    mount_volume(cfg, sys).await?;
    stack_nix_store(cfg, sys).await?;
    write_box_files(cfg, box_owner(cfg, sys)?, &args.network)?;
    let changed = write_box_env(cfg, args)?;
    sys.run(
        "systemctl",
        &[
            if changed { "restart" } else { "start" },
            cfg.box_unit.as_str(),
        ],
    )
    .await?;
    wait_healthy(&cfg.box_health_url, budget_left(deadline, HEALTH_WAIT)).await
}

/// Time left before `deadline`, capped at `cap`.
fn budget_left(deadline: Instant, cap: Duration) -> Duration {
    deadline.saturating_duration_since(Instant::now()).min(cap)
}

/// Reject anything that would reach a command line or an env file in a form we did not intend.
fn validate(args: &ConfigureArgs) -> Res<()> {
    if !is_clone_id(&args.clone_id) {
        return Err("cloneId must be 32 lowercase hex characters".into());
    }
    for (name, value) in [("hostId", &args.host_id), ("vmId", &args.vm_id)] {
        env_value(name, value)?;
    }
    for (name, value) in [
        ("boxId", &args.box_id),
        ("controlUrl", &args.control_url),
        ("publicUrl", &args.public_url),
    ] {
        env_file_value(name, value)?;
    }
    if let Some(token) = &args.enroll_token {
        enroll_token(token)?;
    }
    let net = &args.network;
    cidr_v4(&net.address)?;
    ipv4(&net.gateway)?;
    for resolver in &net.dns {
        ipv4(resolver)?;
    }
    match (&net.ipv6_address, &net.ipv6_gateway) {
        (None, None) => {}
        (Some(address), Some(gateway)) => {
            cidr_v6(address)?;
            gateway
                .parse::<Ipv6Addr>()
                .map_err(|_| format!("bad IPv6 gateway {gateway:?}"))?;
        }
        _ => return Err("network.ipv6Address and network.ipv6Gateway must be set together".into()),
    }
    for value in [
        &net.depcache_url,
        &net.nix_cache_url,
        &net.nix_cache_public_key,
    ]
    .into_iter()
    .flatten()
    {
        env_value("network", value)?;
    }
    Ok(())
}

/// Values written unquoted into the box env file and the package configs: no whitespace, control characters, or
/// shell/env metacharacters.
fn env_value(name: &str, value: &str) -> Res<()> {
    let bad = value.is_empty()
        || value.chars().any(|c| {
            c.is_whitespace() || c.is_control() || matches!(c, '"' | '\'' | '\\' | '$' | '`')
        });
    if bad {
        return Err(format!("{name} is empty or contains a forbidden character"));
    }
    Ok(())
}

/// The contract's `EnvValue`: 1 to 2048 visible ASCII characters without quotes, backslashes, or spaces. These land
/// unquoted in the box env file, so nothing else may be there.
fn env_file_value(name: &str, value: &str) -> Res<()> {
    let allowed = |c: char| c.is_ascii_alphanumeric() || "._~:/?#@!$&()*+,;=%[]-".contains(c);
    if value.is_empty() || value.len() > 2048 || !value.chars().all(allowed) {
        return Err(format!("{name} is not a valid environment value"));
    }
    Ok(())
}

/// The contract's `EnrollToken`: 43 base64url characters.
fn enroll_token(value: &str) -> Res<()> {
    let valid = value.len() == 43
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if !valid {
        return Err("enrollToken must be 43 base64url characters".into());
    }
    Ok(())
}

fn ipv4(value: &str) -> Res<Ipv4Addr> {
    value
        .parse()
        .map_err(|_| format!("bad IPv4 address {value:?}"))
}

fn cidr_v4(value: &str) -> Res<()> {
    let (addr, prefix) = value
        .split_once('/')
        .ok_or_else(|| format!("{value:?} lacks a prefix length"))?;
    ipv4(addr)?;
    match prefix.parse::<u8>() {
        Ok(p) if p <= 32 => Ok(()),
        _ => Err(format!("bad IPv4 prefix in {value:?}")),
    }
}

fn cidr_v6(value: &str) -> Res<()> {
    let (addr, prefix) = value
        .split_once('/')
        .ok_or_else(|| format!("{value:?} lacks a prefix length"))?;
    addr.parse::<Ipv6Addr>()
        .map_err(|_| format!("bad IPv6 address {addr:?}"))?;
    match prefix.parse::<u8>() {
        Ok(p) if p <= 128 => Ok(()),
        _ => Err(format!("bad IPv6 prefix in {value:?}")),
    }
}

async fn configure_network(cfg: &Config, sys: &System, net: &GuestNetwork) -> Res<()> {
    let iface = match &cfg.net_iface {
        Some(iface) => iface.clone(),
        None => first_non_loopback()?,
    };
    let iface = iface.as_str();
    let address = net.address.as_str();
    let gateway = net.gateway.as_str();
    sys.run("ip", &["link", "set", iface, "up"]).await?;
    // Re-configuring replaces the network. `addr replace` would keep an earlier address, and a dropped IPv6 config would
    // keep its default route. Routes are flushed by `proto boot`, the protocol `ip route replace` sets below: the
    // kernel's fe80::/64 route is left alone (`scope global` on routes would remove it).
    sys.run("ip", &["-4", "addr", "flush", "dev", iface])
        .await?;
    sys.run("ip", &["-4", "route", "flush", "dev", iface])
        .await?;
    sys.run(
        "ip",
        &["-6", "addr", "flush", "dev", iface, "scope", "global"],
    )
    .await?;
    sys.run(
        "ip",
        &["-6", "route", "flush", "dev", iface, "proto", "boot"],
    )
    .await?;
    sys.run("ip", &["addr", "replace", address, "dev", iface])
        .await?;
    sys.run(
        "ip",
        &["route", "replace", gateway, "dev", iface, "scope", "link"],
    )
    .await?;
    sys.run(
        "ip",
        &[
            "route", "replace", "default", "via", gateway, "dev", iface, "onlink",
        ],
    )
    .await?;
    if let (Some(address6), Some(gateway6)) = (&net.ipv6_address, &net.ipv6_gateway) {
        let address6 = address6.as_str();
        let gateway6 = gateway6.as_str();
        sys.run("ip", &["-6", "addr", "replace", address6, "dev", iface])
            .await?;
        sys.run("ip", &["-6", "route", "replace", gateway6, "dev", iface])
            .await?;
        sys.run(
            "ip",
            &[
                "-6", "route", "replace", "default", "via", gateway6, "dev", iface, "onlink",
            ],
        )
        .await?;
    }
    let resolv: String = net
        .dns
        .iter()
        .map(|d| format!("nameserver {d}\n"))
        .collect();
    write_file(&cfg.resolv_conf, &resolv, 0o644, None)
}

fn first_non_loopback() -> Res<String> {
    let mut names: Vec<String> = fs::read_dir("/sys/class/net")
        .map_err(|e| format!("list network interfaces: {e}"))?
        .filter_map(|entry| entry.ok()?.file_name().into_string().ok())
        .filter(|name| name != "lo")
        .collect();
    names.sort();
    names
        .into_iter()
        .next()
        .ok_or_else(|| "no non-loopback network interface".into())
}

async fn setup_swap(cfg: &Config, sys: &System) -> Res<()> {
    let swap = path_str(&cfg.swap_device)?;
    // A swap device from an earlier configure may still be active on a re-configured VM; the new disk replaces it. A
    // failed swapoff on an active device is fatal: mkswap must not run on a device still in use.
    if swap_active(&cfg.swap_device)? {
        sys.run("swapoff", &[swap]).await?;
    }
    sys.run("mkswap", &["-q", swap]).await?;
    sys.run("swapon", &[swap]).await
}

/// Whether `device` is listed in `/proc/swaps`. A device that does not exist is not active.
fn swap_active(device: &Path) -> Res<bool> {
    let Ok(device) = fs::canonicalize(device) else {
        return Ok(false);
    };
    let swaps = fs::read_to_string("/proc/swaps").map_err(|e| format!("read /proc/swaps: {e}"))?;
    Ok(swap_listed(&swaps, &device))
}

/// `proc_swaps` is the text of `/proc/swaps`: a header line, then one device per line.
fn swap_listed(proc_swaps: &str, device: &Path) -> bool {
    proc_swaps
        .lines()
        .skip(1)
        .filter_map(|line| line.split_whitespace().next())
        .any(|name| Path::new(name) == device)
}

async fn mount_volume(cfg: &Config, sys: &System) -> Res<()> {
    let mount = cfg.volume_mount.as_path();
    if is_mount_point(mount)? {
        return Ok(());
    }
    if sys.dry_run {
        log("[dry-run] not probing the volume filesystem");
    } else {
        match probe_fs_type(sys, &cfg.volume_device).await? {
            Some(fs_type) if fs_type == "ext4" => {}
            Some(fs_type) => {
                return Err(format!(
                    "{} holds a {fs_type} filesystem, expected ext4",
                    cfg.volume_device.display()
                ))
            }
            None => {
                // blkid sees no filesystem, but the disk may hold data it cannot read: only a blank disk is formatted.
                if !device_is_blank(&cfg.volume_device)? {
                    return Err(format!(
                        "{} has no filesystem but is not blank; refusing to format it",
                        cfg.volume_device.display()
                    ));
                }
                let device = path_str(&cfg.volume_device)?;
                sys.run("mkfs.ext4", &["-q", "-F", "-L", NEST_VOLUME_SERIAL, device])
                    .await?;
            }
        }
    }
    ensure_dir(mount, 0o755, None)?;
    mount_ext4(sys, &cfg.volume_device, mount).await
}

/// Whether the first MiB of `device` is all zero.
fn device_is_blank(device: &Path) -> Res<bool> {
    let mut head = Vec::new();
    File::open(device)
        .map_err(|e| format!("open {}: {e}", device.display()))?
        .take(BLANK_CHECK_BYTES)
        .read_to_end(&mut head)
        .map_err(|e| format!("read {}: {e}", device.display()))?;
    Ok(head.iter().all(|b| *b == 0))
}

/// Re-stack the Nix store overlay so its writable upper directory lives on the volume. The image's overlay has a
/// tmpfs upper; its contents are copied to the volume first and the new overlay is mounted over the store.
async fn stack_nix_store(cfg: &Config, sys: &System) -> Res<()> {
    let store = cfg.nix_store.as_path();
    let upper = cfg.nix_volume_upper();
    let work = cfg.nix_volume_work();
    let upper_opt = format!("upperdir={}", path_str(&upper)?);
    if top_mount_has_option(store, &upper_opt)? {
        return Ok(());
    }
    let is_overlay = mountinfo()?
        .into_iter()
        .rev()
        .find(|m| Path::new(&m.mount_point) == store)
        .is_some_and(|m| m.fs_type == "overlay");
    if !is_overlay {
        log(format!(
            "{} is not an overlay mount; not moving it to the volume",
            store.display()
        ));
        return Ok(());
    }
    ensure_dir(&upper, 0o755, None)?;
    ensure_dir(&work, 0o755, None)?;
    if has_entries(&cfg.nix_tmp_upper)? {
        let from = format!("{}/.", path_str(&cfg.nix_tmp_upper)?);
        sys.run(
            "cp",
            &["-a", "--reflink=auto", from.as_str(), path_str(&upper)?],
        )
        .await?;
    }
    let options = format!(
        "lowerdir={},upperdir={},workdir={}",
        path_str(&cfg.nix_lower)?,
        path_str(&upper)?,
        path_str(&work)?
    );
    sys.run(
        "mount",
        &[
            "-t",
            "overlay",
            "overlay",
            "-o",
            options.as_str(),
            path_str(store)?,
        ],
    )
    .await
}

fn has_entries(dir: &Path) -> Res<bool> {
    match fs::read_dir(dir) {
        Ok(mut entries) => Ok(entries.next().is_some()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(format!("read {}: {e}", dir.display())),
    }
}

/// The box user, who owns its home and data directory. A dry run has no box user, so nothing is owned.
fn box_owner(cfg: &Config, sys: &System) -> Res<Option<Owner>> {
    if sys.dry_run {
        Ok(None)
    } else {
        lookup_user(&cfg.box_user).map(Some)
    }
}

/// Writes the box's package configs under its home. The box owns that home and can plant links in it, so every write
/// walks down from an fd opened with O_NOFOLLOW, and modes and owners are changed through fds, never through paths.
/// `home` itself sits in the root-owned volume root, which the box cannot write to.
fn write_box_files(cfg: &Config, owner: Option<Owner>, net: &GuestNetwork) -> Res<()> {
    let home = cfg.box_home();
    ensure_dir(&home, 0o750, owner)?;
    ensure_dir(&cfg.data_dir(), 0o750, owner)?;
    let home_dir = File::open(&home).map_err(|e| format!("open {}: {e}", home.display()))?;
    for (rel, content) in package_configs(net) {
        let rel = Path::new(rel);
        let name = rel
            .file_name()
            .ok_or_else(|| format!("{} has no file name", rel.display()))?;
        let dir = open_box_parent(&home_dir, rel, owner)?;
        match content {
            Some(content) => write_file_at(&dir, name, &content, 0o644, owner)?,
            None => remove_at(&dir, name)?,
        }
    }
    Ok(())
}

/// Opens the directory holding `rel` under `home`, making each level a real directory on the way down.
fn open_box_parent(home: &File, rel: &Path, owner: Option<Owner>) -> Res<File> {
    let mut dir = home.try_clone().map_err(|e| format!("dup box home: {e}"))?;
    if let Some(parent) = rel.parent() {
        for component in parent.components() {
            dir = open_box_dir(&dir, component.as_os_str(), owner)?;
        }
    }
    Ok(dir)
}

/// Opens `name` in `parent` as a real directory. A link or file the box left there is replaced by one.
fn open_box_dir(parent: &File, name: &OsStr, owner: Option<Owner>) -> Res<File> {
    let flags = libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC;
    let dir = match openat(parent, name, flags, 0) {
        Ok(dir) => dir,
        Err(e) if is_replaceable(&e) => {
            remove_at(parent, name)?;
            mkdir_at(parent, name)?;
            openat(parent, name, flags, 0)
                .map_err(|e| format!("open {}: {e}", name.to_string_lossy()))?
        }
        Err(e) => return Err(format!("open {}: {e}", name.to_string_lossy())),
    };
    set_mode_and_owner(&dir, name, 0o755, owner)?;
    Ok(dir)
}

fn is_replaceable(e: &io::Error) -> bool {
    matches!(
        e.raw_os_error(),
        Some(libc::ENOENT | libc::ENOTDIR | libc::ELOOP)
    )
}

/// Writes `content` to `name` in `dir` through a temp file made with O_EXCL and O_NOFOLLOW, then renames it over `name`.
fn write_file_at(
    dir: &File,
    name: &OsStr,
    content: &str,
    mode: u32,
    owner: Option<Owner>,
) -> Res<()> {
    let mut tmp = OsString::from(".");
    tmp.push(name);
    tmp.push(".tmp");
    remove_at(dir, &tmp)?;
    let flags = libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC;
    let mut file = openat(dir, &tmp, flags, mode)
        .map_err(|e| format!("create {}: {e}", name.to_string_lossy()))?;
    file.write_all(content.as_bytes())
        .map_err(|e| format!("write {}: {e}", name.to_string_lossy()))?;
    file.sync_all()
        .map_err(|e| format!("sync {}: {e}", name.to_string_lossy()))?;
    set_mode_and_owner(&file, name, mode, owner)?;
    rename_at(dir, &tmp, name)
}

/// Applies owner and mode through an open fd, so a path swapped after open cannot redirect the change.
/// Ownership is skipped in a dry run, which has no owner.
fn set_mode_and_owner(file: &File, name: &OsStr, mode: u32, owner: Option<Owner>) -> Res<()> {
    let fd = file.as_raw_fd();
    if let Some(owner) = owner {
        if unsafe { libc::fchown(fd, owner.uid, owner.gid) } != 0 {
            return Err(format!(
                "chown {}: {}",
                name.to_string_lossy(),
                io::Error::last_os_error()
            ));
        }
    }
    if unsafe { libc::fchmod(fd, mode) } != 0 {
        return Err(format!(
            "chmod {}: {}",
            name.to_string_lossy(),
            io::Error::last_os_error()
        ));
    }
    Ok(())
}

fn remove_at(dir: &File, name: &OsStr) -> Res<()> {
    let name_c = c_name(name)?;
    if unsafe { libc::unlinkat(dir.as_raw_fd(), name_c.as_ptr(), 0) } == 0 {
        return Ok(());
    }
    let e = io::Error::last_os_error();
    if e.kind() == ErrorKind::NotFound {
        Ok(())
    } else {
        Err(format!("remove {}: {e}", name.to_string_lossy()))
    }
}

fn rename_at(dir: &File, from: &OsStr, to: &OsStr) -> Res<()> {
    let (from_c, to_c) = (c_name(from)?, c_name(to)?);
    let fd = dir.as_raw_fd();
    if unsafe { libc::renameat(fd, from_c.as_ptr(), fd, to_c.as_ptr()) } == 0 {
        Ok(())
    } else {
        Err(format!(
            "rename {}: {}",
            to.to_string_lossy(),
            io::Error::last_os_error()
        ))
    }
}

fn mkdir_at(parent: &File, name: &OsStr) -> Res<()> {
    let name_c = c_name(name)?;
    if unsafe { libc::mkdirat(parent.as_raw_fd(), name_c.as_ptr(), 0o755) } == 0 {
        Ok(())
    } else {
        Err(format!(
            "mkdir {}: {}",
            name.to_string_lossy(),
            io::Error::last_os_error()
        ))
    }
}

fn openat(dir: &File, name: &OsStr, flags: libc::c_int, mode: u32) -> io::Result<File> {
    let name_c = c_name(name).map_err(io::Error::other)?;
    let fd = unsafe { libc::openat(dir.as_raw_fd(), name_c.as_ptr(), flags, mode) };
    if fd < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(unsafe { File::from_raw_fd(fd) })
    }
}

fn c_name(name: &OsStr) -> Res<CString> {
    CString::new(name.as_bytes()).map_err(|_| format!("{name:?} contains a NUL byte"))
}

/// Package-manager and Nix configs under the box home, pointing at the host's dependency cache and Nix cache.
/// `None` removes a config that a previous network no longer needs.
fn package_configs(net: &GuestNetwork) -> Vec<(&'static str, Option<String>)> {
    let depcache = net
        .depcache_url
        .as_deref()
        .map(|url| url.trim_end_matches('/'));
    let npmrc = depcache.map(|d| format!("registry={d}/npm/\n"));
    let pip = depcache.map(|d| format!("[global]\nindex-url = {d}/pypi/simple/\n"));
    let cargo = depcache.map(|d| {
        format!(
            "[source.crates-io]\nreplace-with = \"kestrel-depcache\"\n\n[source.kestrel-depcache]\nregistry = \"sparse+{d}/crates/index/\"\n"
        )
    });
    let nix = net.nix_cache_url.as_deref().map(|url| {
        let mut conf = format!("extra-substituters = {url}\n");
        if let Some(key) = &net.nix_cache_public_key {
            conf.push_str(&format!("extra-trusted-public-keys = {key}\n"));
        }
        conf
    });
    vec![
        (".npmrc", npmrc),
        (".config/pip/pip.conf", pip),
        (".cargo/config.toml", cargo),
        (".config/nix/nix.conf", nix),
    ]
}

/// The box environment file: exactly the `NEST_BOX_ENV` variables, `enrollToken` only when the host sends one.
fn box_env_content(args: &ConfigureArgs, box_socket: &str, data_dir: &str) -> String {
    let mut vars = vec![
        (NEST_BOX_ENV.box_id, args.box_id.as_str()),
        (NEST_BOX_ENV.control_url, args.control_url.as_str()),
        (NEST_BOX_ENV.public_url, args.public_url.as_str()),
        (NEST_BOX_ENV.guest_agent_socket, box_socket),
        (NEST_BOX_ENV.data_dir, data_dir),
    ];
    if let Some(token) = &args.enroll_token {
        vars.push((NEST_BOX_ENV.enroll_token, token.as_str()));
    }
    vars.iter()
        .map(|(name, value)| format!("{name}={value}\n"))
        .collect()
}

/// Writes the box environment file. Returns whether its content changed, so the caller restarts the box to pick
/// up a new enrollment token or identity.
fn write_box_env(cfg: &Config, args: &ConfigureArgs) -> Res<bool> {
    let content = box_env_content(args, path_str(&cfg.box_socket)?, path_str(&cfg.data_dir())?);
    let changed = fs::read_to_string(&cfg.box_env_file).ok().as_deref() != Some(content.as_str());
    if let Some(parent) = cfg.box_env_file.parent() {
        ensure_dir(parent, 0o755, None)?;
    }
    write_file(&cfg.box_env_file, &content, 0o600, None)?;
    Ok(changed)
}

/// The box enrolled and kept its secret: `enrollToken` leaves the env file, so the token is not kept on the volume.
/// Only that line changes. A missing file, or one without the token, is left as it is.
pub fn drop_enroll_token(cfg: &Config) -> Res<()> {
    let Ok(content) = fs::read_to_string(&cfg.box_env_file) else {
        return Ok(());
    };
    let prefix = format!("{}=", NEST_BOX_ENV.enroll_token);
    if !content.lines().any(|line| line.starts_with(&prefix)) {
        return Ok(());
    }
    let kept: String = content
        .split_inclusive('\n')
        .filter(|line| !line.starts_with(&prefix))
        .collect();
    write_file(&cfg.box_env_file, &kept, 0o600, None)
}

fn path_str(path: &Path) -> Res<&str> {
    path.to_str()
        .ok_or_else(|| format!("{} is not valid UTF-8", path.display()))
}
#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;
    use std::env;
    use std::os::unix::fs::{symlink, PermissionsExt};
    use std::path::PathBuf;

    use serde_json::{json, Value};

    use super::*;
    use crate::args::{parse, Parsed};
    use crate::protocol::HostToGuest;

    const FIXTURES: &str = include_str!("../tests/fixtures/guest-frames.json");

    fn fixtures() -> Value {
        serde_json::from_str(FIXTURES).expect("fixture file is JSON")
    }

    /// Variable names in a rendered box env file.
    fn written_names(content: &str) -> BTreeSet<String> {
        content
            .lines()
            .map(|line| line.split_once('=').expect("NAME=value line").0.to_string())
            .collect()
    }

    /// The fixture's `configure` frames: the first carries an enroll token, the second none.
    fn configure_frames(fixtures: &Value) -> Vec<ConfigureArgs> {
        fixtures["hostToGuest"]
            .as_array()
            .expect("hostToGuest is an array")
            .iter()
            .filter(|frame| frame["_tag"] == "configure")
            .map(|frame| {
                let decoded: HostToGuest =
                    serde_json::from_value(frame.clone()).expect("configure frame decodes");
                match decoded {
                    HostToGuest::Configure(args) => *args,
                    other => panic!("not a configure frame: {other:?}"),
                }
            })
            .collect()
    }

    /// The first `configure` frame of the fixtures, with one JSON field replaced.
    fn configure_with(name: &str, value: Value) -> ConfigureArgs {
        let fixtures = fixtures();
        let mut frame = fixtures["hostToGuest"]
            .as_array()
            .expect("hostToGuest is an array")
            .iter()
            .find(|frame| frame["_tag"] == "configure")
            .expect("a configure frame")
            .clone();
        frame[name] = value;
        let decoded: HostToGuest = serde_json::from_value(frame).expect("configure frame decodes");
        match decoded {
            HostToGuest::Configure(args) => *args,
            other => panic!("not a configure frame: {other:?}"),
        }
    }

    #[test]
    fn box_env_writes_exactly_the_pinned_names() {
        let fixtures = fixtures();
        let pinned: BTreeSet<String> = fixtures["boxEnv"]
            .as_object()
            .expect("boxEnv is an object")
            .values()
            .map(|name| name.as_str().expect("name is a string").to_string())
            .collect();
        let token_name = fixtures["boxEnv"]["enrollToken"]
            .as_str()
            .expect("enrollToken name");
        let frames = configure_frames(&fixtures);
        let with_token = frames
            .iter()
            .find(|a| a.enroll_token.is_some())
            .expect("configure frame with a token");
        let without = frames
            .iter()
            .find(|a| a.enroll_token.is_none())
            .expect("configure frame without a token");
        let socket = "/run/kestrel-guest/box.sock";
        let data_dir = "/var/lib/kestrel/box";

        let content = box_env_content(with_token, socket, data_dir);
        assert_eq!(written_names(&content), pinned);

        let mut expected = pinned;
        expected.remove(token_name);
        let content = box_env_content(without, socket, data_dir);
        assert_eq!(written_names(&content), expected);
    }

    /// An empty scratch directory under the system temp dir.
    fn scratch(name: &str) -> PathBuf {
        let dir =
            env::temp_dir().join(format!("kestrel-guest-agent-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("create scratch dir");
        dir
    }

    fn dry_run_config(volume: &Path) -> Config {
        let args = [
            "--dry-run-system",
            "--volume-mount",
            volume.to_str().expect("utf-8 path"),
        ];
        match parse(args.map(str::to_string)).expect("valid args") {
            Parsed::Run(cfg) => *cfg,
            Parsed::Help => panic!("parse returned help"),
        }
    }

    fn network(depcache: Option<&str>) -> GuestNetwork {
        GuestNetwork {
            address: "10.77.0.5/32".into(),
            gateway: "10.77.0.1".into(),
            ipv6_address: None,
            ipv6_gateway: None,
            dns: vec![],
            depcache_url: depcache.map(str::to_string),
            nix_cache_url: None,
            nix_cache_public_key: None,
        }
    }

    fn current_owner() -> Owner {
        // SAFETY: getuid and getgid take no arguments and cannot fail.
        Owner {
            uid: unsafe { libc::getuid() },
            gid: unsafe { libc::getgid() },
        }
    }

    fn mode_of(path: &Path) -> u32 {
        fs::metadata(path).expect("stat").permissions().mode() & 0o777
    }

    /// The box owns its home and can plant links in it. Writing a config must not follow them out of the home, and
    /// must not change the mode or owner of what they point at. The owner is the real one, so the chown path runs.
    #[test]
    fn box_files_never_write_through_a_link() {
        let root = scratch("box-links");
        let volume = root.join("volume");
        let home = volume.join("home");
        let outside = root.join("outside");
        fs::create_dir_all(&home).expect("create home");
        fs::create_dir_all(&outside).expect("create outside");
        let victim = outside.join("victim");
        fs::write(&victim, "keep").expect("write victim");
        fs::set_permissions(&victim, fs::Permissions::from_mode(0o600)).expect("chmod victim");
        symlink(&outside, home.join(".cargo")).expect("plant dir link");
        symlink(&outside, home.join(".config")).expect("plant nested dir link");
        symlink(&victim, home.join(".npmrc")).expect("plant file link");
        symlink(&victim, home.join("..npmrc.tmp")).expect("plant temp link");

        let cfg = dry_run_config(&volume);
        write_box_files(
            &cfg,
            Some(current_owner()),
            &network(Some("https://depcache.example")),
        )
        .expect("write box files");

        assert_eq!(fs::read_to_string(&victim).expect("read victim"), "keep");
        assert_eq!(mode_of(&victim), 0o600);
        assert!(!outside.join("config.toml").exists());
        assert!(!outside.join("pip").exists());
        assert!(fs::symlink_metadata(home.join(".cargo"))
            .expect("stat .cargo")
            .is_dir());
        assert!(home.join(".cargo/config.toml").is_file());
        assert!(home.join(".config/pip/pip.conf").is_file());
        assert!(fs::symlink_metadata(home.join(".npmrc"))
            .expect("stat .npmrc")
            .file_type()
            .is_file());
    }

    #[test]
    fn swap_listed_matches_only_the_named_device() {
        let proc_swaps = "Filename\t\t\t\tType\t\tSize\t\tUsed\t\tPriority\n/dev/vdb\t\t\t\tpartition\t1048572\t\t0\t\t-2\n";
        assert!(swap_listed(proc_swaps, Path::new("/dev/vdb")));
        assert!(!swap_listed(proc_swaps, Path::new("/dev/vdc")));
        assert!(!swap_listed("Filename\tType\n", Path::new("Filename")));
    }

    /// Any data in a disk's first MiB (a partition table or a filesystem superblock) makes it not blank, so it is never
    /// formatted.
    #[test]
    fn only_a_zeroed_first_mebibyte_counts_as_blank() {
        let root = scratch("blank-disk");
        let disk = root.join("disk");
        fs::write(&disk, vec![0u8; 2 << 20]).expect("write blank disk");
        assert!(device_is_blank(&disk).expect("probe blank disk"));
        // The ext4 superblock magic (0xEF53) at byte 1080.
        let mut used = vec![0u8; 2 << 20];
        used[1080] = 0x53;
        used[1081] = 0xEF;
        fs::write(&disk, used).expect("write used disk");
        assert!(!device_is_blank(&disk).expect("probe used disk"));
        let _ = fs::remove_dir_all(&root);
    }

    /// Dropping a config removes the link the box may have planted, never the file it points at.
    #[test]
    fn removing_a_config_removes_the_link_not_its_target() {
        let root = scratch("box-remove");
        let volume = root.join("volume");
        let home = volume.join("home");
        let outside = root.join("outside");
        fs::create_dir_all(&home).expect("create home");
        fs::create_dir_all(&outside).expect("create outside");
        let victim = outside.join("victim");
        fs::write(&victim, "keep").expect("write victim");
        symlink(&victim, home.join(".npmrc")).expect("plant file link");

        let cfg = dry_run_config(&volume);
        write_box_files(&cfg, Some(current_owner()), &network(None)).expect("write box files");

        let gone = fs::symlink_metadata(home.join(".npmrc")).expect_err("link removed");
        assert_eq!(gone.kind(), ErrorKind::NotFound);
        assert_eq!(fs::read_to_string(&victim).expect("read victim"), "keep");
    }

    /// `EnvValue` values land unquoted in the env file: visible ASCII without quotes, backslashes, or spaces. `$`, `&`
    /// and `;` are in the contract's set.
    #[test]
    fn env_values_follow_the_contract() {
        let fine = configure_with("controlUrl", json!("https://ctl.example:8443/a?b=c&d=$e;f"));
        assert!(validate(&fine).is_ok());
        for value in ["https://box example", "box'id", "box\"id", "a\\b", ""] {
            assert!(
                validate(&configure_with("publicUrl", json!(value))).is_err(),
                "{value:?} must be refused"
            );
        }
    }

    #[test]
    fn enroll_token_is_exactly_43_base64url_characters() {
        assert!(validate(&configure_with("enrollToken", json!("x".repeat(43)))).is_ok());
        assert!(validate(&configure_with("enrollToken", json!("x".repeat(42)))).is_err());
        assert!(validate(&configure_with(
            "enrollToken",
            json!(format!("{}+", "x".repeat(42)))
        ))
        .is_err());
    }

    /// `enrolled` removes the token line and nothing else, so the secret is no longer kept on the volume.
    #[test]
    fn enrolled_drops_the_token_line_only() {
        let root = scratch("enrolled");
        let volume = root.join("volume");
        fs::create_dir_all(&volume).expect("create volume");
        let cfg = dry_run_config(&volume);
        let token_name = fixtures()["boxEnv"]["enrollToken"]
            .as_str()
            .expect("enrollToken name")
            .to_string();
        let with_token = configure_with("enrollToken", json!("x".repeat(43)));
        let token = with_token.enroll_token.clone().expect("token");
        let content = box_env_content(
            &with_token,
            "/run/kestrel-guest/box.sock",
            "/var/lib/kestrel/box",
        );
        fs::write(&cfg.box_env_file, &content).expect("write env");

        drop_enroll_token(&cfg).expect("drop token");

        let kept = fs::read_to_string(&cfg.box_env_file).expect("read env");
        let prefix = format!("{token_name}=");
        let expected: String = content
            .split_inclusive('\n')
            .filter(|line| !line.starts_with(&prefix))
            .collect();
        assert_eq!(kept, expected);
        assert!(!kept.contains(&token));
        let _ = fs::remove_dir_all(&root);
    }
}
