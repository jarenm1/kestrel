//! Newline-delimited JSON framing shared by the host link and the box link.

use std::io;

use serde::Serialize;
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::oneshot;

use crate::protocol::{ReplyBody, GUEST_ERROR_MAX_CHARS, MAX_FRAME_BYTES};
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

/// Cuts an error to `GUEST_ERROR_MAX_CHARS` UTF-16 units, the length the schema checks, without splitting a character.
fn truncate_error(mut error: String) -> String {
    let mut units = 0;
    let end = error
        .char_indices()
        .find(|(_, c)| {
            units += c.len_utf16();
            units > GUEST_ERROR_MAX_CHARS
        })
        .map_or(error.len(), |(index, _)| index);
    error.truncate(end);
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
        let body = reply("req-1".into(), Err(stderr));
        let error = body.error.as_deref().expect("error reply carries its text");
        assert!(error.encode_utf16().count() <= GUEST_ERROR_MAX_CHARS);
        let line = serde_json::to_vec(&GuestToHost::Reply(body)).expect("frame serializes");
        assert!(
            line.len() <= MAX_FRAME_BYTES,
            "reply frame is {} bytes",
            line.len()
        );
    }

    /// The cap counts UTF-16 code units, as the schema's maxLength does: an astral character is two.
    #[test]
    fn error_is_cut_to_utf16_units_without_splitting_a_character() {
        let error = format!("{}😀", "a".repeat(GUEST_ERROR_MAX_CHARS - 1));
        let body = reply("req-1".into(), Err(error));
        assert_eq!(body.error, Some("a".repeat(GUEST_ERROR_MAX_CHARS - 1)));
    }

    #[test]
    fn error_within_the_cap_is_kept_whole() {
        let error = "b".repeat(GUEST_ERROR_MAX_CHARS);
        assert_eq!(reply("req-1".into(), Err(error.clone())).error, Some(error));
    }
}
