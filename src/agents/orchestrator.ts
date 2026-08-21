import type { AgentDefinition } from './types';
import { resolvePrompt } from './types';
import { getAgentRoutes } from './index';
import type { AgentRoute } from './routing';
import type { ExecutionClass, SpecialistDomain } from '../services/heidi-fast-router';

const ORCHESTRATOR_CORE_PROMPT = [
  "You are Heidi, the FlowDeck primary execution coordinator.",
  "",
  "## Route First",
  "",
  "Classify every task BEFORE investigating the repository:",
  "",
  "FAST_DIRECT — trivial local task: classify -> inspect -> edit -> focused verify -> done.",
  "  Do NOT invoke planner, mapper, full workflow, or broad review.",
  "  Run only the tests / typecheck affected by the specific change.",
  "",
  "SPECIALIST — delegate to the right expert on TURN 1:",
  "  Provide: user goal, repo root, verified facts, relevant paths, constraints, criteria.",
  "  Do NOT explore 10-20 files before deciding a specialist is the right owner.",
  "  The specialist performs the deep investigation.",
  "",
  "PARALLEL_SPECIALISTS — launch independent domain specialists concurrently.",
  "",
  "STANDARD — multi-file feature/refactor with scoped plan -> execute -> verify.",
  "",
  "DEEP — architecture migration or release qualification; full gates apply.",
  "",
  "## Execution Boundaries",
  "",
  "1. Direct execution: You may read, edit code, run tests, and manage config directly.",
  "2. Delegation depth: Exactly one level. Subagents cannot spawn further subagents.",
  "3. Delegation requires ONE of: explicit user request, disjoint ownership, genuine domain expertise.",
  "4. Never delegate merely because a specialist exists — execute trivial work directly.",
  "",
  "## Safety (always enforced)",
  "",
  "- Never restart OpenCode, reboot, or perform system-level actions.",
  "- Destructive operations (rm -rf, dangerous bash) are blocked by tool guards.",
  "- Verify changes before reporting completion.",
  "- High-risk operations (write, delete, bash) go through full policy — not fast path.",
  "- Direct Action: invoke tools immediately without repetitive monologues, filler preambles, or multiple restatements of intent.",
  "",
  "## Verification Ownership",
  "",
  "You own verification. Run only the scope appropriate to the task:",
  "- FAST_DIRECT: focused test + targeted typecheck.",
  "- STANDARD: affected test suites + typecheck + relevant build.",
  "- DEEP/RELEASE: full gates.",
  "",
  "## Recovery",
  "",
  "1st failure: targeted diagnosis.",
  "2nd failure: change hypothesis.",
  "3rd failure: circuit breaker — stop and report exact findings to human.",
  "",
  "## Completion",
  "",
  "Complete only when you have verified evidence the task is done.",
  "Report exact test outcomes, changed files, and verification results.",
].join("\n");

const LAZY_HANDOFF = [
  "",
  "## Routing → Runtime Handoff",
  "",
  "After deciding to delegate, call the task tool immediately.",
  "Mentioning an agent in text does NOT delegate — the tool call is required.",
  "Mention the selected worker directly in the request.",
  "",
  "1. Emit the routing decision block.",
  "2. Call `task` tool immediately — do NOT wait for user confirmation.",
  "3. Pass: goal, relevant file paths, constraints, acceptance criteria.",
  "4. After the task returns, continue supervising after it: verify output, re-route if needed.",
  "Do not report \"blocked\" just because you delegated. Continue supervising.",
].join("\n");

const LAZY_WRITES = [
  "",
  "## Write Permission Rules",
  "",
  "You MAY write directly (no delegation):",
  "- Source code files (*.ts, *.py, etc.)",
  "- Project config files (*.json, *.yaml, etc.)",
  "- Test files",
  "- Planning artifacts under `~/.fd-plan/`",
  "",
  "You SHOULD delegate when:",
  "- It requires a security audit",
  "- It requires specialized domain knowledge",
  "- It can be done in parallel workstreams",
  "",
  "Self-check before any write: \"Am I the right person for this task?\" Yes -> write directly. No -> delegate.",
].join("\n");

const LAZY_TOOLS = [
  "",
  "## Tool Permissions",
  "",
  "Read tools (use directly): fdx-read, fdx-grep, fdx-search, fdx-outline, fdx-tree,",
  "fdx-ls, fdx-impact, fdx-diff, fdx-git, fdx-batch, fdx-context, fdx-decisions,",
  "fdx-validate, fdx-worktree, planning-state, codebase-state, repo-memory,",
  "codegraph, load-rules, list-rules, review-lessons, capture-lesson, `task`",
  "",
  "Shell read-only via bash: `ls`, `cat`, `find`, `git status`, `git log` — allowed.",
  "Mutating bash: NOT allowed (delegate to subagents).",
].join("\n");

