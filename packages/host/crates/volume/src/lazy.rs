//! `restore-lazy`: serves a backed-up volume as a ublk block device at once, fetching chunks on first access.
//!
//! `dest` is sparse until a chunk is fetched. A bitmap next to it records which chunks are present, so a
//! restart resumes instead of refetching. A background hydrator fetches the rest in order.

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::os::unix::fs::FileExt;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
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
use crate::files::{FileLock, create_unnamed, link_unnamed, suffixed, write_file_atomic};
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
    /// Held for the life of the volume. A second open of the same destination would have its own presence map.
    _image_lock: FileLock,
    bitmap_path: PathBuf,
    identity: Vec<u8>,
    present: Presence,
    /// Serializes bitmap writes, so the file on disk always holds every bit set before its write.
    persist_lock: Mutex<()>,
    chunk_locks: Vec<Mutex<()>>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Binds the bitmap to one box and one manifest, so it cannot be applied to another restore.
fn identity(box_id: &str, volume_ref: &str) -> Vec<u8> {
    Sha256::digest(format!("{box_id}\n{volume_ref}")).to_vec()
}

/// Publishes the bitmap of a restore whose destination does not exist yet. A file at `path` is replaced only if it is a
/// bitmap for this same restore, left by an interrupted create; any other file is refused and left untouched.
fn create_bitmap(path: &Path, bytes: &[u8], identity: &[u8], chunks: usize) -> Result<()> {
    match fs::read(path) {
        Ok(old) => {
            Presence::decode(&old, identity, chunks).with_context(|| {
                format!("{} exists and is not this restore's bitmap", path.display())
            })?;
            fs::remove_file(path).with_context(|| format!("removing {}", path.display()))?;
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => return Err(err).with_context(|| format!("reading {}", path.display())),
    }
    let mut file = create_unnamed(path)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    link_unnamed(&file, path)
}

/// Which chunks are present, as atomic bits so reads never wait on a fetch. The bitmap file is the identity followed by
/// one bit per chunk: bit `i` is bit `i % 8` of byte `i / 8`.
struct Presence {
    words: Vec<AtomicU64>,
    chunks: usize,
}

impl Presence {
    fn new(chunks: usize) -> Self {
        Self {
            words: (0..chunks.div_ceil(64))
                .map(|_| AtomicU64::new(0))
                .collect(),
            chunks,
        }
    }

    fn get(&self, index: usize) -> bool {
        self.words[index / 64].load(Ordering::Acquire) & (1 << (index % 64)) != 0
    }

    fn set(&self, index: usize, present: bool) {
        let bit = 1u64 << (index % 64);
        if present {
            self.words[index / 64].fetch_or(bit, Ordering::AcqRel);
        } else {
            self.words[index / 64].fetch_and(!bit, Ordering::AcqRel);
        }
    }

    /// The bitmap bytes, with chunk `extra` also marked present when given.
    fn encode(&self, identity: &[u8], extra: Option<usize>) -> Vec<u8> {
        let mut bytes = identity.to_vec();
        bytes.extend((0..self.chunks.div_ceil(8)).map(|byte| {
            let mut value =
                (self.words[byte / 8].load(Ordering::Acquire) >> (8 * (byte % 8))) as u8;
            if let Some(index) = extra.filter(|index| index / 8 == byte) {
                value |= 1 << (index % 8);
            }
            value
        }));
        bytes
    }

    fn decode(bytes: &[u8], identity: &[u8], chunks: usize) -> Result<Self> {
        ensure!(
            bytes.len() == IDENTITY_LEN + chunks.div_ceil(8) && &bytes[..IDENTITY_LEN] == identity,
            "the bitmap belongs to a different restore"
        );
        let words = (0..chunks.div_ceil(64))
            .map(|word| {
                let mut value = 0u64;
                for k in 0..8 {
                    if let Some(byte) = bytes.get(IDENTITY_LEN + word * 8 + k) {
                        value |= (*byte as u64) << (8 * k);
                    }
                }
                AtomicU64::new(value)
            })
            .collect();
        Ok(Self { words, chunks })
    }
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
        let manifest = Manifest::open(&bytes, &key, box_id, volume_ref)?;
        let chunks = manifest.chunks.len();
        let identity = identity(box_id, volume_ref);
        let bitmap_path = suffixed(dest, BITMAP_SUFFIX);
        let image_lock = FileLock::try_acquire(&suffixed(dest, ".lock"))?;

        let (file, present) = if dest.exists() {
            let bitmap = fs::read(&bitmap_path)
                .with_context(|| format!("reading {}", bitmap_path.display()))?;
            let present = Presence::decode(&bitmap, &identity, chunks)?;
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
            let present = Presence::new(chunks);
            // The image is created unnamed and its bitmap is durable before it is linked to `dest`, so `dest` existing
            // implies a valid bitmap. A crash leaves nothing behind.
            let file = create_unnamed(dest)?;
            file.set_len(manifest.size_bytes)?;
            file.sync_all()?;
            create_bitmap(
                &bitmap_path,
                &present.encode(&identity, None),
                &identity,
                chunks,
            )?;
            link_unnamed(&file, dest)?;
            (file, present)
        };

        Ok(Self {
            store,
            box_id: box_id.to_owned(),
            key,
            manifest,
            file,
            _image_lock: image_lock,
            bitmap_path,
            identity,
            present,
            persist_lock: Mutex::new(()),
            chunk_locks: (0..chunks).map(|_| Mutex::new(())).collect(),
        })
    }

    fn chunk_count(&self) -> usize {
        self.manifest.chunks.len()
    }

    /// Makes chunk `index` present in `dest`, fetching and authenticating it on first use.
    /// A null chunk is zeros, which the sparse file already holds. The bit is published only once the bitmap is durable.
    fn ensure(&self, index: usize) -> Result<()> {
        if self.present.get(index) {
            return Ok(());
        }
        let _fetching = lock(&self.chunk_locks[index]);
        if self.present.get(index) {
            return Ok(());
        }
        if let Some(name) = &self.manifest.chunks[index] {
            let mut plaintext = fetch_chunk(self.store.as_ref(), &self.box_id, &self.key, name)?;
            plaintext.truncate(chunk_len(self.manifest.size_bytes, index));
            self.file
                .write_all_at(&plaintext, index as u64 * CHUNK_SIZE)?;
            self.file.sync_data()?;
        }
        self.publish(index)
    }

    /// Marks chunk `index` present. The bitmap on disk is written with the bit before the bit is visible to other I/O,
    /// so a write acknowledged from this chunk is never in a chunk the bitmap calls absent. If the bitmap write fails,
    /// the chunk stays absent and is fetched again.
    fn publish(&self, index: usize) -> Result<()> {
        let _writing = lock(&self.persist_lock);
        write_file_atomic(
            &self.bitmap_path,
            &self.present.encode(&self.identity, Some(index)),
        )?;
        self.present.set(index, true);
        Ok(())
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
        // libublk advertises only the volatile-cache attribute, so discard, write-zeroes and FUA never arrive here.
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

    // Detached: a fetch in flight can take minutes, and a chunk whose bit was not persisted is fetched again on restart.
    {
        let volume = Arc::clone(&volume);
        let stop = Arc::clone(stop);
        thread::spawn(move || hydrate(&volume, &stop));
    }

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
    served.map_err(|e| anyhow!("serving {}: {e}", dest.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backup::backup;
    use crate::manifest::chunk_key;
    use crate::store::FileStore;
    use crate::testutil::{BOX, box_key, volume, volume_bytes};

    fn open(dir: &Path, volume_ref: &str, dest: &Path) -> Result<Volume> {
        let store = Box::new(FileStore::new(dir.join("store")));
        Volume::open(volume_ref, BOX, store, box_key(dir, BOX), dest)
    }

    /// Backs up a volume of `chunks` chunks and returns its manifest ref.
    fn backed_up(dir: &Path, chunks: u64) -> String {
        let store = FileStore::new(dir.join("store"));
        let key = box_key(dir, BOX);
        let path = volume(dir, chunks);
        backup(&path, BOX, dir, &store, &key).unwrap().volume_ref
    }

    #[test]
    fn presence_bits_round_trip_and_are_bound_to_their_identity() {
        let id = identity(BOX, "ref-a");
        let present = Presence::new(70);
        present.set(0, true);
        present.set(69, true);
        present.set(8, true);
        present.set(8, false);
        let bytes = present.encode(&id, None);
        let decoded = Presence::decode(&bytes, &id, 70).unwrap();
        let bits: Vec<usize> = (0..70).filter(|i| decoded.get(*i)).collect();
        assert_eq!(bits, vec![0, 69]);
        assert!(Presence::decode(&bytes, &identity(BOX, "ref-b"), 70).is_err());
        assert!(Presence::decode(&bytes, &id, 80).is_err());
    }

    #[test]
    fn read_fetches_only_the_chunks_it_touches() {
        let dir = tempfile::tempdir().unwrap();
        let volume_ref = backed_up(dir.path(), 3);
        let dest = dir.path().join("dest.raw");
        let lazy = open(dir.path(), &volume_ref, &dest).unwrap();
        let offset = CHUNK_SIZE - 8;
        let mut buf = vec![0u8; 16];
        lazy.read(offset, &mut buf).unwrap();
        let expected = volume_bytes(3);
        assert_eq!(buf, expected[offset as usize..offset as usize + 16]);
        assert!(lazy.present.get(0) && lazy.present.get(1));
        assert!(!lazy.present.get(2));
    }

    #[test]
    fn io_past_the_end_fails_and_an_empty_read_succeeds() {
        let dir = tempfile::tempdir().unwrap();
        let volume_ref = backed_up(dir.path(), 1);
        let dest = dir.path().join("dest.raw");
        let lazy = open(dir.path(), &volume_ref, &dest).unwrap();
        let mut buf = [0u8; 8];
        assert!(lazy.read(CHUNK_SIZE - 4, &mut buf).is_err());
        lazy.read(0, &mut []).unwrap();
    }

    #[test]
    fn present_chunks_survive_a_restart_without_refetching() {
        let dir = tempfile::tempdir().unwrap();
        let volume_ref = backed_up(dir.path(), 2);
        let dest = dir.path().join("dest.raw");
        let name = {
            let lazy = open(dir.path(), &volume_ref, &dest).unwrap();
            let mut buf = [0u8; 4];
            lazy.read(0, &mut buf).unwrap();
            lazy.manifest.chunks[0].clone().unwrap()
        };
        // Chunk 0 is present, so its object is no longer needed: a restarted volume must not fetch it.
        FileStore::new(dir.path().join("store"))
            .delete(&chunk_key(BOX, &name))
            .unwrap();
        let lazy = open(dir.path(), &volume_ref, &dest).unwrap();
        let mut buf = [0u8; 4];
        lazy.read(0, &mut buf).unwrap();
        assert_eq!(buf, [1; 4]);
    }

    #[test]
    fn a_second_open_of_a_destination_is_refused_while_the_first_is_open() {
        let dir = tempfile::tempdir().unwrap();
        let volume_ref = backed_up(dir.path(), 1);
        let dest = dir.path().join("dest.raw");
        let first = open(dir.path(), &volume_ref, &dest).unwrap();
        let err = open(dir.path(), &volume_ref, &dest).err().unwrap();
        assert!(format!("{err:#}").contains("held by another process"));
        drop(first);
        open(dir.path(), &volume_ref, &dest).unwrap();
    }

    #[test]
    fn null_chunks_read_as_zeros_without_an_object() {
        let dir = tempfile::tempdir().unwrap();
        let path = volume(dir.path(), 1);
        fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .unwrap()
            .set_len(2 * CHUNK_SIZE)
            .unwrap();
        let store = FileStore::new(dir.path().join("store"));
        let key = box_key(dir.path(), BOX);
        let volume_ref = backup(&path, BOX, dir.path(), &store, &key)
            .unwrap()
            .volume_ref;
        let dest = dir.path().join("dest.raw");
        let lazy = open(dir.path(), &volume_ref, &dest).unwrap();
        assert!(lazy.manifest.chunks[1].is_none());
        let mut buf = [9u8; 8];
        lazy.read(CHUNK_SIZE, &mut buf).unwrap();
        assert_eq!(buf, [0u8; 8]);
        assert!(lazy.present.get(1));
    }

    #[test]
    fn a_bitmap_from_another_restore_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let first = backed_up(dir.path(), 1);
        let dest = dir.path().join("dest.raw");
        open(dir.path(), &first, &dest).unwrap();
        let path = dir.path().join("volume.raw");
        fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .unwrap()
            .write_all_at(&[0xAB; 8], 0)
            .unwrap();
        let store = FileStore::new(dir.path().join("store"));
        let key = box_key(dir.path(), BOX);
        let second = backup(&path, BOX, dir.path(), &store, &key)
            .unwrap()
            .volume_ref;
        assert_ne!(first, second);
        assert!(open(dir.path(), &second, &dest).is_err());
    }

    #[test]
    fn a_failed_bitmap_write_leaves_the_chunk_absent_until_it_succeeds() {
        let dir = tempfile::tempdir().unwrap();
        let volume_ref = backed_up(dir.path(), 1);
        let dest = dir.path().join("dest.raw");
        let lazy = open(dir.path(), &volume_ref, &dest).unwrap();
        // A directory at the bitmap path makes every bitmap write fail, because the rename over it cannot succeed.
        fs::remove_file(&lazy.bitmap_path).unwrap();
        fs::create_dir(&lazy.bitmap_path).unwrap();
        let mut buf = [0u8; 4];
        assert!(lazy.read(0, &mut buf).is_err());
        assert!(!lazy.present.get(0));
        fs::remove_dir(&lazy.bitmap_path).unwrap();
        lazy.read(0, &mut buf).unwrap();
        assert_eq!(buf, [1; 4]);
        assert!(lazy.present.get(0));
    }

    #[test]
    fn a_file_at_the_old_staging_name_is_never_touched() {
        let dir = tempfile::tempdir().unwrap();
        let volume_ref = backed_up(dir.path(), 2);
        let dest = dir.path().join("dest.raw");
        let other = suffixed(&dest, ".partial");
        fs::write(&other, vec![7u8; 3 * CHUNK_SIZE as usize]).unwrap();
        open(dir.path(), &volume_ref, &dest).unwrap();
        assert_eq!(fs::metadata(&dest).unwrap().len(), 2 * CHUNK_SIZE);
        assert_eq!(
            fs::read(&other).unwrap(),
            vec![7u8; 3 * CHUNK_SIZE as usize]
        );
    }

    #[test]
    fn a_file_at_the_bitmap_path_is_refused_and_untouched() {
        let dir = tempfile::tempdir().unwrap();
        let volume_ref = backed_up(dir.path(), 2);
        let dest = dir.path().join("dest.raw");
        let bitmap = suffixed(&dest, BITMAP_SUFFIX);
        fs::write(&bitmap, b"someone else's image").unwrap();
        assert!(open(dir.path(), &volume_ref, &dest).is_err());
        assert_eq!(fs::read(&bitmap).unwrap(), b"someone else's image");
        assert!(!dest.exists());
    }

    #[test]
    fn a_stale_bitmap_from_an_interrupted_create_does_not_mark_chunks_present() {
        let dir = tempfile::tempdir().unwrap();
        let volume_ref = backed_up(dir.path(), 2);
        let dest = dir.path().join("dest.raw");
        {
            let lazy = open(dir.path(), &volume_ref, &dest).unwrap();
            lazy.read(0, &mut [0u8; 4]).unwrap();
        }
        // The image is gone but its bitmap, with chunk 0 marked present, survives: an interrupted restore of the same
        // manifest leaves exactly that.
        fs::remove_file(&dest).unwrap();
        let lazy = open(dir.path(), &volume_ref, &dest).unwrap();
        assert!(!lazy.present.get(0));
    }
}
