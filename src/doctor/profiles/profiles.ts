import type { DoctorProfile } from "../types"

const PROFILES: Record<string, DoctorProfile> = {
  "minimal": {
    name: "minimal",
    description: "Minimal FlowDeck installation — only essential components",
    enabledMcps: ["context7", "grep_app", "sequentialThinking"],
    enabledHooks: ["chat.message", "tool.execute.before", "tool.execute.after", "guardRailsHook"],
    runtimeRequirements: ["node >= 20", "npm", "git"],
    recommendedSettings: {
      governance: { mode: "strict" },
      default_agent: "heidi",
    },
  },
  "recommended-dev": {
    name: "recommended-dev",
    description: "Recommended development environment — best balance of features and performance",
    enabledMcps: [
      "context7", "websearch", "grep_app", "github",
      "memory", "sequentialThinking", "tokenOptimizer",
    ],
    enabledHooks: [
      "chat.message", "tool.execute.before", "tool.execute.after",
      "guardRailsHook", "orchestratorGuard", "toolGuardHook",
      "sessionStartHook", "sessionEventsHook", "commandRefGuard",
      "patchTrust", "todoHook", "fileTracker", "contextWindowMonitor",
    ],
    runtimeRequirements: ["node >= 20", "npm", "bun >= 1.0", "git"],
    recommendedSettings: {
      governance: { mode: "strict" },
      default_agent: "heidi",
      runtimeAgent: { enforcement: "strict" },
      maxDelegationDepth: 1,
    },
  },
  "full-dev": {
    name: "full-dev",
    description: "Full development environment — all MCPs, all hooks, all tooling",
    enabledMcps: [
      "context7", "websearch", "grep_app", "github",
      "magic", "memory", "playwright", "sequentialThinking",
      "tokenOptimizer",
    ],
    enabledHooks: [
      "chat.message", "tool.execute.before", "tool.execute.after",
      "guardRailsHook", "orchestratorGuard", "toolGuardHook",
      "sessionStartHook", "sessionEventsHook", "commandRefGuard",
      "patchTrust", "notifications", "todoHook", "fileTracker",
      "contextWindowMonitor", "shellEnvHook",
    ],
    runtimeRequirements: ["node >= 20", "npm", "bun >= 1.0", "git"],
    recommendedSettings: {
      governance: { mode: "strict" },
      default_agent: "heidi",
      runtimeAgent: { enforcement: "strict" },
      maxDelegationDepth: 1,
      designFirst: { enabled: true, enforcement: "advisory" },
    },
  },
  "ci": {
    name: "ci",
    description: "CI pipeline — no MCPs, no UI, fast execution",
    enabledMcps: [],
    enabledHooks: [
      "tool.execute.before", "tool.execute.after",
      "guardRailsHook",
    ],
    runtimeRequirements: ["node >= 20", "npm"],
    recommendedSettings: {
      governance: { mode: "strict" },
      default_agent: "heidi",
    },
  },
  "release": {
    name: "release",
    description: "Release preparation — security checks and validation enabled",
    enabledMcps: [],
    enabledHooks: [
      "tool.execute.before", "tool.execute.after",
      "guardRailsHook", "sessionEventsHook",
    ],
    runtimeRequirements: ["node >= 20", "npm", "bun >= 1.0", "git"],
    recommendedSettings: {
      governance: { mode: "strict" },
      default_agent: "heidi",
      runtimeAgent: { enforcement: "strict" },
    },
  },
}

export function resolveProfile(name: string): DoctorProfile {
  return PROFILES[name] || PROFILES["recommended-dev"]
}

export function getProfileNames(): string[] {
  return Object.keys(PROFILES)
}
