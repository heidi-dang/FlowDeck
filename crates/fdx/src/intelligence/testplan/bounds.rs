//! Bounds management and injectable limits for test discovery and verification planning.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
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

std::thread_local! {
    static TEST_LIMITS_STACK: std::cell::RefCell<Vec<TestPlanLimits>> = const { std::cell::RefCell::new(Vec::new()) };
    static TEST_DISCOVERY_WALKER_ERROR: std::cell::RefCell<Option<String>> = const { std::cell::RefCell::new(None) };
    static TEST_MAPPING_DB_ERROR: std::cell::RefCell<Option<String>> = const { std::cell::RefCell::new(None) };
}

pub fn get_active_test_plan_limits() -> TestPlanLimits {
    TEST_LIMITS_STACK.with(|stack| stack.borrow().last().copied().unwrap_or_default())
}

pub struct TestPlanLimitsGuard;

impl Drop for TestPlanLimitsGuard {
    fn drop(&mut self) {
        TEST_LIMITS_STACK.with(|stack| {
            stack.borrow_mut().pop();
        });
    }
}

pub fn set_test_limits_override(limits: TestPlanLimits) -> TestPlanLimitsGuard {
    TEST_LIMITS_STACK.with(|stack| {
        stack.borrow_mut().push(limits);
    });
    TestPlanLimitsGuard
}

pub fn with_test_limits<R>(limits: TestPlanLimits, f: impl FnOnce() -> R) -> R {
    let _guard = set_test_limits_override(limits);
    f()
}

pub fn get_test_discovery_walker_error() -> Option<String> {
    TEST_DISCOVERY_WALKER_ERROR.with(|c| c.borrow().clone())
}

pub fn set_test_discovery_walker_error(err: Option<String>) {
    TEST_DISCOVERY_WALKER_ERROR.with(|c| {
        *c.borrow_mut() = err;
    });
}

pub fn with_test_discovery_walker_error<R>(err: Option<String>, f: impl FnOnce() -> R) -> R {
    set_test_discovery_walker_error(err);
    let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(f));
    set_test_discovery_walker_error(None);
    match res {
        Ok(val) => val,
        Err(err) => std::panic::resume_unwind(err),
    }
}

pub fn get_test_mapping_db_error() -> Option<String> {
    TEST_MAPPING_DB_ERROR.with(|c| c.borrow().clone())
}

pub fn set_test_mapping_db_error(err: Option<String>) {
    TEST_MAPPING_DB_ERROR.with(|c| {
        *c.borrow_mut() = err;
    });
}

pub fn with_test_mapping_db_error<R>(err: Option<String>, f: impl FnOnce() -> R) -> R {
    set_test_mapping_db_error(err);
    let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(f));
    set_test_mapping_db_error(None);
    match res {
        Ok(val) => val,
        Err(err) => std::panic::resume_unwind(err),
    }
}
