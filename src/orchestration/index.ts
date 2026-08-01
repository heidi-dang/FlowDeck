/**
 * FlowDeck Orchestration Module
 *
 * External interface to the orchestration engine.
 * No business rules, no persistence logic, no UI.
 */

export * from "./types";
export * from "./services";
export * from "./api";
export * from "./streaming";
export * from "./projections";
export * from "./metrics";
export * from "./logging";
export * from "./tracing";
export * from "./diagnostics";
export * from "./telemetry";

// —— Dev 2 runtime modules ——————————————————————————————————————
// Runtime integration wires the Dev 2 runtime (contracts, transitions,
// verification, completion, cancellation, recovery, context budgets,
// telemetry) through the production execution path.
export { RuntimeOrchestrator, type RuntimeConfig, type RuntimeEvent, type RuntimeEventListener } from "./runtime-integration.js";
export type { Unsubscribe } from "./runtime-integration.js";

// Runtime state machine modules
export * from "./runtime";
export * from "./completion";
export * from "./context";
