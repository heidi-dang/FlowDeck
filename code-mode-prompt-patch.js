const fs = require('fs');

let content = fs.readFileSync('src/agents/orchestrator.ts', 'utf8');

const codeModeGuidanceOld = `  // If native Code Mode is available and turn involves MCP tools / automation composition, include lazy guidance
  const codeModeGuidance = (options?.codeModeAvailable && options?.mcpCompositionCandidate) ? [
    "",
    "## Native Code Mode (OpenCode execute tool)",
    "",
    "- OpenCode provides native experimental Code Mode via the \`execute\` tool when OPENCODE_EXPERIMENTAL_CODE_MODE=true.",
    "- Scope & Boundary: \`execute\` has access ONLY to connected, eligible MCP tools. Do NOT attempt to invoke internal plugin tools (fdx-*, native read, native shell) inside \`execute\`.",
    "- Use \`execute\` when composing dependent MCP calls, filtering/aggregating MCP responses, or running \`Promise.all\` across independent MCP operations in a single turn to eliminate inference round trips.",
  ].join("\n") : ""`;

const codeModeGuidanceNew = `  // If native Code Mode is available and turn involves MCP tools / automation composition, include lazy guidance
  const codeModeGuidance = (options?.codeModeAvailable && options?.mcpCompositionCandidate) ? [
    "",
    "## Native Code Mode (OpenCode execute tool)",
    "",
    "- OpenCode provides native experimental Code Mode via the \`execute\` tool when OPENCODE_EXPERIMENTAL_CODE_MODE=true.",
    "- Scope & Boundary: \`execute\` has access ONLY to connected, eligible MCP tools. Do NOT attempt to invoke internal plugin tools (fdx-*, native read, native shell) inside \`execute\`.",
    "- Use \`execute\` when composing dependent MCP calls, filtering/aggregating MCP responses, or running \`Promise.all\` across independent MCP operations in a single turn to eliminate inference round trips.",
    "",
    "### Code Mode Limits & Guardrails",
    "- Max Tool Calls: 10 total, 4 parallel max.",
    "- Max Dependency Stages: 3 (e.g. Gather -> Correlate -> Return).",
    "- Max Collection Items: 25. Do not map over unbounded arrays; always slice/filter first.",
    "- Execution Timeout: 30 seconds. Result size: under 64 KiB.",
    "- Return structured evidence: \`return { targets, details, missing }\`. Do not generate prose inside Code Mode.",
    "",
    "### Forbidden Control Flow",
    "- NO RETRIES (budget=0): Do not use try/catch in loops to retry failures. Return failures and let Heidi decide.",
    "- NO RECURSION, no nested execute.",
    "- NO Task/specialist spawning: Do not launch agents from inside Code Mode.",
    "- NO infinite/open-ended loops (while, do...while) or setTimeout/setInterval.",
    "- NO shell/filesystem/network operations (allowImports=false, allowDirectNetwork=false, allowShell=false).",
    "",
    "Fall back to Heidi's normal execution loop or delegates if a workflow exceeds these bounds.",
  ].join("\n") : ""`;

if (content.includes(codeModeGuidanceOld)) {
  content = content.replace(codeModeGuidanceOld, codeModeGuidanceNew);
  
  // Need to update ORCHESTRATOR_CORE_PROMPT
  const corePromptOld = `  "- High-risk operations (write, delete, bash) go through full policy — not fast path.",
  "- Direct Action: invoke tools immediately without repetitive monologues, filler preambles, or multiple restatements of intent.",
  "",`;
  
  const corePromptNew = `  "- High-risk operations (write, delete, bash) go through full policy — not fast path.",
  "- Direct Action: invoke tools immediately without repetitive monologues, filler preambles, or multiple restatements of intent.",
  "- Use native Code Mode only for small bounded MCP compositions. Never use it for open-ended reasoning, retries, specialists, shell/filesystem workflows, or complex multi-stage execution.",
  "",`;
  
  content = content.replace(corePromptOld, corePromptNew);
  
  fs.writeFileSync('src/agents/orchestrator.ts', content);
  console.log("Patched orchestrator.ts successfully.");
} else {
  console.log("Could not find codeModeGuidanceOld");
}
