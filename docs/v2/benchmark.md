# v2 benchmark methodology

Run:

```bash
npm run benchmark:v2
```

The harness executes the B1–B14 corpus through deterministic task assessment, the SQLite execution scheduler, the authoritative token controller, and restart reconstruction. Results are written as machine-readable JSON to `/tmp/flowdeck-v2-benchmark.json` unless `FLOWDECK_BENCHMARK_OUTPUT` is set.

Each result records success, duration, token usage, agents, workstreams, parallelism, retries, duplicate work, verification failures, integration conflicts, recovery, context volume, and FDX output/latency where applicable. The report also runs the same corpus through a deterministic serial-reference scheduler, so candidate-versus-control measurements are real and reproducible.

The historical baseline SHA is recorded as `0ac894959587e5a2dfc11a66766fc834a64d5226`. That baseline predates the v2 routing/execution surface, so the harness reports the historical comparison as not executed while separately measuring the same-revision serial reference. `npm run verify:benchmark:v2` rejects missing B1–B14 cases, duplicate ids, missing reference results, or an unqualified historical claim.
