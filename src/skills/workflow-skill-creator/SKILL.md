---
name: workflow-skill-creator
description: Distill completed user multi-step session workflows into reusable, production-ready agent skills.
origin: vibehackers/science
---

# Workflow-to-Skill Distiller Skill

Extracts completed session interactions and packages them into reusable agent skills with optional CLI scripts.

## When to Activate

Activate whenever:
- User requests *"make this a skill"* or *"package this workflow into a skill"*
- Distilling a verified multi-step phase into a repeatable runbook
- Creating automated helper scripts for complex multi-tool sequences

## Distillation Pipeline

1. **Phase 1 (Brainstorming)**: Conduct 2-3 iterative question rounds establishing inputs, outputs, and edge cases.
2. **Phase 2 (Design Document)**: Draft directory layout, frontmatter schema, and CLI subcommands.
3. **Phase 3 (Implementation)**: Write `SKILL.md` and optional argparse scripts writing output to `--output` files.
4. **Phase 4 (Validation)**: Run sample queries to confirm triggering and execution accuracy.
