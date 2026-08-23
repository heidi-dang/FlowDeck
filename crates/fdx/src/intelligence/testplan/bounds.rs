//! Bounds management and injectable limits for test discovery and verification planning.

use std::sync::Mutex;

#[derive(Debug, Clone, Copy)]
pub struct TestPlanLimits {
    pub max_discovered_tests: usize,
    pub max_mapping_edges: usize,
    pub max_selected_checks: usize,
    pub max_fallback_boundaries: usize,
}

impl Default for TestPlanLimits {
    fn default() -> Self {
        Self {
            max_discovered_tests: 5000,
            max_mapping_edges: 50000,
            max_selected_checks: 2000,
            max_fallback_boundaries: 1000,
        }
    }
}

static LIMITS_OVERRIDE: Mutex<Option<TestPlanLimits>> = Mutex::new(None);

pub fn get_active_test_plan_limits() -> TestPlanLimits {
    if let Ok(guard) = LIMITS_OVERRIDE.lock() {
        if let Some(lim) = *guard {
            return lim;
        }
    }
    TestPlanLimits::default()
}

pub struct TestPlanLimitsGuard;

impl Drop for TestPlanLimitsGuard {
    fn drop(&mut self) {
        if let Ok(mut guard) = LIMITS_OVERRIDE.lock() {
            *guard = None;
        }
    }
}

pub fn set_test_limits_override(limits: TestPlanLimits) -> TestPlanLimitsGuard {
    if let Ok(mut guard) = LIMITS_OVERRIDE.lock() {
        *guard = Some(limits);
    }
    TestPlanLimitsGuard
}
