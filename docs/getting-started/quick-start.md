# Quick Start — First 15 Minutes

Get FlowDeck installed and run your first feature workflow in under 15 minutes.

## Step 1: Install FlowDeck

```bash
curl -fsSL https://raw.githubusercontent.com/heidi-dang/flowdeck/main/install.sh | bash
```

See [Installation](installation.md) for alternative install methods.

## Step 2: Verify Installation

```bash
flowdeck doctor
```

Checks that FlowDeck is installed, the OpenCode plugin is loaded, and your environment is ready.

## Step 3: Initialize a Task

In OpenCode:

```
/fd-task "Add user authentication endpoint"
```

Analyzes the project with `@mapper`, explores requirements, and initializes structured planning under `~/.fd-plan/`.

## Step 4: Review the Plan

In OpenCode:

```
/fd-review
```

Performs automated plan quality review and security audit using `@reviewer` and `@security-auditor`.

## Step 5: Execute Implementation

In OpenCode:

```
/fd-execute
```

Executes the plan steps with specialist subagents (`@backend-coder`, `@frontend-coder`, `@devops`) following TDD discipline.

## Step 6: Verify Implementation

In OpenCode:

```
/fd-verify
```

Runs the test suite, linting, typechecking, and contract verification to guarantee stability.

## Step 7: Complete and Commit

In OpenCode:

```
/fd-done
```

Summarizes the outcome, cleans up worktrees, and records the finalized delivery.

## What to Expect

After completing these steps you will have:

- Structured planning logs and decisions under `~/.fd-plan/`
- Working code with passing tests
- Completed verification and review audits
- Safe, non-invasive commits ready for pull request
