import { describe, it, expect } from "bun:test"
import { fileURLToPath } from "node:url"
import { resolveDoctorEngineUrl, DoctorEngineLoadError } from "../src/services/doctor"

describe("Doctor Engine Path Resolution & Error Handling", () => {
  describe("resolveDoctorEngineUrl layout resolution", () => {
    it("resolves source module layout (src/services/doctor.ts)", () => {
      const metaUrl = "file:///home/user/project/src/services/doctor.ts"
      const resolved = resolveDoctorEngineUrl(metaUrl)
      expect(resolved).toBeInstanceOf(URL)
      const path = fileURLToPath(resolved)
      expect(path.replace(/\\/g, "/")).toBe("/home/user/project/scripts/doctor-engine.mjs")
    })

    it("resolves source module layout (src/doctor/doctor.ts)", () => {
      const metaUrl = "file:///home/user/project/src/doctor/doctor.ts"
      const resolved = resolveDoctorEngineUrl(metaUrl)
      const path = fileURLToPath(resolved)
      expect(path.replace(/\\/g, "/")).toBe("/home/user/project/scripts/doctor-engine.mjs")
    })

    it("resolves compiled dist layout (dist/index.js)", () => {
      const metaUrl = "file:///home/user/project/dist/index.js"
      const resolved = resolveDoctorEngineUrl(metaUrl)
      const path = fileURLToPath(resolved)
      expect(path.replace(/\\/g, "/")).toBe("/home/user/project/scripts/doctor-engine.mjs")
    })

    it("resolves compiled dist subfolder layout (dist/services/doctor.js)", () => {
      const metaUrl = "file:///home/user/project/dist/services/doctor.js"
      const resolved = resolveDoctorEngineUrl(metaUrl)
      const path = fileURLToPath(resolved)
      expect(path.replace(/\\/g, "/")).toBe("/home/user/project/scripts/doctor-engine.mjs")
    })

    it("resolves npm-packed / installed layout in node_modules", () => {
      const metaUrl = "file:///home/user/project/node_modules/@heidi-dang/flowdeck/dist/index.js"
      const resolved = resolveDoctorEngineUrl(metaUrl)
      const path = fileURLToPath(resolved)
      expect(path.replace(/\\/g, "/")).toBe(
        "/home/user/project/node_modules/@heidi-dang/flowdeck/scripts/doctor-engine.mjs"
      )
    })

    it("resolves layout with paths containing spaces", () => {
      const metaUrl = "file:///home/user/my%20project/dist/index.js"
      const resolved = resolveDoctorEngineUrl(metaUrl)
      expect(resolved.href).toContain("my%20project")
      const path = fileURLToPath(resolved)
      expect(path.replace(/\\/g, "/")).toBe("/home/user/my project/scripts/doctor-engine.mjs")
    })

    it("resolves layout with Unicode paths", () => {
      const metaUrl = "file:///home/user/%E9%A0%85%20%E7%9B%AE/dist/index.js"
      const resolved = resolveDoctorEngineUrl(metaUrl)
      const path = fileURLToPath(resolved)
      expect(path.replace(/\\/g, "/")).toBe("/home/user/項 目/scripts/doctor-engine.mjs")
    })

    it("handles URL object inputs and encoding edge cases", () => {
      const metaUrl = new URL("file:///home/user/path%20with%20%23hash/src/services/doctor.ts")
      const resolved = resolveDoctorEngineUrl(metaUrl)
      const path = fileURLToPath(resolved)
      expect(path.replace(/\\/g, "/")).toBe(
        "/home/user/path with #hash/scripts/doctor-engine.mjs"
      )
    })

    it("handles plain filesystem path strings", () => {
      const plainPath = "/home/user/project/dist/index.js"
      const resolved = resolveDoctorEngineUrl(plainPath)
      const path = fileURLToPath(resolved)
      expect(path.replace(/\\/g, "/")).toBe("/home/user/project/scripts/doctor-engine.mjs")
    })

    it("resolves Windows drive letter paths without double drive prefix", () => {
      const metaUrl = "file:///D:/a/FlowDeck/FlowDeck/src/services/doctor.ts"
      const resolved = resolveDoctorEngineUrl(metaUrl)
      expect(resolved).toBeInstanceOf(URL)
      const path = fileURLToPath(resolved)
      const normalized = path.replace(/\\/g, "/")
      expect(normalized).not.toMatch(/^[a-zA-Z]:\/[a-zA-Z]:/)
      expect(normalized).not.toContain("D:/D:")
      expect(normalized).not.toContain("D:\\D:")
      expect(normalized.endsWith("D:/a/FlowDeck/FlowDeck/scripts/doctor-engine.mjs")).toBe(true)
    })

    it("resolves Windows backslash filesystem path strings without double drive prefix", () => {
      const plainPath = "D:\\a\\FlowDeck\\FlowDeck\\src\\services\\doctor.ts"
      const resolved = resolveDoctorEngineUrl(plainPath)
      expect(resolved).toBeInstanceOf(URL)
      const path = fileURLToPath(resolved)
      const normalized = path.replace(/\\/g, "/")
      expect(normalized).not.toMatch(/^[a-zA-Z]:\/[a-zA-Z]:/)
      expect(normalized).not.toContain("D:/D:")
      expect(normalized).not.toContain("D:\\D:")
      expect(normalized.endsWith("D:/a/FlowDeck/FlowDeck/scripts/doctor-engine.mjs")).toBe(true)
    })

    it("resolves existing file on disk when metaUrl points to real project file", () => {
      const resolved = resolveDoctorEngineUrl(import.meta.url)
      expect(resolved).toBeInstanceOf(URL)
      const path = fileURLToPath(resolved)
      expect(path.endsWith("scripts/doctor-engine.mjs")).toBe(true)
    })
  })

  describe("Missing doctor-engine.mjs and error handling", () => {
    it("produces structured DoctorEngineLoadError with actionable diagnostic message when asset is missing", () => {
      const missingPath = "/non/existent/path/scripts/doctor-engine.mjs"
      const err = new DoctorEngineLoadError(`Doctor engine asset missing: ${missingPath}`)

      expect(err).toBeInstanceOf(DoctorEngineLoadError)
      expect(err).toBeInstanceOf(Error)
      expect(err.name).toBe("DoctorEngineLoadError")
      expect(err.message).toContain("Doctor engine asset missing:")
      expect(err.message).toContain(missingPath)
    })

    it("includes cause when provided in DoctorEngineLoadError", () => {
      const cause = new Error("ENOENT: no such file or directory")
      const err = new DoctorEngineLoadError("Doctor engine asset missing: /test/path", cause)
      expect(err.cause).toBe(cause)
    })
  })
})
