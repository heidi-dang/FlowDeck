# Multi-Repo Coordination (Proposed Specification)

> **Note:** Multi-repo workspace coordination is a proposed architecture specification and is currently under design.

## Overview

FlowDeck's proposed multi-repo architecture enables coordinating changes across multiple repositories in a single session. Each repository will be registered with the session, assigned a role, and managed through workspace configurations.

---

## Workspace Configuration

Declare multi-repo dependencies explicitly in `.flowdeck.json`:

```json
{
  "multiRepo": {
    "repositories": [
      {
        "name": "flowdeck-lib",
        "path": "/home/user/flowdeck-lib",
        "role": "library"
      }
    ],
    "dependencies": [
      {
        "from": "flowdeck",
        "to": "flowdeck-lib",
        "type": "import"
      }
    ]
  }
}
```

---

## Proposed Cross-Repo Planning

In a multi-repo session:

1. The `@planner` agent reads task requirements and repository dependencies
2. Tasks are organized by repository, then by wave within each repository
3. Cross-repo dependencies are resolved before dependent tasks execute
