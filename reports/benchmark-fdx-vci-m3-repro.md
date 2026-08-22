# M3 Semantic Benchmark reproduction

Report: reports/benchmark-fdx-vci-m3-semantic.json
Source SHA: ab673e043263fbc045b86dc7cb803f53421d721b (committed functional state)
Branch: feat/fdx-verifiable-change-intelligence

Method: release fdx binary (cargo build -p fdx --release); a temp repo with
src/a.ts, src/b.ts, src/c.ts, tsconfig.json; a deterministic fake
scip-typescript provider (copies crates/fdx/tests/fixtures/scip/basic-ts.scip
to --output, reports version 0.4.0). Provider execution time is therefore
fixture-copy time, never FDX-only latency. No real indexer was installed.

Measured operations (ms per sample, release build):

  SCIP_TYPESCRIPT_BIN=<bin> fdx semantic refresh --provider scip-typescript
  fdx semantic status
  fdx semantic decode crates/fdx/tests/fixtures/scip/basic-ts.scip      (484 B)
  fdx semantic decode <16KB fixture>
  fdx semantic references foo --lang typescript --intent reference_complete
  fdx semantic references area --lang rust --intent reference_complete    (fallback)

DB size read from .fdx/index.sqlite before/after a refresh; growth 0 B in
this fixture (replacing the identical generation).
Cache size after benchmark: 0 bytes (ephemeral temporary outputs cleaned).
