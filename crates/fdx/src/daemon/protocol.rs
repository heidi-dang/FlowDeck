//! Daemon protocol definitions

use std::path::PathBuf;
use serde::{Deserialize, Serialize};

/// Current protocol version
pub const PROTOCOL_VERSION: &str = "1.0.0";

/// Protocol version with compatibility range
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProtocolVersion {
    pub major: u16,
    pub minor: u16,
    pub patch: u16,
}

impl ProtocolVersion {
    pub fn new(major: u16, minor: u16, patch: u16) -> Self {
        Self { major, minor, patch }
    }

    pub fn current() -> Self {
        Self::new(1, 0, 0)
    }

    pub fn is_compatible(&self, other: &ProtocolVersion) -> bool {
        self.major == other.major
    }
}

impl std::fmt::Display for ProtocolVersion {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}.{}.{}", self.major, self.minor, self.patch)
    }
}

/// Daemon request types
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum DaemonRequest {
    /// Ping to check daemon is alive
    Ping,

    /// Protocol version handshake
    Handshake {
        client_version: ProtocolVersion,
    },

    /// Initialize or update repository index
    IndexRepo {
        repo_path: PathBuf,
        force: bool,
    },

    /// Read a file with caching
    ReadFile {
        path: PathBuf,
        mode: String,
    },

    /// Search symbols
    SearchSymbols {
        pattern: String,
        paths: Vec<PathBuf>,
        kind: Option<String>,
        max_matches: usize,
    },

    /// Grep search
    Grep {
        pattern: String,
        paths: Vec<PathBuf>,
        context: usize,
    },

    /// Get outline
    Outline {
        paths: Vec<PathBuf>,
    },

    /// Get impact analysis
    Impact {
        files: Vec<PathBuf>,
        root: PathBuf,
        depth: usize,
    },

    /// Git status
    GitStatus,

    /// Incremental index update
    IncrementalUpdate {
        changed_files: Vec<PathBuf>,
        deleted_files: Vec<PathBuf>,
    },

    /// Get daemon health
    Health,

    /// Shutdown daemon gracefully
    Shutdown,
}

/// Daemon response types
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "status")]
pub enum DaemonResponse {
    /// Success response
    Ok {
        data: serde_json::Value,
    },

    /// Error response
    Error {
        message: String,
        code: String,
    },

    /// Health report
    Health {
        uptime_secs: u64,
        index_count: usize,
        cache_size: usize,
        memory_mb: u64,
    },

    /// Handshake response
    Handshake {
        server_version: ProtocolVersion,
        compatible: bool,
    },
}

impl DaemonResponse {
    pub fn ok<T: Serialize>(data: T) -> Self {
        DaemonResponse::Ok {
            data: serde_json::to_value(data).unwrap_or(serde_json::Value::Null),
        }
    }

    pub fn error(message: &str, code: &str) -> Self {
        DaemonResponse::Error {
            message: message.to_string(),
            code: code.to_string(),
        }
    }
}
