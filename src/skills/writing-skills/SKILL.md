---
name: writing-skills
description: Create, test, and validate custom SKILL.md agent skills following standardized schema rules.
origin: vibehackers/obra
---

# Writing Skills Skill

Provides authoring guidelines for creating high-quality, token-efficient `SKILL.md` files for AI agent runtimes.

## When to Activate

Activate whenever:
- Authoring a new custom skill in `src/skills/` or `.opencode/skills/`
- Editing existing skill markdown files or frontmatter headers
- Validating skill YAML frontmatter schemas

## Skill Authoring Rules

1. **YAML Frontmatter**: Include `name`, `description` (target ≤22 words), and `origin`.
2. **Concise Body**: Keep SKILL.md under 500 lines to preserve agent context budget.
3. **Structured Sections**: Use clear `## ` headings with actionable execution instructions.
