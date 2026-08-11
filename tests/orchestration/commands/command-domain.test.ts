import { describe, it, expect, beforeEach } from "bun:test";
import { CommandRegistry, CommandRegistryError } from "../../../src/orchestration/commands/domain/command-registry";
import { validateCommandInput } from "../../../src/orchestration/commands/domain/command-validator";
import type { CommandDefinition } from "../../../src/orchestration/commands/domain/command-definition";

describe("M9 Command Registry & Input Validation", () => {
  let registry: CommandRegistry;

  const sampleDefinition: CommandDefinition = {
    id: "task/start",
    version: 1,
    description: "Start a task run",
    aliases: ["fd-task"],
    inputSchema: {
      type: "object",
      properties: {
        taskDescription: { type: "string", required: true },
        isTrivial: { type: "boolean" },
      },
      required: ["taskDescription"],
    },
    strategy: "planned",
    capabilities: { requiresWorktree: true },
    planningPolicy: { requiresPlan: true },
    executionPolicy: { timeoutMs: 30000 },
    verificationPolicy: { requiresPassedVerification: true },
    completionPolicy: { requireAllAssignmentsCompleted: true },
    retryPolicy: { maxRetries: 3, backoffMs: 1000 },
    tokenPolicy: { maxTokenBudget: 50000 },
  };

  beforeEach(() => {
    registry = new CommandRegistry();
  });

  it("registers and resolves a command definition", () => {
    registry.register(sampleDefinition);
    const resolved = registry.resolve("task/start");
    expect(resolved.id).toBe("task/start");
    expect(resolved.version).toBe(1);
  });

  it("resolves by alias", () => {
    registry.register(sampleDefinition);
    const resolved = registry.resolve("fd-task");
    expect(resolved.id).toBe("task/start");
  });

  it("rejects duplicate ID + version", () => {
    registry.register(sampleDefinition);
    expect(() => registry.register(sampleDefinition)).toThrow(CommandRegistryError);
  });

  it("rejects alias collision across different commands", () => {
    registry.register(sampleDefinition);
    const colliding: CommandDefinition = {
      ...sampleDefinition,
      id: "task/start-other",
      aliases: ["fd-task"],
    };
    expect(() => registry.register(colliding)).toThrow(CommandRegistryError);
  });

  it("validates correct input successfully", () => {
    const res = validateCommandInput(sampleDefinition, { taskDescription: "Build feature X" });
    expect(res.valid).toBe(true);
    expect(res.errors).toHaveLength(0);
  });

  it("rejects invalid input missing required fields", () => {
    const res = validateCommandInput(sampleDefinition, {});
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.field === "taskDescription")).toBe(true);
  });

  it("rejects input with wrong type", () => {
    const res = validateCommandInput(sampleDefinition, { taskDescription: 12345 });
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.field === "taskDescription")).toBe(true);
  });
});
