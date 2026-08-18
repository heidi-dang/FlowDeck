import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import {
  resolveGovernanceMode,
  evaluateGovernanceToolCheck,
  recordRoutingAudit,
  recordRecoveryAudit,
  executeVerifiedPostWrite,
} from "@/services/governance-wiring"
import { auditLogPath, flushAuditBuffer } from "@/services/audit-log"
import { verificationLogPath } from "@/services/verification-layer"

const TMP = join(tmpdir(), "phase5-test-" + Date.now())

describe("Phase 5 — Complete Governance Wiring", () => {
  beforeEach(() => {
    if (!existsSync(TMP)) mkdirSync(TMP, { recursive: true })
  })

  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true })
  })

  describe("1. Governance Modes (off, advisory, strict)", () => {
    it("resolves default mode to advisory when unspecified", () => {
      const mode = resolveGovernanceMode(TMP)
      expect(mode).toBe("advisory")
    })

    it("off mode permits contract violations with allow status", () => {
      writeFileSync(
        join(TMP, ".flowdeck.json"),
        JSON.stringify({ governance: { validator: { mode: "off" } } }),
        "utf-8"
      )

      const res = evaluateGovernanceToolCheck({
        directory: TMP,
        agent: "researcher",
        tool: "write_file",
      })

      expect(res.mode).toBe("off")
      expect(res.action).toBe("allow")
    })

    it("advisory mode returns warn status for contract violations without blocking", () => {
      writeFileSync(
        join(TMP, ".flowdeck.json"),
        JSON.stringify({ governance: { validator: { mode: "advisory" } } }),
        "utf-8"
      )

      const res = evaluateGovernanceToolCheck({
        directory: TMP,
        agent: "researcher",
        tool: "write_file",
      })

      expect(res.mode).toBe("advisory")
      expect(res.action).toBe("warn")
      expect(res.reason).toBeDefined()
    })

    it("strict mode returns block status for contract violations", () => {
      writeFileSync(
        join(TMP, ".flowdeck.json"),
        JSON.stringify({ governance: { validator: { mode: "strict" } } }),
        "utf-8"
      )

      const res = evaluateGovernanceToolCheck({
        directory: TMP,
        agent: "researcher",
        tool: "write_file",
      })

      expect(res.mode).toBe("strict")
      expect(res.action).toBe("block")
      expect(res.reason).toContain("not in allowedTools")
    })
  })

  describe("2. Verification Layer Checks", () => {
    it("passes verification for non-empty existing target files", () => {
      const testFile = join(TMP, "src", "index.ts")
      mkdirSync(join(TMP, "src"), { recursive: true })
      writeFileSync(testFile, 'console.log("hello")', "utf-8")

      const vEvent = executeVerifiedPostWrite(TMP, {
        sessionID: "s1",
        agent: "backend-coder",
        tool: "write_file",
        filePath: testFile,
      })

      expect(vEvent.status).toBe("passed")
      expect(vEvent.checks).toContain("file_exists")
      expect(vEvent.checks).toContain("file_non_empty")
      expect(vEvent.findings).toHaveLength(0)
    })

    it("fails verification for empty target files", () => {
      const emptyFile = join(TMP, "src", "empty.ts")
      mkdirSync(join(TMP, "src"), { recursive: true })
      writeFileSync(emptyFile, "", "utf-8")

      const vEvent = executeVerifiedPostWrite(TMP, {
        sessionID: "s2",
        agent: "backend-coder",
        tool: "write_file",
        filePath: emptyFile,
      })

      expect(vEvent.status).toBe("failed")
      expect(vEvent.checks).toContain("file_empty")
      expect(vEvent.findings).toContain("written file is empty")
    })

    it("fails verification for non-existent target files", () => {
      const missingFile = join(TMP, "src", "ghost.ts")

      const vEvent = executeVerifiedPostWrite(TMP, {
        sessionID: "s3",
        agent: "backend-coder",
        tool: "write_file",
        filePath: missingFile,
      })

      expect(vEvent.status).toBe("failed")
      expect(vEvent.checks).toContain("file_missing")
      expect(vEvent.findings).toContain("written file not found after write")
    })

    it("fails verification for forbidden paths like node_modules", () => {
      const forbiddenFile = join(TMP, "node_modules", "pkg", "index.js")

      const vEvent = executeVerifiedPostWrite(TMP, {
        sessionID: "s4",
        agent: "backend-coder",
        tool: "write_file",
        filePath: forbiddenFile,
      })

      expect(vEvent.status).toBe("failed")
      expect(vEvent.checks).toContain("forbidden_path")
      expect(vEvent.findings).toContain("write targeted a generated/dependency path")
    })
  })

  describe("3. Audit Log Completeness", () => {
    it("records routing audit events to AUDIT.jsonl", () => {
      recordRoutingAudit({
        directory: TMP,
        sessionID: "s-audit-1",
        agent: "heidi",
        strategy: "fast_direct",
        details: { direct: true },
      })

      const path = auditLogPath(TMP)
      flushAuditBuffer()
      expect(existsSync(path)).toBe(true)

      const lines = readFileSync(path, "utf-8").trim().split("\n")
      const last = JSON.parse(lines[lines.length - 1])
      expect(last.kind).toBe("routing.decision")
      expect(last.agent).toBe("heidi")
      expect(last.decision).toBe("fast_direct")
    })

    it("records recovery audit events to AUDIT.jsonl", () => {
      recordRecoveryAudit({
        directory: TMP,
        sessionID: "s-audit-2",
        agent: "heidi",
        errorKey: "tsc_error_1",
        action: "targeted_diagnosis",
        message: "[Recovery 1/3] Targeted diagnosis",
      })

      const path = auditLogPath(TMP)
      const lines = readFileSync(path, "utf-8").trim().split("\n")
      const last = JSON.parse(lines[lines.length - 1])
      expect(last.kind).toBe("recovery.action")
      expect(last.decision).toBe("targeted_diagnosis")
    })

    it("records verification events to VERIFICATION.jsonl and AUDIT.jsonl", () => {
      const testFile = join(TMP, "src", "app.ts")
      mkdirSync(join(TMP, "src"), { recursive: true })
      writeFileSync(testFile, "export const app = {}", "utf-8")

      executeVerifiedPostWrite(TMP, {
        sessionID: "s-audit-3",
        agent: "backend-coder",
        tool: "write_file",
        filePath: testFile,
      })

      const vPath = verificationLogPath(TMP)
      expect(existsSync(vPath)).toBe(true)

      const aPath = auditLogPath(TMP)
      flushAuditBuffer()
      expect(existsSync(aPath)).toBe(true)

      const aLines = readFileSync(aPath, "utf-8").trim().split("\n")
      const lastAudit = JSON.parse(aLines[aLines.length - 1])
      expect(lastAudit.kind).toBe("verification.event")
      expect(lastAudit.decision).toBe("passed")
    })
  })
})
