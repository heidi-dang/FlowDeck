---
name: systematic-debugging
description: Execute structured step-by-step root cause analysis before proposing or applying code fixes.
origin: vibehackers/obra
---

# Systematic Debugging Skill

Enforces structured, empirical root-cause analysis before touching code when encountering any bug or test failure.

## When to Activate

Activate whenever:
- Encountering a failing unit test or build error
- Observing unexpected runtime behavior or API errors
- Investigating flaky or non-deterministic test results

## 3-Stage Recovery Tracker

1. **Stage 1 (Targeted Diagnosis)**: Inspect full error stack traces and logs. Do not guess root causes.
2. **Stage 2 (Change Hypothesis)**: Formulate a clear hypothesis explaining why the error occurs before modifying code.
3. **Stage 3 (Circuit Breaker)**: If two fix attempts fail, halt execution, summarize findings, and present tradeoffs to the user.
