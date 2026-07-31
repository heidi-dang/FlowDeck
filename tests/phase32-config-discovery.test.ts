import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  performSurfaceAreaCheck,
  discoverRelatedConfig,
} from "@/services/heidi-execution-policy"

const PROJECT_ROOT = join(tmpdir(), "phase32-config-disc-" + Date.now())
const OTHER_CWD = join(tmpdir(), "phase32-other-cwd-" + Date.now())

describe("Phase 32 — Configuration Discovery & Surface Area Checks", () => {
  beforeEach(() => {
    if (!existsSync(PROJECT_ROOT)) mkdirSync(PROJECT_ROOT, { recursive: true })
    if (!existsSync(OTHER_CWD)) mkdirSync(OTHER_CWD, { recursive: true })

    // Create test files and configs in PROJECT_ROOT
    mkdirSync(join(PROJECT_ROOT, "src"), { recursive: true })
    mkdirSync(join(PROJECT_ROOT, "tests"), { recursive: true })
    writeFileSync(join(PROJECT_ROOT, "src/feature.ts"), "export const feat = 1", "utf-8")
    writeFileSync(join(PROJECT_ROOT, "src/caller.ts"), 'import { feat } from "./feature"\nconsole.log(feat)', "utf-8")
    writeFileSync(join(PROJECT_ROOT, "tests/feature.test.ts"), 'import { feat } from "../src/feature"', "utf-8")
    writeFileSync(join(PROJECT_ROOT, "package.json"), '{"name":"test-project"}', "utf-8")
    writeFileSync(join(PROJECT_ROOT, "tsconfig.json"), '{"compilerOptions":{}}', "utf-8")
  })

  afterEach(() => {
    try { rmSync(PROJECT_ROOT, { recursive: true, force: true }) } catch {}
    try { rmSync(OTHER_CWD, { recursive: true, force: true }) } catch {}
  })

  it("resolves relative target paths against explicit projectRoot without depending on process.cwd()", () => {
    const origCwd = process.cwd()
    try {
      // Change cwd to OTHER_CWD
      process.chdir(OTHER_CWD)

      const result = performSurfaceAreaCheck({
        targetFiles: ["src/feature.ts"],
        projectRoot: PROJECT_ROOT,
      })

      expect(result.readyForEdit).toBe(true)
      expect(result.dependents).toContain(join(PROJECT_ROOT, "src/caller.ts"))
      expect(result.existingTests).toContain(join(PROJECT_ROOT, "tests/feature.test.ts"))
      expect(result.relatedConfig).toContain(join(PROJECT_ROOT, "package.json"))
      expect(result.relatedConfig).toContain(join(PROJECT_ROOT, "tsconfig.json"))
    } finally {
      process.chdir(origCwd)
    }
  })

  it("keeps absolute target file paths intact and resolves configs cleanly", () => {
    const absTarget = join(PROJECT_ROOT, "src/feature.ts")

    const result = performSurfaceAreaCheck({
      targetFiles: [absTarget],
      projectRoot: PROJECT_ROOT,
    })

    expect(result.readyForEdit).toBe(true)
    expect(result.relatedConfig).toContain(join(PROJECT_ROOT, "package.json"))
    expect(result.relatedConfig).toContain(join(PROJECT_ROOT, "tsconfig.json"))
  })

  it("discoverRelatedConfig finds config files using explicit projectRoot even when process.cwd() differs", () => {
    const origCwd = process.cwd()
    try {
      process.chdir(OTHER_CWD)

      const configs = discoverRelatedConfig(["src/feature.ts"], PROJECT_ROOT)

      expect(configs).toContain(join(PROJECT_ROOT, "package.json"))
      expect(configs).toContain(join(PROJECT_ROOT, "tsconfig.json"))
    } finally {
      process.chdir(origCwd)
    }
  })
})
