/**
 * FlowDeck routing domain — public surface.
 *
 * Deterministic task classification, complexity/ambiguity/risk scoring, and
 * the shared routing contracts consumed by strategy selection, delegation,
 * specialist scheduling, and model routing (implemented in stacked Dev 4
 * milestones). This layer is pure and deterministic: no state machine, no
 * persistence, no model calls. It consumes Dev 2 runtime interfaces and
 * Dev 3 capability metadata through the shared contracts.
 */

export * from "./contracts"
export * from "./classifier/classifier"
export * from "./scoring/scorers"
