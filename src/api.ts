/**
 * FlowDeck API — library exports for consumers that import
 * from @heidi-dang/flowdeck/api (or from the root barrel when
 * not used as an OpenCode plugin).
 *
 * These exports are intentionally separated from the plugin
 * entry point so that the plugin module exposes only the
 * callable server function expected by OpenCode's loader.
 */

export { AGENT_NAMES, createAgent } from "./agents/index"
export { validateDelegationDepth, evaluateGovernanceToolCheck } from "./services/governance-wiring"
export { acquireLock, releaseLock } from "./services/async-lock"
export { runDoctor, formatReport, formatJSON } from "./doctor/doctor"
export { resolveDoctorExitCode } from "./doctor/exit-code.mjs"
export { resolveBetterHarnessConfig } from "./config/index"
export type { ResolvedBetterHarnessConfig } from "./config/index"
