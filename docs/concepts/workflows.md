# Workflows

FlowDeck structures every feature through a command cycle. Each step has a clear purpose, produces specific artifacts, and transitions the project state forward.

## The Command Cycle

```
/fd-task
   │
   ▼
/fd-execute ─────────────────────────────────────┐
   │                                             │
   ▼                                             │
/fd-verify ──────────────────────────────────────┼────────┐
   │                                             │        │
   ▼                                             ▼        ▼
/fd-review ─────────────────────────────────► /fd-done ◄──┘
```

Each command reads the current `STATE.md` and writes updated state when it completes. Use `/fd-checkpoint` at any time to save a mid-session snapshot and `/fd-resume` to restore it in a new session.

---

## /fd-task

**Purpose:** Primary entry point to execute a task through the Heidi workflow lifecycle (`intake` → `route` → `context` → `execute` → `verify` → `complete`).

**Step-by-step:**
1. Evaluate user prompt and select execution strategy (`fast_direct`, `direct`, `explore_then_direct`, `planner_then_execute`, `debugger_root_cause`, `frontend_backend_parallel`, `audit_only`, `audit_after_change`).
2. Preflight repository exploration to index codebase state and active skills.
3. Perform surgical changes with pre-edit surface-area inspection.
4. Execute post-write verification checks.

---

## /fd-execute

**Purpose:** Implement feature or changes with TDD discipline and parallel agent delegation.

**Step-by-step:**
1. Read active plan from `STATE.md` or `.fd-plan/`.
2. Invoke specialist agents in parallel within delegation depth limits (max depth 1).
3. Execute post-write verification hooks after file writes.

---

## /fd-verify

**Purpose:** Full verification pipeline — tests, code review, security scan, and build checks.

**Step-by-step:**
1. Run full unit and integration test suites.
2. Verify TypeScript typechecking and syntax.
3. Record verification event in `.codebase/VERIFICATION.jsonl`.

---

## /fd-review

**Purpose:** Supervisor code review gate for final quality approval.

---

## /fd-done

**Purpose:** Mark task complete, verify post-write state, and clear session locks.

---

## Adaptive Workflow Routing

FlowDeck uses **adaptive workflow routing** to select the minimal sufficient workflow for each task. `heidi` scores tasks across multiple dimensions and chooses the lightest workflow strategy that can reliably accomplish the objective.
