/**
 * Heidi Parallel Context — compact Fast Harness parallel packet (Roadmap item 2b).
 *
 * Renders ONLY status/phase/directive metadata from the active coordinator so the
 * Fast Harness can observe parallel fan-out without leaking hidden reasoning,
 * transcripts, or child chain-of-thought into provider context.
 *
 * Linear and cheap: reads a small fixed set of coordinator fields, never throws,
 * never invokes an LLM, and returns "" when no coordinator is registered.
 */

import { getParallelCoordinator } from "./heidi-active-coordinator"

/**
 * Render a compact (<200 token) Fast Harness parallel packet for a session.
 * Returns "" when no coordinator is registered for that session id.
 */
export function renderParallelPacket(sessionID: string): string {
  const coord = getParallelCoordinator(sessionID)
  if (!coord) return ""

  const desc = coord.describe()
  const lines: string[] = []

  const children = desc.children
    .map((c) => c.workstreamId + "(" + c.specialist + ":" + c.state + ":" + c.integration + ")")
    .join(" ")
  lines.push("Parallel CoA: " + (children.length > 0 ? children : "-"))

  lines.push("Ready: " + desc.readyCount)

  const ownership = desc.coordinatorOwnership.integrationScopes.join(",")
  lines.push("Coordinator ownership: " + (ownership.length > 0 ? ownership : "-"))

  const directive = desc.nextDirective
  lines.push("Next: " + directive.kind + " " + (directive.reason ?? ""))

  return lines.join("\n")
}

/** Approximate token estimate: ~chars/4, matching the global cores-prompt heuristic. */
export function estimateParallelPacketTokens(sessionID: string): number {
  return Math.round(renderParallelPacket(sessionID).length / 4)
}
