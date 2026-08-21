import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { FdxSourceCorrelator } from "../src/browser/fdx-correlation"
import type { BrowserFailureFingerprint } from "../src/browser/types"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

function makeFailure(partial: Partial<BrowserFailureFingerprint>): BrowserFailureFingerprint {
  return {
    fingerprint: "fp-123",
    category: "uncaught-exception",
    message: "Test failure",
    firstSeenAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    occurrences: 1,
    navigationGeneration: 1,
    classification: "actionable",
    ...partial,
  }
}

describe("FdxSourceCorrelator Unit Tests", () => {
  let tmpDir: string
  let correlator: FdxSourceCorrelator

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "fdx-correlator-test-"))
    correlator = new FdxSourceCorrelator(tmpDir)
  })

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true })
    } catch {}
  })

  it("correlates explicit source file and line with enclosing symbol", async () => {
    const srcDir = join(tmpDir, "src")
    mkdirSync(srcDir, { recursive: true })
    const fileContent = `
export function renderHeader() {
  const title = "Welcome";
  console.log(title);
  throw new Error("Crash");
}
`
    writeFileSync(join(srcDir, "header.ts"), fileContent)

    const result = await correlator.correlateFailure(
      makeFailure({
        category: "uncaught-exception",
        message: "Crash",
        sourceFile: join(srcDir, "header.ts"),
        line: 5,
        column: 3,
      })
    )

    expect(result).not.toBeNull()
    expect(result?.file).toContain("header.ts")
    expect(result?.line).toBe(5)
    expect(result?.symbolName).toBe("title")
    expect(result?.sourceSnippet).toContain("throw new Error")
  })

  it("correlates by React component name in error message", async () => {
    const srcDir = join(tmpDir, "src", "components")
    mkdirSync(srcDir, { recursive: true })
    const fileContent = `
export const UserBadge = () => {
  return "<span>User</span>";
}
`
    writeFileSync(join(srcDir, "UserBadge.tsx"), fileContent)

    const result = await correlator.correlateFailure(
      makeFailure({
        category: "react-error",
        message: "The above error occurred in <UserBadge> component",
      })
    )

    expect(result).not.toBeNull()
    expect(result?.file).toContain("UserBadge.tsx")
    expect(result?.line).toBeDefined()
  })

  it("correlates network API failures by endpoint path", async () => {
    const srcDir = join(tmpDir, "src")
    mkdirSync(srcDir, { recursive: true })
    const fileContent = `
export async function fetchUsers() {
  return fetch("/api/v1/users");
}
`
    writeFileSync(join(srcDir, "api-client.ts"), fileContent)

    const result = await correlator.correlateFailure(
      makeFailure({
        category: "network-failure",
        message: "Failed to load resource: 500",
        requestUrl: "http://localhost:3000/api/v1/users?page=1",
      })
    )

    expect(result).not.toBeNull()
    expect(result?.file).toContain("api-client.ts")
    expect(result?.symbolName).toContain("/api/v1/users")
  })

  it("returns null when no correlation can be found", async () => {
    const result = await correlator.correlateFailure(
      makeFailure({
        category: "console-error",
        message: "Unknown random error without identifiable tokens",
      })
    )
    expect(result).toBeNull()
  })
})