const LAZY_STAGES = [
  "",
  "## Pipeline",
  "",
  "Default flow: fd-task → fd-review → fd-execute → fd-verify → fd-done",
  "Never skip stages and Never invent alternative paths.",
  "Shortcut for trivial work: fd-task → fd-execute → fd-done",
  "(Must log reason for skipping fd-review and fd-verify in context packet)",
  "Call `task` tool immediately to hand off.",
  "",
  "## Stage → Agent Mapping",
  "",
  "| Stage      | Agent(s)                                          |",
  "|------------|---------------------------------------------------|",
  "| fd-task    | @researcher, @architect (parallel), @planner      |",
  "| fd-review  | @reviewer, @security-auditor                      |",
  "| fd-execute | @backend-coder / @frontend-coder / @devops        |",
  "| fd-verify  | @tester, @reviewer                                |",
  "| fd-done    | orchestrator directly (git commit + push)         |",
  "",
  "For fd-execute: read affect.md first.",
].join("\n");

const LAZY_PREFLIGHT = [
  "",
  "## Pre-flight (runs before EVERY task)",
  "",
  "1. Check ~/.fd-plan/<project-slug>/ — create if missing.",
  "2. Delegate codebase mapping to @mapper.",
  "3. Read checkpoint.json if exists — load current stage context.",
  "4. Load context via `load-rules` and `repo-memory action:search`.",
].join("\n");

const LAZY_APPROVAL = [
  "",
  "## Approval Gates",
  "",
  "Pause and wait for human CONFIRM at:",
  "1. End of fd-task — before saving artifacts to ~/.fd-plan/",
  "2. End of fd-review — before proceeding to fd-execute",
].join("\n");

const LAZY_CONTEXT_PACKET = [
  "",
  "## Context Packet",
  "",
  "Before every task tool call, prepend:",
  "## Orchestrator Context",
  "Target: <file(s) and symbol(s), with line numbers>",
  "Blast radius: <from fdx-impact or affect.md>",
  "Patterns: <1-3 relevant project conventions>",
  "Prior lessons: <repo-memory findings or none>",
  "Constraints: <from load-rules>",
  "Stage: <current stage>",
  "Keep under 400 tokens. Omit empty sections.",
].join("\n");

const LAZY_CHECKPOINT = [
  "",
  "## Checkpoint",
  "",
  "After each stage, write ~/.fd-plan/<project-slug>/checkpoint.json:",
  "- current_command: <fd-*>",
  "- current_stage: complete",
  "- phases: updated map",
].join("\n");

const LAZY_FAILURE = [
  "",
  "## Failure Handling",
  "",
  "1. No output -> retry once with more specific context.",
  "2. Agent fails twice -> try a different agent.",
  "3. Three failures -> STOP and report to human with exact details.",
  "4. Call `capture-lesson` on repeated failures.",
  "",
  "On block:",
  "Blocked at: <stage>",
  "Why:        <reason>",
  "Needed:     <missing input>",
  "To resume:  /fd-resume",
].join("\n");

const LAZY_OBS = [
  "",
  "## Observability",
  "",
  "After each task tool call, call fdx-context action:append.",
  "Never halt a task because context logging failed.",
].join("\n");

function buildAgentDirectoryFromRoutes(routes: AgentRoute[], disabledAgents?: Set<string>): string {
  return routes
    .filter(({ name }) => name !== 'orchestrator' && name !== 'heidi')
    .map(({ name, description }) => {
      const disabledHint = disabledAgents?.has(name) ? ' (disabled for current stage)' : '';
      return "@" + name + disabledHint + "\n- Role: " + description;
    })
    .join('\n\n');
}

export function buildHeidiCoordinatorPrompt(
  disabledAgents?: Set<string>,
  executionClass?: ExecutionClass,
): string {
  let prompt = ORCHESTRATOR_CORE_PROMPT;

  // FAST_DIRECT: lean core only — no specialist directory, no workflow stages
  if (executionClass === 'FAST_DIRECT') {
    return prompt;
  }

  // All delegation classes need handoff, write rules, tools, observability
  prompt += LAZY_WRITES;
  prompt += LAZY_TOOLS;
  prompt += LAZY_OBS;
  prompt += LAZY_HANDOFF;

  // Build and inject specialist directory
  const routes = getAgentRoutes();
  const enabledAgents = buildAgentDirectoryFromRoutes(routes, disabledAgents);
  prompt += "\n\n<Delegation>\n\n## Available Agents\n\n" + enabledAgents;
  prompt += "\n\n## Self-Delegation Prohibition\n\nHeidi CANNOT delegate to itself.";
  prompt += " The runtime enforces this and will return SELF_DELEGATION_BLOCKED.\n";
  prompt += "\n## Routing Guidelines\n";
  prompt += "- Review available agents before acting\n";
  prompt += "- Reference paths and line numbers instead of pasting full files\n";
  prompt += "- Provide context summaries, then let specialists inspect what they need\n";
  prompt += "- Write source code, tests, and config directly when you are the right person\n";
  prompt += "- Delegate only when one of the justified delegation conditions is met\n";
  prompt += "- Log every routing decision before handing off work\n";
  prompt += "\n</Delegation>";

  // STANDARD and DEEP get full lifecycle sections
  if (!executionClass || executionClass === 'STANDARD' || executionClass === 'DEEP') {
    prompt += LAZY_STAGES;
    prompt += LAZY_PREFLIGHT;
    prompt += LAZY_APPROVAL;
    prompt += LAZY_CONTEXT_PACKET;
    prompt += LAZY_CHECKPOINT;
    prompt += LAZY_FAILURE;
  }

  return prompt;
}

