---
name: executing-plans
description: Execute written implementation plans sequentially with strict review checkpoints and step verification.
origin: vibehackers/obra
---

# Executing Plans Skill

Guides systematic execution of pre-approved implementation plans with milestone verification checkpoints.

## When to Activate

Activate whenever:
- Executing an approved `implementation_plan.md` or `.fd-plan`
- Following a multi-step phase schedule
- Coordinating multi-file code modifications

## Execution Protocol

1. **Step Isolation**: Execute one plan section at a time.
2. **Surgical Edits**: Change only what the plan requires without drive-by refactoring.
3. **Milestone Verification**: Verify step completion using automated tests before proceeding to the next step.
