# Future Native Background Subagent UX Design

**Target Repository:** `heidi-dang/opencode-web-ui`  
**Status:** Design / Future Implementation  
**Note:** This is *not* part of the current FlowDeck runtime. It is a roadmap design for how OpenCode Web UI should natively visualize active background tasks.

## Overview
Currently, when Heidi launches OpenCode background tasks (e.g., via `task(background=true)`), the background tasks run efficiently but the web UI does not provide rich visual feedback once the parent assistant turn finishes. Heidi relies on a persistent native Todo (`todowrite`) and user-visible status messages to communicate that integration is pending.

The goal of this design is to specify a richer, native UI visualization layer that renders background task status dynamically, *without* inventing a custom FlowDeck polling mechanism, custom task database, or artificially holding the SSE stream open.

## 1. Core Principles
*   **OpenCode Native Authority:** OpenCode is the sole authority for task IDs, parent/child session IDs, BackgroundJob lifecycles, execution states (running, completed, error, cancelled), result delivery, and completion events.
*   **No FlowDeck Backend Registry:** FlowDeck will not maintain a custom child-task registry, custom scheduler, or custom wake-loop.
*   **Derived UI State:** The web UI will derive its display natively from existing OpenCode background-job / session state events.

## 2. Target UI Panel
The future UI should render a panel (either inline in the chat or docked in a sidebar) similar to this abstract view:

```text
┌────────────────────────────────────────────┐
│ Background specialists                     │
│                                            │
│ ✓ Mapper                         completed │
│ ● Reviewer                       running   │
│ ● Security Auditor               running   │
│                                            │
│ 2 specialists still working                │
└────────────────────────────────────────────┘
```

**State Transitions:**
*   As each specialist finishes: `● → ✓ completed`
*   If one fails: `● → ! failed`
*   If cancelled: `● → × cancelled`

When a native child result completes and OpenCode injects it, waking Heidi:
```text
Background specialists
✓ Mapper
✓ Reviewer
● Security Auditor

Heidi is integrating completed specialist results…
```

When final convergence finishes:
```text
✓ All specialist results integrated
```

## 3. UI Lifecycle & Parent-Child Distinction
*   **Child state vs. Parent integration state:** It is crucial that the UI distinguishes between "child execution complete" and "overall objective complete". Even when all background children display as `✓ completed`, Heidi's integration step may still be active.
*   **Multiple Parent Sessions:** The panel must be correctly scoped. If Parent Session A has Reviewer and Mapper, and Parent Session B has Tester and Auditor, the UI panel for Session A must *only* show Session A's workers. Correlation relies natively on `parentSessionID`, `childSessionID`, and `taskID`.

## 4. Reconnection and Reconstruction
The UI cannot depend exclusively on transient SSE messages to maintain state. 
If the user refreshes the browser while specialists are running:
*   **Page Reload** → UI queries/reconstructs native task/session state from the OpenCode backend.
*   **Restore Panel** → Background specialist panel resumes live SSE updates.

*Rule:* SSE/events provide live updates; native server/session state provides reconstruction.

## 5. Conceptual Native Event Model
The `opencode-web-ui` implementation must rely on native OpenCode APIs. The conceptual event model is detailed below. 
*(Note: These are conceptual state/events — exact OpenCode API/event names must be verified against the target OpenCode version before implementation. Do not assume these exact string constants exist yet).*

```text
BACKGROUND TASK STARTED
- taskID
- parentSessionID
- childSessionID
- agent
- description
- startedAt

BACKGROUND TASK COMPLETED
- taskID
- childSessionID
- completedAt
- result metadata

BACKGROUND TASK ERROR
- taskID
- childSessionID
- error metadata

BACKGROUND TASK CANCELLED
- taskID
- childSessionID
- cancelledAt
```

### Implementation Discovery Hierarchy
1.  **Existing native OpenCode background-task/session event:** Use it directly.
2.  **Existing native generic session/task event:** If it contains enough metadata, derive UI state from it.
3.  **Missing UI-facing projection:** If the backend has the state but no frontend event, add the smallest `opencode-web-ui`/backend adapter necessary.
4.  **No viable state/event:** Only as a last resort, design a minimal upstream-compatible extension to the native OpenCode API. Never make FlowDeck the database.

## 6. Cancellation UX
The future UI should eventually expose native cancellation state and controls (if OpenCode APIs safely support them):
*   `Cancel specialist`
*   `Open child session` (link to view the subagent's dedicated chat view)
*   `View completed result`

*Requirement:* Do not promise or render controls that have not been verified against stable OpenCode backend APIs. The v1 implementation can be read-only status.

## 7. Accessibility and Mobile Requirements
*   Status indicators must not rely solely on color (use textual `running`/`completed`/`failed`/`cancelled` labels).
*   Live updates must be readable by screen readers (e.g., using `aria-live`).
*   The panel must render compactly on mobile viewports.
*   No permanently animated UI after completion.
*   Respect the user's `prefers-reduced-motion` settings.
*   Completed tasks must remain inspectable without dominating the chat history.

## 8. Non-Goals
*   Implementing a FlowDeck task scheduler.
*   Polling child sessions from the Heidi orchestrator.
*   Keeping assistant SSE turns artificially open (e.g., via sleep loops or heartbeat text).
*   Creating a second BackgroundJob database.
*   Replacing OpenCode Task functionality.
*   Duplicating OpenCode session state in browser memory without a server source of truth.
*   Guessing task completion by reading FlowDeck's Todo state.
*   Requiring FlowDeck to be installed just to get generic OpenCode background-task visualization.
