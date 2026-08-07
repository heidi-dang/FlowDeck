//! FDX daemon — transport abstraction.
//!
//! Protocol v1 speaks NDJSON over a byte stream. This module hides the
//! concrete stream behind [`Transport`], which reads/writes length-bounded
//! NDJSON messages. Two implementations ship in Task 2:
//!
//! - [`stdio`] — one-shot mode: the client spawns `fdxd --stdio` and talks
//!   over the child's stdin/stdout. Works on every OS, no filesystem state.
//! - [`unix_socket`] — persistent mode (unix targets): `fdxd --socket <path>`
//!   listens and serves concurrent clients over a Unix domain socket.
//!
//! Windows named-pipe transport lands in a later task behind the same trait;
//! the daemon already discovers transport by CLI flag so nothing downstream
//! changes when it ships.

use std::io::{BufRead, BufReader};
use std::time::Duration;

use super::protocol::MAX_MESSAGE_BYTES;

/// Error surfaced by a [`Transport`].
#[derive(Debug)]
pub enum TransportError {
    /// Read/write/IO failure (including EOF).
    Io(std::io::Error),
    /// A message exceeded [`MAX_MESSAGE_BYTES`].
    TooLarge { bytes: usize },
    /// Invalid UTF-8 in a message line.
    NotUtf8,
}

impl std::fmt::Display for TransportError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TransportError::Io(e) => write!(f, "transport io: {e}"),
            TransportError::TooLarge { bytes } => write!(
                f,
                "message exceeded {MAX_MESSAGE_BYTES} bytes (got {bytes}); refusing to buffer unboundedly"
            ),
            TransportError::NotUtf8 => write!(f, "message is not valid UTF-8"),
        }
    }
}

impl From<std::io::Error> for TransportError {
    fn from(e: std::io::Error) -> Self {
        TransportError::Io(e)
    }
}

impl std::error::Error for TransportError {}

/// Byte-stream transport that exchanges length-bounded NDJSON messages.
pub trait Transport {
    /// Read the next single-line message. `Ok(None)` means clean EOF.
    fn read_message(&mut self) -> Result<Option<String>, TransportError>;
    /// Write one message plus its trailing newline.
    fn write_message(&mut self, line: &str) -> Result<(), TransportError>;
    /// Flush any buffered writes.
    fn flush(&mut self) -> Result<(), TransportError>;
}

/// Shared framing over any `Read + Write` stream pair. Read and write
/// handles are separate types (`R` and `W`), which matches stdio (Stdin /
/// Stdout) and duplicated Unix streams.
pub struct StreamTransport<R, W> {
    reader: BufReader<R>,
    writer: W,
}

impl<R: std::io::Read, W> StreamTransport<R, W> {
    pub fn new(read: R, write: W) -> Self {
        Self {
            reader: BufReader::with_capacity(16 * 1024, read),
            writer: write,
        }
    }
}

impl<R: std::io::Read, W: std::io::Write> Transport for StreamTransport<R, W> {
    fn read_message(&mut self) -> Result<Option<String>, TransportError> {
        loop {
            let mut line = Vec::new();
            // Read a line, capping growth so a hostile peer cannot make us
            // buffer unboundedly (output-bounding requirement).
            loop {
                let buf = self.reader.fill_buf()?;
                if buf.is_empty() {
                    // EOF. If we already have bytes with no newline, the
                    // stream ended mid-message — treat as truncated line.
                    if !line.is_empty() {
                        return Err(TransportError::Io(std::io::Error::new(
                            std::io::ErrorKind::UnexpectedEof,
                            "stream ended mid-message",
                        )));
                    }
                    return Ok(None);
                }
                let newline = buf.iter().position(|&b| b == b'\n');
                let take = newline.map(|i| i + 1).unwrap_or(buf.len());
                if line.len() + take > MAX_MESSAGE_BYTES {
                    return Err(TransportError::TooLarge {
                        bytes: line.len() + take,
                    });
                }
                line.extend_from_slice(&buf[..take]);
                self.reader.consume(take);
                if newline.is_some() {
                    break;
                }
            }
            // Drop the trailing newline.
            if line.last() == Some(&b'\n') {
                line.pop();
            }
            // Ignore blank lines (keepalive/whitespace) and parse.
            if line.is_empty() {
                continue;
            }
            return Ok(Some(
                String::from_utf8(line).map_err(|_| TransportError::NotUtf8)?,
            ));
        }
    }

