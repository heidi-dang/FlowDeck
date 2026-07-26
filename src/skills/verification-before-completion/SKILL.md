---
name: verification-before-completion
description: Require empirical runtime verification logs before declaring work complete, fixed, or passing.
origin: vibehackers/obra
---

# Verification Before Completion Skill

Enforces gathering empirical evidence (test runs, typecheck output, build status) before declaring any task complete or submitting a pull request.

## When to Activate

Activate whenever:
- Claiming a bug is fixed or a test is passing
- Completing a task or phase implementation
- Preparing code changes for commit or pull request

## Verification Protocol

1. **Execute Verification Commands**: Run `npm run typecheck`, `npm test`, or relevant single-file test suites.
2. **Inspect Output**: Read full execution logs. Do not rely on plausible-looking code changes alone.
3. **Report Evidence**: Provide exact pass counts and build outputs in the final task summary.
