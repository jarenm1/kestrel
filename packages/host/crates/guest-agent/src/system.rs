//! Every OS side effect of the agent: commands, mounts, files, ownership, clock, sync. With `dry_run` set, the calls
//! that change the machine (commands, clock, sysfs writes, chown) are logged instead of executed. Config files under
//! the paths the agent was given are still written, so a dry run shows what would be configured.

use std::ffi::CString;
use std::fs;
use std::io::Write;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::Path;
use std::time::{Duration, Instant};

use tokio::process::Command;

pub type Res<T> = Result<T, String>;

pub fn log(message: impl AsRef<str>) {
    eprintln!("kestrel-guest-agent: {}", message.as_ref());
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Owner {
    pub uid: u32,
    pub gid: u32,
}

#[derive(Clone, Copy, Debug)]
pub struct System {
    pub dry_run: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MountEntry {
    pub mount_point: String,
    pub fs_type: String,
    pub source: String,
    pub super_opts: String,
}

impl System {
    /// Run a command and fail on a non-zero exit. Dry run logs the command line only.
    pub async fn run(&self, program: &str, args: &[&str]) -> Res<()> {
        let line = format!("{program} {}", args.join(" "));
        if self.dry_run {
            log(format!("[dry-run] {line}"));
            return Ok(());
        }
        let out = Command::new(program)
            .args(args)
            .output()
            .await
            .map_err(|e| format!("`{line}`: {e}"))?;
        if out.status.success() {
            Ok(())
        } else {
            Err(format!(
                "`{line}` exited with {}: {}",
                out.status,
                String::from_utf8_lossy(&out.stderr).trim()
            ))
        }
    }

    /// Run a command and return its exit code and stdout, without failing on non-zero exits.
    pub async fn probe(&self, program: &str, args: &[&str]) -> Res<(Option<i32>, String)> {
        let out = Command::new(program)
            .args(args)
            .output()
            .await
            .map_err(|e| format!("`{program}`: {e}"))?;
        Ok((
            out.status.code(),
            String::from_utf8_lossy(&out.stdout).into_owned(),
        ))
    }

    pub fn set_realtime(&self, wall_clock_ms: u64) -> Res<()> {
        if self.dry_run {
            log(format!(
                "[dry-run] clock_settime CLOCK_REALTIME {wall_clock_ms}ms"
            ));
            return Ok(());
        }
        let ts = libc::timespec {
            tv_sec: (wall_clock_ms / 1000) as libc::time_t,
            tv_nsec: ((wall_clock_ms % 1000) * 1_000_000) as libc::c_long,
        };
        // SAFETY: `ts` is a valid timespec for the duration of the call.
        if unsafe { libc::clock_settime(libc::CLOCK_REALTIME, &ts) } < 0 {
            return Err(format!(
                "clock_settime: {}",
                std::io::Error::last_os_error()
            ));
        }
        Ok(())
    }

    /// Write a value into a sysfs/procfs knob (e.g. `/proc/sys/vm/drop_caches`). Dry run logs it.
    pub fn write_knob(&self, path: &str, value: &str) -> Res<()> {
        if self.dry_run {
            log(format!("[dry-run] echo {value} > {path}"));
            return Ok(());
        }
        fs::write(path, value).map_err(|e| format!("write {path}: {e}"))
    }
}

/// `sync(2)`: flush every filesystem. It can block for a long time on a busy disk, so it runs on the blocking pool.
/// Harmless in a dry run, so it always runs.
pub async fn sync_all() -> Res<()> {
    tokio::task::spawn_blocking(|| {
        // SAFETY: sync(2) takes no arguments and cannot fail.
        unsafe { libc::sync() }
    })
    .await
    .map_err(|e| format!("sync: {e}"))
}

pub fn mountinfo() -> Res<Vec<MountEntry>> {
    let text =
        fs::read_to_string("/proc/self/mountinfo").map_err(|e| format!("read mountinfo: {e}"))?;
    text.lines().map(parse_mountinfo_line).collect()
}

fn parse_mountinfo_line(line: &str) -> Res<MountEntry> {
    let (left, right) = line
        .split_once(" - ")
        .ok_or_else(|| format!("bad mountinfo line {line:?}"))?;
    let mount_point = left
        .split(' ')
        .nth(4)
        .ok_or_else(|| format!("bad mountinfo line {line:?}"))?;
    let mut fields = right.split(' ');
    let fs_type = fields.next().unwrap_or_default();
    let source = fields.next().unwrap_or_default();
    let super_opts = fields.next().unwrap_or_default();
    Ok(MountEntry {
        mount_point: unescape_mount(mount_point),
        fs_type: fs_type.to_string(),
        source: unescape_mount(source),
        super_opts: super_opts.to_string(),
    })
}

/// mountinfo escapes space, tab, newline and backslash as octal `\NNN`.
fn unescape_mount(field: &str) -> String {
    let bytes = field.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'\\' && i + 4 <= bytes.len() {
            let digits = std::str::from_utf8(&bytes[i + 1..i + 4]).unwrap_or("");
            if let Ok(v) = u8::from_str_radix(digits, 8) {
                out.push(v);
                i += 4;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

pub fn is_mount_point(path: &Path) -> Res<bool> {
    let target = path.to_string_lossy();
    Ok(mountinfo()?.iter().any(|m| m.mount_point == target))
}

/// Whether the top-most mount on `path` has `needle` among its superblock options.
pub fn top_mount_has_option(path: &Path, needle: &str) -> Res<bool> {
    let target = path.to_string_lossy();
    let top = mountinfo()?
        .into_iter()
        .rev()
        .find(|m| m.mount_point == target);
    Ok(top.is_some_and(|m| m.super_opts.split(',').any(|o| o == needle)))
}

pub async fn mount_ext4(sys: &System, device: &Path, target: &Path) -> Res<()> {
    sys.run(
        "mount",
        &[
            "-t",
            "ext4",
            "-o",
            "noatime,lazytime,discard",
            &device.to_string_lossy(),
            &target.to_string_lossy(),
        ],
    )
    .await
}

/// `blkid -p` probe: `Some(type)` when the device carries a filesystem, `None` when it has none.
pub async fn probe_fs_type(sys: &System, device: &Path) -> Res<Option<String>> {
    let dev = device.to_string_lossy();
    let (code, stdout) = sys
        .probe("blkid", &["-p", "-o", "value", "-s", "TYPE", &dev])
        .await?;
    match code {
        Some(0) if !stdout.trim().is_empty() => Ok(Some(stdout.trim().to_string())),
        Some(0) | Some(2) => Ok(None),
        other => Err(format!("blkid {dev} exited with {other:?}")),
    }
}

pub async fn wait_for_path(path: &Path, timeout: Duration) -> Res<()> {
    let start = Instant::now();
    while !path.exists() {
        if start.elapsed() > timeout {
            return Err(format!(
                "{} did not appear within {}s",
                path.display(),
                timeout.as_secs()
            ));
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    Ok(())
}

/// Create `path` (and parents) with `mode`, owned by `owner` when given.
pub fn ensure_dir(path: &Path, mode: u32, owner: Option<Owner>) -> Res<()> {
    fs::create_dir_all(path).map_err(|e| format!("mkdir {}: {e}", path.display()))?;
    fs::set_permissions(path, fs::Permissions::from_mode(mode))
        .map_err(|e| format!("chmod {}: {e}", path.display()))?;
    if let Some(owner) = owner {
        chown(path, owner)?;
    }
    Ok(())
}

/// Replace `path` with `content` atomically (temp file in the same directory, then rename).
pub fn write_file(path: &Path, content: &str, mode: u32, owner: Option<Owner>) -> Res<()> {
    let name = path
        .file_name()
        .ok_or_else(|| format!("{} has no file name", path.display()))?
        .to_string_lossy()
        .into_owned();
    let tmp = path.with_file_name(format!(".{name}.tmp"));
    // Remove whatever is there (a leftover or a planted link), then create exclusively: nothing is written through a link.
    remove_if_exists(&tmp)?;
    {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(mode)
            .open(&tmp)
            .map_err(|e| format!("open {}: {e}", tmp.display()))?;
        file.write_all(content.as_bytes())
            .map_err(|e| format!("write {}: {e}", tmp.display()))?;
        file.sync_all()
            .map_err(|e| format!("sync {}: {e}", tmp.display()))?;
    }
    fs::set_permissions(&tmp, fs::Permissions::from_mode(mode))
        .map_err(|e| format!("chmod {}: {e}", tmp.display()))?;
    if let Some(owner) = owner {
        chown(&tmp, owner)?;
    }
    fs::rename(&tmp, path).map_err(|e| format!("rename into {}: {e}", path.display()))
}

/// Remove `path` if it exists.
pub fn remove_if_exists(path: &Path) -> Res<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("remove {}: {e}", path.display())),
    }
}

pub fn chown(path: &Path, owner: Owner) -> Res<()> {
    let c = CString::new(path.as_os_str().as_bytes())
        .map_err(|_| format!("{} has a NUL byte", path.display()))?;
    // SAFETY: `c` is a valid NUL-terminated path for the duration of the call.
    if unsafe { libc::chown(c.as_ptr(), owner.uid, owner.gid) } < 0 {
        return Err(format!(
            "chown {}: {}",
            path.display(),
            std::io::Error::last_os_error()
        ));
    }
    Ok(())
}

pub fn lookup_user(name: &str) -> Res<Owner> {
    let c = CString::new(name).map_err(|_| format!("user {name:?} has a NUL byte"))?;
    // SAFETY: getpwnam returns a pointer into static storage; we copy the ids out immediately.
    let entry = unsafe { libc::getpwnam(c.as_ptr()) };
    if entry.is_null() {
        return Err(format!("no such user {name}"));
    }
    // SAFETY: non-null per the check above.
    let (uid, gid) = unsafe { ((*entry).pw_uid, (*entry).pw_gid) };
    Ok(Owner { uid, gid })
}