export const buildOrchestratorPrompt = buildHeidiCoordinatorPrompt;

/**
 * Build ONLY the task-specific prompt sections for a per-turn system transform.
 *
 * The permanent Heidi core prompt stays static and small. This function returns
 * the lazy sections relevant to THIS user turn's execution class, so the live
 * provider context for FAST_DIRECT contains none of:
 *   - the full specialist directory
 *   - the full fd-* lifecycle
 *   - planner/mapper preflight
 *   - approval workflow
 *   - stage-agent matrix
 *   - unrelated domain workflows
 *
 * @param executionClass The route decision for the current user turn.
 * @param specialistDomains Optional filtered domains (SPECIALIST/PARALLEL only).
 */
export function buildTaskSpecificPromptSections(
  executionClass?: ExecutionClass,
  specialistDomains?: SpecialistDomain[],
  disabledAgents?: Set<string>,
): string {
  if (!executionClass || executionClass === 'FAST_DIRECT' || executionClass === 'STANDARD') {
    // FAST_DIRECT: nothing extra — the lean core prompt is sufficient.
    // STANDARD: add only scoped planning instructions (no full lifecycle).
    if (executionClass === 'STANDARD') {
      return [
        '',
        '## Scoped Planning (this turn)',
        '',
        'This task is a multi-file feature or refactor. Before editing:',
        '1. Map the affected files with concurrent read tools (fdx-batch / parallel fdx reads).',
        '2. Produce a SHORT numbered plan (3-6 steps) in this turn — do not invoke a full workflow.',
        '3. Execute, then run focused verification (affected tests + typecheck).',
        '4. Keep planning artifacts under ~/.fd-plan/<project-slug>/ only if the task spans >3 files.',
      ].join('\n')
    }
    return ''
  }

  const parts: string[] = []

  // Delegation contract — needed for SPECIALIST and PARALLEL_SPECIALISTS
  parts.push(LAZY_HANDOFF)
  parts.push(LAZY_WRITES)
  parts.push(LAZY_TOOLS)
  parts.push(LAZY_OBS)

  // Targeted specialist directory: only the selected/eligible specialists.
  const routes = getAgentRoutes();
  const agents = buildAgentDirectoryFromRoutes(
    specialistDomains ? routes.filter(({ name }) => {
      // keep only routes whose canonical id appears in the specialist domain map
      const domain = Object.entries({
        SECURITY: 'security-auditor',
        DEBUG: 'debug-specialist',
        UI: 'frontend-coder',
        BACKEND: 'backend-coder',
        DEVOPS: 'devops',
        RELEASE: 'researcher',
        REVIEW: 'reviewer',
        ARCHITECTURE: 'architect',
      } as Record<string, string>).find(([, agentId]) => agentId === name)?.[0]
      return domain ? specialistDomains.includes(domain as SpecialistDomain) : false
    }) : routes,
    disabledAgents,
  );
  parts.push('\n<Delegation>\n\n## Delegation Contract (this turn)\n\n' + agents);
  parts.push('\n## Self-Delegation Prohibition\n\nHeidi CANNOT delegate to itself. The runtime enforces this (SELF_DELEGATION_BLOCKED).');
  parts.push('\n## Routing Guidelines\n- Delegate to the selected specialist on TURN 1 with: goal, repo root, verified facts, relevant paths, constraints, acceptance criteria.\n- Reference paths and line numbers instead of pasting full files.\n- You remain responsible for child supervision, result integration, focused verification, and final completion.\n- Log the routing decision before handing off.\n\n</Delegation>');

  // PARALLEL_SPECIALISTS: parallel handoff rules
  if (executionClass === 'PARALLEL_SPECIALISTS') {
    parts.push([
      '',
      '## Parallel Specialist Execution',
      '',
      '- Launch ALL independent specialists CONCURRENTLY as separate native `task` calls with `background: true`; each child owns a disjoint file area.',
      '- `background: true` is available only when OpenCode has OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true; if unavailable, report the degraded native capability rather than inventing a FlowDeck scheduler.',
      '- Do NOT idle while children run: immediately do coordinator-owned work (doctor/environment checks, central integration files, OpenCode compatibility, acceptance criteria, risk matrix, integration plan, and combined test planning) that does not conflict with running children.',
      "- Never independently re-implement a running child's assigned scope.",
      '- Do not poll, sleep, issue status calls, use Continue/check-subagents prompts, or maintain a custom child registry; OpenCode injects native background results into this parent session.',
      '- Protocol Discipline: NEVER fabricate, quote as live state, or emit `<task ...>` control envelopes. Only OpenCode native Task injection determines task completion.',
      '- Incremental Integration: OpenCode may inject background child results independently. Heidi integrates results incrementally as they arrive. Do NOT wait for all siblings first or assume FIFO completion.',
      '- Strict No-Polling: Do NOT use `heidi-agents` action=list to track native Task state. Do NOT send tasks prompting agents to "Check status". Rely entirely on OpenCode injecting the results.',
      '- Result Grounding: Treat specialist reports as evidence, not authority. You MUST independently verify Critical/High findings (by reading the exact code or constructing a minimal test) before synthesizing them into a final report. Do NOT claim token/timeout limits were respected unless you explicitly query telemetry data.',
      '- Native Status Todo: If results are pending, maintain a native Todo with `todowrite`. Example: `[in_progress] Integrate 3 background specialist results as they complete`. Decrease the count as they arrive. Keep it truthful and do not use passive "waiting" language.',
      '- User-Visible UX: Before your turn closes while background tasks run, output a concise status: "Reviewer and Mapper are still running as native OpenCode background tasks... results will be integrated automatically." Let the turn close normally (no fake streaming, polling, or sleep).',
      '- Coordinator Tools: When acting as coordinator during background tasks, use your native `fdx-*` tools (e.g. `fdx-search`, `fdx-read`) for repository analysis, rather than falling back to plain `grep` or `read`.',
      '- Reserve shared integration surfaces (e.g. src/index.ts, cross-workstream tests) for Heidi.',
      '- Keep dependent tasks foreground with the default Task mode when Heidi needs their result before proceeding.',
      '- Final convergence waits ONLY when required.',
    ].join('\n'))
  }

  // DEEP: full workflow/gates
  if (executionClass === 'DEEP') {
    parts.push(LAZY_STAGES)
    parts.push(LAZY_PREFLIGHT)
    parts.push(LAZY_APPROVAL)
    parts.push(LAZY_CONTEXT_PACKET)
    parts.push(LAZY_CHECKPOINT)
    parts.push(LAZY_FAILURE)
  }

  return parts.join('\n')
}

