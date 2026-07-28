import { EventBus } from "./event-bus";
import { isRunCancelled, clearCancellation } from "./run-cancellation";
import { runAllCollectors } from "../collectors/collector-runner";
import { analyzeTaskUnderstanding } from "../analyzers/task-understanding";
import { analyzeControlledExecution } from "../analyzers/controlled-execution";
import { analyzeChangeValidation } from "../analyzers/change-validation";
import { analyzeReliableDelivery } from "../analyzers/reliable-delivery";
import { analyzeLearningCapture } from "../analyzers/learning-capture";
import { synthesizeFindings } from "../analyzers/finding-synthesizer";
import { scoreDimension } from "../scoring/dimension-scoring";
import { calculateOverallScore } from "../scoring/overall-scoring";
import { SCORING_VERSION } from "../scoring/scoring-version";
import { captureWorkspaceSnapshot } from "../workspace/workspace-snapshot";
import { getProjectIdentity } from "../workspace/project-identity";
import { saveRun, type StoredRun } from "../persistence/run-store";
import type { HarnessReport } from "../contracts/report";
import { saveReport } from "../persistence/report-store";
import { saveFindingIndex } from "../persistence/finding-store";
import { readSessionRecords } from "../opencode/session-reader";
import { analyzeSessions } from "../opencode/session-analyzer";
import type { HarnessRunStatus } from "../contracts/common";
import { cancelRun as cancelRunAction } from "./run-cancellation";

export interface RunConfig {
  projectRoot: string;
  timeoutMs?: number;
}

export interface RunState {
  runId: string;
  status: HarnessRunStatus;
  progressPercent: number;
  stage: string;
  errorMessage?: string;
}

export class RunCoordinator {
  private eventBus = new EventBus();
  private activeRun: RunState | null = null;

  getEventBus(): EventBus {
    return this.eventBus;
  }

  isActive(): boolean {
    return this.activeRun !== null && (this.activeRun.status === "queued" || this.activeRun.status === "running");
  }

  /**
   * Update run progress, persist the run state, then emit run.progress.
   * Ensures persistence happens before broadcast so consumers never see
   * unpersisted progress.
   */
  private emitProgress(runId: string, projectId: string, updates: Partial<RunState>): void {
    if (!this.activeRun || this.activeRun.runId !== runId) return;

    // Apply updates
    Object.assign(this.activeRun, updates);

    // Persist first
    const now = new Date().toISOString();
    const runRecord = {
      runId: this.activeRun.runId,
      projectId,
      status: this.activeRun.status,
      startedAt: now,
      stage: this.activeRun.stage,
      progressPercent: this.activeRun.progressPercent,
    };
    saveRun(projectId, runRecord);

    // Then emit
    this.eventBus.emit("run.progress", {
      runId: this.activeRun.runId,
      status: this.activeRun.status,
      stage: this.activeRun.stage,
      progressPercent: this.activeRun.progressPercent,
      updatedAt: now,
      errorMessage: this.activeRun.errorMessage,
    });
  }

