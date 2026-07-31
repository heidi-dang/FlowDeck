import { describe, it, expect } from "vitest"
import { resolveDesignFirstConfig } from "../../src/config/loader"
import type { FlowDeckConfig } from "../../src/config/schema"

describe("resolveDesignFirstConfig", () => {
  it("resolves default values when designFirst is undefined", () => {
    const config: FlowDeckConfig = {}
    const resolved = resolveDesignFirstConfig(config)

    expect(resolved).toEqual({
      enabled: true,
      enforcement: "strict",
      requireApprovalBeforeImplementation: true,
      modelOverrides: {},
      defaultSkillsByTaskType: {
        "landing-page": ["landing-page-design", "wireframe-planning", "design-system-definition", "frontend-handoff"],
        "dashboard": ["dashboard-design", "ui-ux-planning", "wireframe-planning", "responsive-review"],
        "admin-panel": ["ui-ux-planning", "wireframe-planning", "design-system-definition", "frontend-handoff"],
        "app-screen": ["app-shell-design", "ui-ux-planning", "wireframe-planning", "responsive-review"],
        "general-ui": ["ui-ux-planning", "wireframe-planning", "design-system-definition", "frontend-handoff"],
      }
    })
  })

  it("resolves default values when designFirst is partially defined", () => {
    const config: FlowDeckConfig = {
      designFirst: {
        enforcement: "advisory",
        modelOverrides: { "some-model": "overridden-model" }
      }
    }
    const resolved = resolveDesignFirstConfig(config)

    expect(resolved.enabled).toBe(true) // Default
    expect(resolved.enforcement).toBe("advisory") // Overridden
    expect(resolved.requireApprovalBeforeImplementation).toBe(true) // Default
    expect(resolved.modelOverrides).toEqual({ "some-model": "overridden-model" }) // Overridden

    // Default skills are preserved
    expect(resolved.defaultSkillsByTaskType["landing-page"]).toBeDefined()
  })

  it("respects falsy boolean values in configuration", () => {
    const config: FlowDeckConfig = {
      designFirst: {
        enabled: false,
        requireApprovalBeforeImplementation: false
      }
    }
    const resolved = resolveDesignFirstConfig(config)

    expect(resolved.enabled).toBe(false)
    expect(resolved.requireApprovalBeforeImplementation).toBe(false)
  })

  it("respects fully overriding configurations", () => {
    const customSkills = {
      "custom-task": ["custom-skill-1", "custom-skill-2"]
    }

    const config: FlowDeckConfig = {
      designFirst: {
        enabled: false,
        enforcement: "off",
        requireApprovalBeforeImplementation: false,
        modelOverrides: { "task-planner": "gpt-4" },
        defaultSkillsByTaskType: customSkills
      }
    }
    const resolved = resolveDesignFirstConfig(config)

    expect(resolved).toEqual({
      enabled: false,
      enforcement: "off",
      requireApprovalBeforeImplementation: false,
      modelOverrides: { "task-planner": "gpt-4" },
      defaultSkillsByTaskType: customSkills
    })
  })
})
