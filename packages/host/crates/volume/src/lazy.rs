//! `restore-lazy`: serves a backed-up volume as a ublk block device at once, fetching chunks on first access.
//!
//! `dest` is sparse until a chunk is fetched. A bitmap next to it records which chunks are present, so a
//! restart resumes instead of refetching. A background hydrator fetches the rest in order.

use std::fs::{self, File, OpenOptions};
use std::os::unix::fs::FileExt;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::thread;
use std::time::Duration;

use anyhow::{Context, Result, anyhow, ensure};
use libublk::ctrl::{UblkCtrl, UblkCtrlBuilder};
use libublk::io::{BufDesc, UblkDev, UblkIOCtx, UblkQueue};
use libublk::{UblkError, UblkFlags, UblkIORes, sys};
use sha2::{Digest, Sha256};

use crate::backup::{chunk_len, fetch_chunk};
use crate::crypto::BoxKey;
use crate::files::{suffixed, write_file_atomic};
use crate::manifest::{CHUNK_SIZE, Manifest, check_ref};
use crate::store::Store;

const QUEUES: u16 = 4;
const QUEUE_DEPTH: u16 = 64;
const IO_BUF_BYTES: u32 = 1024 * 1024;
const HYDRATE_RETRY: Duration = Duration::from_secs(2);
const POLL: Duration = Duration::from_millis(100);
const BITMAP_SUFFIX: &str = ".bitmap";
const IDENTITY_LEN: usize = 32;

struct Volume {
    store: Box<dyn Store>,
    box_id: String,
    key: BoxKey,
    manifest: Manifest,
    file: File,
    bitmap_path: PathBuf,
    identity: Vec<u8>,
    present: Mutex<Vec<bool>>,
    chunk_locks: Vec<Mutex<()>>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Binds the bitmap to one box and one manifest, so it cannot be applied to another restore.
fn identity(box_id: &str, volume_ref: &str) -> Vec<u8> {
    Sha256::digest(format!("{box_id}\n{volume_ref}")).to_vec()
}

fn encode_bitmap(identity: &[u8], present: &[bool]) -> Vec<u8> {
    let mut bytes = identity.to_vec();
    bytes.resize(IDENTITY_LEN + present.len().div_ceil(8), 0);
    for (index, is_present) in present.iter().enumerate() {
        if *is_present {
            bytes[IDENTITY_LEN + index / 8] |= 1 << (index % 8);
        }
    }
    bytes
}

fn decode_bitmap(bytes: &[u8], identity: &[u8], chunks: usize) -> Result<Vec<bool>> {
    ensure!(
        bytes.len() == IDENTITY_LEN + chunks.div_ceil(8) && &bytes[..IDENTITY_LEN] == identity,
        "the bitmap belongs to a different restore"
    );
    Ok((0..chunks)
        .map(|index| bytes[IDENTITY_LEN + index / 8] & (1 << (index % 8)) != 0)
        .collect())
}

impl Volume {
    fn open(
        volume_ref: &str,
        box_id: &str,
        store: Box<dyn Store>,
        key: BoxKey,
        dest: &Path,
    ) -> Result<Self> {
        let bytes = store
            .get(volume_ref)?
            .ok_or_else(|| anyhow!("manifest {volume_ref} is missing"))?;
        let manifest = Manifest::parse(&bytes, box_id)?;
        let chunks = manifest.chunks.len();
        let identity = identity(box_id, volume_ref);
        let bitmap_path = suffixed(dest, BITMAP_SUFFIX);

        let (file, present) = if dest.exists() {
            let bitmap = fs::read(&bitmap_path)
                .with_context(|| format!("reading {}", bitmap_path.display()))?;
            let present = decode_bitmap(&bitmap, &identity, chunks)?;
            let file = OpenOptions::new()
                .read(true)
                .write(true)
                .open(dest)
                .with_context(|| format!("opening {}", dest.display()))?;
            ensure!(
                file.metadata()?.len() == manifest.size_bytes,
                "{} is not {} bytes",
                dest.display(),
                manifest.size_bytes
            );
            (file, present)
        } else {
            let present = vec![false; chunks];
            write_file_atomic(&bitmap_path, &encode_bitmap(&identity, &present))?;
            let file = OpenOptions::new()
                .read(true)
                .write(true)
                .create_new(true)
                .open(dest)
                .with_context(|| format!("creating {}", dest.display()))?;
            file.set_len(manifest.size_bytes)?;
            (file, present)
        };

        Ok(Self {
            store,
            box_id: box_id.to_owned(),
            key,
            manifest,
            file,
            bitmap_path,
            identity,
            present: Mutex::new(present),
            chunk_locks: (0..chunks).map(|_| Mutex::new(())).collect(),
        })
    }

