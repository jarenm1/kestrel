//! Filesystem primitives for point-in-time copies and change detection: reflinks (FICLONE), the physical extent map
//! (FIEMAP) and data regions (SEEK_DATA/SEEK_HOLE).
//!
//! Two files that map a logical range to the same physical extents hold identical bytes there, because copy-on-write
//! never rewrites a block that another file references. So a chunk whose physical mapping in the new snapshot equals its
//! mapping in the baseline is unchanged. This is stricter than the shared flag alone, which only says "referenced twice".

use std::fs::{self, File};
use std::io;
use std::os::fd::AsRawFd;
use std::path::Path;

use anyhow::{Context, Result};

use crate::manifest::CHUNK_SIZE;

const FICLONE: libc::c_ulong = 0x4004_9409;
const FS_IOC_FIEMAP: libc::c_ulong = 0xC020_660B;
const FIEMAP_FLAG_SYNC: u32 = 0x1;
const FIEMAP_EXTENT_LAST: u32 = 0x1;
const EXTENTS_PER_CALL: usize = 512;

#[repr(C)]
#[derive(Default, Clone, Copy)]
struct FiemapExtent {
    logical: u64,
    physical: u64,
    length: u64,
    reserved: [u64; 2],
    flags: u32,
    reserved2: [u32; 3],
}

#[repr(C)]
struct FiemapHeader {
    start: u64,
    length: u64,
    flags: u32,
    mapped_extents: u32,
    extent_count: u32,
    reserved: u32,
}

/// Physical mapping of one piece of a chunk, relative to the chunk start: `(offset in chunk, physical, length)`.
pub type Piece = (u64, u64, u64);

/// Creates `dst` as a reflink of `src`: a copy-on-write clone the filesystem makes atomically, so it is a point-in-time
/// image even while the guest writes to `src`. A filesystem without reflinks is an error rather than a copy, because a
/// copy of a live image can tear across concurrent writes.
pub fn snapshot(src: &Path, dst: &Path) -> Result<()> {
    let src_file = File::open(src).with_context(|| format!("opening {}", src.display()))?;
    let dst_file = File::create(dst).with_context(|| format!("creating {}", dst.display()))?;
    // SAFETY: FICLONE takes a source file descriptor and no pointers.
    let rc = unsafe { libc::ioctl(dst_file.as_raw_fd(), FICLONE as _, src_file.as_raw_fd()) };
    if rc == 0 {
        return Ok(());
    }
    let err = io::Error::last_os_error();
    drop(dst_file);
    fs::remove_file(dst).ok();
    Err(err).with_context(|| {
        format!(
            "reflinking {} to {}: the volume and its state directory must be on one reflink filesystem (XFS or btrfs)",
            src.display(),
            dst.display()
        )
    })
}

/// Every physical extent of `file`, sorted by logical offset.
fn fiemap(file: &File) -> Result<Vec<FiemapExtent>> {
    let mut out = Vec::new();
    let mut start = 0u64;
    let fd = file.as_raw_fd();
    loop {
        // The buffer is u64-backed so the header and the extents that follow it are aligned.
        let bytes = std::mem::size_of::<FiemapHeader>()
            + EXTENTS_PER_CALL * std::mem::size_of::<FiemapExtent>();
        let mut aligned = vec![0u64; bytes.div_ceil(8)];
        let header = aligned.as_mut_ptr() as *mut FiemapHeader;
        // SAFETY: `aligned` holds at least `bytes` zeroed bytes; the header is written at its start.
        unsafe {
            header.write(FiemapHeader {
                start,
                length: u64::MAX - start,
                flags: FIEMAP_FLAG_SYNC,
                mapped_extents: 0,
                extent_count: EXTENTS_PER_CALL as u32,
                reserved: 0,
            });
        }
        // SAFETY: FS_IOC_FIEMAP reads and writes the fiemap structure we just laid out in `aligned`.
        let rc = unsafe { libc::ioctl(fd, FS_IOC_FIEMAP as _, header) };
        if rc != 0 {
            return Err(io::Error::last_os_error()).context("FIEMAP");
        }
        // SAFETY: the kernel wrote `mapped_extents` valid extents directly after the header.
        let (mapped, extents) = unsafe {
            let header = &*header;
            let base = (header as *const FiemapHeader).add(1) as *const FiemapExtent;
            let n = header.mapped_extents as usize;
            (n, std::slice::from_raw_parts(base, n).to_vec())
        };
        if mapped == 0 {
            return Ok(out);
        }
        let last = extents
            .last()
            .is_some_and(|e| e.flags & FIEMAP_EXTENT_LAST != 0);
        let last_end = extents
            .last()
            .map(|e| e.logical + e.length)
            .unwrap_or(start);
        out.extend(extents);
        if last {
            return Ok(out);
        }
        start = last_end;
    }
}

