//! Bounded, safe child process runner for verification actions.
//!
//! Direct Command execution only: no shell invocation, no string interpolation.
//! Process group management ensures all subprocesses are reaped on timeout.

use crate::intelligence::verify::model::CheckExecutionStatus;
use crate::intelligence::verify::redact::redact_secrets;
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// Configuration limits for child process execution.
#[derive(Debug, Clone)]
pub struct ProcessBounds {
    pub timeout: Duration,
    pub max_stdout_bytes: u64,
    pub max_stderr_bytes: u64,
    pub tail_limit_bytes: usize,
}

impl Default for ProcessBounds {
    fn default() -> Self {
        Self {
            timeout: Duration::from_secs(60),
            max_stdout_bytes: 1024 * 1024, // 1 MiB
            max_stderr_bytes: 1024 * 1024, // 1 MiB
            tail_limit_bytes: 8 * 1024,    // 8 KiB
        }
    }
}

/// Raw execution result from a bounded process invocation.
#[derive(Debug, Clone)]
pub struct RawProcessOutcome {
    pub status: CheckExecutionStatus,
    pub exit_code: Option<i32>,
    pub signal: Option<String>,
    pub duration_ms: u64,
    pub stdout_digest: Option<String>,
    pub stderr_digest: Option<String>,
    pub stdout_excerpt: Option<String>,
    pub stderr_excerpt: Option<String>,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
    pub started_at_ms: u64,
    pub reason: Option<String>,
}

#[derive(Default)]
struct StreamCapture {
    hasher: sha2::Sha256,
    bytes: u64,
    truncated: bool,
    tail: Vec<u8>,
}

fn append_bounded_tail(tail: &mut Vec<u8>, new_bytes: &[u8], tail_limit: usize) {
    if tail_limit == 0 {
        tail.clear();
        return;
    }
    if new_bytes.len() >= tail_limit {
        tail.clear();
        tail.extend_from_slice(&new_bytes[new_bytes.len() - tail_limit..]);
        return;
    }
    let overflow = (tail.len() + new_bytes.len()).saturating_sub(tail_limit);
    if overflow > 0 {
        let drop_n = overflow.min(tail.len());
        tail.drain(0..drop_n);
    }
    tail.extend_from_slice(new_bytes);
}

/// Kill the child process and its process group.
fn kill_child_group(child: &mut std::process::Child) {
    #[cfg(unix)]
    {
        unsafe {
            libc::killpg(child.id() as i32, libc::SIGKILL);
        }
    }
    #[cfg(not(unix))]
    {
        let _ = child.kill();
    }
    let _ = child.wait();
}

