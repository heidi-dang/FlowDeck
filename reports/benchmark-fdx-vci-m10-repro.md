# Milestone 10 Hardened Shadow Calibration Report (R30)

| Item | Value |
|---|---|
| Authoritative starting R29 | `a20583e904e9e5948423fc137f46d74ce62fd45c` |
| Correction | The earlier supplied R29 SHA was incorrect. |
| F27 | `5f0f5f8733e87a6aeb31fd241b3e40f7cfc9875c` |
| H30 | `fae3daf532c97c8822de319342e46016f6fe3e74` |
| Schema | v9; immutable v7→v8 migration independently compared unchanged |

F27 hardens M10 as **measurement-only**. Candidate checks are retained regardless of the additional-shadow limit; M7 physical-process truth is reused; candidate and shadow execution evidence is grouped by process identity; and duration, recall, eligibility, source-artifact binding, exact metadata persistence, canonical record conflicts, legacy-v8 qualification, and privacy boundaries are fail-closed.

## Validation State

| Gate | Result |
|---|---|
| `cargo fmt --all --check` | Passed |
| `cargo check -p fdx` | Passed |
| All `test_calibration_*` targets | Passed |
| Strict total-duration regression | Passed |
| Candidate physical-truth/grouping regression | Passed |
| v8→v9 legacy/eligibility regression | Passed |
| Full `cargo test -p fdx` | Blocked by reproducible unrelated failures in `test_diff_modified_file` and `test_diff_staged_changes` |
| H30 exact-binary run | Not run |

> **Qualification status: not final.** The full FDX gate is not clean, so H30 has not been executed and no binary SHA or benchmark timing is claimed. M11 has not been started.

Milestones 1–9 remained behaviorally frozen. Calibration history has zero M6 planner authority: no result can remove checks or upgrade assurance.
