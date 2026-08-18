import { classifyTask } from "../src/services/heidi-fast-router"
import { governanceFastPath } from "../src/services/governance-fast-path"
import { executeBatchReads, type ReadOperation } from "../src/services/read-batch"
import { buildHeidiCoordinatorPrompt } from "../src/agents/orchestrator"
import { liveCorePromptTokens } from "../src/services/heidi-fast-harness-runtime"
import { HeidiPerformanceTracker } from "../src/services/heidi-performance"
import { HeidiTaskState } from "../src/services/heidi-task-state"

function p50ms(fn: () => void, n: number): string {
  const start = performance.now()
  for (let i = 0; i < n; i++) fn()
  const per = (performance.now() - start) / n
  return per.toFixed(4) + " ms"
}

const out: string[] = []

out.push("ROUTING_P50(1k): " + p50ms(() => classifyTask("fix a typo in readme"), 1000))
out.push("ROUTING_MIX_P50(2k): " + p50ms(() => { classifyTask("security audit"); classifyTask("debug why the test fails"); classifyTask("Build the frontend form and backend API") }, 2000))

const BASELINE = 2933
const lean = buildHeidiCoordinatorPrompt(undefined, "FAST_DIRECT")
const leanTokens = Math.round(lean.length / 4)
const fullTokens = Math.round(buildHeidiCoordinatorPrompt().length / 4)
out.push("BASELINE_PROMPT_TOKENS: " + BASELINE)
out.push("FULL_PROMPT_TOKENS(now): " + fullTokens)
out.push("FAST_DIRECT_PROMPT_TOKENS: " + leanTokens)
out.push("PROMPT_REDUCTION_PCT: " + (((BASELINE - leanTokens) / BASELINE) * 100).toFixed(1) + "%")
out.push("LIVE_CORE_PROMPT_TOKENS: " + liveCorePromptTokens())

out.push("GOV_FASTPATH_P50(5k): " + p50ms(() => governanceFastPath("fdx-read", "strict", "src/auth.ts"), 5000))

const executor = async (_t: string, _a: Record<string, unknown>) => { await new Promise(r => setTimeout(r, 40)); return "data" }
const ops: ReadOperation[] = [0,1,2,3].map(i => ({ tool: "fdx-read", args: { file_path: "f" + i + ".ts" }, label: "r" + i }))
const seqStart = performance.now()
for (const _ of ops) await executor("fdx-read", {})
const seqMs = performance.now() - seqStart
const parStart = performance.now()
await executeBatchReads(ops, executor)
const parMs = performance.now() - parStart
out.push("READHEAVY_SEQUENTIAL_4x40ms: " + seqMs.toFixed(1) + " ms")
out.push("READHEAVY_PARALLEL_4x40ms: " + parMs.toFixed(1) + " ms")
out.push("READHEAVY_SPEEDUP: " + (seqMs / parMs).toFixed(2) + "x")

const tr = new HeidiPerformanceTracker("bench")
out.push("TRACKER_SPAN_P50(10k): " + p50ms(() => { const k = tr.startSpan("tool.before"); tr.endSpan(k) }, 10000))

const st = new HeidiTaskState("long", "long session task", "STANDARD")
for (let i = 0; i < 60; i++) st.addVerifiedFact("f" + i)
for (let i = 0; i < 40; i++) st.addChangedFile("f" + i + ".ts")
out.push("TASK_STATE_PACKET_CHARS: " + st.renderContextPacket().length)

const start = performance.now()
for (let i = 0; i < 500; i++) classifyTask("fix typo in the readme file")
out.push("USER_TO_ROUTE_P50: " + ((performance.now() - start) / 500).toFixed(4) + " ms")

console.log(out.join("\n"))