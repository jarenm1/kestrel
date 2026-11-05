//! Local state files: written whole, fsynced, renamed into place and the directory fsynced, so a crash leaves the old
//! file or the new one.

use std::ffi::CString;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::os::fd::AsRawFd;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, anyhow, bail};

/// Replaces `path` with `bytes` through a temp file under a fresh random name, created exclusively, so no existing file
/// is ever opened or truncated. The temp file is fsynced and renamed over `path`; a failure removes only the temp file.
pub fn write_file_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut token = [0u8; 8];
    getrandom::fill(&mut token).map_err(|e| anyhow!("random temp name: {e}"))?;
    let tmp = suffixed(path, &format!(".{}.tmp", hex::encode(token)));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&tmp)
        .with_context(|| format!("creating {}", tmp.display()))?;
    let written = file.write_all(bytes).and_then(|()| file.sync_all());
    drop(file);
    let published = written.map_err(anyhow::Error::from).and_then(|()| {
        fs::rename(&tmp, path).with_context(|| format!("renaming into {}", path.display()))
    });
    if published.is_err() {
        fs::remove_file(&tmp).ok();
    }
    published?;
    sync_parent(path)
}

/// The directory holding `path`; `.` for a bare file name.
fn parent_dir(path: &Path) -> Result<&Path> {
    match path.parent() {
        Some(parent) if parent.as_os_str().is_empty() => Ok(Path::new(".")),
        Some(parent) => Ok(parent),
        None => Err(anyhow!("{} has no directory", path.display())),
    }
}

/// Fsyncs the directory holding `path`, so a rename or link into it survives a crash.
pub fn sync_parent(path: &Path) -> Result<()> {
    File::open(parent_dir(path)?)?.sync_all()?;
    Ok(())
}

/// Creates an unnamed file in the directory of `dest` (`O_TMPFILE`). It has no name until `link_unnamed` gives it one,
/// so a crash leaves nothing behind and no existing file is ever opened or truncated.
pub fn create_unnamed(dest: &Path) -> Result<File> {
    let dir = parent_dir(dest)?;
    OpenOptions::new()
        .read(true)
        .write(true)
        .custom_flags(libc::O_TMPFILE)
        .open(dir)
        .with_context(|| format!("creating a file in {}", dir.display()))
}

/// Gives an unnamed file from `create_unnamed` the name `dest`, failing if `dest` exists, then fsyncs the directory.
pub fn link_unnamed(file: &File, dest: &Path) -> Result<()> {
    let source = CString::new(format!("/proc/self/fd/{}", file.as_raw_fd()))?;
    let target = CString::new(dest.as_os_str().as_bytes())?;
    // SAFETY: both arguments are NUL-terminated strings that live across the call. `AT_SYMLINK_FOLLOW` makes `linkat`
    // follow the `/proc/self/fd` link to the unnamed inode.
    let rc = unsafe {
        libc::linkat(
            libc::AT_FDCWD,
            source.as_ptr(),
            libc::AT_FDCWD,
            target.as_ptr(),
            libc::AT_SYMLINK_FOLLOW,
        )
    };
    if rc != 0 {
        return Err(std::io::Error::last_os_error())
            .with_context(|| format!("linking {}", dest.display()));
    }
    sync_parent(dest)
}

/// `path` with `suffix` appended to its file name.
pub fn suffixed(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(suffix);
    PathBuf::from(name)
}

/// An exclusive `flock` on a lock file, held until the value is dropped. Each open file description contends, so two
/// processes, or two opens in one process, exclude each other. A crash releases the lock.
pub struct FileLock {
    /// Held open so the lock lasts until this value is dropped.
    _file: File,
}

impl FileLock {
    /// Waits until the lock is free.
    pub fn acquire(path: &Path) -> Result<Self> {
        Self::lock(path, libc::LOCK_EX)
    }

    /// Fails at once when another holder has the lock.
    pub fn try_acquire(path: &Path) -> Result<Self> {
        Self::lock(path, libc::LOCK_EX | libc::LOCK_NB)
    }

    fn lock(path: &Path, operation: libc::c_int) -> Result<Self> {
        let file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(path)
            .with_context(|| format!("opening {}", path.display()))?;
        // SAFETY: `flock` takes a valid descriptor and an operation flag, and touches no memory.
        let rc = unsafe { libc::flock(file.as_raw_fd(), operation) };
        if rc != 0 {
            let err = std::io::Error::last_os_error();
            if err.kind() == std::io::ErrorKind::WouldBlock {
                bail!("{} is held by another process", path.display());
            }
            return Err(err).with_context(|| format!("locking {}", path.display()));
        }
        Ok(Self { _file: file })
    }
}
