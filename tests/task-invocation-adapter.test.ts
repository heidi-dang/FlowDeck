import { describe, it, expect } from "bun:test"
import { normalizeTaskInvocation } from "../src/services/task-invocation-adapter"

describe("normalizeTaskInvocation", () => {
  describe("target resolution — subagent_type takes priority", () => {
    it("reads subagent_type as targetAgent when present", () => {
      const result = normalizeTaskInvocation(
        { sessionID: "s1", callID: "c1", agent: "heidi" },
        { subagent_type: "security-auditor", prompt: "Audit the auth module" },
      )
      expect(result.targetAgent).toBe("security-auditor")
      expect(result.resolvedFrom).toBe("subagent_type")
    })

    it("falls back to args.agent when subagent_type is absent", () => {
      const result = normalizeTaskInvocation(
        { sessionID: "s2", callID: "c2", agent: "heidi" },
        { agent: "backend-coder", prompt: "Implement the feature" },
      )
      expect(result.targetAgent).toBe("backend-coder")
      expect(result.resolvedFrom).toBe("agent")
    })

    it("prefers subagent_type over agent when both are present", () => {
      const result = normalizeTaskInvocation(
        { sessionID: "s3", callID: "c3", agent: "heidi" },
        { subagent_type: "mapper", agent: "backend-coder" },
      )
      expect(result.targetAgent).toBe("mapper")
      expect(result.resolvedFrom).toBe("subagent_type")
    })

    it("returns empty targetAgent and resolvedFrom=none when neither field is set", () => {
      const result = normalizeTaskInvocation(
        { sessionID: "s4", callID: "c4", agent: "heidi" },
        { prompt: "Just run something" },
      )
      expect(result.targetAgent).toBe("")
      expect(result.resolvedFrom).toBe("none")
    })

    it("treats whitespace-only subagent_type as absent and falls back to agent", () => {
      const result = normalizeTaskInvocation(
        { sessionID: "s5" },
        { subagent_type: "   ", agent: "researcher" },
      )
      expect(result.targetAgent).toBe("researcher")
      expect(result.resolvedFrom).toBe("agent")
    })

    it("treats whitespace-only agent as absent — resolvedFrom=none", () => {
      const result = normalizeTaskInvocation(
        { sessionID: "s6" },
        { subagent_type: "  ", agent: "  " },
      )
      expect(result.targetAgent).toBe("")
      expect(result.resolvedFrom).toBe("none")
    })
  })

  describe("caller resolution", () => {
    it("reads caller from hookInput.agent", () => {
      const result = normalizeTaskInvocation(
        { agent: "heidi", sessionID: "s7" },
        { subagent_type: "reviewer" },
      )
      expect(result.callerAgent).toBe("heidi")
    })

    it("defaults caller to 'orchestrator' when hookInput.agent is absent", () => {
      const result = normalizeTaskInvocation(
        { sessionID: "s8" },
        { subagent_type: "reviewer" },
      )
      expect(result.callerAgent).toBe("orchestrator")
    })

    it("defaults caller to 'orchestrator' when hookInput.agent is whitespace", () => {
      const result = normalizeTaskInvocation(
        { agent: "   ", sessionID: "s9" },
        { subagent_type: "reviewer" },
      )
      expect(result.callerAgent).toBe("orchestrator")
    })
  })

  describe("metadata passthrough", () => {
    it("copies sessionID and callID from hookInput", () => {
      const result = normalizeTaskInvocation(
        { sessionID: "sess-abc", callID: "call-123", agent: "heidi" },
        { subagent_type: "tester" },
      )
      expect(result.sessionID).toBe("sess-abc")
      expect(result.callID).toBe("call-123")
    })

    it("defaults sessionID and callID to empty string when absent", () => {
      const result = normalizeTaskInvocation(
        {},
        { subagent_type: "tester" },
      )
      expect(result.sessionID).toBe("")
      expect(result.callID).toBe("")
    })

    it("passes prompt through when present", () => {
      const result = normalizeTaskInvocation(
        { sessionID: "s10" },
        { subagent_type: "architect", prompt: "Design the data layer" },
      )
      expect(result.prompt).toBe("Design the data layer")
    })

    it("passes description through when present", () => {
      const result = normalizeTaskInvocation(
        { sessionID: "s11" },
        { subagent_type: "planner", description: "Task breakdown" },
      )
      expect(result.description).toBe("Task breakdown")
    })

    it("returns undefined prompt and description when not supplied", () => {
      const result = normalizeTaskInvocation(
        { sessionID: "s12" },
        { subagent_type: "mapper" },
      )
      expect(result.prompt).toBeUndefined()
      expect(result.description).toBeUndefined()
    })
  })

  describe("native background mode", () => {
    it("records background=true from the OpenCode Task payload", () => {
      const result = normalizeTaskInvocation(
        { sessionID: "s15" },
        { subagent_type: "mapper", background: true },
      )
      expect(result.background).toBe(true)
    })

    it("defaults background to false for foreground Task calls", () => {
      const result = normalizeTaskInvocation(
        { sessionID: "s16" },
        { subagent_type: "reviewer", background: false },
      )
      expect(result.background).toBe(false)
    })
  })

  describe("non-string values are safely ignored", () => {
    it("ignores numeric subagent_type", () => {
      const result = normalizeTaskInvocation(
        { sessionID: "s13" },
        { subagent_type: 42 as unknown as string, agent: "devops" },
      )
      expect(result.targetAgent).toBe("devops")
      expect(result.resolvedFrom).toBe("agent")
    })

    it("ignores null values", () => {
      const result = normalizeTaskInvocation(
        { sessionID: "s14" },
        { subagent_type: null as unknown as string },
      )
      expect(result.targetAgent).toBe("")
      expect(result.resolvedFrom).toBe("none")
    })
  })
})
