---
name: writing-plans
description: Formulate structured implementation plans with explicit verification steps before modifying code.
origin: vibehackers/obra
---

# Writing Plans Skill

Creates clear, actionable technical design plans before touching codebase files.

## When to Activate

Activate whenever:
- Starting a non-trivial feature or multi-phase refactor
- Resolving architectural ambiguity or design choices
- Preparing implementation plans for user approval

## Plan Requirements

1. **Goal & Requirements**: State clear goals and success criteria.
2. **Component Breakdown**: List target files grouped by component with `[MODIFY]`, `[NEW]`, or `[DELETE]`.
3. **Verification Steps**: Define explicit automated test commands and manual checks.
