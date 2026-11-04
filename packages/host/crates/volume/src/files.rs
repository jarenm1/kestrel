//! Local state files: written whole, fsynced, renamed into place and the directory fsynced, so a crash leaves the old
//! file or the new one.

use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, anyhow};

pub fn write_file_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    let tmp = suffixed(path, ".tmp");
    let mut file = File::create(&tmp).with_context(|| format!("creating {}", tmp.display()))?;
    file.write_all(bytes)?;
    file.sync_all()?;
    drop(file);
    fs::rename(&tmp, path).with_context(|| format!("renaming into {}", path.display()))?;
    let parent = path
        .parent()
        .ok_or_else(|| anyhow!("{} has no directory", path.display()))?;
    File::open(parent)?.sync_all()?;
    Ok(())
}

/// `path` with `suffix` appended to its file name.
pub fn suffixed(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(suffix);
    PathBuf::from(name)
}
