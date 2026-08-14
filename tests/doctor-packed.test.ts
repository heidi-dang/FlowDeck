/**
 * Packed Install Doctor Tests
 *
 * Regression suite for v1.0.1: a healthy npm/packed install must not fail
 * repository-only checks (tsconfig.json, uninstall.sh, .gitignore) and must
 * verify secret redaction behaviourally instead of by file presence.
 *
 * Exit-code contract (shared with the CLI):
 *   0 healthy | 1 failing checks | 2 engine failure
 */

import { describe, it, expect, beforeAll } from "bun:test"
import { existsSync, mkdirSync, writeFileSync, cpSync, rmSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { spawnSync } from "node:child_process"
import {
  classifyDoctorEnvironment,
  isRepoLikeEnvironment,
} from "../src/doctor/environment"
import { runDoctorService } from "../scripts/doctor-service.mjs"

const PKG_ROOT = process.cwd()

// ─── Typed service wrapper ─────────────────────────────────────────────

type PackedReport = {
  checks: Array<{ id: string; status: string; detected?: string; recommendation?: string }>
  scores?: { overall?: number }
  summary?: Record<string, number>
}

async function runPackedService(dir: string, profile = "recommended-dev") {
  const result = (await runDoctorService(dir, { profile })) as {
    report: PackedReport | null
    exitCode: number
    stdout: string
    stderr: string
  }
  return { report: result.report, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr }
}

// ─── Fixture Builder ────────────────────────────────────────────────────

let fixtureRoot: string

function makeDir(prefix: string): string {
  const dir = join(fixtureRoot, `${prefix}-${Math.random().toString(36).slice(2, 8)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

function writePkg(dir: string, extra: Record<string, unknown> = {}) {
  const rootPkgPath = join(PKG_ROOT, "package.json")
  let currentVersion = "2.0.0-rc.1"
  if (existsSync(rootPkgPath)) {
    try {
      const parsed = JSON.parse(readFileSync(rootPkgPath, "utf-8"))
      if (parsed.version) currentVersion = parsed.version
    } catch {}
  }

  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: "@heidi-dang/flowdeck",
      version: currentVersion,
      main: "./dist/index.js",
      type: "module",
      ...extra,
    }),
  )
}

function copyDist(dir: string) {
  const src = join(PKG_ROOT, "dist", "index.js")
  if (!existsSync(src)) throw new Error("dist/index.js missing — run `bun run build` first")
  mkdirSync(join(dir, "dist"), { recursive: true })
  cpSync(src, join(dir, "dist", "index.js"))
}

// A real npm install ships the bundle's externals in node_modules
// (@opencode-ai/plugin, jsonc-parser). Provide minimal shims so the packed
// fixtures behave like a genuine installed package.
function setupDeps(dir: string) {
  const pluginDir = join(dir, "node_modules", "@opencode-ai", "plugin")
  mkdirSync(pluginDir, { recursive: true })
  writeFileSync(join(pluginDir, "package.json"), JSON.stringify({ name: "@opencode-ai/plugin", type: "module", main: "./index.js", exports: { ".": "./index.js" } }))
  // The bundle uses the plugin's zod-like schema DSL at module init:
  // `tool({...})`, `tool.schema.enum([...]).optional().default(...)`, etc.
  // A Proxy-based chainable absorbs any property access and call.
  writeFileSync(
    join(pluginDir, "index.js"),
    [
      "const handler = {",
      "  get: (target, prop) => (typeof prop === 'symbol' ? target[prop] : chain),",
      "  apply: () => chain,",
      "};",
      "const chain = new Proxy(function () {}, handler);",
      "const toolFn = (opts = {}) => ({ ...opts });",
      "export const tool = new Proxy(toolFn, { get: (t, prop) => (prop === 'schema' ? chain : chain) });",
      "",
    ].join("\n"),
  )

  const jsoncDir = join(dir, "node_modules", "jsonc-parser")
  mkdirSync(jsoncDir, { recursive: true })
  writeFileSync(join(jsoncDir, "package.json"), JSON.stringify({ name: "jsonc-parser", type: "module", main: "./index.js", exports: { ".": "./index.js" } }))
  writeFileSync(join(jsoncDir, "index.js"), "export function modify() { return null }\nexport function applyEdits() { return null }\nexport function parse() { return null }\n")
}

beforeAll(() => {
  fixtureRoot = join(tmpdir(), `fd-packed-${Date.now()}`)
  mkdirSync(fixtureRoot, { recursive: true })
})

// ─── Environment Classifier ─────────────────────────────────────────────

describe("classifyDoctorEnvironment", () => {
  it("classifies a git checkout with src as source-checkout", () => {
    const dir = makeDir("repo")
    mkdirSync(join(dir, ".git"), { recursive: true })
    mkdirSync(join(dir, "src"), { recursive: true })
    expect(classifyDoctorEnvironment(dir)).toBe("source-checkout")
    expect(isRepoLikeEnvironment("source-checkout")).toBe(true)
  })

  it("classifies a dist-only tarball layout as packed", () => {
    const dir = makeDir("packed")
    mkdirSync(join(dir, "dist"), { recursive: true })
    writeFileSync(join(dir, "dist", "index.js"), "export default {};")
    writeFileSync(join(dir, "install.sh"), "#!/usr/bin/env bash\n")
    // No tsconfig.json, no uninstall.sh, no .git — this is the packed layout
    expect(classifyDoctorEnvironment(dir)).toBe("packed")
    expect(isRepoLikeEnvironment("packed")).toBe(false)
  })

  it("classifies a node_modules install as npm", () => {
    const dir = makeDir("node_modules/pkg")
    mkdirSync(dir, { recursive: true })
    writePkg(dir)
    expect(classifyDoctorEnvironment(dir)).toBe("npm")
    expect(isRepoLikeEnvironment("npm")).toBe(false)
  })

  it("classifies a gitless src+tsconfig layout as local-repo", () => {
    const dir = makeDir("local")
    mkdirSync(join(dir, "src"), { recursive: true })
    writeFileSync(join(dir, "tsconfig.json"), "{}")
    expect(classifyDoctorEnvironment(dir)).toBe("local-repo")
    expect(isRepoLikeEnvironment("local-repo")).toBe(true)
  })

  it("returns unknown and fails closed (repo-like) for ambiguous layouts", () => {
    const dir = makeDir("unknown")
    // Just a bare directory with package.json — not enough markers
    writePkg(dir)
    expect(classifyDoctorEnvironment(dir)).toBe("unknown")
    // Fail closed: unknown environments are treated as repo-like so
    // repository-only checks are NOT silently skipped.
    expect(isRepoLikeEnvironment("unknown")).toBe(true)
  })
})

// ─── Packed / npm Behaviour ─────────────────────────────────────────────

describe("packed-install doctor", () => {
  it("reports zero errors on a healthy packed layout and exits 0", async () => {
    const dir = makeDir("healthy")
    writePkg(dir)
    copyDist(dir)
    setupDeps(dir)
    writeFileSync(join(dir, "install.sh"), "#!/usr/bin/env bash\n")

    const { report, exitCode } = await runPackedService(dir)

    const errors = report!.checks.filter(c => c.status === "error")
    expect(errors).toEqual([])
    expect(exitCode).toBe(0)
  })

  it("skips repository-only checks on npm/packed layouts", async () => {
    const dir = makeDir("skip")
    writePkg(dir)
    copyDist(dir)
    setupDeps(dir)
    writeFileSync(join(dir, "install.sh"), "#!/usr/bin/env bash\n")
    // Deliberately omit: tsconfig.json, uninstall.sh, .gitignore, .git

    const { report } = await runPackedService(dir)

    const repoOnly = report!.checks.filter(c =>
      ["config.tsconfig.json", "config.uninstall.sh", "security.gitignore"].includes(c.id),
    )
    expect(repoOnly.length).toBe(3)
    for (const check of repoOnly) {
      expect(check.status).toBe("skipped")
    }
  })

  it("passes the secret-redaction check behaviourally via the dist bundle", async () => {
    const dir = makeDir("redact")
    writePkg(dir)
    copyDist(dir)
    setupDeps(dir) // src/lib/ is NOT shipped in packed installs — only dist works

    const { report } = await runPackedService(dir)

    const check = report!.checks.find(c => c.id === "security.secret_redaction")
    expect(check).toBeDefined()
    expect(check!.status).toBe("pass")
    expect(check!.detected).toContain("redacts synthetic secrets")
    // Packed installs ship no src/lib — the probe must resolve via dist/index.js
    expect(check!.recommendation).toContain("dist/index.js")
  })

  it("exits 1 with honest errors on a broken packed layout (dist missing)", async () => {
    const dir = makeDir("broken")
    writePkg(dir)
    writeFileSync(join(dir, "install.sh"), "#!/usr/bin/env bash\n")
    // No dist/index.js — broken package. Layout becomes unclassifiable
    // ("unknown"), which fails closed and surfaces repo-only errors too.

    const { report, exitCode } = await runPackedService(dir)

    const ids = report!.checks.filter(c => c.status === "error").map(c => c.id)
    expect(ids).toContain("plugin.bundle")
    expect(ids).toContain("security.secret_redaction")
    expect(exitCode).toBe(1)
  })

  it("exits 2 on engine failure (no package.json)", async () => {
    const dir = makeDir("no-pkg")
    mkdirSync(dir, { recursive: true }) // empty directory

    const { exitCode, stderr } = await runPackedService(dir)

    expect(exitCode).toBe(2)
    expect(stderr).toContain("No package.json")
  })

  it("rejects unknown profiles with exit 2", async () => {
    const dir = makeDir("profile")
    writePkg(dir)
    copyDist(dir)

    const { exitCode, stderr } = await runPackedService(dir, "nope")
    expect(exitCode).toBe(2)
    expect(stderr).toContain("Unknown profile")
  })

  it("executes CLI via dist/index.js when src/doctor/doctor.ts is missing", () => {
    const dir = makeDir("cli-dist-only")
    writePkg(dir)
    copyDist(dir)
    setupDeps(dir)
    writeFileSync(join(dir, "install.sh"), "#!/usr/bin/env bash\n")
    mkdirSync(join(dir, "src", "doctor"), { recursive: true })
    cpSync(join(PKG_ROOT, "src", "doctor", "cli.mjs"), join(dir, "src", "doctor", "cli.mjs"))
    cpSync(join(PKG_ROOT, "src", "doctor", "exit-code.mjs"), join(dir, "src", "doctor", "exit-code.mjs"))
    cpSync(join(PKG_ROOT, "scripts"), join(dir, "scripts"), { recursive: true })

    const bunBin = (process.env.FLOWDECK_BUN_BIN && !process.env.FLOWDECK_BUN_BIN.endsWith("/node") && !process.env.FLOWDECK_BUN_BIN.endsWith("/node.exe"))
      ? process.env.FLOWDECK_BUN_BIN
      : "bun"

    const result = spawnSync("node", [join(dir, "src", "doctor", "cli.mjs"), "--json"], {
      cwd: dir,
      encoding: "utf-8",
      env: { ...process.env, FLOWDECK_BUN_BIN: bunBin },
    })

    expect(result.status, `cli.mjs failed with status ${result.status}. stderr: ${result.stderr}`).toBe(0)
    const rawStdout = result.stdout || ""
    const match = rawStdout.match(/\{[\s\S]*\}/)
    expect(match, `No JSON object found in CLI stdout: ${rawStdout}`).not.toBeNull()
    const report = JSON.parse(match![0])
    expect(report.schemaVersion).toBe(1)
  })
})

// ─── Source-checkout Regression ─────────────────────────────────────────

describe("source-checkout regression", () => {
  it("still enforces repository-only checks on a source checkout", async () => {
    const dir = makeDir("src-checkout")
    mkdirSync(join(dir, ".git"), { recursive: true })
    mkdirSync(join(dir, "src"), { recursive: true })
    writePkg(dir)
    copyDist(dir)
    setupDeps(dir)
    writeFileSync(join(dir, "install.sh"), "#!/usr/bin/env bash\n")
    writeFileSync(join(dir, "uninstall.sh"), "#!/usr/bin/env bash\n")
    writeFileSync(join(dir, "tsconfig.json"), "{\"compilerOptions\":{\"strict\":true}}\n")
    writeFileSync(join(dir, ".gitignore"), "node_modules\ndist\n.env\n")

    const { report, exitCode } = await runPackedService(dir)

    // Repo-only checks are active again — all present, so all pass
    const repoOnly = report!.checks.filter(c =>
      ["config.tsconfig.json", "config.uninstall.sh", "security.gitignore"].includes(c.id),
    )
    expect(repoOnly.length).toBe(3)
    for (const check of repoOnly) {
      expect(check.status).toBe("pass")
    }
    expect(exitCode).toBe(0)
  })

  it("surfaces missing repo-only files as real failures in a source checkout", async () => {
    const dir = makeDir("src-missing")
    mkdirSync(join(dir, ".git"), { recursive: true })
    mkdirSync(join(dir, "src"), { recursive: true })
    writePkg(dir)
    copyDist(dir)
    setupDeps(dir)
    writeFileSync(join(dir, "install.sh"), "#!/usr/bin/env bash\n")
    // No tsconfig.json / uninstall.sh / .gitignore in this checkout

    const { report } = await runPackedService(dir)

    const configTsconfig = report!.checks.find(c => c.id === "config.tsconfig.json")
    const configUninstall = report!.checks.find(c => c.id === "config.uninstall.sh")
    expect(configTsconfig!.status).toBe("error")
    expect(configUninstall!.status).toBe("error")
  })

  it("falls back to src/lib/secret-redaction.ts when dist is absent in a local repo", async () => {
    const dir = makeDir("local-redact")
    mkdirSync(join(dir, "src", "lib"), { recursive: true })
    writePkg(dir)
    writeFileSync(join(dir, "tsconfig.json"), "{}")
    // Copy the real redaction module so the probe can import it
    const redactSrc = join(PKG_ROOT, "src", "lib", "secret-redaction.ts")
    if (!existsSync(redactSrc)) throw new Error("src/lib/secret-redaction.ts missing")
    cpSync(redactSrc, join(dir, "src", "lib", "secret-redaction.ts"))
    // No dist — probe must fall back to the source module

    const { report } = await runPackedService(dir)

    const check = report!.checks.find(c => c.id === "security.secret_redaction")
    expect(check).toBeDefined()
    expect(check!.status).toBe("pass")
    expect(check!.recommendation).toContain("src/lib/secret-redaction.ts")
  })
})

// ─── Cleanup ────────────────────────────────────────────────────────────

import { afterAll } from "bun:test"

afterAll(() => {
  try {
    rmSync(fixtureRoot, { recursive: true, force: true })
  } catch { /* best effort */ }
})
