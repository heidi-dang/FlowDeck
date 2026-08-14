# v2 recovery runbook

On startup, FlowDeck opens the existing SQLite database and applies checksummed migrations. The frozen v0.2.6 schema gate remains unchanged; v2 execution tables are versioned migrations above it.

Recovery checks:

1. Run `npm run verify:orchestration:schema` and `node scripts/check-schema-generated.mjs`.
2. Inspect active worktree leases. Expired leases must be reclaimed before dispatch.
3. Reconcile integration attempts. An already recorded integration is never merged twice.
4. Rebuild token usage from the durable usage store. Provider usage events are idempotent by message identity.
5. Reopen the routing and performance projections; historical records remain immutable.

If SQLite reports busy, corruption, or integrity failure, stop dispatch and preserve the database for diagnosis. Do not mask the error with an in-memory replacement.
