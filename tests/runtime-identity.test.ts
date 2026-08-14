import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

import {
  getExecutingRuntimeIdentity,
  recordRuntimeSelfReport,
  readRuntimeSelfReport,
  isRuntimeRecordFresh,
  type FlowDeckRuntimeIdentity,
} from "../src/services/runtime-identity"

describe("runtime-identity service", () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "fd-runtime-identity-test-"))
  })

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  describe("getExecutingRuntimeIdentity", () => {
    it("should derive runtime identity for default context", () => {
      // Act
      const identity = getExecutingRuntimeIdentity()

      // Assert
      expect(identity).toBeDefined()
      expect(identity.pid).toBe(process.pid)
      expect(typeof identity.startedAt).toBe("string")
      expect(new Date(identity.startedAt).getTime()).not.toBeNaN()
      expect(typeof identity.packageName).toBe("string")
      expect(typeof identity.version).toBe("string")
      expect(typeof identity.packageRoot).toBe("string")
      expect(typeof identity.source).toBe("string")
    })

    it("should walk up directory tree to find package.json", () => {
      // Arrange
      const pkgDir = join(tempDir, "sub", "deep")
      mkdirSync(pkgDir, { recursive: true })
      const pkgJson = join(tempDir, "package.json")
      writeFileSync(pkgJson, JSON.stringify({ name: "test-package", version: "1.2.3" }), "utf-8")
      const testFileUrl = `file://${pkgDir}/index.ts`

      // Act
      const identity = getExecutingRuntimeIdentity(testFileUrl)

      // Assert
      expect(identity.packageName).toBe("test-package")
      expect(identity.version).toBe("1.2.3")
      expect(identity.packageRoot).toBe(tempDir)
    })

    it("should determine source correctly as npm-cache", () => {
      // Arrange
      const fakeUrl = "file:///.cache/opencode/packages/my-pkg/index.js"

      // Act
      const identity = getExecutingRuntimeIdentity(fakeUrl)

      // Assert
      expect(identity.source).toBe("npm-cache")
    })

    it("should determine source correctly as package when in node_modules", () => {
      // Arrange
      const fakeUrl = "file:///project/node_modules/my-pkg/index.js"

      // Act
      const identity = getExecutingRuntimeIdentity(fakeUrl)

      // Assert
      expect(identity.source).toBe("package")
    })

    it("should determine source correctly as file for file URL", () => {
      // Arrange
      const fakeUrl = "file:///home/user/project/src/index.ts"

      // Act
      const identity = getExecutingRuntimeIdentity(fakeUrl)

      // Assert
      expect(identity.source).toBe("file")
    })

    it("should determine source as unknown when no path/file info match", () => {
      // Act
      const identity = getExecutingRuntimeIdentity("custom-protocol://dummy")

      // Assert
      expect(identity.source).toBe("unknown")
    })

    it("should capture opencodeSession environment variables if set", () => {
      // Arrange
      const originalEnv = process.env.OPENCODE_SESSION_ID
      process.env.OPENCODE_SESSION_ID = "sess-12345"

      try {
        // Act
        const identity = getExecutingRuntimeIdentity()

        // Assert
        expect(identity.opencodeSession).toBe("sess-12345")
      } finally {
        if (originalEnv !== undefined) {
          process.env.OPENCODE_SESSION_ID = originalEnv
        } else {
          delete process.env.OPENCODE_SESSION_ID
        }
      }
    })
  })

  describe("recordRuntimeSelfReport and readRuntimeSelfReport", () => {
    it("should write and read runtime identity self-report", () => {
      // Arrange
      const identity: FlowDeckRuntimeIdentity = {
        packageName: "flowdeck-test",
        version: "2.0.0",
        moduleUrl: "file:///test/index.ts",
        packageRoot: tempDir,
        source: "file",
        pid: 1234,
        startedAt: new Date().toISOString(),
        opencodeSession: "session-abc",
      }

      // Act
      recordRuntimeSelfReport(identity, tempDir)
      const readBack = readRuntimeSelfReport(tempDir)

      // Assert
      expect(readBack).toEqual(identity)
    })

    it("should gracefully handle filesystem write failures without throwing", () => {
      // Arrange
      const identity: FlowDeckRuntimeIdentity = {
        packageName: "flowdeck-test",
        version: "2.0.0",
        moduleUrl: "file:///test/index.ts",
        packageRoot: tempDir,
        source: "file",
        pid: 1234,
        startedAt: new Date().toISOString(),
      }

      // Act & Assert - pass an invalid directory or path where write fails
      expect(() => {
        recordRuntimeSelfReport(identity, "\0invalid_path")
      }).not.toThrow()
    })

    it("should return null if runtime report does not exist", () => {
      // Act
      const result = readRuntimeSelfReport(tempDir)

      // Assert
      expect(result).toBeNull()
    })

    it("should return null if runtime report JSON is invalid or malformed", () => {
      // Arrange
      const flowdeckDir = join(tempDir, ".flowdeck")
      mkdirSync(flowdeckDir, { recursive: true })
      writeFileSync(join(flowdeckDir, "runtime-self-report.json"), "invalid json", "utf-8")

      // Act
      const result = readRuntimeSelfReport(tempDir)

      // Assert
      expect(result).toBeNull()
    })

    it("should return null if runtime report lacks required fields (packageName or version)", () => {
      // Arrange
      const flowdeckDir = join(tempDir, ".flowdeck")
      mkdirSync(flowdeckDir, { recursive: true })
      writeFileSync(
        join(flowdeckDir, "runtime-self-report.json"),
        JSON.stringify({ pid: 1234 }),
        "utf-8"
      )

      // Act
      const result = readRuntimeSelfReport(tempDir)

      // Assert
      expect(result).toBeNull()
    })
  })

  describe("isRuntimeRecordFresh", () => {
    it("should return true for a recently started runtime record", () => {
      // Arrange
      const record: FlowDeckRuntimeIdentity = {
        packageName: "test",
        version: "1.0.0",
        moduleUrl: "file:///test",
        packageRoot: "/test",
        source: "file",
        pid: 100,
        startedAt: new Date().toISOString(),
      }

      // Act & Assert
      expect(isRuntimeRecordFresh(record)).toBeTrue()
    })

    it("should return false for an expired runtime record older than maxAgeMs", () => {
      // Arrange
      const oldTime = new Date(Date.now() - 360_000).toISOString() // 6 minutes ago
      const record: FlowDeckRuntimeIdentity = {
        packageName: "test",
        version: "1.0.0",
        moduleUrl: "file:///test",
        packageRoot: "/test",
        source: "file",
        pid: 100,
        startedAt: oldTime,
      }

      // Act & Assert
      expect(isRuntimeRecordFresh(record, 300_000)).toBeFalse()
    })

    it("should return false for invalid or missing startedAt date", () => {
      // Arrange
      const record = {
        packageName: "test",
        version: "1.0.0",
        startedAt: "not-a-date",
      } as unknown as FlowDeckRuntimeIdentity

      // Act & Assert
      expect(isRuntimeRecordFresh(record)).toBeFalse()
      expect(isRuntimeRecordFresh(null as unknown as FlowDeckRuntimeIdentity)).toBeFalse()
    })
  })
})
