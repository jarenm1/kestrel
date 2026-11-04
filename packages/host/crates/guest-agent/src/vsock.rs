//! Minimal AF_VSOCK stream listener on top of `AsyncFd`, so the agent needs no vsock crate.

use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::pin::Pin;
use std::ptr;
use std::task::{ready, Context, Poll};

use tokio::io::unix::AsyncFd;
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};

const AF_VSOCK: libc::c_int = 40;
const VMADDR_CID_ANY: u32 = u32::MAX;
const SOCK_FLAGS: libc::c_int = libc::SOCK_CLOEXEC | libc::SOCK_NONBLOCK;

#[repr(C)]
struct SockaddrVm {
    svm_family: libc::sa_family_t,
    svm_reserved1: u16,
    svm_port: u32,
    svm_cid: u32,
    svm_flags: u8,
    svm_zero: [u8; 3],
}

fn last_error() -> io::Error {
    io::Error::last_os_error()
}

/// Hand an owned, non-blocking socket to the reactor.
fn register(fd: OwnedFd) -> io::Result<AsyncFd<OwnedFd>> {
    // SAFETY: `fd` is an open socket owned by the returned `AsyncFd` for its whole lifetime, and `as_raw_fd` is stable.
    unsafe { AsyncFd::register(fd) }.map_err(io::Error::from)
}

pub struct VsockListener {
    fd: AsyncFd<OwnedFd>,
}

impl VsockListener {
    /// Listen on `port` for connections from any CID (the host).
    pub fn bind(port: u32) -> io::Result<Self> {
        // SAFETY: plain socket(2) call; the returned fd is wrapped in OwnedFd immediately.
        let raw = unsafe { libc::socket(AF_VSOCK, libc::SOCK_STREAM | SOCK_FLAGS, 0) };
        if raw < 0 {
            return Err(last_error());
        }
        // SAFETY: `raw` is a fresh fd we own.
        let fd = unsafe { OwnedFd::from_raw_fd(raw) };
        let addr = SockaddrVm {
            svm_family: AF_VSOCK as libc::sa_family_t,
            svm_reserved1: 0,
            svm_port: port,
            svm_cid: VMADDR_CID_ANY,
            svm_flags: 0,
            svm_zero: [0; 3],
        };
        // SAFETY: `addr` is a valid sockaddr_vm of the size passed; `fd` is a live socket.
        let rc = unsafe {
            libc::bind(
                fd.as_raw_fd(),
                ptr::addr_of!(addr).cast::<libc::sockaddr>(),
                std::mem::size_of::<SockaddrVm>() as libc::socklen_t,
            )
        };
        if rc < 0 {
            return Err(last_error());
        }
        // SAFETY: listen(2) on a bound socket we own.
        if unsafe { libc::listen(fd.as_raw_fd(), 128) } < 0 {
            return Err(last_error());
        }
        Ok(Self { fd: register(fd)? })
    }

    pub async fn accept(&self) -> io::Result<VsockStream> {
        loop {
            let mut guard = self.fd.readable().await?;
            let result = guard.try_io(|inner| {
                // SAFETY: accept4 on a listening socket we own; null address output is allowed.
                let raw = unsafe {
                    libc::accept4(
                        inner.get_ref().as_raw_fd(),
                        ptr::null_mut(),
                        ptr::null_mut(),
                        SOCK_FLAGS,
                    )
                };
                if raw < 0 {
                    Err(last_error())
                } else {
                    // SAFETY: `raw` is a fresh fd owned by nobody else.
                    Ok(unsafe { OwnedFd::from_raw_fd(raw) })
                }
            });
            match result {
                Ok(fd) => return VsockStream::new(fd?),
                Err(_would_block) => continue,
            }
        }
    }
}

pub struct VsockStream {
    fd: AsyncFd<OwnedFd>,
}

impl VsockStream {
    fn new(fd: OwnedFd) -> io::Result<Self> {
        Ok(Self { fd: register(fd)? })
    }
}

impl AsyncRead for VsockStream {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        loop {
            let mut guard = ready!(this.fd.poll_read_ready(cx))?;
            let unfilled = buf.initialize_unfilled();
            let raw = this.fd.get_ref().as_raw_fd();
            match guard.try_io(|_| read_raw(raw, unfilled)) {
                Ok(Ok(n)) => {
                    buf.advance(n);
                    return Poll::Ready(Ok(()));
                }
                Ok(Err(e)) => return Poll::Ready(Err(e)),
                Err(_would_block) => continue,
            }
        }
    }
}

impl AsyncWrite for VsockStream {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        let this = self.get_mut();
        loop {
            let mut guard = ready!(this.fd.poll_write_ready(cx))?;
            let raw = this.fd.get_ref().as_raw_fd();
            match guard.try_io(|_| write_raw(raw, buf)) {
                Ok(result) => return Poll::Ready(result),
                Err(_would_block) => continue,
            }
        }
    }

    fn poll_flush(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }

    fn poll_shutdown(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let raw = self.fd.get_ref().as_raw_fd();
        // SAFETY: shutdown(2) on the socket we own.
        if unsafe { libc::shutdown(raw, libc::SHUT_WR) } < 0 {
            return Poll::Ready(Err(last_error()));
        }
        Poll::Ready(Ok(()))
    }
}

fn read_raw(fd: RawFd, buf: &mut [u8]) -> io::Result<usize> {
    // SAFETY: the buffer is valid for `buf.len()` writes.
    let n = unsafe { libc::read(fd, buf.as_mut_ptr().cast(), buf.len()) };
    if n < 0 {
        Err(last_error())
    } else {
        Ok(n as usize)
    }
}

fn write_raw(fd: RawFd, buf: &[u8]) -> io::Result<usize> {
    // SAFETY: the buffer is valid for `buf.len()` reads.
    let n = unsafe { libc::write(fd, buf.as_ptr().cast(), buf.len()) };
    if n < 0 {
        Err(last_error())
    } else {
        Ok(n as usize)
    }
}
