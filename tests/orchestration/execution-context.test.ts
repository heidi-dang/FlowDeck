import { describe, expect, it } from "bun:test"
import { buildWorkstreamContext } from "../../src/orchestration/execution/context"

describe("adaptive workstream context", () => {
  it("builds bounded scoped context from workstream inputs without parent replay", () => {
    const result = buildWorkstreamContext({ workstreamId: "w", objective: "implement API", ownedPaths: ["src/api/**"], requirements: ["contract"], acceptanceCriteria: ["tests pass"], contextScope: "owned", strategy: "direct" }, ["artifact-1"])
    expect(result.parentConversationExcluded).toBe(true)
    expect(result.prompt).toContain("src/api/**")
    expect(result.prompt).toContain("artifact-1")
    expect(result.prompt).not.toContain("parent conversation")
  })
})
