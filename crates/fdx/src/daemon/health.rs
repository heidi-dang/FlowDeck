//! Daemon health diagnostics

use std::time::{Duration, Instant};

/// Health report for the daemon
#[derive(Debug, Clone)]
pub struct HealthReport {
    /// Daemon uptime in seconds
    pub uptime_secs: u64,
    /// Number of indexed repositories
    pub index_count: usize,
    /// Cache size in bytes
    pub cache_size: usize,
    /// Memory usage in MB
    pub memory_mb: u64,
    /// Whether the daemon is responsive
    pub responsive: bool,
    /// Last activity timestamp
    pub last_activity: Option<Duration>,
    /// Number of active connections
    pub active_connections: usize,
    /// Number of requests processed
    pub requests_processed: u64,
    /// Number of errors encountered
    pub errors: u64,
}

impl HealthReport {
    pub fn new(start_time: Instant) -> Self {
        Self {
            uptime_secs: start_time.elapsed().as_secs(),
            index_count: 0,
            cache_size: 0,
            memory_mb: 0,
            responsive: true,
            last_activity: None,
            active_connections: 0,
            requests_processed: 0,
            errors: 0,
        }
    }

    pub fn with_stats(
        mut self,
        index_count: usize,
        cache_size: usize,
        active_connections: usize,
        requests_processed: u64,
        errors: u64,
    ) -> Self {
        self.index_count = index_count;
        self.cache_size = cache_size;
        self.active_connections = active_connections;
        self.requests_processed = requests_processed;
        self.errors = errors;
        self
    }

    pub fn with_memory(self, memory_mb: u64) -> Self {
        Self { memory_mb, ..self }
    }

    pub fn with_last_activity(self, last_activity: Duration) -> Self {
        Self {
            last_activity: Some(last_activity),
            ..self
        }
    }

    /// Check if daemon should be considered healthy
    pub fn is_healthy(&self) -> bool {
        self.responsive && self.errors < 100
    }

    /// Check if daemon should shutdown due to idle
    pub fn should_shutdown(&self, idle_timeout: Duration) -> bool {
        if let Some(last) = self.last_activity {
            return last > idle_timeout;
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_health_report() {
        let report = HealthReport::new(Instant::now())
            .with_stats(2, 1024, 1, 100, 5)
            .with_memory(50);

        assert!(report.is_healthy());
        assert_eq!(report.index_count, 2);
        assert_eq!(report.cache_size, 1024);
    }
}
