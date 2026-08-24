//! Human-readable text formatters for shadow calibration results.

use crate::intelligence::calibration::model::*;

/// Format a full CalibrationRun record as human-readable text.
pub fn format_calibration_run_text(run: &CalibrationRun) -> String {
    let mut out = String::new();
    out.push_str(
        "Shadow Calibration Report:
",
    );
    out.push_str(&format!(
        "  Calibration ID: {}
",
        run.calibration_id
    ));
    out.push_str(&format!(
        "  Source Run ID: {}
",
        run.source_run_id
    ));
    out.push_str(&format!(
        "  Status: {:?}
",
        run.status
    ));
    out.push_str(&format!(
        "  Reference Scope: {:?}
",
        run.policy.scope
    ));
    out.push_str(&format!(
        "  Candidate Plan Digest: {}
",
        run.candidate_plan_digest
    ));
    out.push_str(&format!(
        "  Policy Digest: {}
",
        run.policy_digest
    ));
    out.push_str(&format!(
        "  Reference Truncated: {}
",
        run.reference_truncated
    ));
    out.push_str(&format!(
        "  Duration: {}ms
",
        run.duration_ms
    ));
    out.push_str(
        "
Metrics:
",
    );
    out.push_str(&format!(
        "  Candidate Selected Checks: {}
",
        run.metrics.candidate_selected_count
    ));
    out.push_str(&format!(
        "  Shadow Reference Checks: {}
",
        run.metrics.shadow_reference_count
    ));
    out.push_str(&format!(
        "  Shadow Executed Checks: {}
",
        run.metrics.shadow_executed_count
    ));
    out.push_str(&format!(
        "  Selected Failing Signals: {}
",
        run.metrics.selected_failure_count
    ));
    out.push_str(&format!(
        "  Unselected Failing Signals (Observed Misses): {}
",
        run.metrics.unselected_failure_count
    ));
    out.push_str(&format!(
        "  Shadow Incomplete Checks: {}
",
        run.metrics.shadow_incomplete_count
    ));
    out.push_str(&format!(
        "  Candidate Duration: {}ms
",
        run.metrics.candidate_execution_duration_ms
    ));
    out.push_str(&format!(
        "  Shadow Reference Duration: {}ms
",
        run.metrics.shadow_reference_duration_ms
    ));

    if let Some(sr) = run.metrics.selection_ratio {
        out.push_str(&format!(
            "  Selection Ratio: {:.4}
",
            sr
        ));
    } else {
        out.push_str(
            "  Selection Ratio: N/A
",
        );
    }

    if let Some(cr) = run.metrics.runtime_cost_ratio {
        out.push_str(&format!(
            "  Runtime Cost Ratio: {:.4}
",
            cr
        ));
    } else {
        out.push_str(
            "  Runtime Cost Ratio: N/A
",
        );
    }

    if let Some(recall) = run.metrics.signal_recall {
        out.push_str(&format!(
            "  Signal Recall: {:.2}%
",
            recall * 100.0
        ));
    } else {
        out.push_str(
            "  Signal Recall: N/A (no failing signal observed in reference set)
",
        );
    }

    out.push_str(
        "
Shadow Checks:
",
    );
    for check in &run.checks {
        let tag = if check.candidate_selected {
            "[SELECTED]"
        } else {
            "[SHADOW]  "
        };
        let miss_tag = if check.is_observed_shadow_miss {
            " ** OBSERVED MISS **"
        } else {
            ""
        };
        out.push_str(&format!(
            "  {} {} -> {:?} ({}ms, signal: {:?}){}
",
            tag,
            check.check_id,
            check.execution_status,
            check.duration_ms,
            check.signal_class,
            miss_tag
        ));
    }

    out
}

/// Format aggregate calibration statistics as human-readable text.
pub fn format_calibration_stats_text(stats: &CalibrationAggregateStats) -> String {
    let mut out = String::new();
    out.push_str(
        "Shadow Calibration Aggregate Statistics:
",
    );
    out.push_str(&format!(
        "  Total Calibrations: {}
",
        stats.total_calibrations
    ));
    out.push_str(&format!(
        "  Complete Calibrations: {}
",
        stats.complete_calibrations
    ));
    out.push_str(&format!(
        "  Incomplete Calibrations: {}
",
        stats.incomplete_calibrations
    ));
    out.push_str(&format!(
        "  Total Candidate Checks: {}
",
        stats.total_candidate_checks
    ));
    out.push_str(&format!(
        "  Total Shadow Checks: {}
",
        stats.total_shadow_checks
    ));
    out.push_str(&format!(
        "  Total Observed Misses: {}
",
        stats.total_observed_misses
    ));

    if let Some(sr) = stats.mean_selection_ratio {
        out.push_str(&format!(
            "  Mean Selection Ratio: {:.4}
",
            sr
        ));
    }
    if let Some(cr) = stats.mean_runtime_cost_ratio {
        out.push_str(&format!(
            "  Mean Runtime Cost Ratio: {:.4}
",
            cr
        ));
    }
    if let Some(recall) = stats.mean_signal_recall {
        out.push_str(&format!(
            "  Mean Signal Recall: {:.2}%
",
            recall * 100.0
        ));
    }

    out
}
