import { z } from "zod/v4";
import {
  HarnessDimensionEnum,
  HarnessPriorityEnum,
  HarnessFindingStatusEnum,
  HarnessFixVehicleEnum,
  HarnessCollectorCategoryEnum,
} from "./common";

export const HarnessEvidenceSchema = z.object({
  id: z.string().min(1),
  category: HarnessCollectorCategoryEnum,
  source: z.string().min(1),
  summary: z.string().min(1),
  path: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
  confidence: z.number().min(0).max(1),
  collectedAt: z.string().min(1),
  fingerprint: z.string().min(1),
}).strict();
export type HarnessEvidence = z.infer<typeof HarnessEvidenceSchema>;

export const HarnessFindingSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  dimension: HarnessDimensionEnum,
  priority: HarnessPriorityEnum,
  status: HarnessFindingStatusEnum,
  cause: z.string().min(1),
  impact: z.string().min(1),
  expectedOutput: z.string().min(1),
  evidence: z.array(HarnessEvidenceSchema),
  recommendedVehicle: HarnessFixVehicleEnum,
  allowedPaths: z.array(z.string().min(1)),
  validationRequirements: z.array(z.string().min(1)),
  acceptanceCriteria: z.array(z.string().min(1)),
  firstSeenAt: z.string().min(1),
  lastSeenAt: z.string().min(1),
  repairSessionId: z.string().min(1).optional(),
}).strict();
export type HarnessFinding = z.infer<typeof HarnessFindingSchema>;

export const HarnessDimensionScoreSchema = z.object({
  dimension: HarnessDimensionEnum,
  score: z.number().min(0).max(100),
  previousScore: z.number().min(0).max(100).optional(),
  findingCount: z.number().int().nonnegative(),
  evidenceCoverage: z.number().min(0).max(100),
}).strict();
export type HarnessDimensionScore = z.infer<typeof HarnessDimensionScoreSchema>;

export const HarnessReportSchema = z.object({
  schemaVersion: z.literal(1),
  engineVersion: z.string().min(1),
  scoringVersion: z.string().min(1),
  generatedAt: z.string().min(1),
  sourceRevision: z.string().min(1).optional(),
  project: z.object({
    name: z.string().min(1),
    directory: z.string().min(1),
  }).strict(),
  overallScore: z.number().min(0).max(100),
  previousOverallScore: z.number().min(0).max(100).optional(),
  evidenceCoverage: z.number().min(0).max(100),
  dimensions: z.array(HarnessDimensionScoreSchema),
  findings: z.array(HarnessFindingSchema),
  sessions: z.object({
    analyzed: z.number().int().nonnegative(),
    longSessions: z.number().int().nonnegative(),
    failedSessions: z.number().int().nonnegative(),
    repeatedFailures: z.number().int().nonnegative(),
    compactions: z.number().int().nonnegative(),
    permissionInterruptions: z.number().int().nonnegative(),
  }).strict(),
  assets: z.object({
    agents: z.number().int().nonnegative(),
    skills: z.number().int().nonnegative(),
    commands: z.number().int().nonnegative(),
    rules: z.number().int().nonnegative(),
    hooks: z.number().int().nonnegative(),
    scripts: z.number().int().nonnegative(),
    workflows: z.number().int().nonnegative(),
    tests: z.number().int().nonnegative(),
    lessons: z.number().int().nonnegative(),
    memoryNodes: z.number().int().nonnegative(),
  }).strict(),
}).strict();
export type HarnessReport = z.infer<typeof HarnessReportSchema>;
