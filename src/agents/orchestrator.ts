import type { AgentDefinition } from './types';
import { resolvePrompt } from './types';
import { getAgentRoutes } from './index';
import type { AgentRoute } from './routing';
import type { ExecutionClass } from '../services/heidi-fast-router';

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
