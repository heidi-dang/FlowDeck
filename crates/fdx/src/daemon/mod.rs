//! FDX Persistent Daemon
//!
//! Unix socket on Linux/macOS, named pipe on Windows
//! Protocol version handshake
//! Repository index management
//! Worktree isolation
//! Incremental update
//! Idle shutdown
//! Safe fallback
//! Daemon health diagnostics

pub mod client;
pub mod protocol;
pub mod service;
pub mod index;
pub mod health;

pub use client::DaemonClient;
pub use protocol::{ProtocolVersion, DaemonRequest, DaemonResponse};
pub use service::DaemonService;
pub use health::HealthReport;