    fn write_message(&mut self, line: &str) -> Result<(), TransportError> {
        if line.len() > MAX_MESSAGE_BYTES {
            return Err(TransportError::TooLarge { bytes: line.len() });
        }
        self.writer.write_all(line.as_bytes())?;
        self.writer.write_all(b"\n")?;
        self.writer.flush()?;
        Ok(())
    }

    fn flush(&mut self) -> Result<(), TransportError> {
        self.writer.flush()?;
        Ok(())
    }
}

// ─── stdio transport ─────────────────────────────────────────────────────────

/// Transport over a child process's stdin/stdout (one-shot `--stdio` mode).
pub type StdioTransport = StreamTransport<std::io::Stdin, std::io::Stdout>;

pub fn stdio() -> StdioTransport {
    StreamTransport::new(std::io::stdin(), std::io::stdout())
}

// ─── unix socket transport ───────────────────────────────────────────────────

/// Unix socket stream (persistent `--socket` mode). Read and write share
/// one `UnixStream`; the write side is a cheap `try_clone` of the same handle.
#[cfg(unix)]
pub type UnixSocketTransport =
    StreamTransport<std::os::unix::net::UnixStream, std::os::unix::net::UnixStream>;

#[cfg(unix)]
pub fn unix_socket(stream: std::os::unix::net::UnixStream) -> UnixSocketTransport {
    // Set a read timeout so the server can poll for idle-exit while blocked
    // on a message: the read returns WouldBlock/TimedOut every poll interval
    // instead of blocking forever on a silent client.
    let _ = stream.set_read_timeout(Some(POLL_INTERVAL));
    // Duplicate the handle: one for reading, one for writing. `StreamTransport`
    // takes separate read/write handles; for a duplex UnixStream we clone via
    // try_clone (cheap, shares the same file description).
    let write = stream
        .try_clone()
        .expect("try_clone on UnixStream is infallible");
    StreamTransport::new(stream, write)
}

/// Poll interval (ms) the daemon uses to wake from a blocked read and check
/// idle timeout. Small enough that idle-exit latency is acceptable, large
/// enough not to spin.
pub const POLL_INTERVAL: Duration = Duration::from_millis(50);

/// Idle timeout used by the daemon server.
pub const DEFAULT_IDLE_TIMEOUT: Duration = Duration::from_secs(300);

