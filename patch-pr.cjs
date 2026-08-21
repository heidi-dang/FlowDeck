const fs = require('fs')

const prData = JSON.parse(fs.readFileSync('pr.json', 'utf8'))
let body = prData.body

body = body.replace(
  /Added \`scripts\/benchmark-code-mode\.ts\` demonstrating a 75% reduction in LLM round trips and 43\.5% latency reduction when composing MCP tools via native Code Mode\./,
  `Added \`scripts/benchmark-code-mode-synthetic.ts\` demonstrating a SYNTHETIC MICROBENCHMARK.
    Measures sequential-vs-Promise.all scheduling structure using simulated MCP latency.
    Does NOT measure:
    - actual LLM round trips
    - model token usage
    - OpenCode Code Mode sandbox overhead
    - real MCP transport/IPC latency
    - provider inference latency`
)

body = body.replace(
  /Added live FDX resident daemon health check \(\`fdx\.resident_daemon\`\)\./,
  `Added bounded FDX daemon Startup & IPC capability check (\`fdx.resident_daemon\`) measuring spawn, request, response, and clean shutdown.`
)

body = body.replace(
  /\- Added \`classifyOpenCodeCompatibility\` distinguishing \`FULLY_QUALIFIED\` \(1\.18\.20\), \`RECOMMENDED\` \(1\.18\.20\), \`SUPPORTED\` \(>= 1\.18\.18\), \`DEGRADED\` \(1\.18\.0-1\.18\.17\), and \`UNSUPPORTED\` \(< 1\.18\.0\)\./,
  `- Added \`classifyOpenCodeCompatibility\` distinguishing \`FULLY_QUALIFIED\` (1.18.20), \`SUPPORTED\` (1.18.18-19), \`SUPPORTED_UNVERIFIED\` (>1.18.20), \`DEGRADED\` (1.18.0-1.18.17), and \`UNSUPPORTED\` (< 1.18.0).`
)

body = body.replace(
  /- TS \/ Bun Test: 2,712 passing tests across 265 test suites \(0 failures\)\./,
  `- TS / Bun Test: Fully passing.
- Live OpenCode 1.18.20 Acceptance:
  - Executed: 3
  - Passed: 3
  - Failed: 0
  - Skipped: 0
  - Background task native error injection validated in SQLite.
  - Code Mode isolation and MCP catalog inspection validated.`
)

fs.writeFileSync('new_body.txt', body)
