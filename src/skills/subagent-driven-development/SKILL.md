---
name: subagent-driven-development
description: Dispatch independent multi-step tasks across subagents with clean context isolation and delegation depth limits.
origin: vibehackers/obra
---

# Subagent-Driven Development Skill

Standardizes delegating independent subtasks to subagents while maintaining context hygiene and governance control.

## When to Activate

Activate whenever:
- Executing multi-file refactors or parallel research tasks
- Running independent test suites concurrently
- Exploring multiple parts of the codebase simultaneously

## Delegation Rules

1. **Depth Limit**: Maximum delegation depth is 1. Subagents cannot spawn nested subagents.
2. **Context Scope**: Pass only relevant files and specific goal descriptions to subagent prompts.
3. **Execution Review**: Verify subagent tool calls and findings before incorporating into primary workflow.