/// Execute a program with argv in working dir under strict bounds.
pub fn execute_bounded_command(
    program: &str,
    argv: &[String],
    cwd: &Path,
    bounds: &ProcessBounds,
) -> RawProcessOutcome {
    use sha2::Digest;

    let started_at_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;

    let mut cmd = Command::new(program);
    cmd.args(argv)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    // Isolate in process group on Unix
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }

    let start_instant = Instant::now();

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            return RawProcessOutcome {
                status: CheckExecutionStatus::SpawnFailed,
                exit_code: None,
                signal: None,
                duration_ms: start_instant.elapsed().as_millis() as u64,
                stdout_digest: None,
                stderr_digest: None,
                stdout_excerpt: None,
                stderr_excerpt: None,
                stdout_truncated: false,
                stderr_truncated: false,
                started_at_ms,
                reason: Some(format!("failed to spawn '{}': {}", program, e)),
            };
        }
    };

    let stdout_pipe = child.stdout.take();
    let stderr_pipe = child.stderr.take();

    let stdout_cap = Arc::new(Mutex::new(StreamCapture::default()));
    let stderr_cap = Arc::new(Mutex::new(StreamCapture::default()));
    let stdout_overflow = Arc::new(Mutex::new(false));
    let stderr_overflow = Arc::new(Mutex::new(false));

    fn spawn_reader(
        pipe: Option<impl Read + Send + 'static>,
        cap: Arc<Mutex<StreamCapture>>,
        overflow: Arc<Mutex<bool>>,
        max_bytes: u64,
        tail_limit: usize,
    ) -> Option<std::thread::JoinHandle<()>> {
        pipe.map(|mut p| {
            std::thread::spawn(move || {
                let mut buf = [0u8; 8192];
                loop {
                    let n = match p.read(&mut buf) {
                        Ok(0) => break,
                        Ok(n) => n,
                        Err(_) => break,
                    };
                    let mut guard = cap.lock().unwrap();
                    if guard.bytes + n as u64 > max_bytes {
                        guard.truncated = true;
                        let allowed = max_bytes.saturating_sub(guard.bytes) as usize;
                        let take_n = allowed.min(n);
                        if take_n > 0 {
                            guard.hasher.update(&buf[..take_n]);
                            guard.bytes += take_n as u64;
                            append_bounded_tail(&mut guard.tail, &buf[..take_n], tail_limit);
                        }
                        *overflow.lock().unwrap() = true;
                        break;
                    }
                    guard.hasher.update(&buf[..n]);
                    guard.bytes += n as u64;
                    append_bounded_tail(&mut guard.tail, &buf[..n], tail_limit);
                }
            })
        })
    }

    let h_stdout = spawn_reader(
        stdout_pipe,
        Arc::clone(&stdout_cap),
        Arc::clone(&stdout_overflow),
        bounds.max_stdout_bytes,
        bounds.tail_limit_bytes,
    );
    let h_stderr = spawn_reader(
        stderr_pipe,
        Arc::clone(&stderr_cap),
        Arc::clone(&stderr_overflow),
        bounds.max_stderr_bytes,
        bounds.tail_limit_bytes,
    );

    let mut exit_code: Option<i32> = None;
    let mut signal: Option<String> = None;
    let mut timed_out = false;
    let mut overflowed = false;

    loop {
        if start_instant.elapsed() > bounds.timeout {
            timed_out = true;
            break;
        }
        if *stdout_overflow.lock().unwrap() || *stderr_overflow.lock().unwrap() {
            overflowed = true;
            break;
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                exit_code = status.code();
                #[cfg(unix)]
                {
                    use std::os::unix::process::ExitStatusExt;
                    if let Some(sig) = status.signal() {
                        signal = Some(format!("SIG{}", sig));
                    }
                }
                break;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(10)),
            Err(e) => {
                kill_child_group(&mut child);
                return RawProcessOutcome {
                    status: CheckExecutionStatus::SpawnFailed,
                    exit_code: None,
                    signal: None,
                    duration_ms: start_instant.elapsed().as_millis() as u64,
                    stdout_digest: None,
                    stderr_digest: None,
                    stdout_excerpt: None,
                    stderr_excerpt: None,
                    stdout_truncated: false,
                    stderr_truncated: false,
                    started_at_ms,
                    reason: Some(format!("wait error: {}", e)),
                };
            }
        }
    }

    if timed_out || overflowed || exit_code.is_none() {
        kill_child_group(&mut child);
    }

    if let Some(h) = h_stdout {
        let _ = h.join();
    }
    if let Some(h) = h_stderr {
        let _ = h.join();
    }

    let duration_ms = start_instant.elapsed().as_millis() as u64;

    let out_guard = stdout_cap.lock().unwrap();
    let err_guard = stderr_cap.lock().unwrap();

    let out_digest = format!("{:x}", out_guard.hasher.clone().finalize());
    let err_digest = format!("{:x}", err_guard.hasher.clone().finalize());

    let out_raw_str = String::from_utf8_lossy(&out_guard.tail);
    let err_raw_str = String::from_utf8_lossy(&err_guard.tail);

    let stdout_excerpt = if out_raw_str.is_empty() {
        None
    } else {
        Some(redact_secrets(&out_raw_str))
    };

    let stderr_excerpt = if err_raw_str.is_empty() {
        None
    } else {
        Some(redact_secrets(&err_raw_str))
    };

    let stdout_truncated = out_guard.truncated || out_guard.bytes >= bounds.max_stdout_bytes;
    let stderr_truncated = err_guard.truncated || err_guard.bytes >= bounds.max_stderr_bytes;

    let (status, reason) = if timed_out {
        (
            CheckExecutionStatus::TimedOut,
            Some(format!(
                "execution timed out after {}s",
                bounds.timeout.as_secs()
            )),
        )
    } else if overflowed || stdout_truncated || stderr_truncated {
        if let Some(code) = exit_code {
            if code == 0 {
                (CheckExecutionStatus::Passed, None)
            } else {
                (
                    CheckExecutionStatus::Failed,
                    Some(format!("command exited with status {}", code)),
                )
            }
        } else {
            (
                CheckExecutionStatus::Failed,
                Some("output exceeded maximum byte cap".to_string()),
            )
        }
    } else if let Some(code) = exit_code {
        if code == 0 {
            (CheckExecutionStatus::Passed, None)
        } else {
            (
                CheckExecutionStatus::Failed,
                Some(format!("command exited with status {}", code)),
            )
        }
    } else if let Some(sig) = &signal {
        (
            CheckExecutionStatus::Failed,
            Some(format!("terminated by signal {}", sig)),
        )
    } else {
        (
            CheckExecutionStatus::Failed,
            Some("command terminated abnormally".to_string()),
        )
    };

    RawProcessOutcome {
        status,
        exit_code,
        signal,
        duration_ms,
        stdout_digest: Some(out_digest),
        stderr_digest: Some(err_digest),
        stdout_excerpt,
        stderr_excerpt,
        stdout_truncated,
        stderr_truncated,
        started_at_ms,
        reason,
    }
}
