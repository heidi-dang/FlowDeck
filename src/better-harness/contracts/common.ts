import { z } from "zod/v4";

export const HarnessDimensionEnum = z.enum([
  "task-understanding",
  "controlled-execution",
  "change-validation",
  "reliable-delivery",
  "learning-capture",
]);
export type HarnessDimension = z.infer<typeof HarnessDimensionEnum>;

export const HarnessPriorityEnum = z.enum(["high", "medium", "low"]);
export type HarnessPriority = z.infer<typeof HarnessPriorityEnum>;

export const HarnessFindingStatusEnum = z.enum([
  "pending",
  "planning",
  "processing",
  "fixed",
  "ignored",
  "regressed",
]);
export type HarnessFindingStatus = z.infer<typeof HarnessFindingStatusEnum>;

export const HarnessFixVehicleEnum = z.enum([
  "rule",
  "skill",
  "hook",
  "script",
  "command",
  "agent",
  "ci-workflow",
  "automation",
  "human-gate",
  "documentation",
]);
export type HarnessFixVehicle = z.infer<typeof HarnessFixVehicleEnum>;

export const HarnessRunStatusEnum = z.enum([
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
]);
export type HarnessRunStatus = z.infer<typeof HarnessRunStatusEnum>;

export const HarnessCollectorCategoryEnum = z.enum([
  "customization",
  "session",
  "foundation",
]);
export type HarnessCollectorCategory = z.infer<typeof HarnessCollectorCategoryEnum>;

export const CollectorNameEnum = z.enum([
  "customization",
  "sessions",
  "foundations",
]);
export type CollectorName = z.infer<typeof CollectorNameEnum>;
