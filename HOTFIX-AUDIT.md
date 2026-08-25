# FlowDeck v2.5.1 Bug Audit Ledger
Generated: 2026-08-25T10:57:36.118Z
Branch: hotfix/v2.5.1-runtime-authority

## BUG-001

**Severity:** P1  
**Status:** FIXED  
**Title:** Internal FlowDeck synthetic messages increment userTurnVersion, creating autonomous loop after finish=stop

**Root Cause:**  
`onChatMessage` in `src/runtime/flowdeck-opencode-adapter.ts` calls  
`sessionTurnRepo.incrementTurnVersion()` for every `role=user` message  
OpenCode delivers — including messages FlowDeck itself injected via  
`session.promptAsync`. This caused the durable `user_turn_version` counter  
to increment on every synthetic orchestration message (specialist dispatch,  
verification prompt, continuation prompt), creating new continuation authority  
on each injection. The next `session.idle` event would then see a fresh  
`userTurnVersion` and dispatch again.

**Observed behavior:**  
1. Heidi completes a model turn with `finish=stop`.  
2. FlowDeck injects `[FlowDeck Specialist Dispatch] ...` via `promptAsync`.  
3. OpenCode echoes the injected message back as `role=user`.  
4. `onChatMessage` calls `incrementTurnVersion` — bumps the counter.  
5. `session.idle` fires; new token built with the bumped version; dispatches again.  
6. Loop: same dispatch re-appears after specialist completed.

**Files changed:**  
- `src/runtime/message-provenance.ts` (new) — authoritative prefix registry  
- `src/runtime/flowdeck-opencode-adapter.ts` — authority boundary guard before incrementTurnVersion  
- `tests/stop-authority-regression.test.ts` (new) — 18 regression tests

**Regression tests:** 18 tests, all pass  
**Fix commit:** see git log  

---

## Pre-existing failures (not introduced by this fix, confirmed on origin/main)

- **P2 Security: Installer argument safety** — doctor-packed test: pre-existing environment issue  
- **FlowDeck Doctor Fix E2E** — doctor-fix-e2e test: pre-existing environment issue  

Both confirmed by running the same tests on `origin/main` before any changes.

---

## Audit scope completed

- ✅ Confirmed loop root cause
- ✅ Traced all wake-up paths (session.idle, message.updated, continuation dispatcher)
- ✅ Verified ContinuationDispatcher atomic SQLite claim (ON CONFLICT DO NOTHING) is correct
- ✅ Verified dispatchReadySpecialists correctly filters settled specialists
- ✅ Verified terminal Run guard in onSessionIdle (line 905, 1109-1110)
- ✅ Verified CompletionPolicy is sole terminal authority (not bypassed)
- ✅ Verified VerificationService stateVersion/fingerprint guards
- ✅ No new .skip/.todo/.only introduced
- ✅ No sleeps added
- ✅ No string-based loop suppression (authority model fixed at source)
