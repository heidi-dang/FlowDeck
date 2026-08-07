import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { existsSync, mkdirSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { ArtifactStore } from "@/services/artifact-store"
import {
  buildAssignmentContext,
  externalizeToolOutput,
  compactConversationContext,
} from "@/services/context-scoping"

const TMP_DIR = join(tmpdir(), "flowdeck-compaction-test-" + Date.now())

describe("Context Compaction and Externalisation Integration", () => {
  beforeEach(() => {
    if (!existsSync(TMP_DIR)) {
      mkdirSync(TMP_DIR, { recursive: true })
    }
  })

  afterEach(() => {
    rmSync(TMP_DIR, { recursive: true, force: true })
  })

  describe("ArtifactStore & Tool Output Externalisation", () => {
    it("archives oversized output in ArtifactStore and returns reference marker", () => {
      const store = new ArtifactStore({ baseDir: TMP_DIR })
      const hugeOutput = "x".repeat(5000)
      const maxChars = 1000

      const result = externalizeToolOutput(hugeOutput, maxChars, {
        sessionID: "test-sess",
        toolName: "fdx-read",
        artifactStore: store,
        type: "tool_output",
      })

      expect(result.truncated).toBe(true)
      expect(result.originalChars).toBe(5000)
      expect(result.artifactId).toBeDefined()
      expect(result.text).toContain("[Externalized Artifact:")
      expect(result.text).toContain("fdx-context")

      // Verify the content is in the store
      const archived = store.get(result.artifactId!)
      expect(archived).not.toBeNull()
      expect(archived!.content).toBe(hugeOutput)
      expect(archived!.toolName).toBe("fdx-read")
      expect(archived!.sessionID).toBe("test-sess")
    })

    it("handles error extraction in artifact summaries", () => {
      const store = new ArtifactStore({ baseDir: TMP_DIR })
      const errorContent = "Everything is fine\nLine 2: error: Database connection failed!\nLine 3: some more log details\nLine 4: exit code 1"
      const maxChars = 20

      const result = externalizeToolOutput(errorContent, maxChars, {
        sessionID: "test-sess",
        toolName: "fdx-test",
        artifactStore: store,
      })

      const archived = store.get(result.artifactId!)
      expect(archived).not.toBeNull()
      expect(archived!.summary).toContain("[Contains Errors]")
      expect(archived!.summary).toContain("Database connection failed!")
    })
  })

  describe("Conversation Context Compaction", () => {
    it("prunes conversation history turns but preserves system message and recent turns", () => {
      const messages = [
        { role: "system", content: "You are a helpful assistant" },
        { role: "user", content: "Hello, let's start the project" },
        { role: "assistant", content: "Great! Let's do it." },
        { role: "user", content: "Can you create src/index.ts?" },
        { role: "assistant", content: "Done: I created src/index.ts." },
        { role: "user", content: "Nice, now run tests" },
        { role: "assistant", content: "Tests passed successfully" },
      ]

      // Set threshold low enough to force compaction
      const thresholdTokens = 50
      const result = compactConversationContext({
        messages,
        thresholdTokens,
        sessionID: "compaction-sess",
        modifiedFiles: ["src/index.ts"],
      })

      expect(result.compacted).toBe(true)
      expect(result.messages.length).toBeLessThan(messages.length)
      expect(result.messages[0].role).toBe("system")
      expect(result.messages[0].content).toBe("You are a helpful assistant")

      // The last user and assistant message should still be there (the active turns)
      const lastMessage = result.messages[result.messages.length - 1]
      expect(lastMessage.role).toBe("assistant")
      expect(lastMessage.content).toBe("Tests passed successfully")

      // Should contain the compaction marker
      const summaryMsg = result.messages[1]
      expect(summaryMsg.role).toBe("user")
      expect(summaryMsg.content).toContain("## Compacted Execution State")
      expect(summaryMsg.content).toContain("src/index.ts")
    })

    it("replaces existing compaction marker when compacting a second time (prevents nesting)", () => {
      const initialMessages = [
        { role: "system", content: "You are an assistant" },
        { role: "user", content: "## Compacted Execution State\n- Verified Facts: initially done" },
        { role: "user", content: "New step 1" },
        { role: "assistant", content: "Response step 1" },
        { role: "user", content: "New step 2" },
        { role: "assistant", content: "Response step 2" },
      ]

      const result = compactConversationContext({
        messages: initialMessages,
        thresholdTokens: 20, // very small to force compaction
        sessionID: "double-compaction-sess",
      })

      expect(result.compacted).toBe(true)
      
      // The output messages should have exactly one summary block, not nested ones
      const summaryBlocks = result.messages.filter(m => 
        typeof m.content === "string" && m.content.includes("## Compacted Execution State")
      )
      expect(summaryBlocks.length).toBe(1)
    })
  })

  describe("Delegation Bounded Prompt Construction", () => {
    it("excludes parent conversation in child assignment context", () => {
      const assignmentInput = {
        assignment: "Implement user authentication router",
        target: "src/services/auth.ts",
        stage: "fd-execute",
        gitCommit: "a1b2c3d4",
        relevantFiles: ["src/services/auth.ts", "tests/services/auth.test.ts"],
      }

      const result = buildAssignmentContext(assignmentInput)
      expect(result.parentConversationExcluded).toBe(true)
      expect(result.prompt).toContain("## Assignment")
      expect(result.prompt).toContain("## Orchestrator Context")
      expect(result.prompt).toContain("src/services/auth.ts")
      expect(result.prompt).toContain("a1b2c3d4")
      
      // Excludes parent conversational details
      expect(result.prompt).not.toContain("user:")
      expect(result.prompt).not.toContain("assistant:")
    })
  })
})