  async enqueueRun(config: RunConfig): Promise<RunState> {
    if (this.isActive()) {
      throw new Error("A run is already in progress for this coordinator");
    }

    const runId = "run_" + Date.now();
    const projectRoot = config.projectRoot;
    const timeoutMs = config.timeoutMs ?? 120_000;

    this.activeRun = {
      runId,
      status: "queued",
      progressPercent: 0,
      stage: "initializing",
    };

    this.eventBus.emit("run.queued", { runId });

    const _projectIdentity = getProjectIdentity(projectRoot);
    const snapshot = captureWorkspaceSnapshot(projectRoot);

    const runRecord: StoredRun = {
      runId,
      projectId: snapshot.projectId,
      status: "running",
      startedAt: new Date().toISOString(),
      stage: "collecting",
      progressPercent: 5,
    };
    saveRun(snapshot.projectId, runRecord);

    setImmediate(async () => {
      try {
        await this.runWithTimeout(timeoutMs, runId, async () => {
          this.emitProgress(runId, snapshot.projectId, { status: "running", stage: "collecting", progressPercent: 5 });
          this.eventBus.emit("run.started", { runId });
          this.eventBus.emit("collector.started", { runId });

          if (isRunCancelled(runId)) {
            this.internalCancelRun(runId, snapshot.projectId);
            return;
          }

          const { evidence, collectorResults: _collectorResults } = await runAllCollectors(projectRoot);

          this.emitProgress(runId, snapshot.projectId, { progressPercent: 10 });
          this.eventBus.emit("collector.completed", { runId, evidenceCount: evidence.length });

          if (isRunCancelled(runId)) {
            this.internalCancelRun(runId, snapshot.projectId);
            return;
          }

          this.emitProgress(runId, snapshot.projectId, { stage: "analyzing", progressPercent: 15 });
          this.eventBus.emit("analysis.started", { runId });

          const dimensionResults = [
            analyzeTaskUnderstanding(evidence),
            analyzeControlledExecution(evidence),
            analyzeChangeValidation(evidence),
            analyzeReliableDelivery(evidence, projectRoot),
            analyzeLearningCapture(evidence),
          ];

          this.emitProgress(runId, snapshot.projectId, { progressPercent: 55 });

          const findings = synthesizeFindings(dimensionResults.map((r) => ({
            dimension: r.dimension,
            findings: r.findings,
          })));

          const dimensionScores = dimensionResults.map((dr) =>
            scoreDimension({
              dimension: dr.dimension,
              findings,
              evidenceCoverage: evidence.length > 0 ? Math.min(100, Math.round((evidence.length / 20) * 100)) : 0,
            }),
          );

          this.emitProgress(runId, snapshot.projectId, { progressPercent: 75 });
          this.eventBus.emit("finding.created", { runId, findingCount: findings.length });

          this.emitProgress(runId, snapshot.projectId, { stage: "scoring", progressPercent: 85 });
          const { overallScore, evidenceCoverage } = calculateOverallScore(dimensionScores);

          const sessionRecords = readSessionRecords(projectRoot);
          const sessionAnalysis = analyzeSessions(sessionRecords);

          const now = new Date().toISOString();
          const report: HarnessReport = {
            schemaVersion: 1,
            engineVersion: "1.0.0",
            scoringVersion: SCORING_VERSION,
            generatedAt: now,
            sourceRevision: snapshot.revision || undefined,
            project: {
              name: snapshot.projectId,
              directory: projectRoot,
            },
            overallScore,
            evidenceCoverage,
            dimensions: dimensionScores,
            findings,
            sessions: {
              analyzed: sessionAnalysis.totalSessions,
              longSessions: sessionAnalysis.longSessions,
              failedSessions: sessionAnalysis.failedSessions,
              repeatedFailures: sessionAnalysis.repeatedFailures,
              compactions: sessionAnalysis.compactions,
              permissionInterruptions: sessionAnalysis.permissionInterruptions,
            },
            assets: {
              agents: evidence.filter((e) => e.source.includes("agents")).length,
              skills: evidence.filter((e) => e.source.includes("skills")).length,
              commands: evidence.filter((e) => e.source.includes("commands")).length,
              rules: evidence.filter((e) => e.source.includes("rules")).length,
              hooks: evidence.filter((e) => e.source.includes("hooks")).length,
              scripts: evidence.filter((e) => e.source.includes("scripts")).length,
              workflows: evidence.filter((e) => e.source.includes("workflows")).length,
              tests: evidence.filter((e) => e.summary.includes("Test script")).length,
              lessons: evidence.filter((e) => e.summary.includes("lessons") || e.summary.includes("Lessons")).length,
              memoryNodes: 0,
            },
          };

          saveReport(snapshot.projectId, report);
          saveFindingIndex(snapshot.projectId, findings);

          this.emitProgress(runId, snapshot.projectId, { status: "completed", stage: "completed", progressPercent: 100 });
          this.eventBus.emit("report.completed", { runId, report });

          const completedRecord: StoredRun = {
            ...runRecord,
            status: "completed",
            completedAt: new Date().toISOString(),
            progressPercent: 100,
          };
          saveRun(snapshot.projectId, completedRecord);
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.failRun(runId, snapshot.projectId, msg);
      } finally {
        clearCancellation(runId);
      }
    });

    return { ...this.activeRun! };
  }

  getRun(runId: string): StoredRun | null {
    try {
      const { homedir } = require("os");
      const { join } = require("path");
      const { existsSync, readdirSync } = require("fs");
      const stateDir = join(homedir(), ".flowdeck", "state");
      if (!existsSync(stateDir)) return null;
      const projectDirs = readdirSync(stateDir);
      for (const projectId of projectDirs) {
        const runPath = join(stateDir, projectId, "better-harness", "runs", runId + ".json");
        if (existsSync(runPath)) {
          const { readFileSync } = require("fs");
          return JSON.parse(readFileSync(runPath, "utf-8")) as StoredRun;
        }
      }
    } catch { /* best-effort */ }
    return null;
  }

  cancelRun(runId: string): boolean {
    const alreadyCancelled = !cancelRunAction(runId);
    if (alreadyCancelled) return false;

    if (this.activeRun && this.activeRun.runId === runId) {
      this.activeRun.status = "cancelled";
      this.activeRun.stage = "cancelled";
      this.eventBus.emit("run.cancelled", { runId, errorMessage: "Run cancelled" });
    }
    return true;
  }

  getActiveRun(): RunState | null {
    return this.activeRun;
  }

  private async runWithTimeout(timeoutMs: number, runId: string, fn: () => Promise<void>): Promise<void> {
    const timeoutPromise = new Promise<void>((_, reject) => {
      setTimeout(() => {
        reject(new Error("Run timed out after " + timeoutMs + "ms"));
      }, timeoutMs);
    });
    await Promise.race([fn(), timeoutPromise]);
  }

  private internalCancelRun(runId: string, projectId: string): void {
    this.emitProgress(runId, projectId, {
      status: "cancelled",
      stage: this.activeRun?.stage ?? "unknown",
      progressPercent: this.activeRun?.progressPercent ?? 0,
      errorMessage: "Run cancelled",
    });
    this.eventBus.emit("run.cancelled", { runId, errorMessage: "Run cancelled" });
  }

  private failRun(runId: string, projectId: string, errorMessage: string): RunState {
    this.emitProgress(runId, projectId, {
      status: "failed",
      stage: this.activeRun?.stage ?? "unknown",
      progressPercent: this.activeRun?.progressPercent ?? 0,
      errorMessage,
    });
    this.eventBus.emit("run.failed", { runId, errorMessage });
    return this.activeRun!;
  }

  recoverActiveRuns(): void {
    try {
      const { homedir } = require("os");
      const { join } = require("path");
      const { existsSync, readdirSync } = require("fs");
      const stateDir = join(homedir(), ".flowdeck", "state");
      if (!existsSync(stateDir)) return;

      const projectDirs = readdirSync(stateDir);
      for (const projectId of projectDirs) {
        const runsDir = join(stateDir, projectId, "better-harness", "runs");
        if (!existsSync(runsDir)) continue;
        const runFiles = readdirSync(runsDir).filter((f: string) => f.endsWith(".json"));
        for (const runFile of runFiles) {
          try {
            const { readFileSync } = require("fs");
            const run: StoredRun = JSON.parse(readFileSync(join(runsDir, runFile), "utf-8"));
            if (run.status === "running" || run.status === "queued") {
              run.status = "failed";
              run.completedAt = new Date().toISOString();
              run.errorMessage = "Recovered: process terminated unexpectedly";
              saveRun(run.projectId, run);
            }
          } catch { /* skip corrupt run files */ }
        }
      }
    } catch { /* best-effort recovery */ }
  }
}
