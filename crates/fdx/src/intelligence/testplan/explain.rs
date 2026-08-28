//! Explainability and human-readable plan output formatting.

use crate::intelligence::testplan::model::*;
use std::fmt::Write;

pub fn format_verification_plan_text(plan: &VerificationPlan) -> String {
    let mut out = String::new();

    let _ = writeln!(&mut out, "Assurance: {:?}", plan.assurance);
    let _ = writeln!(&mut out, "Semantic Changes: {}", plan.changed.len());
    for ch in &plan.changed {
        if let Some(ref sym) = ch.symbol {
            let _ = writeln!(&mut out, "  - [{:?}] {}::{}", ch.change_kind, ch.file, sym);
        } else {
            let _ = writeln!(&mut out, "  - [{:?}] {}", ch.change_kind, ch.file);
        }
    }

    let _ = writeln!(
        &mut out,
        "Impacted Targets: {}",
        plan.impacted_targets.len()
    );
    for imp in &plan.impacted_targets {
        let _ = writeln!(
            &mut out,
            "  - [{:?}] (depth {}) {}",
            imp.strength, imp.depth, imp.target
        );
    }

    let _ = writeln!(
        &mut out,
        "Planned Checks & Tests ({}):",
        plan.selected_checks.len()
    );
    for check in &plan.selected_checks {
        let sel_str = match check.selection {
            SelectionReason::Evidence => "evidence",
            SelectionReason::PolicyWidening => "widening",
            SelectionReason::MandatoryCheck => "mandatory",
        };
        let _ = writeln!(
            &mut out,
            "  - [{:?}] [{:?}] [{}] {}",
            check.kind, check.strength, sel_str, check.check_id
        );
        let _ = writeln!(&mut out, "    Reason: {}", check.reason);
        if let Some(ref path) = check.evidence_path {
            let _ = writeln!(&mut out, "    Path: {}", path.explanation);
        }
    }

    if !plan.uncertainty.is_empty() {
        let _ = writeln!(&mut out, "Uncertainties ({}):", plan.uncertainty.len());
        for u in &plan.uncertainty {
            let _ = writeln!(&mut out, "  - [{}] {:?}", u.code(), u);
        }
    }

    out
}
