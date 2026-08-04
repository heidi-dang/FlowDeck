//! FDX daemon — persistent, user-scoped code-intelligence service.
//!
//! Task 2 delivers the skeleton: versioned NDJSON protocol, cross-platform
//! transport abstraction, lifecycle (hello/ping/query/batch/cancel/shutdown,
//! idle-exit, EOF, crash-safe single-message semantics), in-process hosting
//! of a small command surface, and full unit-test coverage.
//!
//! The daemon is additive: existing `fdx` one-shot CLI behavior is untouched,
//! and clients that cannot reach a daemon fall back to one-shot spawns.

pub mod protocol;
pub mod server;
pub mod transport;
