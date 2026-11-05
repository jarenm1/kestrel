//! Local state files: written whole, fsynced, renamed into place and the directory fsynced, so a crash leaves the old
//! file or the new one.

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::os::fd::AsRawFd;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, anyhow, bail};

pub fn write_file_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    let tmp = suffixed(path, ".tmp");
    let mut file = File::create(&tmp).with_context(|| format!("creating {}", tmp.display()))?;
    file.write_all(bytes)?;
    file.sync_all()?;
    drop(file);
    fs::rename(&tmp, path).with_context(|| format!("renaming into {}", path.display()))?;
    sync_parent(path)
}

/// Fsyncs the directory holding `path`, so a rename into it survives a crash.
pub fn sync_parent(path: &Path) -> Result<()> {
    let parent = match path.parent() {
        Some(parent) if parent.as_os_str().is_empty() => Path::new("."),
        Some(parent) => parent,
        None => return Err(anyhow!("{} has no directory", path.display())),
    };
    File::open(parent)?.sync_all()?;
    Ok(())
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
