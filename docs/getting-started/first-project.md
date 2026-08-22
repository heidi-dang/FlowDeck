# First Project — End-to-End Walkthrough

This guide walks through creating a simple feature end-to-end using FlowDeck's canonical workflow.

## Step 1: Initialize Task

In OpenCode:

```
/fd-task "User authentication with JWT"
```

FlowDeck analyzes the codebase with `@mapper`, records requirements and decisions, and creates structured planning artifacts under `~/.fd-plan/`.

## Step 2: Review Plan

In OpenCode:

```
/fd-review
```

Automated review verifies the plan structure, security requirements, and test strategy before any source code is changed.

## Step 3: Execute Implementation

In OpenCode:

```
/fd-execute
```

Specialist agents implement each step following TDD discipline (tests before implementation).

## Step 4: Verify Implementation

In OpenCode:

```
/fd-verify
```

Runs the full verification pipeline:
- Unit and integration tests
- Code review by `@reviewer`
- Security scan by `@security-auditor`
- Contract and build qualification

## Step 5: Complete Task

In OpenCode:

```
/fd-done
```

Finalizes the task, cleans up worktrees, and prepares for git commit/push.

## What You Have Now

After completing the full workflow:

- Persisted planning history under `~/.fd-plan/`
- Working code with comprehensive tests
- Verified code review and security audits
- Clean state ready for pull request
