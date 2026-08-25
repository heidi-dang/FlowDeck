//! Tests for thread-local, scoped, and nested TestPlanLimits.

use fdx::intelligence::testplan::bounds::{
    get_active_test_plan_limits, set_test_limits_override, with_test_limits, TestPlanLimits,
};
use std::thread;

#[test]
fn test_nested_limit_override_restores_previous() {
    let default_limits = get_active_test_plan_limits();

    let outer_limits = TestPlanLimits {
        max_discovered_tests: 10,
        max_mapping_edges: 20,
        max_selected_checks: 30,
        max_fallback_boundaries: 40,
    };

    let inner_limits = TestPlanLimits {
        max_discovered_tests: 2,
        max_mapping_edges: 3,
        max_selected_checks: 4,
        max_fallback_boundaries: 5,
    };

    with_test_limits(outer_limits, || {
        assert_eq!(get_active_test_plan_limits().max_discovered_tests, 10);

        with_test_limits(inner_limits, || {
            assert_eq!(get_active_test_plan_limits().max_discovered_tests, 2);
        });

        // After inner drops, outer is restored
        assert_eq!(get_active_test_plan_limits().max_discovered_tests, 10);
    });

    // After outer drops, default is restored
    assert_eq!(get_active_test_plan_limits(), default_limits);
}

#[test]
fn test_parallel_limits_isolation() {
    let t1 = thread::spawn(|| {
        let lim1 = TestPlanLimits {
            max_discovered_tests: 111,
            max_mapping_edges: 111,
            max_selected_checks: 111,
            max_fallback_boundaries: 111,
        };
        let _g = set_test_limits_override(lim1);
        for _ in 0..100 {
            assert_eq!(get_active_test_plan_limits().max_discovered_tests, 111);
            thread::yield_now();
        }
    });

    let t2 = thread::spawn(|| {
        let lim2 = TestPlanLimits {
            max_discovered_tests: 222,
            max_mapping_edges: 222,
            max_selected_checks: 222,
            max_fallback_boundaries: 222,
        };
        let _g = set_test_limits_override(lim2);
        for _ in 0..100 {
            assert_eq!(get_active_test_plan_limits().max_discovered_tests, 222);
            thread::yield_now();
        }
    });

    t1.join().unwrap();
    t2.join().unwrap();
}
