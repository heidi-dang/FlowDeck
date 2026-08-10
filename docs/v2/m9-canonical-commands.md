# M9: Canonical Executable Commands

M9 places executable command policy behind a versioned `CommandRegistry` and a
durable SQLite invocation boundary. The registry owns command identity,
aliases, validation, security policy, planning, retry, token, verification,
and completion requirements. The `DurableCommandExecutor` owns only invocation
coordination and delegates execution authority to the existing V2 runtime.

The eight core commands are `task/start`, `plan`, `execute`, `verify`,
`review/audit`, `resume/recover`, `status`, and `complete`, with the compatible
`fd-*` aliases registered in `core-commands.ts`.

Invocation state is persisted in `command_invocations` by migration v6. The
unique idempotency key and canonical request fingerprint make concurrent
compatible submissions converge on one durable invocation; reuse with a
different command, version, or input fails closed. Restart reconstruction
reads SQLite rather than a process-local cache.

The frozen v0.2.6 schema remains 53 tables, 36 triggers, and 66 indexes. The
live post-migration schema is additive and currently contains 62 tables, 36
triggers, and 84 indexes; both paths require zero foreign-key violations and
`integrity_check = ok`.