    fn chunk_count(&self) -> usize {
        self.manifest.chunks.len()
    }

    fn is_present(&self, index: usize) -> bool {
        lock(&self.present)[index]
    }

    /// Makes chunk `index` present in `dest`, fetching and authenticating it on first use.
    /// A null chunk is zeros, which the sparse file already holds.
    fn ensure(&self, index: usize) -> Result<()> {
        if self.is_present(index) {
            return Ok(());
        }
        let _fetching = lock(&self.chunk_locks[index]);
        if self.is_present(index) {
            return Ok(());
        }
        if let Some(name) = &self.manifest.chunks[index] {
            let len = chunk_len(self.manifest.size_bytes, index);
            let plaintext = fetch_chunk(self.store.as_ref(), &self.box_id, &self.key, name, len)?;
            self.file
                .write_all_at(&plaintext, index as u64 * CHUNK_SIZE)?;
            self.file.sync_data()?;
        }
        self.mark_present(index)
    }

    fn mark_present(&self, index: usize) -> Result<()> {
        let mut present = lock(&self.present);
        present[index] = true;
        write_file_atomic(&self.bitmap_path, &encode_bitmap(&self.identity, &present))
    }

    fn ensure_range(&self, offset: u64, len: usize) -> Result<()> {
        if len == 0 {
            return Ok(());
        }
        let end = offset + len as u64;
        ensure!(
            end <= self.manifest.size_bytes,
            "I/O at {offset} runs past the end of the volume"
        );
        for index in (offset / CHUNK_SIZE)..=((end - 1) / CHUNK_SIZE) {
            self.ensure(index as usize)?;
        }
        Ok(())
    }

    fn read(&self, offset: u64, buf: &mut [u8]) -> Result<()> {
        self.ensure_range(offset, buf.len())?;
        self.file.read_exact_at(buf, offset)?;
        Ok(())
    }

