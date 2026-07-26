# Phase 12 — Legendary Heidi Agent Skill Architecture & Integration Roadmap

> Upgrading `heidi` into a world-class OpenCode agent runtime through curated skill adoption, execution policy embedding, and agency-grade design taste.

---

## 1. Executive Summary

Phase 12 defines the comprehensive architecture and integration roadmap to transform `heidi` from a standard orchestration agent into a **legendary OpenCode agent runtime**. By synthesizing the top curated skills from the [Vibehackers Skills Directory](https://vibehackers.io/claude-code/skills) — spanning Anthropic's official collection, Obra's superpowers, Matt Pocock's software engineering patterns, Leonxlnx's taste skills, and Pbakaus's `impeccable` design system — `heidi` gains deterministic planning discipline, empirical verification, agency-level frontend design, and token-efficient execution.

---

## 2. Key Skill Categories & Replacement Strategy

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                                LEGENDARY HEIDI RUNTIME                                 │
├──────────────────────┬──────────────────────┬───────────────────┬──────────────────────┤
│ 1. Core Orchestration│ 2. Verification & QA │ 3. Frontend & UI  │ 4. Efficiency/Tokens │
│    & Subagents       │    & TDD Discipline  │    Design Taste   │    & Security        │
└──────────────────────┴──────────────────────┴───────────────────┴──────────────────────┘
```

### 2.1 Core Planning & Orchestration (Anthropic & Obra Superpowers)

| Vibehackers Skill | Source Repo | Current FlowDeck Baseline | Legendary Upgrade Rationale |
| :--- | :--- | :--- | :--- |
| **`brainstorming`** | `obra/superpowers` | Basic prompt intake | **Replaces raw prompt parsing.** Forces `heidi` to ask 2–3 targeted questions to explore user intent, edge cases, and design constraints before touching code. |
| **`writing-plans`** & **`executing-plans`** | `obra/superpowers` | Standard `.fd-plan` generation | **Replaces single-pass planning.** Breaks multi-step tasks into explicit wave phases with review checkpoints after each wave. |
| **`subagent-driven-development`** & **`dispatching-parallel-agents`** | `obra/superpowers` | Direct `task` tool delegation | **Replaces unconstrained subagents.** Enforces max delegation depth of 1, clean context isolation, and non-overlapping file ownership. |

### 2.2 Verification, Testing & Quality (Anthropic & Obra Superpowers)

| Vibehackers Skill | Source Repo | Current FlowDeck Baseline | Legendary Upgrade Rationale |
| :--- | :--- | :--- | :--- |
| **`verification-before-completion`** | `obra/superpowers` | Manual completion claims | **Replaces premature "done" claims.** Mandates empirical command logs (`npm test`, `typecheck`) before any task can be marked complete. |
| **`systematic-debugging`** | `obra/superpowers` | Trial-and-error bug fixes | **Upgrades `BoundedRecoveryTracker`.** Enforces a 3-stage failure protocol: (1) Diagnosis → (2) Change Hypothesis → (3) Circuit Breaker. |
| **`test-driven-development`** | `obra/superpowers` | Post-hoc test writing | **Enforces TDD Discipline.** Requires RED (failing test) → GREEN (pass implementation) → REFACTOR cycle before production code writes. |
| **`webapp-testing`** | `anthropics/skills` | Terminal unit tests only | **Adds Playwright E2E UI verification.** Enables `heidi` to inspect real DOM output, capture browser screenshots, and verify visual flows. |

### 2.3 High-End UI & Frontend Design Taste (Leonxlnx & Pbakaus & Anthropic)

| Vibehackers Skill | Source Repo | Current FlowDeck Baseline | Legendary Upgrade Rationale |
| :--- | :--- | :--- | :--- |
| **`impeccable`** | `pbakaus/impeccable` | Ad-hoc HTML/CSS layouts | **Replaces generic UI defaults.** Provides expert UX audit guidelines, visual hierarchy principles, cognitive load reduction, and accessibility compliance. |
| **`high-end-visual-design`** & **`minimalist-ui`** | `leonxlnx/taste-skill` | Generic component styling | **Agency-level design taste.** Eliminates cheap AI defaults (overused gradients/heavy shadows) in favor of typography, spacing, and bento grids. |
| **`web-artifacts-builder`** | `anthropics/skills` | Single-file HTML output | **Complex frontend builder.** Teaches `heidi` to compose multi-component React, Tailwind CSS, and `shadcn/ui` web applications. |

### 2.4 Architecture, Document & Token Efficiency (Matt Pocock, Anthropic, Juliusbrussee, Sickn33)

| Vibehackers Skill | Source Repo | Current FlowDeck Baseline | Legendary Upgrade Rationale |
| :--- | :--- | :--- | :--- |
| **`improve-codebase-architecture`** | `mattpocock/skills` | Static `doctor` checks | **Deep architecture scanner.** Scans codebase for deepening opportunities, circular dependencies, and modular boundary improvements. |
| **`design-an-interface`** | `mattpocock/skills` | Single API proposal | **"Design It Twice" principle.** Uses parallel subagents to generate radically different API/interface shapes before committing. |
| **`caveman`** | `juliusbrussee/caveman` | Verbose LLM prose | **Reduces output tokens by 65%.** Enables ultra-compressed response mode during high-volume tool loops while preserving full technical accuracy. |
| **`cc-skill-security-review`** | `sickn33/agentic-awesome-skills` | Basic prompt security checks | **Automated vulnerability audit.** Evaluates auth/authz boundaries, input validation, and SQL injection risks before PR approval. |
| **`mcp-builder`** | `anthropics/skills` | Hand-crafted MCP servers | **Standardized MCP Server Builder.** Teaches `heidi` to build Model Context Protocol (MCP) servers in Python (FastMCP) or TypeScript. |
| **`pdf`**, **`docx-official`**, **`xlsx`**, **`pptx`** | `anthropics/skills` | Text-only documentation | **Full document processing.** Direct programmatic manipulation of PDFs, spreadsheets, presentations, and DOCX files. |

---

## 3. Detailed Phase 12 Implementation Steps

### Step 1: Core Execution Policy & Intent Skill Embedding
- Embed `brainstorming`, `writing-plans`, `executing-plans`, `verification-before-completion`, and `systematic-debugging` into `src/skills/` with full frontmatter metadata (`name`, `description`, `origin`).
- Update `src/services/heidi-execution-policy.ts` to reference these skills during preflight routing.

### Step 2: Agency-Grade Design Taste & Frontend Integration
- Vendor `impeccable`, `high-end-visual-design`, and `minimalist-ui` into `src/skills/` for UI tasks.
- Configure `frontend-coder` agent to auto-trigger design taste validation whenever modifying React/HTML/CSS files.

### Step 3: Token Compression & Security Review Scaffolding
- Integrate `caveman` token compression protocol into `src/services/token-optimizer.ts`.
- Integrate `cc-skill-security-review` into `security-auditor` agent prompts and pre-commit checks.

### Step 4: Verification & E2E Testing Integration
- Wire `webapp-testing` skill into `tester` agent using Playwright browser runners.
- Connect post-write verification (`.codebase/VERIFICATION.jsonl`) directly to `verification-before-completion` skill logic.

---

## 4. Verification & Validation Plan

1. **Skill Frontmatter & Length Validation**:
   ```bash
   npm run validate:skills
   ```
2. **Documentation & Slash Command Alignment**:
   ```bash
   npm run validate:docs
   ```
3. **TypeScript Typechecking & Test Suite Execution**:
   ```bash
   npm run typecheck
   npm test
   npm run build
   ```
