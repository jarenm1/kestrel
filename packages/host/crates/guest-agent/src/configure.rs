//! `configure`: makes a fresh clone or a restored VM this box's VM. Steps the clock, regenerates the machine id,
//! applies the network, sets up swap and the user volume, stacks the Nix store overlay on the volume, writes the
//! box's package configs and environment, then starts the box and waits for its health check.

use std::fs;
use std::net::{Ipv4Addr, Ipv6Addr};
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::args::Config;
use crate::http::wait_healthy;
use crate::protocol::{ConfigureArgs, GuestNetwork, NEST_BOX_ENV, NEST_VOLUME_SERIAL};
use crate::system::{
    ensure_dir, is_mount_point, log, lookup_user, mount_ext4, mountinfo, probe_fs_type,
    remove_if_exists, top_mount_has_option, wait_for_path, write_file, Res, System,
};

const DISK_WAIT: Duration = Duration::from_secs(60);
const HEALTH_WAIT: Duration = Duration::from_secs(50);

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
            wait_for_path(&cfg.volume_device, DISK_WAIT),
            wait_for_path(&cfg.swap_device, DISK_WAIT)
        )?;
    }
    setup_swap(cfg, sys).await?;
    mount_volume(cfg, sys).await?;
    stack_nix_store(cfg, sys).await?;
    write_box_files(cfg, sys, &args.network).await?;
    let changed = write_box_env(cfg, args)?;
    sys.run(
        "systemctl",
        &[
            if changed { "restart" } else { "start" },
            cfg.box_unit.as_str(),
        ],
    )
    .await?;
    wait_healthy(&cfg.box_health_url, HEALTH_WAIT).await
}

/// Reject anything that would reach a command line or an env file in a form we did not intend.
fn validate(args: &ConfigureArgs) -> Res<()> {
    if !is_clone_id(&args.clone_id) {
        return Err("cloneId must be 32 lowercase hex characters".into());
    }
    for (name, value) in [
        ("hostId", &args.host_id),
        ("boxId", &args.box_id),
        ("vmId", &args.vm_id),
        ("controlUrl", &args.control_url),
        ("publicUrl", &args.public_url),
    ] {
        env_value(name, value)?;
    }
    if let Some(token) = &args.enroll_token {
        env_value("enrollToken", token)?;
    }
    let net = &args.network;
    cidr_v4(&net.address)?;
    ipv4(&net.gateway)?;
    if net.dns.is_empty() {
        return Err("network.dns lists no resolver".into());
    }
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
    // A swap device from an earlier configure is still active on a re-configured VM; the new disk replaces it.
    if let Err(e) = sys.run("swapoff", &[swap]).await {
        log(format!("swapoff (ignored): {e}"));
    }
    sys.run("mkswap", &["-q", swap]).await?;
    sys.run("swapon", &[swap]).await
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
                let device = path_str(&cfg.volume_device)?;
                sys.run("mkfs.ext4", &["-q", "-F", "-L", NEST_VOLUME_SERIAL, device])
                    .await?;
            }
        }
    }
    ensure_dir(mount, 0o755, None)?;
    mount_ext4(sys, &cfg.volume_device, mount).await
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

async fn write_box_files(cfg: &Config, sys: &System, net: &GuestNetwork) -> Res<()> {
    let owner = if sys.dry_run {
        None
    } else {
        Some(lookup_user(&cfg.box_user)?)
    };
    let home = cfg.box_home();
    ensure_dir(&home, 0o750, owner)?;
    ensure_dir(&cfg.data_dir(), 0o750, owner)?;
    for (rel, content) in package_configs(net) {
        let mut dir: PathBuf = home.clone();
        if let Some(parent) = Path::new(rel).parent() {
            for component in parent.components() {
                dir.push(component.as_os_str());
                ensure_dir(&dir, 0o755, owner)?;
            }
        }
        let path = home.join(rel);
        match content {
            Some(content) => write_file(&path, &content, 0o644, owner)?,
            None => remove_if_exists(&path)?,
        }
    }
    Ok(())
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

fn path_str(path: &Path) -> Res<&str> {
    path.to_str()
        .ok_or_else(|| format!("{} is not valid UTF-8", path.display()))
}
#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use serde_json::Value;

    use super::*;
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
}