    fn write(&self, offset: u64, buf: &[u8]) -> Result<()> {
        self.ensure_range(offset, buf.len())?;
        self.file.write_all_at(buf, offset)?;
        Ok(())
    }
}

/// Fetches every absent chunk in order. A failed fetch is retried until the volume is stopped.
fn hydrate(volume: &Volume, stop: &AtomicBool) {
    let mut index = 0;
    while index < volume.chunk_count() && !stop.load(Ordering::Relaxed) {
        match volume.ensure(index) {
            Ok(()) => index += 1,
            Err(e) => {
                eprintln!("kestrel-volume: fetching chunk {index} failed, retrying: {e:#}");
                thread::sleep(HYDRATE_RETRY);
            }
        }
    }
}

/// Runs one I/O against the volume and returns the ublk result: bytes transferred, or a negative errno.
fn perform(volume: &Volume, op: u32, offset: u64, buf: &mut [u8]) -> i32 {
    let outcome = match op {
        sys::UBLK_IO_OP_READ => volume.read(offset, buf),
        sys::UBLK_IO_OP_WRITE => volume.write(offset, buf),
        sys::UBLK_IO_OP_FLUSH => volume.file.sync_data().map_err(Into::into),
        _ => return -libc::EOPNOTSUPP,
    };
    match outcome {
        Ok(()) => buf.len() as i32,
        Err(e) => {
            eprintln!("kestrel-volume: op {op} at offset {offset} failed: {e:#}");
            -libc::EIO
        }
    }
}

fn serve_queue(qid: u16, dev: &UblkDev, volume: Arc<Volume>) {
    let bufs = Rc::new(dev.alloc_queue_io_bufs());
    let queue = match UblkQueue::new(qid, dev).and_then(|q| {
        q.submit_fetch_commands_unified(libublk::io::BufDescList::Slices(Some(&bufs)))
    }) {
        Ok(queue) => queue,
        Err(e) => {
            eprintln!("kestrel-volume: starting queue {qid} failed: {e}");
            return;
        }
    };
    let handler = move |q: &UblkQueue, tag: u16, _io: &UblkIOCtx| {
        let iod = q.get_iod(tag);
        let op = iod.op_flags & 0xff;
        let offset = iod.start_sector << 9;
        let len = (iod.nr_sectors as usize) << 9;
        let buf = &bufs[tag as usize];
        let res = if len > buf.len() {
            -libc::EINVAL
        } else {
            // SAFETY: ublk hands this tag to the target exclusively until it is completed below, and the
            // buffer holds `buf.len()` bytes, of which the first `len` are used.
            let slice = unsafe { std::slice::from_raw_parts_mut(buf.as_mut_ptr(), len) };
            perform(&volume, op, offset, slice)
        };
        let result = if res < 0 {
            Err(UblkError::OtherError(res))
        } else {
            Ok(UblkIORes::Result(res))
        };
        if let Err(e) =
            q.complete_io_cmd_unified(tag, BufDesc::Slice(bufs[tag as usize].as_slice()), result)
        {
            eprintln!("kestrel-volume: queue {qid} completing tag {tag} failed: {e}");
        }
    };
    queue.wait_and_handle_io(handler);
}

/// Serves the manifest `volume_ref` at `dest` as a ublk device until `stop` is set.
/// Prints `{"device":"/dev/ublkbN"}` once the device is live.
pub fn restore_lazy(
    volume_ref: &str,
    box_id: &str,
    store: Box<dyn Store>,
    key: BoxKey,
    dest: &Path,
    stop: &Arc<AtomicBool>,
) -> Result<()> {
    check_ref(box_id, volume_ref)?;
    let volume = Arc::new(Volume::open(volume_ref, box_id, store, key, dest)?);
    let size = volume.manifest.size_bytes;

    let hydrator = {
        let volume = Arc::clone(&volume);
        let stop = Arc::clone(stop);
        thread::spawn(move || hydrate(&volume, &stop))
    };

    let ctrl = UblkCtrlBuilder::default()
        .name("kestrel-volume")
        .nr_queues(QUEUES)
        .depth(QUEUE_DEPTH)
        .io_buf_bytes(IO_BUF_BYTES)
        .dev_flags(UblkFlags::UBLK_DEV_F_ADD_DEV)
        .build()
        .map_err(|e| anyhow!("creating the ublk device: {e}"))?;

    let queue_volume = Arc::clone(&volume);
    let watch_stop = Arc::clone(stop);
    let ready = move |ctrl: &UblkCtrl| {
        println!("{{\"device\":\"{}\"}}", ctrl.get_bdev_path());
        let id = ctrl.dev_info().dev_id as i32;
        thread::spawn(move || {
            while !watch_stop.load(Ordering::Relaxed) {
                thread::sleep(POLL);
            }
            if let Err(e) = UblkCtrl::new_simple(id).and_then(|c| c.kill_dev()) {
                eprintln!("kestrel-volume: stopping ublk device {id} failed: {e}");
            }
        });
    };
    let served = ctrl.run_target(
        |dev: &mut UblkDev| {
            dev.set_default_params(size);
            Ok(())
        },
        move |qid: u16, dev: &UblkDev| serve_queue(qid, dev, Arc::clone(&queue_volume)),
        ready,
    );

    stop.store(true, Ordering::Relaxed);
    hydrator
        .join()
        .map_err(|_| anyhow!("the chunk hydrator panicked"))?;
    served.map_err(|e| anyhow!("serving {}: {e}", dest.display()))?;
    Ok(())
}
