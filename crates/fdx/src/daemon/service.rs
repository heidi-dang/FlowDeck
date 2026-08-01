//! Daemon service implementation

use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

#[cfg(unix)]
use std::os::unix::net::{UnixListener, UnixStream};

use super::health::HealthReport;
use super::index::RepoIndexManager;
use super::protocol::{DaemonRequest, DaemonResponse, ProtocolVersion};

/// Default socket path for the daemon
#[cfg(unix)]
pub const DEFAULT_SOCKET_PATH: &str = "/tmp/fdx-daemon.sock";

/// Default idle timeout before daemon shuts down
pub const DEFAULT_IDLE_TIMEOUT: Duration = Duration::from_secs(300);

/// Daemon service that handles requests
pub struct DaemonService {
    /// Protocol version
    version: ProtocolVersion,
    /// Index manager
    index_manager: Arc<RepoIndexManager>,
    /// Socket path
    socket_path: PathBuf,
    /// Start time for uptime calculation
    start_time: Instant,
    /// Last activity time
    last_activity: Arc<RwLock<Instant>>,
    /// Number of requests processed
    requests_processed: Arc<RwLock<u64>>,
    /// Number of errors
    errors: Arc<RwLock<u64>>,
    /// Idle timeout
    idle_timeout: Duration,
    /// Running flag
    running: Arc<RwLock<bool>>,
}

impl DaemonService {
    pub fn new(socket_path: Option<PathBuf>) -> Self {
        Self {
            version: ProtocolVersion::current(),
            index_manager: Arc::new(RepoIndexManager::new()),
            socket_path: socket_path.unwrap_or_else(|| PathBuf::from(DEFAULT_SOCKET_PATH)),
            start_time: Instant::now(),
            last_activity: Arc::new(RwLock::new(Instant::now())),
            requests_processed: Arc::new(RwLock::new(0)),
            errors: Arc::new(RwLock::new(0)),
            idle_timeout: DEFAULT_IDLE_TIMEOUT,
            running: Arc::new(RwLock::new(false)),
        }
    }

    /// Set idle timeout
    pub fn with_idle_timeout(mut self, timeout: Duration) -> Self {
        self.idle_timeout = timeout;
        self
    }

    /// Start the daemon service
    pub fn start(&self) -> anyhow::Result<()> {
        // Remove existing socket file
        if self.socket_path.exists() {
            std::fs::remove_file(&self.socket_path)?;
        }

        // Set running flag
        *self.running.write().unwrap() = true;

        // Create Unix socket listener
        #[cfg(unix)]
        {
            let listener = UnixListener::bind(&self.socket_path)?;

            // Set socket permissions
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&self.socket_path, std::fs::Permissions::from_mode(0o600))?;
            }

            self.run_loop(listener);
        }

        #[cfg(not(unix))]
        {
            anyhow::bail!("Daemon only supported on Unix-like systems");
        }

        Ok(())
    }

    #[cfg(unix)]
    fn run_loop(&self, listener: UnixListener) {
        listener.set_nonblocking(false).ok();

        while *self.running.read().unwrap() {
            // Check idle timeout
            if self.should_shutdown() {
                break;
            }

            match listener.accept() {
                Ok((stream, _)) => {
                    self.update_activity();
                    self.handle_connection(stream);
                }
                Err(e) => {
                    if e.kind() != std::io::ErrorKind::WouldBlock {
                        *self.errors.write().unwrap() += 1;
                    }
                    std::thread::sleep(Duration::from_millis(100));
                }
            }
        }

        // Cleanup socket file
        let _ = std::fs::remove_file(&self.socket_path);
    }

    fn handle_connection(&self, mut stream: UnixStream) {
        // Read request
        let mut buffer = vec![0u8; 65536];
        match stream.read(&mut buffer) {
            Ok(n) => buffer.truncate(n),
            Err(_) => {
                *self.errors.write().unwrap() += 1;
                return;
            }
        }

        // Parse request
        let request: DaemonRequest = match serde_json::from_slice(&buffer) {
            Ok(req) => req,
            Err(_) => {
                *self.errors.write().unwrap() += 1;
                let _ = stream.write_all(b"{\"status\":\"Error\",\"message\":\"Invalid request\"}");
                return;
            }
        };

        // Process request
        let response = self.process_request(request);

        // Send response
        let response_bytes = serde_json::to_vec(&response).unwrap_or_default();
        if stream.write_all(&response_bytes).is_err() {
            *self.errors.write().unwrap() += 1;
        }

        *self.requests_processed.write().unwrap() += 1;
    }

    fn process_request(&self, request: DaemonRequest) -> DaemonResponse {
        match request {
            DaemonRequest::Ping => DaemonResponse::ok("pong"),

            DaemonRequest::Handshake { client_version } => DaemonResponse::Handshake {
                server_version: self.version.clone(),
                compatible: client_version.is_compatible(&self.version),
            },

            DaemonRequest::IndexRepo { repo_path, force } => {
                match self.index_manager.index_repo(&repo_path, force) {
                    Ok(_) => DaemonResponse::ok("indexed"),
                    Err(e) => DaemonResponse::error(&e.to_string(), "INDEX_ERROR"),
                }
            }

            DaemonRequest::IncrementalUpdate {
                changed_files,
                deleted_files,
            } => {
                if changed_files.is_empty() && deleted_files.is_empty() {
                    return DaemonResponse::ok("no-op");
                }
                // Use the first changed file's parent as repo root
                if let Some(first) = changed_files.first() {
                    if let Some(parent) = first.parent() {
                        match self
                            .index_manager
                            .incremental_update(parent, &changed_files, &deleted_files)
                        {
                            Ok(_) => DaemonResponse::ok("updated"),
                            Err(e) => DaemonResponse::error(&e.to_string(), "UPDATE_ERROR"),
                        }
                    } else {
                        DaemonResponse::error("No parent directory", "INVALID_PATH")
                    }
                } else {
                    DaemonResponse::ok("no-op")
                }
            }

            DaemonRequest::Health => {
                let (index_count, file_count) = self.index_manager.get_stats();
                let report = HealthReport::new(self.start_time)
                    .with_stats(index_count, file_count, 1, *self.requests_processed.read().unwrap(), *self.errors.read().unwrap());
                DaemonResponse::Health {
                    uptime_secs: report.uptime_secs,
                    index_count: report.index_count,
                    cache_size: report.cache_size,
                    memory_mb: report.memory_mb,
                }
            }

            DaemonRequest::Shutdown => {
                *self.running.write().unwrap() = false;
                DaemonResponse::ok("shutdown")
            }

            _ => DaemonResponse::error("Not implemented", "NOT_IMPLEMENTED"),
        }
    }

    fn update_activity(&self) {
        *self.last_activity.write().unwrap() = Instant::now();
    }

    fn should_shutdown(&self) -> bool {
        let last = *self.last_activity.read().unwrap();
        last.elapsed() > self.idle_timeout
    }

    /// Stop the daemon
    pub fn stop(&self) {
        *self.running.write().unwrap() = false;
    }

    /// Check if daemon is running
    pub fn is_running(&self) -> bool {
        *self.running.read().unwrap()
    }
}

impl Default for DaemonService {
    fn default() -> Self {
        Self::new(None)
    }
}