// ─── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    struct PipePair {
        client: StreamTransport<std::io::PipeReader, std::io::PipeWriter>,
        server: StreamTransport<std::io::PipeReader, std::io::PipeWriter>,
    }

    fn pipe_pair() -> PipePair {
        // std::io::pipe() returns (reader, writer). Two pipes:
        //   pipe A: client -> server
        //   pipe B: server -> client
        let (server_r, client_w) = std::io::pipe().unwrap();
        let (client_r, server_w) = std::io::pipe().unwrap();
        PipePair {
            client: StreamTransport::new(client_r, client_w),
            server: StreamTransport::new(server_r, server_w),
        }
    }

    #[test]
    fn round_trips_single_message() {
        let mut p = pipe_pair();
        p.client
            .write_message(r#"{"v":1,"id":1,"method":"ping"}"#)
            .unwrap();
        let msg = p.server.read_message().unwrap().unwrap();
        assert_eq!(msg, r#"{"v":1,"id":1,"method":"ping"}"#);
    }

    #[test]
    fn round_trips_multiple_messages_with_blank_lines() {
        let mut p = pipe_pair();
        p.client.write_message("hello").unwrap();
        p.client.write_message("").unwrap(); // blank line must be skipped
        p.client.write_message("world").unwrap();
        assert_eq!(p.server.read_message().unwrap().unwrap(), "hello");
        assert_eq!(p.server.read_message().unwrap().unwrap(), "world");
    }

    /// A `Read` that yields a giant single line (64 KB + 1) in one call,
    /// then EOF. Simulates a hostile peer flooding us past the cap without
    /// relying on OS pipe buffering (which can block on writes).
    struct OversizedSource {
        remaining: usize,
    }

    impl std::io::Read for OversizedSource {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            if self.remaining == 0 {
                return Ok(0);
            }
            let n = buf.len().min(self.remaining).min(MAX_MESSAGE_BYTES);
            // Deliver as much as fits, then mark the rest as pending — the
            // framing layer must reject BEFORE it has consumed the whole
            // message, i.e. as soon as cumulative bytes exceed the cap.
            buf[..n].fill(b'x');
            self.remaining = self.remaining.saturating_sub(n);
            Ok(n)
        }
    }

    #[test]
    fn rejects_oversized_message_before_buffering() {
        // The reader must reject as soon as cumulative frame bytes exceed
        // MAX_MESSAGE_BYTES, without buffering the entire (attacker-chosen)
        // payload. We deliver the first chunk (<= cap) so `fill_buf` returns
        // it, then a second chunk that pushes the cumulative total over.
        let src = OversizedSource {
            remaining: MAX_MESSAGE_BYTES + 1,
        };
        let mut server =
            StreamTransport::<OversizedSource, std::io::Sink>::new(src, std::io::sink());
        let err = server.read_message().unwrap_err();
        assert!(
            matches!(err, TransportError::TooLarge { .. }),
            "got {err:?}"
        );
    }

    #[test]
    fn eof_returns_none() {
        let mut p = pipe_pair();
        // Dropping the client side closes both pipes.
        drop(p.client);
        let got = p.server.read_message().unwrap();
        assert!(got.is_none());
    }

    #[test]
    fn rejects_truncated_message_at_eof() {
        let (r, mut w) = std::io::pipe().unwrap();
        w.write_all(b"no-newline").unwrap();
        drop(w);
        let mut t = StreamTransport::<std::io::PipeReader, std::io::Sink>::new(r, std::io::sink());
        let err = t.read_message().unwrap_err();
        assert!(matches!(err, TransportError::Io(_)));
    }
    #[cfg(unix)]
    mod unix_socket_tests {
        use super::*;
        use std::os::unix::net::{UnixListener, UnixStream};
        use std::time::Duration;

        fn socket_pair() -> (UnixStream, UnixStream) {
            let dir = std::env::temp_dir();
            let path = dir.join(format!("fdxd-transport-test-{}.sock", std::process::id()));
            let _ = std::fs::remove_file(&path);
            let listener = UnixListener::bind(&path).expect("bind");
            let client = UnixStream::connect(&path).expect("connect");
            let (server, _) = listener.accept().expect("accept");
            let _ = std::fs::remove_file(&path);
            (client, server)
        }

        #[test]
        fn read_timeout_wakes_blocked_read() {
            let (_client, server) = socket_pair();
            // Server side: set a 50ms read timeout on the stream before wrapping.
            let s = server;
            s.set_read_timeout(Some(Duration::from_millis(50)))
                .expect("set timeout");
            let write = s.try_clone().expect("clone");
            let mut server = StreamTransport::new(s, write);
            // Client sends nothing; read must return a timeout error, not hang.
            let start = std::time::Instant::now();
            let err = server
                .read_message()
                .expect_err("should time out, not block forever");
            let elapsed = start.elapsed();
            match &err {
                TransportError::Io(e)
                    if e.kind() == std::io::ErrorKind::TimedOut
                        || e.kind() == std::io::ErrorKind::WouldBlock => {}
                other => panic!("expected timeout/WouldBlock, got {other:?}"),
            }
            assert!(elapsed < Duration::from_secs(2), "took {elapsed:?}");
        }
    }
}