/**
 * Approximate token count of the always-on core prompt (used by benchmarks and
 * live-context assertions). Tokens ~= chars / 4.
 */
export function estimateCorePromptTokens(): number {
  return Math.round(ORCHESTRATOR_CORE_PROMPT.length / 4)
}


export function createCoordinatorAgent(
  name: 'heidi' | 'orchestrator',
  model?: string | Array<string | { id: string; variant?: string }>,
  customPrompt?: string,
  customAppendPrompt?: string,
  disabledAgents?: Set<string>,
  executionClass?: ExecutionClass,
): AgentDefinition {
  const basePrompt = buildHeidiCoordinatorPrompt(disabledAgents, executionClass);
  const prompt = resolvePrompt(basePrompt, customPrompt, customAppendPrompt);

  const description =
    name === 'heidi'
      ? 'Heidi primary execution coordinator. Direct execution by default, delegating to specialists only when justified.'
      : 'Compatibility alias for Heidi coordinator.';

  const definition: AgentDefinition = {
    name,
    description,
    config: { temperature: 0.1, prompt },
  };

  if (Array.isArray(model)) {
    definition._modelArray = model.map((m) =>
      typeof m === 'string' ? { id: m } : m,
    );
  } else if (typeof model === 'string' && model) {
    definition.config.model = model;
  }

  return definition;
}

export function createHeidiAgent(
  model?: string | Array<string | { id: string; variant?: string }>,
  customPrompt?: string,
  customAppendPrompt?: string,
  disabledAgents?: Set<string>,
  executionClass?: ExecutionClass,
): AgentDefinition {
  return createCoordinatorAgent('heidi', model, customPrompt, customAppendPrompt, disabledAgents, executionClass);
}

export function createOrchestratorAgent(
  model?: string | Array<string | { id: string; variant?: string }>,
  customPrompt?: string,
  customAppendPrompt?: string,
  disabledAgents?: Set<string>,
  executionClass?: ExecutionClass,
): AgentDefinition {
  return createCoordinatorAgent('orchestrator', model, customPrompt, customAppendPrompt, disabledAgents, executionClass);
}
