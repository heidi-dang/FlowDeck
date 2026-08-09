# v2 hardening gates

The hardening suite exercises the authority boundaries instead of trusting
in-memory coordination:

- twenty concurrent lease attempts produce one live owner;
- twenty concurrent integration acknowledgements produce one durable attempt;
- expired leases are reclaimable after restart;
- ownership rejects traversal, Windows drive paths, and nested symlink escapes;
- SQLite WAL recovery and `integrity_check` remain explicit;
- malformed FDX methods, workspace escapes, and oversized values fall back safely;
- the milestone and benchmark validators reject incomplete or hand-edited rollups.

The safety policy is fail-closed for authoritative execution. Optional FDX,
metrics export, and shadow routing failures remain non-blocking diagnostics.
No hardening command creates a tag, publishes npm, or changes the stable line.
