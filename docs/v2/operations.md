# v2 operations and troubleshooting

## No worktree dispatch

Check the source SHA, configured worktree root, branch collision, active lease, and ownership claims. A stale lease must be reclaimed explicitly; never delete a live worktree to bypass a lease conflict.

## Enforce falls back

Inspect the structured fallback reason. Typical causes are a stale routing decision, missing token-budget authority, missing worktree executor, invalid specialist, or source drift. Keep `shadow` enabled while investigating.

## FDX unavailable

The daemon and persistent index are optional. FlowDeck falls back to the native FDX CLI or TypeScript implementation. A daemon timeout, malformed response, workspace escape, or cache limit must not return stale intelligence.

## Budget appears stuck

Reconcile the provider message ID, inspect the durable usage record, and verify that a reservation is committed or cancelled exactly once. Do not reset the run budget manually.

## Release state

The v2 development package remains `2.0.0-alpha.1`. No tag, npm publication, GitHub release, deployment, or promotion to `latest` is implied by these checks.
