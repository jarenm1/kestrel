//! Newline-delimited JSON framing shared by the host link and the box link.

use std::io;

use serde::Serialize;
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::oneshot;

use crate::protocol::{ReplyBody, MAX_FRAME_BYTES};
use crate::system::Res;

/// A frame queued for the writer of a session. `flushed` fires once the frame reached the peer's socket, so a
/// caller can order a side effect (power off) after its acknowledgement.
pub struct Outgoing<T> {
    pub frame: T,
    pub flushed: Option<oneshot::Sender<()>>,
}

impl<T> Outgoing<T> {
    pub fn new(frame: T) -> Self {
        Self {
            frame,
            flushed: None,
        }
    }
}

/// Read one line into `pending`, returning it without the newline; `Ok(None)` at a clean end of stream.
///
/// Cancel-safe: bytes are only moved out of the reader once they are in `pending`, so a dropped future loses
/// nothing and the caller keeps the partial line for the next call.
pub async fn read_frame<R: AsyncBufRead + Unpin>(
    rd: &mut R,
    pending: &mut Vec<u8>,
) -> io::Result<Option<Vec<u8>>> {
    loop {
        let (found, consumed) = {
            let available = rd.fill_buf().await?;
            if available.is_empty() {
                if pending.is_empty() {
                    return Ok(None);
                }
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "connection closed mid-frame",
                ));
            }
            match available.iter().position(|&b| b == b'\n') {
                Some(i) => {
                    pending.extend_from_slice(&available[..i]);
                    (true, i + 1)
                }
                None => {
                    pending.extend_from_slice(available);
                    (false, available.len())
                }
            }
        };
        rd.consume(consumed);
        if pending.len() > MAX_FRAME_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "frame longer than the 64 KiB limit",
            ));
        }
        if found {
            return Ok(Some(std::mem::take(pending)));
        }
    }
}

pub async fn write_frame<W: AsyncWrite + Unpin, T: Serialize>(
    wr: &mut W,
    frame: &T,
) -> io::Result<()> {
    let mut line = serde_json::to_vec(frame).map_err(io::Error::other)?;
    line.push(b'\n');
    wr.write_all(&line).await?;
    wr.flush().await
}

/// Longest error text a reply carries. JSON escapes a control character to six bytes, so 8 KiB of error text is at most
/// 48 KiB on the wire, inside `MAX_FRAME_BYTES`. Errors can be a command's whole stderr.
const MAX_ERROR_BYTES: usize = 8 * 1024;

pub fn reply(id: String, result: Res<()>) -> ReplyBody {
    match result {
        Ok(()) => ReplyBody {
            id,
            ok: true,
            error: None,
        },
        Err(error) => ReplyBody {
            id,
            ok: false,
            error: Some(truncate_error(error)),
        },
    }
}

fn truncate_error(mut error: String) -> String {
    if error.len() <= MAX_ERROR_BYTES {
        return error;
    }
    let mut end = MAX_ERROR_BYTES;
    while !error.is_char_boundary(end) {
        end -= 1;
    }
    error.truncate(end);
    error.push_str(" [truncated]");
    error
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::GuestToHost;

    /// A reply must fit one frame however large its error text is.
    #[test]
    fn an_error_reply_fits_one_frame() {
        // Control characters are the worst case: each one serializes to six bytes.
        let stderr = "\u{1}".repeat(100 * 1024);
        let frame = GuestToHost::Reply(reply("req-1".into(), Err(stderr)));
        let line = serde_json::to_vec(&frame).expect("frame serializes");
        assert!(
            line.len() <= MAX_FRAME_BYTES,
            "reply frame is {} bytes",
            line.len()
        );
    }
}
