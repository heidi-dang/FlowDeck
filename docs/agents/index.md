# Agents

FlowDeck provides a specialized multi-agent coordination system centered around Heidi. Heidi acts as the primary coordinator, performing direct execution by default and delegating to specialist subagents only when justified.

## Delegation Model

Heidi holds the user session context, classifies requests, and dispatches to specialist agents when domain expertise or isolation is needed.

- **primary**: visible and selectable from the user interface (`heidi`, `orchestrator`)
- **subagent**: internal only, invoked for focused domain work

```
user → @heidi
        ├── Direct Execution (FAST_DIRECT)
        └── Specialist Delegation (SPECIALIST / PARALLEL)
             ├── @planner (Wave planning)
             ├── @architect (System design & ADRs)
             ├── @researcher (API & documentation lookup)
             ├── @mapper (Codebase indexing & exploration)
             ├── @backend-coder (Backend, APIs & data layer)
             ├── @frontend-coder (Frontend & UI components)
             ├── @devops (CI/CD, containers & infra)
             ├── @tester (Test suites & TDD)
             ├── @reviewer (Code review & regression risk)
             ├── @security-auditor (OWASP & vulnerability review)
             ├── @debug-specialist (Root cause diagnosis & build fixes)
             └── @browser-debugger (Autonomous UI/browser debugging)
```

All agent configurations derive from `src/services/canonical-registry.ts`.

---

## Primary Coordinator

### @heidi
Heidi primary execution coordinator. Direct execution by default, delegating to specialists only when justified. Can edit code, run tests, and manage configuration directly.

### @orchestrator
Compatibility alias for Heidi primary coordinator. Same direct-execution capability as Heidi.

---

## Planning & Architecture

### @planner
Wave-structured task planning. Takes task descriptions and produces phased implementation plans with dependency graphs and observable success criteria per step.

### @architect
System design and boundary decisions. Produces architecture documents, evaluates technical choices, creates ADRs, and defines API contracts.

### @researcher
Research documentation, APIs, best practices, and third-party libraries. Read-only analysis.

### @mapper
Codebase indexing and exploration. Explores codebase architecture, entry points, dependencies, and file structures into `.codebase/`.

---

## Implementation Specialists

### @backend-coder
Implements server-side features: API endpoints, services, data layer, and business logic using TDD.

### @frontend-coder
Implements UI and client-side features: UI components, client state, styling, and rendering using TDD.

### @devops
Implements DevOps and infrastructure changes: CI/CD pipelines, Docker/containers, deployment scripts, and operations.

### @tester
Test suite implementation and gap closing. Writes and runs tests following TDD principles (tests before implementation).

### @debug-specialist
Diagnoses bugs through systematic root cause analysis. Resolves compilation, type, dependency, and runtime errors.

### @browser-debugger
Autonomous browser debugging specialist for reproducing, diagnosing, and repairing UI, console, and network errors in web applications.

---

## Review & Security

### @reviewer
Reviews code for quality, security, convention adherence, and assesses regression risks and blast radius.

### @security-auditor
Performs deep security audits: OWASP Top 10, injection vulnerabilities, authentication, authorization, and secret leaks.
