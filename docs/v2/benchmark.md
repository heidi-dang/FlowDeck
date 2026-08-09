# v2 benchmark methodology

Run:

```bash
npm run benchmark:v2
```

The harness executes the B1–B14 corpus through deterministic task assessment, the SQLite execution scheduler, the authoritative token controller, and restart reconstruction. Results are written as machine-readable JSON to `/tmp/flowdeck-v2-benchmark.json` unless `FLOWDECK_BENCHMARK_OUTPUT` is set.

Each result records success, duration, token usage, agents, workstreams, parallelism, retries, duplicate work, verification failures, integration conflicts, recovery, context volume, and FDX output/latency where applicable.

The historical baseline SHA is recorded as `0ac894959587e5a2dfc11a66766fc834a64d5226`. That baseline predates the v2 routing/execution surface, so the current harness reports the comparison as not executed rather than fabricating a performance delta. A release-readiness report must not present a baseline improvement until an equivalent baseline control is available.