/// For each chunk of a `size`-byte file, the physical pieces that back it. A hole has no pieces.
pub fn chunk_signatures(file: &File, size: u64) -> Result<Vec<Vec<Piece>>> {
    let chunks = size.div_ceil(CHUNK_SIZE) as usize;
    let mut sigs: Vec<Vec<Piece>> = vec![Vec::new(); chunks];
    for extent in fiemap(file)? {
        let ext_end = extent.logical + extent.length;
        let first = (extent.logical / CHUNK_SIZE) as usize;
        let last = ((ext_end.saturating_sub(1)) / CHUNK_SIZE) as usize;
        for (index, sig) in sigs
            .iter_mut()
            .enumerate()
            .take(last.min(chunks.saturating_sub(1)) + 1)
            .skip(first)
        {
            let chunk_start = index as u64 * CHUNK_SIZE;
            let start = extent.logical.max(chunk_start);
            let end = ext_end.min(chunk_start + CHUNK_SIZE).min(size);
            if end <= start {
                continue;
            }
            sig.push((
                start - chunk_start,
                extent.physical + (start - extent.logical),
                end - start,
            ));
        }
    }
    Ok(sigs)
}

/// Indices of chunks that contain data (not a hole). Zero-filled data still counts; the backup checks content.
pub fn data_chunks(file: &File, size: u64) -> Result<Vec<usize>> {
    let fd = file.as_raw_fd();
    let mut chunks = Vec::new();
    let mut pos: libc::off_t = 0;
    let end = size as libc::off_t;
    while pos < end {
        // SAFETY: lseek only reads the descriptor and offset.
        let data = unsafe { libc::lseek(fd, pos, libc::SEEK_DATA) };
        if data < 0 {
            let err = io::Error::last_os_error();
            if err.raw_os_error() == Some(libc::ENXIO) {
                break;
            }
            return Err(err).context("SEEK_DATA");
        }
        if data >= end {
            break;
        }
        // SAFETY: as above.
        let hole = unsafe { libc::lseek(fd, data, libc::SEEK_HOLE) };
        if hole < 0 {
            return Err(io::Error::last_os_error()).context("SEEK_HOLE");
        }
        let hole = hole.min(end);
        let first = data as u64 / CHUNK_SIZE;
        let last = (hole as u64 - 1) / CHUNK_SIZE;
        chunks.extend(first..=last);
        pos = hole;
    }
    chunks.dedup();
    Ok(chunks.into_iter().map(|c| c as usize).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Seek, SeekFrom, Write};

    #[test]
    fn data_chunks_skip_holes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sparse");
        let mut file = File::create(&path).unwrap();
        let size = CHUNK_SIZE * 3;
        file.set_len(size).unwrap();
        file.seek(SeekFrom::Start(CHUNK_SIZE + 10)).unwrap();
        file.write_all(b"x").unwrap();
        file.sync_all().unwrap();
        let file = File::open(&path).unwrap();
        assert_eq!(data_chunks(&file, size).unwrap(), vec![1]);
    }

    /// Needs a reflink filesystem (btrfs, XFS): run with `cargo test -- --ignored`.
    #[test]
    #[ignore = "needs a reflink filesystem (btrfs/XFS); run with --ignored"]
    fn reflink_shares_extents_and_a_rewrite_changes_them() {
        use std::fs::OpenOptions;
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("src");
        fs::write(&src, vec![5u8; CHUNK_SIZE as usize]).unwrap();
        let cloned = dir.path().join("clone");
        snapshot(&src, &cloned).unwrap();
        let src_sig = chunk_signatures(&File::open(&src).unwrap(), CHUNK_SIZE).unwrap();
        let clone_sig = chunk_signatures(&File::open(&cloned).unwrap(), CHUNK_SIZE).unwrap();
        assert_eq!(src_sig, clone_sig);
        let mut edit = OpenOptions::new().write(true).open(&cloned).unwrap();
        edit.write_all(b"changed").unwrap();
        edit.sync_all().unwrap();
        let edited = chunk_signatures(&File::open(&cloned).unwrap(), CHUNK_SIZE).unwrap();
        assert_ne!(edited, src_sig);
        assert_eq!(
            fs::read(&src).unwrap(),
            vec![5u8; CHUNK_SIZE as usize],
            "a rewrite of the clone reached the source"
        );
    }
}
