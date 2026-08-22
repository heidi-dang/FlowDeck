# /fd-task

Start or resume a FlowDeck task workflow.

## Usage

```
/fd-task <task description>
```

## Description

Initializes planning artifacts under `~/.fd-plan/<project-slug>/<topic>/`.
Explores the codebase with `@mapper` if not indexed, evaluates architecture with `@architect`, and constructs a phased execution plan with `@planner`.
