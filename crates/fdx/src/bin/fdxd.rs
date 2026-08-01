//! fdxd — FDX daemon binary entrypoint.
//!
//! Two modes:
//!   fdxd --stdio                     one-shot: serve NDJSON over stdin/stdout
//!   fdxd --socket <path> [--idle N]  persistent: serve a unix socket
//!
//! The daemon is user-scoped: it is spawned on demand by the FlowDeck client,
//! exits on `shutdown`, on EOF, or after the idle timeout. It is never a
//! system service.

use std::time::Duration;

use fdx::daemon::server::{Server, TransportKind};
use fdx::daemon::transport;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();

    let mut mode: Mode = Mode::Stdio;
    let mut idle: Option<Duration> = None;

    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--stdio" => mode = Mode::Stdio,
            "--socket" => {
                if let Some(path) = args.get(i + 1) {
                    mode = Mode::UnixSocket(path.clone());
                    i += 1;
                } else {
                    eprintln!("fdxd: --socket requires a path");
                    std::process::exit(2);
                }
            }
            "--idle" => {
                if let Some(secs) = args.get(i + 1).and_then(|s| s.parse::<u64>().ok()) {
                    idle = Some(Duration::from_secs(secs));
                    i += 1;
                } else {
                    eprintln!("fdxd: --idle requires a number of seconds");
                    std::process::exit(2);
                }
            }
            "--version" => {
                println!("fdxd {}", env!("CARGO_PKG_VERSION"));
                std::process::exit(0);
            }
            "--help" | "-h" => {
                println!(
                    "fdxd {} — FDX daemon\n\nUSAGE:\n  fdxd --stdio\n  fdxd --socket <path> [--idle SECONDS]\n  fdxd --version\n",
                    env!("CARGO_PKG_VERSION")
                );
                std::process::exit(0);
            }
            other => {
                eprintln!("fdxd: unknown argument '{other}'");
                std::process::exit(2);
            }
        }
        i += 1;
    }

    match mode {
        Mode::Stdio => {
            let mut server = Server::new();
            let mut t = transport::stdio();
            let outcome = server.run(&mut t, TransportKind::Stdio, idle);
            exit_for(outcome);
        }
        Mode::UnixSocket(path) => {
            #[cfg(unix)]
            {
                run_unix_socket(&path, idle);
            }
            #[cfg(not(unix))]
            {
                eprintln!("fdxd: --socket is not supported on this platform; use --stdio");
                std::process::exit(2);
            }
        }
    }
}

enum Mode {
    Stdio,
    UnixSocket(String),
}

#[cfg(unix)]
fn run_unix_socket(path: &str, idle: Option<Duration>) {
    use std::os::unix::net::UnixListener;
    use std::time::Instant;

    // Remove a stale socket from a previous crashed daemon so we never get
    // "address already in use" and never leave a half-dead endpoint.
    match std::fs::remove_file(path) {
        Ok(()) => eprintln!("fdxd: removed stale socket {path}"),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => {
            eprintln!("fdxd: failed to remove stale socket {path}: {e}");
            std::process::exit(2);
        }
    }

    let listener = match UnixListener::bind(path) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("fdxd: failed to bind socket {path}: {e}");
            std::process::exit(2);
        }
    };
    // Non-blocking accept so the daemon can poll for a daemon-wide idle exit
    // even when no client is connected.
    if let Err(e) = listener.set_nonblocking(true) {
        eprintln!("fdxd: failed to set nonblocking accept: {e}");
        std::process::exit(2);
    }
    eprintln!("fdxd: listening on {path} (pid {})", std::process::id());

    let idle = idle.unwrap_or(transport::DEFAULT_IDLE_TIMEOUT);
    let mut last_activity = Instant::now();
    let poll_interval = transport::POLL_INTERVAL;

    // Serve one client at a time (the FlowDeck client model). Accept loop:
    // - Idle (daemon-wide): no connection AND no traffic for `idle` -> exit.
    // - EOF from a client: loop and accept the next client.
    // - Shutdown from a client: remove socket, exit 0.
    loop {
        match listener.accept() {
            Ok((stream, _)) => {
                last_activity = Instant::now();
                let mut server = Server::new();
                let mut t = transport::unix_socket(stream);
                let outcome = server.run(&mut t, TransportKind::Unix, Some(idle));
                match outcome {
                    Ok(o) => {
                        // Client asked to shut the daemon down.
                        if o == fdx::daemon::server::RunOutcome::Shutdown {
                            let _ = std::fs::remove_file(path);
                            std::process::exit(0);
                        }
                        // Idle while a client was attached: the daemon itself
                        // has been idle — exit rather than wait forever.
                        if o == fdx::daemon::server::RunOutcome::Idle {
                            let _ = std::fs::remove_file(path);
                            std::process::exit(0);
                        }
                        // EOF: client disconnected; loop and accept the next.
                        last_activity = Instant::now();
                    }
                    Err(e) => {
                        eprintln!("fdxd: connection error: {e}");
                    }
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                // No pending connection. Check the daemon-wide idle budget.
                if last_activity.elapsed() >= idle {
                    let _ = std::fs::remove_file(path);
                    std::process::exit(0);
                }
                std::thread::sleep(poll_interval);
            }
            Err(e) => {
                eprintln!("fdxd: accept error: {e}");
                std::process::exit(2);
            }
        }
    }
}

fn exit_for(outcome: Result<fdx::daemon::server::RunOutcome, transport::TransportError>) {
    match outcome {
        Ok(o) => {
            let code = match o {
                fdx::daemon::server::RunOutcome::Shutdown => 0,
                fdx::daemon::server::RunOutcome::Eof => 0,
                fdx::daemon::server::RunOutcome::Idle => 0,
                fdx::daemon::server::RunOutcome::Error => 1,
            };
            std::process::exit(code);
        }
        Err(e) => {
            eprintln!("fdxd: {e}");
            std::process::exit(1);
        }
    }
}
