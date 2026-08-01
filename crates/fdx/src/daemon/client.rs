//! Daemon client for connecting to the FDX daemon

use std::io::{Read, Write};
use std::path::PathBuf;
use std::time::Duration;

#[cfg(unix)]
use std::os::unix::net::UnixStream;

use super::protocol::{DaemonRequest, DaemonResponse, ProtocolVersion};

/// Default socket path
#[cfg(unix)]
pub const DEFAULT_SOCKET_PATH: &str = "/tmp/fdx-daemon.sock";

/// Default connection timeout
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);

/// Client error types
#[derive(Debug)]
pub enum DaemonClientError {
    ConnectionFailed(String),
    RequestFailed(String),
    Timeout,
    ProtocolMismatch,
}

impl std::fmt::Display for DaemonClientError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DaemonClientError::ConnectionFailed(s) => write!(f, "Connection failed: {}", s),
            DaemonClientError::RequestFailed(s) => write!(f, "Request failed: {}", s),
            DaemonClientError::Timeout => write!(f, "Connection timeout"),
            DaemonClientError::ProtocolMismatch => write!(f, "Protocol version mismatch"),
        }
    }
}

impl std::error::Error for DaemonClientError {}

/// Daemon client
pub struct DaemonClient {
    socket_path: PathBuf,
    timeout: Duration,
}

impl DaemonClient {
    pub fn new(socket_path: Option<PathBuf>) -> Self {
        Self {
            socket_path: socket_path
                .unwrap_or_else(|| PathBuf::from(DEFAULT_SOCKET_PATH)),
            timeout: DEFAULT_TIMEOUT,
        }
    }

    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    /// Send a request and get response
    pub fn send_request(&self, request: DaemonRequest) -> Result<DaemonResponse, DaemonClientError> {
        #[cfg(unix)]
        {
            self.send_request_unix(request)
        }

        #[cfg(not(unix))]
        {
            Err(DaemonClientError::ConnectionFailed(
                "Daemon only supported on Unix".to_string(),
            ))
        }
    }

    #[cfg(unix)]
    fn send_request_unix(
        &self,
        request: DaemonRequest,
    ) -> Result<DaemonResponse, DaemonClientError> {
        let mut stream =
            UnixStream::connect(&self.socket_path).map_err(|e| {
                DaemonClientError::ConnectionFailed(e.to_string())
            })?;

        stream
            .write_all(&serde_json::to_vec(&request).unwrap_or_default())
            .map_err(|e| DaemonClientError::ConnectionFailed(e.to_string()))?;

        let mut response_buffer = vec![0u8; 65536];
        let n = stream.read(&mut response_buffer).map_err(|e| {
            DaemonClientError::ConnectionFailed(e.to_string())
        })?;

        response_buffer.truncate(n);

        serde_json::from_slice(&response_buffer)
            .map_err(|e| DaemonClientError::RequestFailed(e.to_string()))
    }

    /// Ping the daemon
    pub fn ping(&self) -> Result<bool, DaemonClientError> {
        match self.send_request(DaemonRequest::Ping) {
            Ok(DaemonResponse::Ok { .. }) => Ok(true),
            _ => Ok(false),
        }
    }

    /// Perform handshake
    pub fn handshake(&self) -> Result<(ProtocolVersion, bool), DaemonClientError> {
        match self.send_request(DaemonRequest::Handshake {
            client_version: ProtocolVersion::current(),
        }) {
            Ok(DaemonResponse::Handshake {
                server_version,
                compatible,
            }) => Ok((server_version, compatible)),
            Ok(_) => Err(DaemonClientError::ProtocolMismatch),
            Err(e) => Err(e),
        }
    }

    /// Check daemon health
    pub fn health(&self) -> Result<DaemonResponse, DaemonClientError> {
        self.send_request(DaemonRequest::Health)
    }

    /// Index a repository
    pub fn index_repo(&self, repo_path: &PathBuf, force: bool) -> Result<(), DaemonClientError> {
        match self.send_request(DaemonRequest::IndexRepo {
            repo_path: repo_path.clone(),
            force,
        }) {
            Ok(DaemonResponse::Ok { .. }) => Ok(()),
            Ok(DaemonResponse::Error { message, .. }) => {
                Err(DaemonClientError::RequestFailed(message))
            }
            Err(e) => Err(e),
            _ => Err(DaemonClientError::RequestFailed(
                "Unexpected response".to_string(),
            )),
        }
    }

    /// Incremental update
    pub fn incremental_update(
        &self,
        changed: Vec<PathBuf>,
        deleted: Vec<PathBuf>,
    ) -> Result<(), DaemonClientError> {
        match self.send_request(DaemonRequest::IncrementalUpdate {
            changed_files: changed,
            deleted_files: deleted,
        }) {
            Ok(DaemonResponse::Ok { .. }) => Ok(()),
            Ok(DaemonResponse::Error { message, .. }) => {
                Err(DaemonClientError::RequestFailed(message))
            }
            Err(e) => Err(e),
            _ => Err(DaemonClientError::RequestFailed(
                "Unexpected response".to_string(),
            )),
        }
    }

    /// Shutdown daemon
    pub fn shutdown(&self) -> Result<(), DaemonClientError> {
        match self.send_request(DaemonRequest::Shutdown) {
            Ok(DaemonResponse::Ok { .. }) => Ok(()),
            Ok(DaemonResponse::Error { message, .. }) => {
                Err(DaemonClientError::RequestFailed(message))
            }
            Err(e) => Err(e),
            _ => Err(DaemonClientError::RequestFailed(
                "Unexpected response".to_string(),
            )),
        }
    }

    /// Check if daemon is running
    pub fn is_daemon_running(&self) -> bool {
        self.ping().unwrap_or(false)
    }
}

impl Default for DaemonClient {
    fn default() -> Self {
        Self::new(None)
    }
}
